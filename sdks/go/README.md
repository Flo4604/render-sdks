# Go SDK

`Render` returns finished images for both cached requests and new GPU renders. It sends `Prefer: wait=10`, then polls automatically until the images are ready.

The module uses Go 1.22 or later and has no external dependencies. Install the public module:

```bash
go get github.com/Flo4604/render-sdks/sdks/go@v0.1.6
```

```go
import (
    "fmt"
    "os"

    render "github.com/Flo4604/render-sdks/sdks/go"
)

client, err := render.NewClient(render.Config{
    APIKey: os.Getenv("RENDER_API_KEY"),
})
if err != nil {
    return err
}

images, err := client.Render(ctx, render.RenderRequest{
    InspectURL: "steam://...",
})
if err != nil {
    return err
}
fmt.Println(images[render.Front])
```

Use an existing `context.Context` as `ctx`, or pass `context.Background()`. The default API URL is `https://render.medalbot.cc`. Omit `Views` for preview, front, and back. Omit `Format` for lossless WebP. To request one PNG:

```go
images, err := client.Render(ctx, render.RenderRequest{
    InspectURL: inspectURL,
    Views:      []render.View{render.Front},
    Format:     render.PNG,
})
```

`Config.Timeout` defaults to 120 seconds and covers submission, retries, and polling together. A shorter context deadline takes precedence. Canceling the context stops the local wait and leaves shared GPU work running. Polls start at 500 milliseconds and increase to a maximum of 2 seconds.

## Telemetry

The client reports how long each call took on your side, so slow renders can be traced to DNS, connecting, the network, polling, retries or the calling process. Turn it off when you create the client:

```go
client, err := render.NewClient(render.Config{
    APIKey:           os.Getenv("RENDER_API_KEY"),
    DisableTelemetry: true,
})
```

`TelemetrySampleRate: 0.1` keeps it on and reports a tenth of fast, successful calls; zero means the default, a quarter. Failed calls and calls of three seconds or more are always reported. Setting `MEDALBOT_TELEMETRY=0` in the environment turns it off for every client in the process.

Each report covers one call: time to first byte, total time, the API's own `Server-Timing`, retries and their backoff, polls and the time between them, the error code, and the server's request ID, plus DNS, connect and TLS time for new connections. It never contains your inspect link, API key or image URLs. Reports go to `POST /v1/telemetry/sdk` on the same API with your key, in batches every ten seconds, and a failed report is dropped without affecting the call. A program that exits right after its last render can call `client.FlushTelemetry(ctx)` first.

Every request also names the SDK in `User-Agent` and `X-Medalbot-SDK` and carries a W3C `traceparent`, whether telemetry is on or off, so a support request can quote one call's trace.

Omit `Appearance` or use `render.AppearanceDefault` to preserve the original lighting. Use `render.AppearancePattern` for the optional pattern lighting:

```go
images, err := client.Render(ctx, render.RenderRequest{
    InspectURL: akInspectURL,
    Appearance: render.AppearancePattern,
})
```

The server supports pattern appearance for AK-47 preview, front, and back images. Omit `Views` to request all three, or provide a subset. Pattern appearance preserves the original preview lighting. Unsupported items return HTTP 422 with code `unsupported_appearance`; the SDK preserves that error. The server determines support, so the SDK does not restrict items or views locally.

Network errors and HTTP 429, 502, 503, and 504 receive at most three retries per request. Retries preserve the submission body and idempotency key. `Retry-After` accepts seconds or an HTTP date; the operation deadline bounds the wait. `Config.HTTPClient` lets you supply a transport for proxies, tracing, or tests. The SDK copies the HTTP client and disables redirects to avoid forwarding credentials.

For recovery, inspect `*render.Error` with `errors.As`. It includes `Code`, `StatusCode`, `RenderID`, `RequestID`, and `IdempotencyKey` when available. Context errors support `errors.Is(err, context.Canceled)` and `errors.Is(err, context.DeadlineExceeded)`.

```go
var renderErr *render.Error
if errors.As(err, &renderErr) && renderErr.Code == "wait_timeout" {
    if renderErr.RenderID != "" {
        images, err = client.Wait(freshContext, renderErr.RenderID)
    } else if renderErr.IdempotencyKey != "" {
        images, err = client.Render(freshContext, request,
            render.SubmitOptions{IdempotencyKey: renderErr.IdempotencyKey})
    }
}
```

Use a fresh context when the original context has expired. `Create` submits without waiting, `Get` reads the current state, and `Wait` resumes an existing render. Low-level states expose `RequestID`; completed states normalize `Status` to `"completed"`. HTTP responses use the `{meta: {requestId}, data}` envelope. `Render` verifies that the completed response includes every requested view.

From this directory, run the example with a key in the environment:

```bash
go run ./examples/render 'steam://...'
go test -race ./...
```

The example prints image URLs as JSON and elapsed time to stderr. It never prints the API key. Public releases use immutable Go module tags. The render service repository remains private.

To override the displayed StatTrak counter, pass a pointer to an integer from 0 to 999999. A nil pointer preserves the inspected item's counter; a pointer to zero explicitly renders zero. This changes only the render, not the Steam item.

```go
counter := 1337
images, err := client.Render(ctx, render.RenderRequest{
    InspectURL: inspectURL,
    StatTrak:   &counter,
})
```

## Post the link early

A bot can post an image link before the render finishes. Submit with `Create` and `Links: true`, and use `Links[render.Front]` at once:

```go
result, err := client.Create(ctx, render.RenderRequest{
    InspectURL: inspectURL,
    Views:      []render.View{render.Front},
}, render.SubmitOptions{IdempotencyKey: "listing-123-front-v1", Links: true})
if err != nil {
    return err
}
if link, ok := result.Links[render.Front]; ok {
    postEmbed(link)
}
```

The link is final at admission. The image host holds a request for a pending link for up to 20 seconds and answers with the image as soon as it exists, so a chat embed that fetches it a few seconds later gets the image instead of a 404. A render that takes longer than the hold, or fails, answers 503 with `Retry-After: 2`; wait for the finished images instead if your client keeps that response. A completed render's links equal its images, and a failed render has no links. Completion still depends on images, so `Render` and `Wait` keep returning finished images.

`SubmitOptions.Links` on `Create` and `GetOptions.Links` on `Get` sends `Prefer: links`; with `Render` it combines with the wait as `Prefer: wait=10, links`. Until the API enables links, it ignores the preference and the field is absent, so handle a missing link. Once the API returns links by default, the field is present without the option and the option changes nothing. If the API admits the render but cannot prepare its links, it answers 503 `render_links_unavailable` with `Retry-After`. The SDK retries it with the same idempotency key, like other 503 responses. Response parsing ignores fields this SDK version does not know, so a field the API adds later does not break it.

## Image delivery

```go
card, err := render.ImageURL(images[render.Front], render.Card)
if err != nil {
    return err
}
```

Use `render.Small`, `render.Card`, or `render.Zoom` as the variant.

The public recipes trim transparent padding, treating alpha values above 8 as visible. `small` fits within 500×220 at WebP quality 85, `card` fits within 1000×440 at quality 90, and `zoom` keeps the cropped native dimensions at quality 95. Resizing preserves the aspect ratio and never enlarges the image. The original lossless image stays unchanged.

Helpers accept an absolute HTTP(S) original URL under `/v1/<canonical SHA-256>.webp` or `.png`. They reject credentials, queries, fragments, unknown variants and derivative URLs. They preserve the original origin for custom image domains and make no network request.
