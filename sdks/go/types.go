// Package render renders CS2 items and waits for their public image URLs.
package render

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

const DefaultBaseURL = "https://render.medalbot.cc"

// Config configures a reusable client. Zero timeout uses 120 seconds per operation.
type Config struct {
	APIKey     string
	BaseURL    string
	HTTPClient *http.Client
	Timeout    time.Duration
	// DisableTelemetry stops the call timings this client sends to the API. The
	// MEDALBOT_TELEMETRY=0 environment variable does the same for every client.
	DisableTelemetry bool
	// TelemetrySampleRate is the share of fast, successful calls reported; zero means 0.25.
	// Failed calls and calls of three seconds or more are always reported.
	TelemetrySampleRate float64
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

// Framing picks the camera for a gun that has a charm camera.
type Framing string

const (
	// FramingAuto uses the charm camera only when the item has a charm.
	FramingAuto Framing = "auto"
	// FramingCharm uses the charm camera for every item of the gun, with or without a charm.
	FramingCharm Framing = "charm"
	// FramingStandard always uses the gun's normal camera, even when the item has a charm.
	FramingStandard Framing = "standard"
)

// RenderRequest defaults to all three views in lossless WebP.
type RenderRequest struct {
	InspectURL string `json:"inspectUrl"`
	Views      []View `json:"views,omitempty"`
	Format     Format `json:"format,omitempty"`
	// Appearance selects lighting. The zero value preserves the default rendering.
	Appearance Appearance `json:"appearance,omitempty"`
	// Framing selects the camera. The zero value behaves as FramingAuto.
	Framing Framing `json:"framing,omitempty"`
	// StatTrak overrides the displayed counter. Nil preserves the item's counter.
	StatTrak *int `json:"statTrak,omitempty"`
	// Retention sets how long the API keeps the images. Nil uses the API key's default,
	// which keeps them forever unless the key sets one.
	Retention *Retention `json:"retentionSeconds,omitempty"`
}

// Retention is how long the API keeps a render's images and item data. Build it with
// RetainFor or RetainForever.
type Retention struct {
	duration time.Duration
	forever  bool
}

// RetainFor keeps the images for d, a whole number of seconds from one hour to 30 days.
func RetainFor(d time.Duration) *Retention { return &Retention{duration: d} }

// RetainForever keeps the images forever, even when the API key has a default retention.
func RetainForever() *Retention { return &Retention{forever: true} }

func (r Retention) valid() bool {
	if r.forever {
		return true
	}
	return r.duration%time.Second == 0 && r.duration >= time.Hour && r.duration <= 30*24*time.Hour
}

// MarshalJSON writes the seconds, or null for RetainForever.
func (r Retention) MarshalJSON() ([]byte, error) {
	if r.forever {
		return []byte("null"), nil
	}
	return strconv.AppendInt(nil, int64(r.duration/time.Second), 10), nil
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
	Links Images `json:"links,omitempty"`
	// RetainUntil is when the API stops keeping the images. Nil for a render kept
	// forever, and when links are off.
	RetainUntil *time.Time `json:"retainUntil,omitempty"`
	Error       *Failure   `json:"error,omitempty"`
	RequestID   string     `json:"-"`
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

// ErrRenderExpired matches, through errors.Is, an *Error for a render whose retention
// ended or that was deleted. Retrying never succeeds; submit again with a new
// idempotency key to render the item again.
var ErrRenderExpired = errors.New("render: render expired")

func (e *Error) Error() string { return fmt.Sprintf("render: %s: %s", e.Code, e.Detail) }
func (e *Error) Unwrap() error { return e.cause }
func (e *Error) Is(target error) bool {
	return target == ErrRenderExpired && e.Code == "render_expired"
}
