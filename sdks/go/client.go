package render

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var renderIDPattern = regexp.MustCompile(`^rnd_(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[a-f0-9]{32})$`)

// Client is safe for concurrent use. It never cancels shared work on the server.
type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
	timeout time.Duration
	sleep   func(context.Context, time.Duration) error
}

func NewClient(config Config) (*Client, error) {
	if config.APIKey == "" || strings.ContainsAny(config.APIKey, "\r\n") {
		return nil, invalidInput("API key is required and cannot contain newlines")
	}
	if config.BaseURL == "" {
		config.BaseURL = DefaultBaseURL
	}
	u, err := url.Parse(config.BaseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, invalidInput("BaseURL must be an HTTP or HTTPS URL without credentials, query, or fragment")
	}
	if config.Timeout < 0 {
		return nil, invalidInput("Timeout must not be negative")
	}
	if config.Timeout == 0 {
		config.Timeout = 120 * time.Second
	}
	transport := http.DefaultClient
	if config.HTTPClient != nil {
		transport = config.HTTPClient
	}
	copied := *transport
	// A render API never needs redirects; do not forward credentials to another host.
	copied.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{strings.TrimRight(config.BaseURL, "/"), config.APIKey, &copied, config.Timeout, sleep}, nil
}

// Render returns finished images whether the request is cached or needs GPU work.
// The operation timeout covers submission, retries, and polling together.
func (c *Client) Render(ctx context.Context, input RenderRequest, options ...SubmitOptions) (Images, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	result, key, err := c.submit(ctx, input, true, options)
	if err != nil {
		return nil, enrich(err, "", key)
	}
	images, err := c.poll(ctx, result)
	if err != nil {
		return nil, enrich(err, result.ID, key)
	}
	views := input.Views
	if len(views) == 0 {
		views = []View{Preview, Front, Back}
	}
	for _, view := range views {
		if _, ok := images[view]; !ok {
			failure := invalidResponse("Completed render is missing " + string(view))
			failure.RequestID = result.RequestID
			return nil, enrich(failure, result.ID, key)
		}
	}
	return images, nil
}

// Create submits a render without waiting for it to finish.
func (c *Client) Create(ctx context.Context, input RenderRequest, options ...SubmitOptions) (*Render, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	result, key, err := c.submit(ctx, input, false, options)
	return result, enrich(err, "", key)
}

// Get retrieves the current render state.
func (c *Client) Get(ctx context.Context, id string) (*Render, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	result, err := c.get(ctx, id)
	return result, enrich(err, id, "")
}

// Wait resumes a render and returns its images when complete.
func (c *Client) Wait(ctx context.Context, id string) (Images, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	result, err := c.get(ctx, id)
	if err != nil {
		return nil, enrich(err, id, "")
	}
	images, err := c.poll(ctx, result)
	return images, enrich(err, id, "")
}

func (c *Client) submit(ctx context.Context, input RenderRequest, wait bool, options []SubmitOptions) (*Render, string, error) {
	if err := ctx.Err(); err != nil {
		return nil, "", contextError(err)
	}
	if err := validateInput(input); err != nil {
		return nil, "", err
	}
	if len(options) > 1 {
		return nil, "", invalidInput("Provide at most one SubmitOptions value")
	}
	key := ""
	if len(options) == 1 {
		key = options[0].IdempotencyKey
	}
	if key == "" {
		var entropy [16]byte
		if _, err := rand.Read(entropy[:]); err != nil {
			return nil, "", &Error{Code: "random_error", Detail: "Cannot generate idempotency key", cause: err}
		}
		key = hex.EncodeToString(entropy[:])
	}
	if len(key) > 128 || strings.IndexFunc(key, func(r rune) bool { return r < 33 || r > 126 }) >= 0 {
		return nil, key, invalidInput("IdempotencyKey must contain 1 to 128 printable ASCII characters without spaces")
	}
	body, err := json.Marshal(input)
	if err != nil {
		return nil, key, err
	}
	headers := http.Header{"Idempotency-Key": {key}}
	if wait {
		headers.Set("Prefer", "wait=10")
	}
	result, err := c.request(ctx, http.MethodPost, "/v1/renders", body, headers)
	return result, key, err
}

