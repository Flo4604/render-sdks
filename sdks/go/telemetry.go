package render

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	mrand "math/rand"
	"net/http"
	"net/http/httptrace"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Identification headers and call timings. Every request names the SDK and carries a W3C
// traceparent whose trace id is fixed for one call. Unless Config.DisableTelemetry is set,
// each finished call becomes one sdk_call event; events go to POST /v1/telemetry/sdk in
// batches, and a failed send is dropped. Nothing here returns an error to the caller or
// delays a render.

//go:embed VERSION
var versionFile string

// Version is this module's release version.
var Version = strings.TrimSpace(versionFile)

var (
	goRuntime = "go/" + strings.TrimPrefix(runtime.Version(), "go")
	userAgent = "medalbot-render-go/" + Version + " (" + goRuntime + "; " + runtime.GOOS + ")"
	sdkHeader = "go/" + Version
)

const (
	defaultSampleRate = 0.25
	// Calls at least this slow, and every failed call, are always reported, so the sample
	// never hides the calls a customer complains about.
	slowCall    = 3 * time.Second
	maxBatch    = 100
	maxBuffered = 1000
	flushAfter  = 10 * time.Second
)

var stableCode = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)

func randomHex(n int) string {
	buffer := make([]byte, n)
	_, _ = rand.Read(buffer)
	return hex.EncodeToString(buffer)
}

// call records what one operation observed. HTTP time covers each attempt from send to the
// end of the body; the sleeps between polls and between retries are counted apart from it.
// serverMs sums the API's own Server-Timing over every response, so network and gateway
// time is httpMs - serverMs.
type call struct {
	mu            sync.Mutex
	op            string
	traceID       string
	started       time.Time
	inflight      int
	views         int
	httpMs        float64
	serverMs      float64
	dnsMs         float64
	connectMs     float64
	tlsMs         float64
	connections   int
	ttfbMs        float64
	requests      int
	retries       int
	backoffMs     float64
	polls         int
	pollWaitMs    float64
	status        int
	requestID     string
	serverTraceID string
	cache         string
	renderID      string
}

type callKey struct{}

func callFrom(ctx context.Context) *call {
	if value, ok := ctx.Value(callKey{}).(*call); ok {
		return value
	}
	return nil
}

func (c *call) traceparent() string {
	return "00-" + c.traceID + "-" + randomHex(8) + "-01"
}

func milliseconds(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

// clientTrace times DNS, new connections, TLS and the first response byte of one attempt.
func (c *call) clientTrace(started time.Time) *httptrace.ClientTrace {
	var dnsStart, connectStart, tlsStart time.Time
	return &httptrace.ClientTrace{
		DNSStart: func(httptrace.DNSStartInfo) { c.mu.Lock(); dnsStart = time.Now(); c.mu.Unlock() },
		DNSDone: func(httptrace.DNSDoneInfo) {
			c.mu.Lock()
			c.dnsMs += milliseconds(time.Since(dnsStart))
			c.mu.Unlock()
		},
		ConnectStart: func(string, string) { c.mu.Lock(); connectStart = time.Now(); c.mu.Unlock() },
		ConnectDone: func(string, string, error) {
			c.mu.Lock()
			c.connectMs += milliseconds(time.Since(connectStart))
			c.connections++
			c.mu.Unlock()
		},
		TLSHandshakeStart: func() { c.mu.Lock(); tlsStart = time.Now(); c.mu.Unlock() },
		TLSHandshakeDone: func(tls.ConnectionState, error) {
			c.mu.Lock()
			c.tlsMs += milliseconds(time.Since(tlsStart))
			c.mu.Unlock()
		},
		GotFirstResponseByte: func() {
			c.mu.Lock()
			if c.ttfbMs == 0 {
				c.ttfbMs = milliseconds(time.Since(started))
			}
			c.mu.Unlock()
		},
	}
}

var serverTiming = regexp.MustCompile(`(?:^|,)\s*app;dur=([\d.]+)`)

func (c *call) response(response *http.Response, started time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests++
	c.status = response.StatusCode
	c.httpMs += milliseconds(time.Since(started))
	if match := serverTiming.FindStringSubmatch(response.Header.Get("Server-Timing")); match != nil {
		if value, err := strconv.ParseFloat(match[1], 64); err == nil {
			c.serverMs += value
		}
	}
	if c.requestID == "" {
		c.requestID = response.Header.Get("X-Request-Id")
	}
	if c.serverTraceID == "" {
		c.serverTraceID = response.Header.Get("X-Trace-Id")
	}
	if c.cache == "" {
		c.cache = response.Header.Get("X-Render-Cache")
	}
}

func (c *call) failure(started time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests++
	c.httpMs += milliseconds(time.Since(started))
}

func (c *call) add(field *float64, d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	*field += milliseconds(d)
}

func truncate(value string, n int) string {
	if len(value) > n {
		return value[:n]
	}
	return value
}

func (c *call) fields(err error) map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	round := func(v float64) int64 { return int64(math.Round(v)) }
	fields := map[string]any{
		"op":           c.op,
		"outcome":      "ok",
		"total_ms":     round(milliseconds(time.Since(c.started))),
		"inflight":     c.inflight,
		"status":       c.status,
		"trace_id":     c.traceID,
		"http_ms":      round(c.httpMs),
		"server_ms":    round(c.serverMs),
		"requests":     c.requests,
		"retries":      c.retries,
		"backoff_ms":   round(c.backoffMs),
		"polls":        c.polls,
		"poll_wait_ms": round(c.pollWaitMs),
	}
	if err != nil {
		fields["outcome"] = "error"
		fields["code"] = errorCode(err)
	}
	if c.connections > 0 {
		fields["connections"] = c.connections
		fields["dns_ms"] = round(c.dnsMs)
		fields["connect_ms"] = round(c.connectMs)
		fields["tls_ms"] = round(c.tlsMs)
	}
	if c.ttfbMs > 0 {
		fields["ttfb_ms"] = round(c.ttfbMs)
	}
	if c.views > 0 {
		fields["views"] = c.views
	}
	for name, value := range map[string]string{
		"request_id":      truncate(c.requestID, 64),
		"server_trace_id": truncate(c.serverTraceID, 64),
		"cache":           truncate(c.cache, 16),
		"render_id":       c.renderID,
	} {
		if value != "" {
			fields[name] = value
		}
	}
	return fields
}

