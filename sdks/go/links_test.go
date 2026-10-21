package render

import (
	"context"
	"io"
	"net/http"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
)

const (
	testImage = "https://img.medalbot.cc/v1/example.webp"
	testLink  = "https://img.medalbot.cc/r/v1/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	// A 202 with links and fields this SDK version does not know.
	pendingWithLinks = `{"meta":{"requestId":"req_test","region":"future"},"future":true,` +
		`"data":{"id":"` + testID + `","status":"queued","position":3,"links":{"front":"` + testLink + `"}}}`
	completedWithLinks = `{"meta":{"requestId":"req_test"},` +
		`"data":{"id":"` + testID + `","images":{"front":"` + testImage + `"},"links":{"front":"` + testImage + `"},"cache":"hit"}}`
)

func writeRaw(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	io.WriteString(w, body)
}

func TestPendingWithLinksAndUnknownFieldsParses(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		writeRaw(w, http.StatusAccepted, pendingWithLinks)
	})
	result, err := client.Create(context.Background(), testInput)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "queued" || result.Images != nil || result.Links[Front] != testLink {
		t.Fatalf("unexpected pending state %+v", result)
	}
}

func TestCompletedLinksEqualImages(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		writeRaw(w, http.StatusOK, completedWithLinks)
	})
	result, err := client.Get(context.Background(), testID, GetOptions{Links: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "completed" || !reflect.DeepEqual(result.Links, result.Images) {
		t.Fatalf("unexpected completed state %+v", result)
	}
}

func TestRenderCompletesOnImagesNotLinks(t *testing.T) {
	var calls atomic.Int32
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			writeRaw(w, http.StatusAccepted, pendingWithLinks)
			return
		}
		writeRaw(w, http.StatusOK, completedWithLinks)
	})
	images, err := client.Render(context.Background(), RenderRequest{InspectURL: "steam://test", Views: []View{Front}})
	if err != nil {
		t.Fatal(err)
	}
	if images[Front] != testImage || calls.Load() != 2 {
		t.Fatalf("unexpected images %v after %d calls", images, calls.Load())
	}
}

func TestLinksPreferenceHeader(t *testing.T) {
	var mu sync.Mutex
	var prefers []string
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		prefers = append(prefers, r.Header.Get("Prefer"))
		mu.Unlock()
		writeRaw(w, http.StatusOK, completedWithLinks)
	})
	ctx := context.Background()
	steps := []func() error{
		func() error { _, err := client.Create(ctx, testInput, SubmitOptions{Links: true}); return err },
		func() error { _, err := client.Get(ctx, testID, GetOptions{Links: true}); return err },
		func() error {
			_, err := client.Render(ctx, RenderRequest{InspectURL: "steam://test", Views: []View{Front}}, SubmitOptions{Links: true})
			return err
		},
		func() error { _, err := client.Create(ctx, testInput); return err },
		func() error { _, err := client.Get(ctx, testID); return err },
	}
	for _, step := range steps {
		if err := step(); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{"links", "links", "wait=10, links", "", ""}
	if !reflect.DeepEqual(prefers, want) {
		t.Fatalf("Prefer headers %q, want %q", prefers, want)
	}
}

func TestRenderLinksUnavailableRetries(t *testing.T) {
	var calls atomic.Int32
	var mu sync.Mutex
	var keys []string
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		mu.Unlock()
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "1")
			writeRaw(w, http.StatusServiceUnavailable, `{"meta":{"requestId":"req_test"},"error":{"code":"render_links_unavailable","detail":"Render links are unavailable","status":503,"title":"Service Unavailable","type":"urn:skinicon:error:render_links_unavailable"}}`)
			return
		}
		writeRaw(w, http.StatusAccepted, pendingWithLinks)
	})
	result, err := client.Create(context.Background(), testInput, SubmitOptions{IdempotencyKey: "fixture-key", Links: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Links[Front] != testLink || calls.Load() != 2 || !reflect.DeepEqual(keys, []string{"fixture-key", "fixture-key"}) {
		t.Fatalf("unexpected retry: %d calls, keys %q", calls.Load(), keys)
	}
}

func TestRenderLinksUnavailableSurfacesAfterRetries(t *testing.T) {
	var calls atomic.Int32
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "1")
		writeRaw(w, http.StatusServiceUnavailable, `{"meta":{"requestId":"req_test"},"error":{"code":"render_links_unavailable","detail":"Render links are unavailable"}}`)
	})
	_, err := client.Create(context.Background(), testInput, SubmitOptions{Links: true})
	failure := sdkError(t, err, "render_links_unavailable")
	if failure.StatusCode != http.StatusServiceUnavailable || calls.Load() != 4 {
		t.Fatalf("unexpected failure %+v after %d calls", failure, calls.Load())
	}
}

func TestInvalidLinkIsRejected(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		writeRaw(w, http.StatusAccepted, `{"meta":{"requestId":"req_test"},"data":{"id":"`+testID+`","status":"queued","links":{"front":"not a url"}}}`)
	})
	_, err := client.Create(context.Background(), testInput)
	sdkError(t, err, "invalid_response")
}
