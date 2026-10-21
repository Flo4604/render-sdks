package render

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
)

func TestAppearanceSubmission(t *testing.T) {
	for _, appearance := range []Appearance{"", AppearanceDefault, AppearancePattern} {
		for _, wait := range []bool{false, true} {
			client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				var body map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}

				value, present := body["appearance"]
				if appearance == "" {
					if present {
						t.Error("default request must omit appearance")
					}
				} else {
					var got Appearance
					if !present || json.Unmarshal(value, &got) != nil || got != appearance {
						t.Errorf("appearance = %s, want %q", value, appearance)
					}
				}

				writeResult(w, fixture("completed"))
			})
			input := RenderRequest{InspectURL: testInput.InspectURL, Appearance: appearance}
			var err error
			if wait {
				_, err = client.Render(context.Background(), input)
			} else {
				_, err = client.Create(context.Background(), input)
			}

			if err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestInvalidAppearanceDoesNotSubmit(t *testing.T) {
	var calls atomic.Int32
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
	})
	for _, appearance := range []Appearance{"unknown", "Pattern", " pattern"} {
		input := RenderRequest{InspectURL: testInput.InspectURL, Appearance: appearance}
		_, err := client.Render(context.Background(), input)
		sdkError(t, err, "invalid_input")
		_, err = client.Create(context.Background(), input)
		sdkError(t, err, "invalid_input")
	}

	if calls.Load() != 0 {
		t.Fatalf("invalid appearance reached the API %d times", calls.Load())
	}
}

func TestUnsupportedAppearancePreservesServerError(t *testing.T) {
	for _, wait := range []bool{false, true} {
		var calls atomic.Int32
		client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.WriteHeader(http.StatusUnprocessableEntity)
			io.WriteString(w, `{"meta":{"requestId":"appearance-request"},"error":{"code":"unsupported_appearance","detail":"Pattern lighting is unavailable for these views"}}`)
		})
		input := RenderRequest{
			InspectURL: testInput.InspectURL,
			Appearance: AppearancePattern,
			Views:      []View{Preview, Front, Back},
		}
		var err error
		if wait {
			_, err = client.Render(context.Background(), input, SubmitOptions{IdempotencyKey: "appearance-key"})
		} else {
			_, err = client.Create(context.Background(), input, SubmitOptions{IdempotencyKey: "appearance-key"})
		}

		failure := sdkError(t, err, "unsupported_appearance")
		if failure.StatusCode != 422 || failure.RequestID != "appearance-request" || failure.Detail != "Pattern lighting is unavailable for these views" || failure.IdempotencyKey != "appearance-key" {
			t.Fatalf("server error was not preserved: %+v", failure)
		}

		if calls.Load() != 1 {
			t.Fatalf("expected one submission without retry, got %d", calls.Load())
		}
	}
}