func (c *Client) get(ctx context.Context, id string) (*Render, error) {
	if !renderIDPattern.MatchString(id) {
		return nil, invalidInput("Invalid render ID")
	}
	result, err := c.request(ctx, http.MethodGet, "/v1/renders/"+id, nil, nil)
	if err == nil && result.ID != id {
		return nil, invalidResponse("Response render ID does not match the request")
	}
	return result, err
}

func (c *Client) poll(ctx context.Context, result *Render) (Images, error) {
	interval := 500 * time.Millisecond
	for {
		if err := ctx.Err(); err != nil {
			failure := contextError(err)
			failure.RequestID = result.RequestID
			return nil, failure
		}
		switch result.Status {
		case "completed":
			return result.Images, nil
		case "failed":
			return nil, &Error{Code: result.Error.Code, Detail: result.Error.Detail, RenderID: result.ID, RequestID: result.RequestID}
		}
		if err := c.sleep(ctx, interval); err != nil {
			failure := contextError(err)
			failure.RequestID = result.RequestID
			return nil, failure
		}
		next, err := c.get(ctx, result.ID)
		if err != nil {
			return nil, err
		}
		result = next
		interval = min(2*time.Second, interval*3/2)
	}
}

func validateInput(input RenderRequest) error {
	if input.InspectURL == "" || len([]rune(input.InspectURL)) > 32768 {
		return invalidInput("InspectURL must contain 1 to 32768 characters")
	}
	if input.Format != "" && input.Format != PNG && input.Format != WebP {
		return invalidInput("Format must be png or webp")
	}
	if input.Appearance != "" && input.Appearance != AppearanceDefault && input.Appearance != AppearancePattern {
		return invalidInput("Appearance must be default or pattern")
	}
	if input.StatTrak != nil && (*input.StatTrak < 0 || *input.StatTrak > 999999) {
		return invalidInput("StatTrak must be an integer from 0 to 999999")
	}
	seen := make(map[View]bool)
	for _, view := range input.Views {
		if !validView(view) || seen[view] {
			return invalidInput("Views must contain unique preview, front, or back values")
		}
		seen[view] = true
	}
	return nil
}

func validView(view View) bool { return view == Preview || view == Front || view == Back }

func validateRender(result *Render) error {
	if !renderIDPattern.MatchString(result.ID) {
		return invalidResponse("Response has an invalid render ID")
	}
	switch result.Status {
	case "queued", "rendering", "processing", "completed":
	case "failed":
		if result.Error == nil || result.Error.Code == "" {
			return invalidResponse("Failed render has no error")
		}
	default:
		return invalidResponse("Response has an invalid render status")
	}
	if result.Status == "completed" && len(result.Images) == 0 {
		return invalidResponse("Completed render has no images")
	}
	for view, imageURL := range result.Images {
		u, err := url.Parse(imageURL)
		if !validView(view) || err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
			return invalidResponse(fmt.Sprintf("Response has an invalid %s image URL", view))
		}
	}
	return nil
}

func invalidInput(detail string) *Error    { return &Error{Code: "invalid_input", Detail: detail} }
func invalidResponse(detail string) *Error { return &Error{Code: "invalid_response", Detail: detail} }
func contextError(err error) *Error {
	code, detail := "canceled", "Caller stopped waiting; shared server work is not canceled"
	if errors.Is(err, context.DeadlineExceeded) {
		code, detail = "wait_timeout", "Deadline exceeded; resume with Wait when RenderID is available, or retry with the same idempotency key"
	}
	return &Error{Code: code, Detail: detail, cause: err}
}
func enrich(err error, id, key string) error {
	if err == nil {
		return nil
	}
	var e *Error
	if !errors.As(err, &e) {
		e = &Error{Code: "client_error", Detail: err.Error(), cause: err}
	}
	copied := *e
	if copied.RenderID == "" {
		copied.RenderID = id
	}
	if copied.IdempotencyKey == "" {
		copied.IdempotencyKey = key
	}
	return &copied
}
func sleep(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return ctx.Err()
	}
}
