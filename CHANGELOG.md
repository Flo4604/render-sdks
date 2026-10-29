# Changes

## Identification and telemetry

| SDK | Version |
| --- | --- |
| TypeScript | unreleased |
| Python | unreleased |
| Go | unreleased |
| C# | unreleased |

Every request sends `User-Agent: medalbot-render-<language>/<version> (<runtime>/<version>; <os>)`, `X-Medalbot-SDK: <language>/<version>` and a W3C `traceparent` whose trace ID is fixed for one call. Unless the caller turns it off, each call reports its timings to `POST /v1/telemetry/sdk` with the caller's key: total time, HTTP time, time to first byte, the API's `Server-Timing`, retries and backoff, polls and the wait between them, the error code and the server request ID. Python and Go add connect time; Go also adds DNS and TLS time. Reports are sampled (a quarter of fast, successful calls; every failed call and every call of three seconds or more), batched, and dropped on failure. Turn it off with the client option (`telemetry: false`, `telemetry=False`, `DisableTelemetry: true`, `Telemetry = false`) or `MEDALBOT_TELEMETRY=0`.

## Render links

| SDK | Version |
| --- | --- |
| TypeScript | 0.1.6 |
| Python | 0.1.6 |
| Go | 0.1.6 |
| C# | 0.1.4 |

Pending and completed render states expose an optional `links` map, one URL per requested view, final at admission. A completed render's links equal its images, and failed renders have none. Completion still depends on `images`. A request option sends `Prefer: links`: `links` in TypeScript (`renders.create`, `get`, `batch`, `lookup`) and Python (`renders.create`, `renders.get`), `SubmitOptions.Links` and `GetOptions.Links` in Go, and `RenderOptions.Links` in C#. With the wait of a full render it becomes `Prefer: wait=10, links`. Once the API returns links by default, the option changes nothing.

Response parsing ignores fields the SDK does not know, so the API can add a field without breaking published clients. The SDKs still validate every field they read. HTTP 503 `render_links_unavailable` retries with `Retry-After` and the same idempotency key, like other 503 responses.

## Public image variants

| SDK | Version |
| --- | --- |
| TypeScript | 0.1.4 |
| Python | 0.1.4 |
| Go | 0.1.4 |
| C# | 0.1.2 |

All SDKs include a pure URL helper for the fixed `small`, `card` and `zoom` image variants. The helpers preserve custom image origins, validate canonical original image URLs and leave the lossless original unchanged. The render response remains a map of view names to original URLs.

## StatTrak overrides

| SDK | Version |
| --- | --- |
| TypeScript | 0.1.3 |
| Python | 0.1.3 |
| Go | 0.1.3 |
| C# | 0.1.1 |

All four SDKs accept an optional StatTrak kill counter for render requests. TypeScript uses `statTrak`, Python uses `stat_trak`, and Go and C# use `StatTrak`. The wire field is `statTrak` in every SDK.

The override accepts integers from 0 to 999999. Explicit zero renders a zero counter; omission preserves the inspected value. It changes the image only, and the API rejects items without a StatTrak kill counter. Changed counters use separate cached renders.
