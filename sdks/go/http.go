package render

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptrace"
	"strconv"
	"strings"
	"time"
)

const maxResponseBytes = 1 << 20

func (c *Client) request(ctx context.Context, method, path string, body []byte, headers http.Header) (*Render, error) {
	current := callFrom(ctx)
	if current == nil {
		current = &call{traceID: randomHex(16), started: time.Now()}
	}
	result, err := c.attempts(ctx, method, path, body, headers, current)
	if err == nil {
		current.mu.Lock()
		current.renderID = result.ID
		current.mu.Unlock()
	}
	return result, err
}

// backoff sleeps before a retry and counts it on the call.
func (c *Client) backoff(ctx context.Context, current *call, delay time.Duration) error {
	started := time.Now()
	err := c.sleep(ctx, delay)
	current.mu.Lock()
	current.retries++
	current.backoffMs += milliseconds(time.Since(started))
	current.mu.Unlock()
	return err
}

func (c *Client) attempts(ctx context.Context, method, path string, body []byte, headers http.Header, current *call) (*Render, error) {
	for attempt := 0; attempt < 4; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, contextError(err)
		}
		started := time.Now()
		request, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, current.clientTrace(started)), method, c.baseURL+path, bytes.NewReader(body))
		if err != nil {
			return nil, invalidInput("Cannot build request URL")
		}
		request.Header.Set("Authorization", "Bearer "+c.apiKey)
		request.Header.Set("Accept", "application/json")
		request.Header.Set("User-Agent", userAgent)
		request.Header.Set("X-Medalbot-SDK", sdkHeader)
		request.Header.Set("Traceparent", current.traceparent())
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		for key, values := range headers {
			request.Header[key] = values
		}
		response, err := c.http.Do(request)
		if err != nil {
			current.failure(started)
			if ctx.Err() != nil {
				return nil, contextError(ctx.Err())
			}
			if attempt == 3 {
				return nil, &Error{Code: "network_error", Detail: "Could not complete the HTTP request", cause: err}
			}
			if err := c.backoff(ctx, current, retryDelay(attempt, "", time.Now())); err != nil {
				return nil, contextError(err)
			}
			continue
		}
		if retryable(response.StatusCode) && attempt < 3 {
			response.Body.Close()
			current.response(response, started)
			if err := c.backoff(ctx, current, retryDelay(attempt, response.Header.Get("Retry-After"), time.Now())); err != nil {
				failure := contextError(err)
				failure.RequestID = response.Header.Get("X-Request-Id")
				return nil, failure
			}
			continue
		}
		payload, readErr := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
		response.Body.Close()
		current.response(response, started)
		if ctx.Err() != nil {
			failure := contextError(ctx.Err())
			failure.RequestID = response.Header.Get("X-Request-Id")
			return nil, failure
		}
		if readErr != nil {
			if attempt < 3 {
				if err := c.backoff(ctx, current, retryDelay(attempt, "", time.Now())); err != nil {
					return nil, contextError(err)
				}
				continue
			}
			return nil, &Error{Code: "network_error", Detail: "Could not read the HTTP response", RequestID: response.Header.Get("X-Request-Id"), cause: readErr}
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, responseError(response, payload)
		}
		if len(payload) > maxResponseBytes {
			return nil, &Error{Code: "invalid_response", Detail: "Response exceeds 1 MiB", RequestID: response.Header.Get("X-Request-Id")}
		}
		var envelope struct {
			Meta struct {
				RequestID string `json:"requestId"`
			} `json:"meta"`
			Data Render `json:"data"`
		}
		if err := json.Unmarshal(payload, &envelope); err != nil {
			return nil, &Error{Code: "invalid_response", Detail: "Response is not a valid render JSON object", RequestID: response.Header.Get("X-Request-Id"), cause: err}
		}
		result := envelope.Data
		result.RequestID = envelope.Meta.RequestID
		if result.RequestID == "" {
			return nil, &Error{Code: "invalid_response", Detail: "Response has no request ID", RequestID: response.Header.Get("X-Request-Id")}
		}
		if result.Status == "" && result.Images != nil {
			result.Status = "completed"
		}
		if err := validateRender(&result); err != nil {
			failure := enrich(err, "", "").(*Error)
			failure.RequestID = result.RequestID
			return nil, failure
		}
		return &result, nil
	}
	panic("unreachable retry state")
}

func retryable(status int) bool {
	return status == 429 || status == 502 || status == 503 || status == 504
}
func retryDelay(attempt int, header string, now time.Time) time.Duration {
	delay := (200 * time.Millisecond) << attempt
	header = strings.TrimSpace(header)
	if seconds, err := strconv.ParseInt(header, 10, 64); err == nil && seconds > 0 {
		// Cap before conversion to avoid overflowing a duration. The operation deadline
		// still ends the wait if Retry-After extends beyond the caller's budget.
		delay = max(delay, time.Duration(min(seconds, int64(1<<32)))*time.Second)
	} else if date, err := http.ParseTime(header); err == nil {
		delay = max(delay, date.Sub(now))
	}
	return delay + time.Duration(rand.Intn(100))*time.Millisecond
}

func responseError(response *http.Response, payload []byte) *Error {
	failure := &Error{Code: "http_error", Detail: fmt.Sprintf("HTTP %d %s", response.StatusCode, http.StatusText(response.StatusCode)), StatusCode: response.StatusCode, RequestID: response.Header.Get("X-Request-Id")}
	if len(payload) > maxResponseBytes {
		return failure
	}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Detail  string `json:"detail"`
			Message string `json:"message"`
		} `json:"error"`
		Meta struct {
			RequestID string `json:"requestId"`
		} `json:"meta"`
	}
	if json.Unmarshal(payload, &body) != nil {
		return failure
	}
	if body.Error.Code != "" {
		failure.Code = body.Error.Code
	}
	if body.Error.Detail != "" {
		failure.Detail = body.Error.Detail
	} else if body.Error.Message != "" {
		failure.Detail = body.Error.Message
	}
	if body.Meta.RequestID != "" {
		failure.RequestID = body.Meta.RequestID
	}
	return failure
}
