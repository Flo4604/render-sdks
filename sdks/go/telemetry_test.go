package render

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

type telemetryBatch struct {
	Schema  int               `json:"schema"`
	Session string            `json:"session"`
	SDK     map[string]string `json:"sdk"`
	Events  []struct {
		Name       string         `json:"name"`
		SampleRate float64        `json:"sample_rate"`
		Fields     map[string]any `json:"fields"`
	} `json:"events"`
}

// telemetryServer queues the render once, then completes it, and records every request.
type telemetryServer struct {
	mu              sync.Mutex
	renders         []http.Header
	batches         []telemetryBatch
	telemetryStatus int
	fail            bool
}

func (s *telemetryServer) client(t *testing.T, config Config) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if r.URL.Path == "/v1/telemetry/sdk" {
			var batch telemetryBatch
			body, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(body, &batch); err != nil {
				t.Errorf("telemetry body: %v", err)
			}
			if r.Header.Get("Authorization") != "Bearer test-key" || strings.Contains(string(body), "test-key") {
				t.Errorf("telemetry must authenticate with the key and never carry it")
			}
			s.batches = append(s.batches, batch)
			status := s.telemetryStatus
			if status == 0 {
				status = http.StatusAccepted
			}
			w.WriteHeader(status)
			return
		}
		s.renders = append(s.renders, r.Header.Clone())
		if s.fail {
			w.Header().Set("X-Request-Id", "req_failed")
			w.WriteHeader(http.StatusUnprocessableEntity)
			w.Write([]byte(`{"meta":{"requestId":"req_failed"},"error":{"code":"unsupported_item","detail":"x"}}`))
			return
		}
		if r.Method == http.MethodPost {
			w.Header().Set("X-Request-Id", "req_submit")
			w.Header().Set("X-Trace-Id", strings.Repeat("a", 32))
			w.Header().Set("X-Render-Cache", "miss")
			w.Header().Set("Server-Timing", "app;dur=1890.25")
			w.WriteHeader(http.StatusAccepted)
			writeResult(w, fixture("queued"))
			return
		}
		w.Header().Set("Server-Timing", "app;dur=3.5")
		writeResult(w, fixture("completed"))
	}))
	t.Cleanup(server.Close)
	config.APIKey = "test-key"
	config.BaseURL = server.URL
	client, err := NewClient(config)
	if err != nil {
		t.Fatal(err)
	}
	client.sleep = func(ctx context.Context, _ time.Duration) error { return ctx.Err() }
	return client
}

func (s *telemetryServer) snapshot() ([]http.Header, []telemetryBatch) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]http.Header(nil), s.renders...), append([]telemetryBatch(nil), s.batches...)
}

func TestRequestsNameTheSDKAndShareOneTracePerCall(t *testing.T) {
	server := &telemetryServer{}
	client := server.client(t, Config{DisableTelemetry: true})
	for range 2 {
		if _, err := client.Render(context.Background(), testInput); err != nil {
			t.Fatal(err)
		}
	}
	renders, _ := server.snapshot()
	agent := regexp.MustCompile(`^medalbot-render-go/` + regexp.QuoteMeta(Version) + ` \(go/[^;]+; [a-z0-9]+\)$`)
	traceparent := regexp.MustCompile(`^00-([0-9a-f]{32})-[0-9a-f]{16}-01$`)
	var traces, parents []string
	for _, headers := range renders {
		if !agent.MatchString(headers.Get("User-Agent")) || headers.Get("X-Medalbot-SDK") != "go/"+Version {
			t.Fatalf("identity headers: %q %q", headers.Get("User-Agent"), headers.Get("X-Medalbot-SDK"))
		}
		match := traceparent.FindStringSubmatch(headers.Get("Traceparent"))
		if match == nil {
			t.Fatalf("traceparent %q", headers.Get("Traceparent"))
		}
		traces = append(traces, match[1])
		parents = append(parents, match[0])
	}
	if traces[0] != traces[1] || parents[0] == parents[1] || traces[0] == traces[2] {
		t.Fatalf("submit and poll share a trace with their own spans, calls do not: %v", parents)
	}
	if Version == "" || strings.ContainsAny(Version, " \n") {
		t.Fatalf("version %q", Version)
	}
}

