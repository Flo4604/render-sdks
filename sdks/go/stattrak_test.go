package render

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestStatTrakSubmission(t *testing.T) {
	zero, custom, maximum := 0, 1337, 999999
	for _, counter := range []*int{nil, &zero, &custom, &maximum} {
		for _, wait := range []bool{false, true} {
			client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				var body map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				value, present := body["statTrak"]
				if counter == nil {
					if present {
						t.Error("default request must omit statTrak")
					}
				} else {
					var got int
					if !present || json.Unmarshal(value, &got) != nil || got != *counter {
						t.Errorf("statTrak = %s, want %d", value, *counter)
					}
				}
				writeResult(w, fixture("completed"))
			})
			input := RenderRequest{InspectURL: testInput.InspectURL, StatTrak: counter}
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

func TestInvalidStatTrakDoesNotSubmit(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("invalid counter must not reach the API")
	})
	for _, counter := range []int{-1, 1000000} {
		input := RenderRequest{InspectURL: testInput.InspectURL, StatTrak: &counter}
		_, err := client.Render(context.Background(), input)
		sdkError(t, err, "invalid_input")
		_, err = client.Create(context.Background(), input)
		sdkError(t, err, "invalid_input")
	}
}
