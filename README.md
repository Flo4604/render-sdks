# Medalbot Render SDKs

Official clients for `https://render.medalbot.cc`. Await a render call to receive public image URLs, whether the request hits the cache or needs GPU work. The SDKs handle polling and retries.

All SDK source, tests, and package builds live here. The render service and native renderer remain private.

| Language | Source and guide | Install |
| --- | --- | --- |
| TypeScript | [sdks/typescript](sdks/typescript) | `npm install @medalbot/render` |
| Python | [sdks/python](sdks/python) | `pip install medalbot-render` |
| Go | [sdks/go](sdks/go) | `go get github.com/Flo4604/render-sdks/sdks/go@v0.1.6` |
| C# | [sdks/csharp](sdks/csharp) | `dotnet add package Medalbot.Render` |

```ts
import { RenderClient } from '@medalbot/render';

const client = new RenderClient({ apiKey: process.env.RENDER_API_KEY! });
const images = await client.render({ inspectUrl });
console.log(images.front);
```

The SDKs report call timings (never inspect links, keys or image URLs) so slow renders can be traced to the network, polling, retries or the caller's process. Turn this off with the client option, such as `new RenderClient({ apiKey, telemetry: false })`, or with `MEDALBOT_TELEMETRY=0`. Each SDK's guide lists its option.

Each SDK has its own version and release tag. See [RELEASING.md](RELEASING.md) for tests, package builds, and trusted publishing.
