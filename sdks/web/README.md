# Web viewer

Two browser packages render a CS2 item in 3D on your page with WebGPU, from the same compiled render plan the Medalbot GPU workers use. The packages are unreleased: nothing is on npm yet, and the engine API can still change.

| Package | What it is | Entry points |
| --- | --- | --- |
| `@medalbot/viewer-engine` | The headless engine. No UI and no dependencies. | `.` (the browser API), `./plan` and `./translate` (Node tooling for the closure builder, not for a page) |
| `@medalbot/viewer-ui` | The styled viewer: stage, header, presets, wear and seed, attachments, PNG download, fullscreen. | `.` (React components), `./element` (the `<medalbot-viewer>` custom element for bundlers), `./standalone` (one ES module with React included, for a page without a bundler), `./styles.css` |

Both are ESM only and ship type declarations. The engine declares `sideEffects: false`. The UI kit marks only its stylesheet and `./element` as side effects, because importing `./element` registers the custom element.

## Install

```sh
npm install @medalbot/viewer-ui @medalbot/viewer-engine
npm install react react-dom   # only for the React entry or ./element in a bundler
```

React 19 is a peer dependency of `.` and `./element`. The custom element is rendered with React internally, so `./standalone` carries React inside the file and a plain HTML page installs nothing.

## Custom element

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@medalbot/viewer-ui@0.1.0/dist/standalone/medalbot-viewer.css" />
<script type="module" src="https://cdn.jsdelivr.net/npm/@medalbot/viewer-ui@0.1.0/dist/standalone/medalbot-viewer.js"></script>
<medalbot-viewer api="https://render.medalbot.cc" api-key="CLOSURE_READ_KEY" item="7-801-661-1036831949" weapon="AK-47" finish="Asiimov"></medalbot-viewer>
```

The CDN URLs work once the package is published. `item` is `defindex-paintindex-paintseed-paintwear` with the wear as its float32 bits, the same form as the API's item path; use `inspect-link` instead to pass a CS2 inspect link. `weapon` and `finish` are display names, because the closure carries indices only.

Other attributes: `closure-url` (a closure service in place of `api`), `rarity`, `rarity-color`, `wear-min`, `wear-max`, `poster`, `disclaimer`, `sticker-slots`, `catalog-url`, `theme` (`dark` or `light`), `controls`, `hide`, `read-only`, `density`, `layout` (`floating` or `panel`) and `load` (`eager`, or `click` to download nothing until the visitor presses View in 3D).

The element dispatches `ready` (the loaded item in `detail`), `error` (the `ViewerError`) and `statechange` (the controller state), and exposes `state` and `actions` properties for scripts on the page.

## React

```tsx
import "@medalbot/viewer-ui/styles.css";
import { MedalbotViewer } from "@medalbot/viewer-ui";

<MedalbotViewer
  api="https://render.medalbot.cc"
  apiKey={closureKey}
  item={{ defindex: 7, paintindex: 801, paintseed: 661, paintwear: 1036831949 }}
  weapon="AK-47"
  finish="Asiimov"
  onReady={(item) => console.log(item.views)}
/>;
```

Pass `closureUrl` instead of `api` for a closure service, or `fetcher` for your own `AssetFetcher`. If you use React but want your own markup, `useViewer` returns the same state and actions the styled kit uses, with no markup or styles.

## Headless engine

```ts
import { apiFetcher, createViewer, detectSupport } from "@medalbot/viewer-engine";

const support = await detectSupport();

