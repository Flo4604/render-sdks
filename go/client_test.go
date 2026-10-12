package skinicon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testID = "rnd_01ARZ3NDEKTSV4RRFFQ69G5FAV"

var testInput = RenderRequest{InspectURL: "steam://test"}

func fixture(status string) Render {
	result := Render{ID: testID, Status: status}
	if status == "completed" {
		result.Images = Images{}
		for _, view := range []View{Preview, Front, Back} {
			result.Images[view] = "https://img.medalbot.cc/" + string(view) + ".webp"
		}
	}
	return result
}
func writeResult(w http.ResponseWriter, result Render) {
	w.Header().Set("Content-Type", "application/json")
	if result.Status == "completed" {
		result.Status = ""
	}
	json.NewEncoder(w).Encode(map[string]any{"meta": map[string]string{"requestId": "test-request"}, "data": result})
}
func testClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := NewClient(Config{APIKey: "test-key", BaseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	client.sleep = func(ctx context.Context, _ time.Duration) error { return ctx.Err() }
	return client
}
func sdkError(t *testing.T, err error, code string) *Error {
	t.Helper()
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != code {
		t.Fatalf("expected %s error, got %v", code, err)
	}
	return typed
}

func TestRenderCachedAndQueued(t *testing.T) {
	for _, queued := range []bool{false, true} {
		t.Run(map[bool]string{false: "cached", true: "queued"}[queued], func(t *testing.T) {
			var calls atomic.Int32
			client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				call := calls.Add(1)
				if r.Header.Get("Authorization") != "Bearer test-key" {
					t.Error("missing auth")
				}
				if call == 1 {
					if r.Method != http.MethodPost || r.URL.Path != "/v1/renders" || r.Header.Get("Prefer") != "wait=10" || r.Header.Get("Idempotency-Key") == "" {
						t.Error("incorrect submission")
					}
					var input RenderRequest
					if json.NewDecoder(r.Body).Decode(&input) != nil || input.InspectURL != testInput.InspectURL {
						t.Error("incorrect request body")
					}
					if queued {
						writeResult(w, fixture("queued"))
						return
					}
				} else if r.Method != http.MethodGet || r.URL.Path != "/v1/renders/"+testID {
					t.Error("incorrect poll")
				}
				writeResult(w, fixture("completed"))
			})
			images, err := client.Render(context.Background(), testInput)
			if err != nil || !reflect.DeepEqual(images, fixture("completed").Images) {
				t.Fatalf("%v %v", images, err)
			}
			expected := int32(1)
			if queued {
				expected = 2
			}
			if calls.Load() != expected {
				t.Fatal(calls.Load())
			}
		})
	}
}

func TestRetryKeepsIdempotencyAndBody(t *testing.T) {
	var keys, bodies []string
	var delays []time.Duration
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		body, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(body))
		if len(keys) == 1 {
			w.Header().Set("Retry-After", "3")
			w.WriteHeader(429)
			return
		}
		writeResult(w, fixture("completed"))
	})
	client.sleep = func(_ context.Context, d time.Duration) error { delays = append(delays, d); return nil }
	_, err := client.Render(context.Background(), testInput, SubmitOptions{IdempotencyKey: "stable-key"})
	if err != nil || len(keys) != 2 || keys[0] != "stable-key" || keys[1] != keys[0] || bodies[0] != bodies[1] || delays[0] < 3*time.Second {
		t.Fatalf("%v %v %v", keys, delays, err)
	}
}

