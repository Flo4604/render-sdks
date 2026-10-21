import httpx
import pytest

from medalbot_render import CompletedRender, PendingRender, RenderClient, RenderError
from medalbot_render.client import _Context

ID = "rnd_01ARZ3NDEKTSV4RRFFQ69G5FAV"
IMAGE = "https://img.medalbot.cc/v1/example.webp"
LINK = "https://img.medalbot.cc/r/v1/" + "A" * 43
# A 202 with links and fields this SDK version does not know.
PENDING = {
    "meta": {"requestId": "req_1", "region": "future"},
    "future": True,
    "data": {"id": ID, "status": "queued", "position": 3, "links": {"front": LINK}},
}
COMPLETED = {
    "meta": {"requestId": "req_1"},
    "data": {
        "id": ID,
        "images": {"front": IMAGE},
        "links": {"front": IMAGE},
        "cache": "hit",
    },
}
UNAVAILABLE = {
    "meta": {"requestId": "req_1"},
    "error": {
        "code": "render_links_unavailable",
        "detail": "Render links are unavailable",
        "status": 503,
        "title": "Service Unavailable",
        "type": "urn:skinicon:error:render_links_unavailable",
    },
}


def client_for(handler):
    return RenderClient(api_key="test", transport=httpx.MockTransport(handler))


async def test_pending_with_links_and_unknown_fields_parses():
    async def handler(request):
        return httpx.Response(202, json=PENDING)

    async with client_for(handler) as client:
        result = await client.renders.create(inspect_url="steam://x", views=["front"])
    assert isinstance(result, PendingRender)
    assert result.links == {"front": LINK}


async def test_completed_links_equal_images():
    async def handler(request):
        return httpx.Response(200, json=COMPLETED)

    async with client_for(handler) as client:
        result = await client.renders.get(ID, links=True)
    assert isinstance(result, CompletedRender)
    assert result.links == result.images


async def test_render_completes_on_images_not_links(monkeypatch):
    responses = [httpx.Response(202, json=PENDING), httpx.Response(200, json=COMPLETED)]

    async def handler(request):
        return responses.pop(0)

    async def no_sleep(_):
        return None

    monkeypatch.setattr("medalbot_render.client.asyncio.sleep", no_sleep)
    async with client_for(handler) as client:
        images = await client.render(inspect_url="steam://x", views=["front"])
    assert images == {"front": IMAGE}
    assert responses == []


async def test_links_preference_header():
    prefers = []

    async def handler(request):
        prefers.append(request.headers.get("Prefer"))
        return httpx.Response(200, json=COMPLETED)

    async with client_for(handler) as client:
        await client.renders.create(inspect_url="steam://x", links=True)
        await client.renders.get(ID, links=True)
        await client.renders.create(inspect_url="steam://x")
        await client.renders.get(ID)
        # The wait and links preferences compose into one header.
        await client._request(
            "POST", "/v1/renders", _Context(), body={}, wait=True, links=True
        )
    assert prefers == ["links", "links", None, None, "wait=10, links"]


async def test_render_links_unavailable_retries(monkeypatch):
    keys = []

    async def handler(request):
        keys.append(request.headers.get("Idempotency-Key"))
        if len(keys) == 1:
            return httpx.Response(503, json=UNAVAILABLE, headers={"Retry-After": "1"})
        return httpx.Response(202, json=PENDING)

    delays = []

    async def record_sleep(delay):
        delays.append(delay)

    monkeypatch.setattr("medalbot_render.client.asyncio.sleep", record_sleep)
    async with client_for(handler) as client:
        result = await client.renders.create(
            inspect_url="steam://x", links=True, idempotency_key="fixture-key"
        )
    assert isinstance(result, PendingRender)
    assert keys == ["fixture-key", "fixture-key"]
    assert len(delays) == 1 and delays[0] >= 1


async def test_render_links_unavailable_surfaces_after_retries(monkeypatch):
    calls = []

    async def handler(request):
        calls.append(request)
        return httpx.Response(503, json=UNAVAILABLE, headers={"Retry-After": "1"})

    async def no_sleep(_):
        return None

    monkeypatch.setattr("medalbot_render.client.asyncio.sleep", no_sleep)
    async with client_for(handler) as client:
        with pytest.raises(RenderError) as caught:
            await client.renders.create(inspect_url="steam://x", links=True)
    assert caught.value.code == "render_links_unavailable"
    assert caught.value.status_code == 503
    assert len(calls) == 4


async def test_invalid_link_is_rejected():
    async def handler(request):
        return httpx.Response(
            202,
            json={
                "meta": {"requestId": "req_1"},
                "data": {"id": ID, "status": "queued", "links": {"front": "nope"}},
            },
        )

    async with client_for(handler) as client:
        with pytest.raises(RenderError) as caught:
            await client.renders.create(inspect_url="steam://x")
    assert caught.value.code == "invalid_response"