if (!support.supported) {
  showFallback(support.missing);
} else {
  const viewer = await createViewer({ canvas, fetcher: apiFetcher({ baseUrl: "https://render.medalbot.cc", apiKey }) });
  viewer.on("progress", ({ phase, done, total }) => showProgress(phase, done / total));
  await viewer.load({ defindex: 7, paintindex: 801, paintseed: 661, paintwear: 1036831949 });
  viewer.setWear(0.25);
  viewer.setSeed(42);
  await viewer.setCamera({ yaw: 30 });
  viewer.render();
  const png = await viewer.renderToBlob();
}
```

`load` also takes `{ inspectLink }`. The engine has presets (`views`, `setView`, `setPreset`), a free camera (`setCamera`, `getCamera`, `resetCamera`), live stickers and StatTrak (`setStickers`, `setStatTrak`), exact RGBA readback (`renderToPixels`) and the events `progress`, `ready`, `error`, `frame` and `camera`. Errors are `ViewerError` with a `code`; `webgpu_unsupported` and `feature_missing` mean the browser can't run the viewer.

Shaders, textures and binding maps aren't in the package. They're content-addressed files of each item's closure, fetched from the API's file host and cached by the browser like images, because they change with every CS2 build.

## Keys

A full API key can submit renders, so it must never appear in a page. Use one of these:

1. **A `closure:read` key in the page.** It reaches only the closure manifest and the file redirect, can be limited to your page's origins and is rate limited (600 requests a minute by default; one viewer load is one manifest request). Anyone who reads the page can copy it, which is acceptable because it only loads published closures within its limit. Ask Medalbot for a closure key for your origins.
2. **Your own proxy.** Your server forwards `GET /v1/items/{item}/closure` with its own key and `If-None-Match`, and the page passes no key: `apiFetcher({ baseUrl: "https://shop.example/render" })` or `<medalbot-viewer api="https://shop.example/render">`. Files still come from the public file host without credentials, so the proxy carries one request per load.

## Theming

Every colour, radius, font, space and shadow is a CSS custom property with the `--mv-` prefix, for example `--mv-color-accent`, `--mv-color-bg`, `--mv-color-text`, `--mv-font`, `--mv-radius-md` and `--mv-space-4`; `src/styles.css` in the UI package lists them all. Custom properties inherit into the element's shadow root, so you set them on the element or any ancestor:

```css
medalbot-viewer {
  --mv-color-accent: #ff7a1a;
  --mv-font: "Inter", system-ui, sans-serif;
}
```

`theme="light"` switches the same variables to their light values. Every region also carries a `part` attribute, so `medalbot-viewer::part(wear-slider) { margin-block: 8px; }` styles one piece.

## Controls

`controls` turns controls on and off by name; a hidden control isn't rendered. The names are `presets`, `wear`, `seed`, `stickers`, `stattrak`, `charm`, `lighting`, `download`, `fullscreen`, `header`, `change-item`, `badge`, `disclaimer` and `shortcuts`. Everything is on except `badge` and `disclaimer`. Attachment and lighting controls appear only when the engine and the item support them.

```tsx
<MedalbotViewer {...source} item={item} controls={{ seed: false, badge: true }} readOnly density="viewer" />
```

```html
<medalbot-viewer ... controls="presets wear download"></medalbot-viewer>
<medalbot-viewer ... hide="seed" read-only density="viewer"></medalbot-viewer>
```

On the element, `controls` lists the only controls to show and `hide` removes some from the default set. `readOnly` shows values without letting the visitor change them. `density` sets how much chrome the kit draws: `full` (header, controls and customise panels), `viewer` (header and view controls, for listing pages) or `host` (the render and its states, for a host that draws its own controls).

## Overrides

Regions are the named pieces of the viewer: `stage`, `loading`, `error`, `unsupported`, `header`, `change-item`, `orbit-hint`, `presets`, `control-bar`, `wear-slider`, `seed-input`, `stickers`, `stattrak`, `charm`, `lighting`, `download`, `fullscreen`, `toasts`, `picker`, `badge`, `disclaimer`, `shortcuts` and `panel`. The same name works for `::part()` styling and for replacement.

In React, `components` maps a region to your component, which receives the controller `state`, the `actions`, the resolved `controls` and the `display` names:

```tsx
import type { RegionProps } from "@medalbot/viewer-ui";

function MyHeader({ display, state }: RegionProps) {
  return <h2>{display.name} {state.paint?.wear.toFixed(4)}</h2>;
}