func TestDeadlineBoundsSubmissionAndPolling(t *testing.T) {
	for _, submitted := range []bool{false, true} {
		t.Run(map[bool]string{false: "submission", true: "polling"}[submitted], func(t *testing.T) {
			client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				if submitted {
					writeResult(w, fixture("queued"))
					return
				}
				io.Copy(io.Discard, r.Body)
				<-r.Context().Done()
			})
			client.sleep = sleep
			client.timeout = 30 * time.Millisecond
			started := time.Now()
			_, err := client.Render(context.Background(), testInput)
			typed := sdkError(t, err, "wait_timeout")
			if !errors.Is(err, context.DeadlineExceeded) || typed.IdempotencyKey == "" {
				t.Fatal(err)
			}
			if submitted && typed.RenderID != testID {
				t.Fatal("missing render ID")
			}
			if time.Since(started) > time.Second {
				t.Fatal("deadline did not bound operation")
			}
		})
	}
}

func TestCancellationDoesNotSubmit(t *testing.T) {
	var calls atomic.Int32
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := client.Render(ctx, testInput)
	sdkError(t, err, "canceled")
	if !errors.Is(err, context.Canceled) || calls.Load() != 0 {
		t.Fatal(err, calls.Load())
	}
}

func TestCallerDeadlineWinsAndRetryAfterWaitCancels(t *testing.T) {
	var calls atomic.Int32
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(503)
	})
	client.sleep = sleep
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := client.Render(ctx, testInput)
	sdkError(t, err, "wait_timeout")
	if calls.Load() != 1 || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err, calls.Load())
	}
}

func TestResponseErrors(t *testing.T) {
	cases := []struct {
		name, body, code, request string
		status                    int
	}{
		{"api", `{"meta":{"requestId":"api-request"},"error":{"code":"invalid_inspect","detail":"Invalid inspect","status":400}}`, "invalid_inspect", "api-request", 400},
		{"gateway", `{"meta":{"requestId":"gateway-request"},"error":{"code":"denied","message":"Authentication required"}}`, "denied", "gateway-request", 401},
		{"html", "<html>proxy failure</html>", "http_error", "header-request", 403},
		{"bad json", "<html>oops</html>", "invalid_response", "header-request", 200},
		{"empty object", "{}", "invalid_response", "header-request", 200},
		{"too large", strings.Repeat("x", maxResponseBytes+1), "invalid_response", "header-request", 200},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Request-Id", "header-request")
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			})
			_, err := client.Render(context.Background(), testInput)
			typed := sdkError(t, err, tc.code)
			if typed.RequestID != tc.request || typed.IdempotencyKey == "" {
				t.Fatal(typed)
			}
		})
	}
}

func TestFailedAndIncompleteRender(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing image", true: "render failed"}[failed], func(t *testing.T) {
			client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				result := fixture("completed")
				if failed {
					result = fixture("failed")
					result.Error = &Failure{Code: "gpu_error", Detail: "Render failed"}
				} else {
					delete(result.Images, Back)
				}
				writeResult(w, result)
			})
			code := "invalid_response"
			if failed {
				code = "gpu_error"
			}
			_, err := client.Render(context.Background(), testInput)
			typed := sdkError(t, err, code)
			if typed.RenderID != testID {
				t.Fatal(typed)
			}
		})
	}
}

func TestCreateGetWaitAndViewSubset(t *testing.T) {
	var posts atomic.Int32
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
			if r.Header.Get("Prefer") != "" {
				t.Error("Create should not wait")
			}
			writeResult(w, fixture("queued"))
			return
		}
		writeResult(w, fixture("completed"))
	})
	result, err := client.Create(context.Background(), testInput)
	if err != nil || result.Status != "queued" {
		t.Fatal(err)
	}
	if _, err = client.Get(context.Background(), result.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = client.Wait(context.Background(), result.ID); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 1 {
		t.Fatal(posts.Load())
	}
	subset := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		result := fixture("completed")
		delete(result.Images, Back)
		delete(result.Images, Preview)
		writeResult(w, result)
	})
	images, err := subset.Render(context.Background(), RenderRequest{InspectURL: "steam://test", Views: []View{Front}, Format: PNG})
	if err != nil || len(images) != 1 {
		t.Fatal(err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestNetworkRetriesAreBounded(t *testing.T) {
	calls := 0
	var keys []string
	client, err := NewClient(Config{APIKey: "key", HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		return nil, errors.New("offline")
	})}})
	if err != nil {
		t.Fatal(err)
	}
	client.sleep = func(context.Context, time.Duration) error { return nil }
	_, err = client.Render(context.Background(), testInput)
	typed := sdkError(t, err, "network_error")
	if calls != 4 || typed.IdempotencyKey == "" {
		t.Fatal(calls, err)
	}
	for _, key := range keys {
		if key != typed.IdempotencyKey {
			t.Fatal("key changed")
		}
	}
}

