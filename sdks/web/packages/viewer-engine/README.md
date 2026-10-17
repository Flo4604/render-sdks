# @medalbot/viewer-engine

The headless WebGPU engine of the Medalbot item viewer. It loads an item's compiled render plan from the render API and draws it on your canvas, with live wear and seed, stickers, StatTrak, a free camera, presets and exact PNG export. It has no UI and no dependencies.

```ts
import { apiFetcher, createViewer } from "@medalbot/viewer-engine";

const viewer = await createViewer({ canvas, fetcher: apiFetcher({ baseUrl: "https://render.medalbot.cc", apiKey }) });
await viewer.load({ inspectLink });
viewer.render();
```

Use a `closure:read` key or your own proxy in a page, never a full API key. The guide, the WebGPU support matrix and bundle sizes are in the [web viewer README](https://github.com/Flo4604/render-sdks/tree/main/sdks/web).
