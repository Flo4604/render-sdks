# Go SDK

`Render` returns finished images for both cached requests and new GPU renders. It sends `Prefer: wait=10`, then polls automatically until the images are ready.

The module uses Go 1.22 or later and has no external dependencies. Install the public module:

```bash
go get github.com/Flo4604/render-sdks/sdks/go@v0.1.4
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
