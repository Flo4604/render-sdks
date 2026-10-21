# TypeScript client

Await `client.render()` to get image URLs. Cache hits and new renders return the same image map. The SDK submits the request, waits for completion and handles transient transport retries.

```bash
npm install @medalbot/render
```

```ts
import { RenderClient } from '@medalbot/render';

const client = new RenderClient({ apiKey });
const images = await client.render({ inspectUrl });

console.log(images.preview);
console.log(images.front);
console.log(images.back);
```

The default API URL is `https://render.medalbot.cc`. Supply `baseUrl` for local development. The package includes its public protocol types and has no private workspace dependencies.

For a StatTrak weapon, `await client.render({ inspectUrl, statTrak: 1337 })` overrides the kill counter in the image. The integer range is 0 to 999999; zero is an explicit override. Omit `statTrak` to preserve the inspected counter. This only changes the render, never the Steam item. A weapon without StatTrak returns `stat_trak_unavailable`.

## Render appearance

`appearance` is optional. Omit it or send `"default"` to preserve the original lighting. Use `"pattern"` for the alternative lighting:

```ts
const images = await client.render({
  inspectUrl,
  appearance: "pattern",
});
```

Pattern appearance supports preview, front, and back for every item in the rendering catalog, including firearms, knives and gloves. Omit `views` to request all three, or provide a subset. The existing AK-47 pattern preview keeps its original lighting. Unsupported items return HTTP 422 with code `unsupported_appearance`. The server determines availability; the SDK forwards your requested views without changing them.

## Waiting and retries

The initial HTTP request asks the server to wait up to ten seconds. A ready result returns immediately. For longer jobs, the SDK polls automatically, starting at 500 milliseconds and backing off to two seconds. The caller's promise resolves only when the requested images are ready.

```ts
const images = await client.render(
  { inspectUrl, views: ['front'], format: 'webp' },
  {
    idempotencyKey: 'listing-123-front-v1',
    timeoutMs: 120_000,
    signal: abortController.signal,
  },
);
```

The default timeout is two minutes for submission and polling together. Cancelling or timing out stops this caller's wait; shared GPU work continues. A timeout from `render()` throws a `RenderError` with code `wait_timeout`, the admitted `renderId` when known and the `idempotencyKey`. Resume with `client.renders.wait(error.renderId)`, or retry `client.render()` with that idempotency key if submission timed out before an ID arrived.

`client.renders.create/get/wait/batch/lookup` are lower-level operations for callers that need to persist request IDs or manage background work. Normal callers only need `render()`.

## Transport choice

[Replicate's JavaScript client](https://github.com/replicate/replicate-javascript#replicaterun) exposes an awaited result and uses a bounded blocking request with a polling fallback. [fal's client](https://fal.ai/docs/documentation/model-apis/inference/client-setup) also exposes an awaited call that returns generated images. Our SDK uses the same caller-facing pattern over HTTP and JSON.

The result is a set of complete image files. It has no token stream to consume. SSE could add optional progress events later; it is not required to await completion. gRPC is unnecessary for this public HTTP API.

## Image delivery

```ts
import { imageUrl } from "@medalbot/render";

const card = imageUrl(images.front, "card");
const zoom = imageUrl(images.front, "zoom");
```

The public recipes trim transparent padding, treating alpha values above 8 as visible. `small` fits within 500×220 at WebP quality 85, `card` fits within 1000×440 at quality 90, and `zoom` keeps the cropped native dimensions at quality 95. Resizing preserves the aspect ratio and never enlarges the image. The original lossless image stays unchanged.

Helpers accept an absolute HTTP(S) original URL under `/v1/<canonical SHA-256>.webp` or `.png`. They reject credentials, queries, fragments, unknown variants and derivative URLs. They preserve the original origin for custom image domains and make no network request.

For a responsive card, choose a smaller image on narrow screens without downloading the original:

```tsx
<picture>
  <source media="(max-width: 600px)" srcSet={imageUrl(images.front, "small")} />
  <img src={imageUrl(images.front, "card")} alt="Weapon front view" loading="lazy" decoding="async" />
</picture>
```

In a zoom dialog, show the card first, then replace it after the zoom image decodes. Start this on user intent so opening a gallery does not download every zoom image:

```ts
async function showZoom(element: HTMLImageElement, original: string) {
  const card = imageUrl(original, "card");
  element.src = card;
  const larger = new Image();
  larger.src = imageUrl(original, "zoom");
  try {
    await larger.decode();
    if (element.isConnected && element.src === card) {
      element.src = larger.src;
    }
  } catch {
    // Keep the card if the larger image cannot load.
  }
}
```

Keep the original URL for an explicit lossless download. It is separate from the smaller display images.
