# C# client

`RenderAsync` returns finished image URLs, whether the images are cached or need a new render. It handles submission, retries, and polling. The package targets .NET 8 or later and has no package dependencies.

```sh
dotnet add package Medalbot.Render --version 0.1.4
```

```csharp
using Medalbot.Render;

using var client = new RenderClient(Environment.GetEnvironmentVariable("RENDER_API_KEY")!);
var images = await client.RenderAsync(new RenderRequest
{
    InspectUrl = inspectUrl,
    Views = [RenderView.Front, RenderView.Back],
});
Console.WriteLine(images.Front);
Console.WriteLine(images.Back);
```

Omit `Views` to request preview, front, and back. Images use lossless WebP by default. Set `Format = ImageFormat.Png` for PNG. Unrequested image properties are null. Reuse one client for concurrent requests, then dispose it when the application shuts down.

## Telemetry

The client reports how long each call took on your side, so slow renders can be traced to the network, polling, retries or the calling process. Turn it off when you create the client:

```csharp
using var client = new RenderClient(apiKey, new RenderClientOptions { Telemetry = false });
```

`TelemetrySampleRate = 0.1` keeps it on and reports a tenth of fast, successful calls; the default is a quarter. Failed calls and calls of three seconds or more are always reported. Setting `MEDALBOT_TELEMETRY=0` in the environment turns it off for every client in the process.

Each report covers one call: time to first byte, total time, the API's own `Server-Timing`, retries and their backoff, polls and the time between them, the error code, and the server's request ID. It never contains your inspect link, API key or image URLs. Reports go to `POST /v1/telemetry/sdk` on the same API with your key, in batches every ten seconds and when the client is disposed, and a failed report is dropped without affecting the call. `await client.FlushTelemetryAsync()` sends them at once.

Every request also names the SDK in `User-Agent` and `X-Medalbot-SDK` and carries a W3C `traceparent`, whether telemetry is on or off, so a support request can quote one call's trace.

For a StatTrak weapon, use `new RenderRequest { InspectUrl = inspectUrl, StatTrak = 1337 }` to override the kill counter in the image. The integer range is 0 to 999999; zero is an explicit override. Leave `StatTrak` null to preserve the inspected counter. This only changes the render, never the Steam item. A weapon without StatTrak returns `stat_trak_unavailable`.

Leave `Appearance` null to keep the original lighting, or set `RenderAppearance.Default` explicitly. To request pattern lighting:

```csharp
var images = await client.RenderAsync(new RenderRequest
{
    InspectUrl = akInspectUrl,
    Appearance = RenderAppearance.Pattern,
});
```

The server supports pattern appearance for AK-47 preview, front, and back images. Omit `Views` to request all three, or provide a subset. Pattern appearance preserves the original preview lighting. Unsupported items return HTTP 422 with code `unsupported_appearance`. The SDK sends the requested appearance and leaves item and view support checks to the server.

## Cancellation and timeouts

```csharp
using var cancellation = new CancellationTokenSource();
var images = await client.RenderAsync(
    new RenderRequest { InspectUrl = inspectUrl },
    new RenderOptions
    {
        Timeout = TimeSpan.FromMinutes(3),
        IdempotencyKey = "listing-123-front-v1",
    },
    cancellation.Token);
```

The default timeout is two minutes for submission, retries, and polling together. Cancellation stops the caller's wait, and shared GPU work continues. `RenderCanceledException` extends `OperationCanceledException` and retains `RenderId`, `RequestId`, and `IdempotencyKey`. A timeout throws `RenderException` with `Code = "wait_timeout"` and the same identifiers.

Resume with `await client.WaitAsync(error.RenderId)` when the render ID is available. If submission times out before admission is confirmed, retry `RenderAsync` with the saved idempotency key. Transient network failures and HTTP 429, 502, 503, and 504 responses receive at most three retries. The SDK respects `Retry-After` within the operation timeout.

`RenderException` contains the API error code, message, HTTP status when available, and request ID. It does not include the API key. `CreateAsync` submits without waiting, and `GetAsync` returns the current state. Normal callers only need `RenderAsync`.

## Configuration and tests

Pass `RenderClientOptions` to change `BaseUrl` or the default `Timeout`. The default URL is `https://render.medalbot.cc`. A custom `HttpMessageHandler` supports transport configuration and tests. The caller owns that handler and must disable automatic redirects. The default handler disables redirects.

Run the protocol tests with `dotnet run --project tests/Medalbot.Render.Tests.csproj -c Release`. Build the package with `dotnet pack src/Medalbot.Render.csproj -c Release`.

## Post the link early

A bot can post an image link before the render finishes. Submit with `CreateAsync` and `Links = true`, and use `Links.Front` at once:

```csharp
var state = await client.CreateAsync(
    new RenderRequest { InspectUrl = inspectUrl, Views = [RenderView.Front] },
    new RenderOptions { Links = true, IdempotencyKey = "listing-123-front-v1" });
if (state.Links?.Front is { } link)
{
    await PostEmbedAsync(link);
}
```

The link is final at admission. The image host holds a request for a pending link for up to 20 seconds and answers with the image as soon as it exists, so a chat embed that fetches it a few seconds later gets the image instead of a 404. A render that takes longer than the hold, or fails, answers 503 with `Retry-After: 2`; wait for the finished images instead if your client keeps that response. A completed render's links equal its images, and a failed render has no links. Completion still depends on images, so `RenderAsync` and `WaitAsync` keep returning finished images.

`RenderOptions.Links` on `CreateAsync` and `GetAsync(id, options)` sends `Prefer: links`; with `RenderAsync` it combines with the wait as `Prefer: wait=10, links`. Until the API enables links, it ignores the preference and the field is absent, so handle a missing link. Once the API returns links by default, the field is present without the option and the option changes nothing. If the API admits the render but cannot prepare its links, it answers 503 `render_links_unavailable` with `Retry-After`. The SDK retries it with the same idempotency key, like other 503 responses. Response parsing ignores fields this SDK version does not know, so a field the API adds later does not break it.

## Image delivery

```csharp
var card = Media.ImageUrl(images.Front!, ImageVariant.Card);
var zoom = Media.ImageUrl(images.Front!, ImageVariant.Zoom);
```

The public recipes trim transparent padding, treating alpha values above 8 as visible. `small` fits within 500×220 at WebP quality 85, `card` fits within 1000×440 at quality 90, and `zoom` keeps the cropped native dimensions at quality 95. Resizing preserves the aspect ratio and never enlarges the image. The original lossless image stays unchanged.

Helpers accept an absolute HTTP(S) original URL under `/v1/<canonical SHA-256>.webp` or `.png`. They reject credentials, queries, fragments, unknown variants and derivative URLs. They preserve the original origin for custom image domains and make no network request.
