package render

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

const expiredBody = `{"meta":{"requestId":"req_expired"},"error":{"status":410,"code":"render_expired",` +
	`"title":"Gone","detail":"The render's retention ended","type":"urn:skinicon:error:render_expired"}}`

func TestRetentionIsSentAsGivenNullIncludedAndOmittedOtherwise(t *testing.T) {
	var bodies []map[string]any
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		payload, _ := io.ReadAll(r.Body)
		json.Unmarshal(payload, &body)
		bodies = append(bodies, body)
		writeRaw(w, http.StatusOK, `{"meta":{"requestId":"req_test"},"data":{"id":"`+testID+
			`","images":{"front":"`+testImage+`"},"retainUntil":"2026-11-23T13:00:00.000Z"}}`)
	})
	inputs := []RenderRequest{
		{InspectURL: "steam://test", Retention: RetainFor(time.Hour)},
		{InspectURL: "steam://test", Retention: RetainForever()},
		{InspectURL: "steam://test"},
	}
	var kept *Render
	for i, input := range inputs {
		result, err := client.Create(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			kept = result
		}
	}
	if value, ok := bodies[0]["retentionSeconds"]; !ok || value != float64(3600) {
		t.Fatalf("expected 3600, got %v", bodies[0])
	}
	if value, ok := bodies[1]["retentionSeconds"]; !ok || value != nil {
		t.Fatalf("expected null, got %v", bodies[1])
	}
	if _, ok := bodies[2]["retentionSeconds"]; ok {
		t.Fatalf("expected no retentionSeconds, got %v", bodies[2])
	}
	want := time.Date(2026, 11, 23, 13, 0, 0, 0, time.UTC)
	if kept.RetainUntil == nil || !kept.RetainUntil.Equal(want) {
		t.Fatalf("expected retainUntil %v, got %v", want, kept.RetainUntil)
	}
}

func TestRetentionOutsideOneHourToThirtyDaysIsRejectedBeforeSending(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("no request expected")
	})
	for _, d := range []time.Duration{0, time.Hour - time.Second, 30*24*time.Hour + time.Second, time.Hour + time.Millisecond} {
		_, err := client.Create(context.Background(), RenderRequest{InspectURL: "steam://test", Retention: RetainFor(d)})
		sdkError(t, err, "invalid_input")
	}
}

func TestDeleteSendsDeleteAndAcceptsAnEmpty204(t *testing.T) {
	var requests []string
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		w.WriteHeader(http.StatusNoContent)
	})
	if err := client.Delete(context.Background(), testID); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 1 || requests[0] != "DELETE /v1/renders/"+testID {
		t.Fatalf("unexpected requests %v", requests)
	}
}

func TestA410RenderExpiredFailsOnceWithoutARetry(t *testing.T) {
	var calls atomic.Int32
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeRaw(w, http.StatusGone, expiredBody)
	})
	_, err := client.Get(context.Background(), testID)
	if !errors.Is(err, ErrRenderExpired) {
		t.Fatalf("expected ErrRenderExpired, got %v", err)
	}
	failure := sdkError(t, err, "render_expired")
	if failure.StatusCode != http.StatusGone || failure.RequestID != "req_expired" || failure.RenderID != testID {
		t.Fatalf("unexpected error %+v", failure)
	}
	if calls.Load() != 1 {
		t.Fatalf("expected one request, got %d", calls.Load())
	}
}

func TestWaitOnAnExpiredRenderFailsWithErrRenderExpired(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		writeRaw(w, http.StatusOK, `{"meta":{"requestId":"req_test"},"data":{"id":"`+testID+
			`","status":"failed","error":{"code":"render_expired","detail":"The render's retention ended"}}}`)
	})
	_, err := client.Wait(context.Background(), testID)
	if !errors.Is(err, ErrRenderExpired) {
		t.Fatalf("expected ErrRenderExpired, got %v", err)
	}
	if errors.Is(&Error{Code: "render_failed"}, ErrRenderExpired) {
		t.Fatal("another code must not match ErrRenderExpired")
	}
}