func errorCode(err error) string {
	var typed *Error
	if errors.As(err, &typed) {
		code := strings.ToLower(typed.Code)
		if stableCode.MatchString(code) {
			return code
		}
		return "other"
	}
	return "client_error"
}

type event struct {
	Name       string         `json:"name"`
	T          int64          `json:"t"`
	SampleRate float64        `json:"sample_rate"`
	Fields     map[string]any `json:"fields"`
}

// reporter buffers events and sends them in batches with the client's own HTTP client.
type reporter struct {
	mu      sync.Mutex
	client  *Client
	rate    float64
	random  func() float64
	buffer  []event
	timer   *time.Timer
	sending sync.WaitGroup
	stopped bool
	session string
}

func (r *reporter) record(c *call, err error) {
	fields := c.fields(err)
	always := err != nil || fields["total_ms"].(int64) >= slowCall.Milliseconds()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped || len(r.buffer) >= maxBuffered {
		return
	}
	if !always && r.random() >= r.rate {
		return
	}
	rate := r.rate
	if always {
		rate = 1
	}
	r.buffer = append(r.buffer, event{Name: "sdk_call", T: time.Now().UnixMilli(), SampleRate: rate, Fields: fields})
	if len(r.buffer) >= maxBatch {
		r.sendLocked()
	} else if r.timer == nil {
		r.timer = time.AfterFunc(flushAfter, func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.sendLocked()
		})
	}
}

// sendLocked starts one background send per batch of buffered events.
func (r *reporter) sendLocked() {
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
	for len(r.buffer) > 0 && !r.stopped {
		size := min(maxBatch, len(r.buffer))
		events := r.buffer[:size:size]
		r.buffer = r.buffer[size:]
		r.sending.Add(1)
		go func() {
			defer r.sending.Done()
			r.send(events)
		}()
	}
}

func (r *reporter) send(events []event) {
	body, err := json.Marshal(map[string]any{
		"schema":  1,
		"session": r.session,
		"sdk":     map[string]string{"name": "go", "version": Version, "runtime": goRuntime, "os": runtime.GOOS},
		"events":  events,
	})
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.client.baseURL+"/v1/telemetry/sdk", bytes.NewReader(body))
	if err != nil {
		return
	}
	request.Header.Set("Authorization", "Bearer "+r.client.apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("X-Medalbot-SDK", sdkHeader)
	response, err := r.client.http.Do(request)
	if err != nil {
		return
	}
	response.Body.Close()
	switch response.StatusCode {
	case 401, 403, 404, 410:
		// No route, or a key the route refuses: stop reporting for this client.
		r.mu.Lock()
		r.stopped = true
		r.buffer = nil
		r.mu.Unlock()
	}
}

// flush sends every buffered event and waits for the sends or ctx, whichever ends first.
func (r *reporter) flush(ctx context.Context) {
	r.mu.Lock()
	r.sendLocked()
	r.mu.Unlock()
	done := make(chan struct{})
	go func() {
		r.sending.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// FlushTelemetry sends buffered call timings and waits until they are sent or ctx ends.
// A program that exits soon after its last render can call it first; the client sends
// on its own every ten seconds otherwise.
func (c *Client) FlushTelemetry(ctx context.Context) {
	if c.reporter != nil {
		c.reporter.flush(ctx)
	}
}

// observe runs one public operation as a call: it puts the call in the context so every
// request shares its trace, and reports the call when it ends.
func (c *Client) observe(ctx context.Context, op string, views int) (context.Context, func(error)) {
	c.mu.Lock()
	inflight := c.inflight
	c.inflight++
	c.mu.Unlock()
	current := &call{op: op, traceID: randomHex(16), started: time.Now(), inflight: inflight, views: views}
	return context.WithValue(ctx, callKey{}, current), func(err error) {
		c.mu.Lock()
		c.inflight--
		c.mu.Unlock()
		if c.reporter != nil {
			c.reporter.record(current, err)
		}
	}
}

var getenv = os.Getenv

func newReporter(c *Client, config Config) *reporter {
	if config.DisableTelemetry {
		return nil
	}
	switch strings.ToLower(strings.TrimSpace(getenv("MEDALBOT_TELEMETRY"))) {
	case "0", "false", "off":
		return nil
	}
	rate := config.TelemetrySampleRate
	if rate == 0 {
		rate = defaultSampleRate
	}
	if !(rate > 0) {
		return nil
	}
	return &reporter{client: c, rate: min(rate, 1), random: mrand.Float64, session: randomHex(8)}
}