func TestRenderReportsTimingsServerIDsAndCounts(t *testing.T) {
	server := &telemetryServer{}
	client := server.client(t, Config{TelemetrySampleRate: 1})
	if _, err := client.Render(context.Background(), RenderRequest{InspectURL: "steam://test", Views: []View{Front}}); err != nil {
		t.Fatal(err)
	}
	client.FlushTelemetry(context.Background())
	renders, batches := server.snapshot()
	if len(batches) != 1 || len(batches[0].Events) != 1 {
		t.Fatalf("batches %+v", batches)
	}
	batch := batches[0]
	if batch.Schema != 1 || len(batch.Session) != 16 || batch.SDK["name"] != "go" || batch.SDK["version"] != Version {
		t.Fatalf("batch %+v", batch)
	}
	event := batch.Events[0]
	if event.Name != "sdk_call" || event.SampleRate != 1 {
		t.Fatalf("event %+v", event)
	}
	want := map[string]any{
		"op": "render", "outcome": "ok", "views": 1.0, "requests": 2.0, "polls": 1.0, "retries": 0.0,
		"server_ms": 1894.0, "request_id": "req_submit", "server_trace_id": strings.Repeat("a", 32),
		"cache": "miss", "render_id": testID, "inflight": 0.0, "status": 200.0,
		"trace_id": strings.Split(renders[0].Get("Traceparent"), "-")[1],
	}
	for name, value := range want {
		if event.Fields[name] != value {
			t.Errorf("%s = %v, want %v", name, event.Fields[name], value)
		}
	}
	for _, name := range []string{"total_ms", "http_ms", "ttfb_ms", "connect_ms"} {
		if _, ok := event.Fields[name].(float64); !ok {
			t.Errorf("%s missing: %v", name, event.Fields)
		}
	}
	if event.Fields["connections"] != 1.0 {
		t.Errorf("one new connection serves both requests: %v", event.Fields["connections"])
	}
}

func TestFailedCallIsAlwaysReported(t *testing.T) {
	server := &telemetryServer{fail: true}
	client := server.client(t, Config{TelemetrySampleRate: 0.000001})
	if _, err := client.Render(context.Background(), testInput); err == nil {
		t.Fatal("expected an error")
	}
	client.FlushTelemetry(context.Background())
	_, batches := server.snapshot()
	if len(batches) != 1 {
		t.Fatalf("batches %+v", batches)
	}
	event := batches[0].Events[0]
	if event.SampleRate != 1 || event.Fields["outcome"] != "error" || event.Fields["code"] != "unsupported_item" || event.Fields["status"] != 422.0 || event.Fields["request_id"] != "req_failed" {
		t.Fatalf("event %+v", event)
	}
}

func TestTelemetryOffSendsNothing(t *testing.T) {
	server := &telemetryServer{}
	off := server.client(t, Config{DisableTelemetry: true, TelemetrySampleRate: 1})
	off.Render(context.Background(), testInput)
	off.FlushTelemetry(context.Background())
	t.Setenv("MEDALBOT_TELEMETRY", "0")
	env := server.client(t, Config{TelemetrySampleRate: 1})
	env.Render(context.Background(), testInput)
	env.FlushTelemetry(context.Background())
	if _, batches := server.snapshot(); len(batches) != 0 {
		t.Fatalf("batches %+v", batches)
	}
}

func TestRefusedReportStopsReporting(t *testing.T) {
	server := &telemetryServer{telemetryStatus: http.StatusNotFound}
	client := server.client(t, Config{TelemetrySampleRate: 1})
	for range 2 {
		if _, err := client.Render(context.Background(), testInput); err != nil {
			t.Fatal(err)
		}
		client.FlushTelemetry(context.Background())
	}
	if _, batches := server.snapshot(); len(batches) != 1 {
		t.Fatalf("a 404 stops reports: %d batches", len(batches))
	}
}
