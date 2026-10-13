# Python client

Await `client.render()` to get finished image URLs. The SDK handles cached results, retries, and polling.

Install the public wheel:

```bash
python -m pip install medalbot-render
export RENDER_API_KEY="your-api-key"
```

```python
import asyncio
import os
from medalbot_render import RenderClient


async def main():
    async with RenderClient(api_key=os.environ["RENDER_API_KEY"]) as client:
        images = await client.render(inspect_url="steam://...")
        print(images["preview"])
        print(images["front"])
        print(images["back"])


asyncio.run(main())
```

Python 3.11 or newer is required. The default API URL is `https://render.medalbot.cc`. Set `base_url` to use another server. The client owns an HTTP connection pool. Use its async context manager or call `await client.aclose()`.

## Request options

```python
images = await client.render(
    inspect_url=inspect_url,
    views=["front"],
    format="webp",
    stat_trak=1337,
    timeout=120,
    idempotency_key="listing-123-front-v1",
)
print(images["front"])
```

All three views are requested by default. WebP is lossless; PNG is also available. The result is a dictionary of URL strings, such as `{"front": "https://img.medalbot.cc/..."}`. Only requested views are present. Cache hits and fresh renders return the same shape.

Set `stat_trak` to an integer from 0 to 999999 to override the displayed counter. Omit it or pass `None` to preserve the inspected item's counter. Zero explicitly renders zero. The option also works with `client.renders.create()` and changes only the render, not the Steam item.

The initial request sends `Prefer: wait=10`. If the render is still pending, the SDK polls at intervals from 500 milliseconds to two seconds. The default 120-second deadline covers submission, retry delays, and polling together. Transport failures and HTTP 429, 502, 503, and 504 receive at most four attempts. Retries keep the same idempotency key. Retry delays honor `Retry-After` up to ten seconds.

## Cancellation and resume

Cancel the asyncio task to stop a local wait. Cancellation raises `asyncio.CancelledError`; shared GPU work continues. A local deadline raises `RenderError` with code `wait_timeout`. Other errors include `code`, `detail`, `render_id`, `request_id`, `idempotency_key`, and `status_code` where available.

```python
from medalbot_render import RenderError

try:
    images = await client.render(inspect_url=inspect_url, timeout=30)
except RenderError as error:
    if error.code != "wait_timeout":
        raise
    if error.render_id:
        images = await client.renders.wait(error.render_id)
    else:
        images = await client.render(
            inspect_url=inspect_url, idempotency_key=error.idempotency_key
        )
```

`client.renders.create()` returns the admitted render without waiting for completion. `client.renders.get(id)` returns its current state. Those methods return `CompletedRender`, `PendingRender`, or `FailedRender` models. Completed renders contain `id` and the URL dictionary `images`. Pending renders contain `id` and `status`. Failed renders contain `id`, `status`, and `error`.

`client.renders.wait(id)` resumes a wait and returns the URL dictionary. Each method accepts a total `timeout` in seconds. Pass `views` to `wait` when you also want to check the original requested views. The SDK unwraps the HTTP response envelope `meta` and `data` for callers. Error request IDs come from `meta.requestId`.

## Development

Run these commands from the repository root:

```bash
uv run --project sdks/python --extra dev pytest sdks/python/tests
uv run --project sdks/python --extra dev mypy --strict sdks/python/src
uv build --project sdks/python
```
