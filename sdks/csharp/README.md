# C# client

`RenderAsync` returns finished image URLs, whether the images are cached or need a new render. It handles submission, retries, and polling. The package targets .NET 8 or later and has no package dependencies.

```sh
dotnet add package Medalbot.Render --version 0.1.2
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

For a StatTrak weapon, use `new RenderRequest { InspectUrl = inspectUrl, StatTrak = 1337 }` to override the kill counter in the image. The integer range is 0 to 999999; zero is an explicit override. Leave `StatTrak` null to preserve the inspected counter. This only changes the render, never the Steam item. A weapon without StatTrak returns `stat_trak_unavailable`.

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

## Image delivery

```csharp
var card = Media.ImageUrl(images.Front!, ImageVariant.Card);
var zoom = Media.ImageUrl(images.Front!, ImageVariant.Zoom);
```

The public recipes trim transparent padding, treating alpha values above 8 as visible. `small` fits within 500×220 at WebP quality 85, `card` fits within 1000×440 at quality 90, and `zoom` keeps the cropped native dimensions at quality 95. Resizing preserves the aspect ratio and never enlarges the image. The original lossless image stays unchanged.

Helpers accept an absolute HTTP(S) original URL under `/v1/<canonical SHA-256>.webp` or `.png`. They reject credentials, queries, fragments, unknown variants and derivative URLs. They preserve the original origin for custom image domains and make no network request.
