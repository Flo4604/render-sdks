// Package render renders CS2 items and waits for their public image URLs.
package render

import (
	"fmt"
	"net/http"
	"time"
)

const DefaultBaseURL = "https://render.medalbot.cc"

// Config configures a reusable client. Zero timeout uses 120 seconds per operation.
type Config struct {
	APIKey     string
	BaseURL    string
	HTTPClient *http.Client
	Timeout    time.Duration
}

type View string

const (
	Preview View = "preview"
	Front   View = "front"
	Back    View = "back"
)

type Format string

const (
	WebP Format = "webp"
	PNG  Format = "png"
)

type Appearance string

const (
	AppearanceDefault Appearance = "default"
	AppearancePattern Appearance = "pattern"
)

// RenderRequest defaults to all three views in lossless WebP.
type RenderRequest struct {
	InspectURL string `json:"inspectUrl"`
	Views      []View `json:"views,omitempty"`
	Format     Format `json:"format,omitempty"`
	// Appearance selects lighting. The zero value preserves the default rendering.
	Appearance Appearance `json:"appearance,omitempty"`
	// StatTrak overrides the displayed counter. Nil preserves the item's counter.
	StatTrak *int `json:"statTrak,omitempty"`
}

// Images maps each requested view to its public image URL.
type Images map[View]string

type Failure struct {
	Code   string `json:"code"`
	Detail string `json:"detail"`
}

// Render is a render state. Completed responses have Status "completed" here,
// although the wire response identifies completion by its images field.
// Decoding ignores response fields this version does not know.
type Render struct {
	ID     string `json:"id"`
	Status string `json:"status,omitempty"`
	Images Images `json:"images,omitempty"`
	// Links maps each requested view to a URL that is final at admission. A finished
	// view's link equals its image URL. Pending and completed states carry it when the
	// request asks for links, or by default once the API enables links. Failed states
	// have none. Completion still depends on Images, not Links.
	Links     Images   `json:"links,omitempty"`
	Error     *Failure `json:"error,omitempty"`
	RequestID string   `json:"-"`
}

// SubmitOptions allows retries across separate calls to reuse the same admission.
// Links sends Prefer: links, so the returned state carries Links. Once the API
// returns links by default, Links changes nothing.
type SubmitOptions struct {
	IdempotencyKey string
	Links          bool
}

// GetOptions configures Get. Links sends Prefer: links, as in SubmitOptions.
type GetOptions struct{ Links bool }

// Error preserves identifiers needed to inspect or resume a render.
// Errors caused by cancellation or deadlines support errors.Is.
type Error struct {
	Code           string
	Detail         string
	StatusCode     int
	RenderID       string
	RequestID      string
	IdempotencyKey string
	cause          error
}

func (e *Error) Error() string { return fmt.Sprintf("render: %s: %s", e.Code, e.Detail) }
func (e *Error) Unwrap() error { return e.cause }
