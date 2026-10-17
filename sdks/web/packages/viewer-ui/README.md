# @medalbot/viewer-ui

The styled Medalbot item viewer over [`@medalbot/viewer-engine`](https://www.npmjs.com/package/@medalbot/viewer-engine): React components, the `<medalbot-viewer>` custom element and a standalone bundle for pages without a bundler.

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@medalbot/viewer-ui@0.1.0/dist/standalone/medalbot-viewer.css" />
<script type="module" src="https://cdn.jsdelivr.net/npm/@medalbot/viewer-ui@0.1.0/dist/standalone/medalbot-viewer.js"></script>
<medalbot-viewer api="https://render.medalbot.cc" api-key="CLOSURE_READ_KEY" inspect-link="steam://..."></medalbot-viewer>
```

Entry points: `.` for React (React 19 is a peer dependency), `./element` to register the custom element in a bundled app, `./standalone` for one file with React included, and `./styles.css`. Theming through `--mv-*` variables, the `controls` config, region overrides and keys are documented in the [web viewer README](https://github.com/Flo4604/render-sdks/tree/main/sdks/web).
