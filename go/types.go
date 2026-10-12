// Package skinicon renders CS2 items and waits for their public image URLs.
package skinicon

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

// RenderRequest defaults to all three views in lossless WebP.
type RenderRequest struct {
	InspectURL string `json:"inspectUrl"`
	Views      []View `json:"views,omitempty"`
	Format     Format `json:"format,omitempty"`
}

// Images maps each requested view to its public image URL.
type Images map[View]string

type Failure struct {
	Code   string `json:"code"`
	Detail string `json:"detail"`
}

// Render is a render state. Completed responses have Status "completed" here,
// although the wire response identifies completion by its images field.
type Render struct {
	ID        string   `json:"id"`
	Status    string   `json:"status,omitempty"`
	Images    Images   `json:"images,omitempty"`
	Error     *Failure `json:"error,omitempty"`
	RequestID string   `json:"-"`
}

// SubmitOptions allows retries across separate calls to reuse the same admission.
type SubmitOptions struct{ IdempotencyKey string }

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

func (e *Error) Error() string { return fmt.Sprintf("skinicon: %s: %s", e.Code, e.Detail) }
func (e *Error) Unwrap() error { return e.cause }
