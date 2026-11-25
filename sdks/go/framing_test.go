package render

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
)

func TestFramingSubmission(t *testing.T) {
	for _, framing := range []Framing{"", FramingAuto, FramingCharm, FramingStandard} {
		for _, wait := range []bool{false, true} {
			client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				var body map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}

				value, present := body["framing"]
				if framing == "" {
					if present {
						t.Error("default request must omit framing")
					}
				} else {
					var got Framing
					if !present || json.Unmarshal(value, &got) != nil || got != framing {
						t.Errorf("framing = %s, want %q", value, framing)
					}
				}

				writeResult(w, fixture("completed"))
			})
			input := RenderRequest{InspectURL: testInput.InspectURL, Framing: framing}
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

func TestInvalidFramingDoesNotSubmit(t *testing.T) {
	var calls atomic.Int32
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
	})
	for _, framing := range []Framing{"unknown", "Charm", " charm"} {
		input := RenderRequest{InspectURL: testInput.InspectURL, Framing: framing}
		_, err := client.Render(context.Background(), input)
		sdkError(t, err, "invalid_input")
		_, err = client.Create(context.Background(), input)
		sdkError(t, err, "invalid_input")
	}

	if calls.Load() != 0 {
		t.Fatalf("invalid framing reached the API %d times", calls.Load())
	}
}