<MedalbotViewer {...source} item={item} components={{ header: MyHeader }} />;
```

On the element, put a light-DOM child in the slot of the same name and drive it from `statechange`:

```html
<medalbot-viewer id="viewer" ...>
  <div slot="header" id="my-header"></div>
</medalbot-viewer>
<script type="module">
  document.querySelector("#viewer").addEventListener("statechange", ({ detail }) => {
    document.querySelector("#my-header").textContent = detail.paint?.wear.toFixed(4) ?? "";
  });
</script>
```

## WebGPU support

The engine needs WebGPU with `texture-compression-bc`, `texture-compression-bc-sliced-3d`, `float32-filterable` and `subgroups`. There is no WebGL fallback, because the paint graph's compute passes, storage textures and subgroup operations have no WebGL 2 equivalent.

| Browser | Status |
| --- | --- |
| Chrome on macOS (Apple silicon) | Verified against the GPU workers' output. |
| Chrome and Edge on Windows | Expected to work; not verified yet. |
| Chrome on Linux | Needs WebGPU enabled (`--enable-unsafe-webgpu`); not verified. |
| Safari 26 on macOS, Firefox on Windows | Unverified; may lack `subgroups` or the sliced 3D BC feature. |
| Android and iOS | Unsupported: phone GPUs have no BC texture compression. Transcoded closures for phones are planned. |

`detectSupport()` checks the adapter before anything downloads. When a feature is missing the styled viewer shows its `unsupported` state, makes no API request and lists what is missing; you can replace that state like any other region.

## Bundle sizes

Measured by `npm run size` after `npm run build` on the current sources, minified with esbuild and gzipped at level 9. CI fails when an entry grows past the budget in `scripts/size.ts`.

| Entry | Minified | Gzipped |
| --- | --- | --- |
| Engine: `createViewer`, `detectSupport`, `apiFetcher` | 73.4 KB | 25.3 KB |
| Engine: everything in `.` | 75.0 KB | 25.9 KB |
| UI: `MedalbotViewer`, React external | 133.9 KB | 43.6 KB |
| UI: `./element`, React external | 188.6 KB | 52.7 KB |
| UI: `./standalone`, React included | 413.7 KB | 122.1 KB |

The element entry is larger than the React component because it carries the stylesheet for its shadow root. Item closures are separate downloads and much larger than the code.

## Development

```sh
cd sdks/web
npm ci
npm test              # builds both packages and runs the Node unit tests, no GPU needed
npm run size          # bundle sizes against the budgets
npm run test:browser  # headless Chrome
```

`npm run test:browser` needs Chrome (or `CHROME_PATH`). Its unsupported-state test runs without a GPU. The load test is skipped unless `VIEWER_API_URL`, `VIEWER_API_KEY` (a `closure:read` key allowing `http://127.0.0.1`) and `VIEWER_ITEM` are set, and it also skips when Chrome finds no adapter with the required features. Two engine unit tests skip here because their data, the executor's binding vectors and a compiled item, stays in the private service repository, where they run.

### Where the source lives

For now the private service repository is the source of truth for `packages/viewer-engine` and `packages/viewer-ui`, because the engine is still built and verified against compile output that only exists there. Copy a revision here with:

```sh
node scripts/sync-web.ts <private checkout> --engine-ref <rev> --ui-ref <rev>
```

The sync reads the packages with `git archive`, so untracked and ignored files in the checkout are never copied. It writes the packages' source, tests, build scripts and `package.json`, where it sets only the publish fields (`license`, `repository`, `homepage`, `publishConfig`, `LICENSE` in `files`, and a version range in place of `workspace:*`). Each package's `README.md`, `tsconfig.json` and `LICENSE` belong to this repository and are never written. `sync.json` records the source commits and the hash of every file the sync wrote, and the sync stops without writing anything when it would overwrite or delete a file changed here since then. Add `--dry-run` to see the changes first.

Once the engine API is frozen, development moves here: the sync script and `sync.json` are deleted and the packages are edited in place like the other SDKs.