func TestRetryAfterDate(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	delay := retryDelay(0, now.Add(30*time.Second).Format(http.TimeFormat), now)
	if delay < 30*time.Second || delay >= 31*time.Second {
		t.Fatal(delay)
	}
}

func TestDoesNotFollowRedirects(t *testing.T) {
	var calls atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer destination.Close()
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	})
	_, err := client.Render(context.Background(), testInput)
	sdkError(t, err, "http_error")
	if calls.Load() != 0 {
		t.Fatal("followed redirect")
	}
}

func TestConcurrentUse(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) { writeResult(w, fixture("completed")) })
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := client.Render(context.Background(), testInput); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
}

func TestValidationAndDefaults(t *testing.T) {
	client, err := NewClient(Config{APIKey: "key"})
	if err != nil {
		t.Fatal(err)
	}
	if client.baseURL != DefaultBaseURL || client.timeout != 120*time.Second {
		t.Fatal("incorrect defaults")
	}
	for _, config := range []Config{{}, {APIKey: "x\ny"}, {APIKey: "key", BaseURL: "ftp://example.org"}, {APIKey: "key", Timeout: -1}} {
		_, err := NewClient(config)
		sdkError(t, err, "invalid_input")
	}
	for _, input := range []RenderRequest{{}, {InspectURL: "test", Views: []View{Front, Front}}, {InspectURL: "test", Format: "jpeg"}} {
		_, err := client.Render(context.Background(), input)
		sdkError(t, err, "invalid_input")
	}
	_, err = client.Get(context.Background(), "../../secrets")
	sdkError(t, err, "invalid_input")
}

func TestDeadlineInterruptsResponseBody(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("X-Request-Id", "slow-body")
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"meta":`)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	client.timeout = 30 * time.Millisecond
	_, err := client.Render(context.Background(), testInput)
	typed := sdkError(t, err, "wait_timeout")
	if typed.RequestID != "slow-body" || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(typed)
	}
}

func TestPollingBackoffCapsAtTwoSeconds(t *testing.T) {
	count := 0
	var delays []time.Duration
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		count++
		status := "queued"
		if count == 8 {
			status = "completed"
		}
		writeResult(w, fixture(status))
	})
	client.sleep = func(_ context.Context, d time.Duration) error { delays = append(delays, d); return nil }
	_, err := client.Render(context.Background(), testInput)
	if err != nil {
		t.Fatal(err)
	}
	want := []time.Duration{500 * time.Millisecond, 750 * time.Millisecond, 1125 * time.Millisecond, 1687500 * time.Microsecond, 2 * time.Second, 2 * time.Second, 2 * time.Second}
	if !reflect.DeepEqual(delays, want) {
		t.Fatal(delays)
	}
}

func TestSavedAndSortableRenderIDs(t *testing.T) {
	for _, id := range []string{testID, "rnd_0123456789abcdef0123456789abcdef"} {
		client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v1/renders/"+id {
				t.Errorf("unexpected path: %s", r.URL.Path)
			}
			result := fixture("completed")
			result.ID = id
			writeResult(w, result)
		})
		if _, err := client.Wait(context.Background(), id); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"rnd_8" + strings.Repeat("0", 25), "rnd_" + strings.Repeat("I", 26)} {
		if renderIDPattern.MatchString(id) {
			t.Fatalf("accepted invalid ULID %s", id)
		}
	}
}
