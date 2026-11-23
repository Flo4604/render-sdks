import json
from datetime import UTC, datetime

import httpx
import pytest

from medalbot_render import (
    CompletedRender,
    FailedRender,
    RenderClient,
    RenderError,
    RenderExpiredError,
)

ID = "rnd_01ARZ3NDEKTSV4RRFFQ69G5FAV"
IMAGE = "https://img.medalbot.cc/v1/example.webp"
COMPLETED = {
    "meta": {"requestId": "req_1"},
    "data": {
        "id": ID,
        "images": {"front": IMAGE},
        "retainUntil": "2026-11-23T13:00:00.000Z",
    },
}
EXPIRED = {
    "meta": {"requestId": "req_expired"},
    "error": {
        "code": "render_expired",
        "detail": "The render's retention ended",
        "status": 410,
        "title": "Gone",
        "type": "urn:skinicon:error:render_expired",
    },
}
FAILED_EXPIRED = {
    "meta": {"requestId": "req_1"},
    "data": {
        "id": ID,
        "status": "failed",
        "error": {"code": "render_expired", "detail": "The render's retention ended"},
    },
}


def client_for(handler):
    return RenderClient(
        api_key="test", transport=httpx.MockTransport(handler), telemetry=False
    )


async def test_retention_seconds_is_sent_as_given_null_included_and_omitted_otherwise():
    bodies = []

    async def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=COMPLETED)

    async with client_for(handler) as client:
        kept = await client.renders.create(
            inspect_url="steam://x", views=["front"], retention_seconds=3600
        )
        await client.renders.create(
            inspect_url="steam://x", views=["front"], retention_seconds=None
        )
        await client.render(inspect_url="steam://x", views=["front"])

    assert bodies[0]["retentionSeconds"] == 3600
    assert bodies[1]["retentionSeconds"] is None
    assert "retentionSeconds" not in bodies[2]
    assert isinstance(kept, CompletedRender)
    assert kept.retain_until == datetime(2026, 11, 23, 13, tzinfo=UTC)


@pytest.mark.parametrize("value", [3599, 2592001, 3600.0, True, "3600"])
async def test_retention_seconds_out_of_range_is_rejected_before_sending(value):
    async def handler(request):
        raise AssertionError("no request expected")

    async with client_for(handler) as client:
        with pytest.raises(ValueError, match="retention_seconds"):
            await client.render(inspect_url="steam://x", retention_seconds=value)


async def test_delete_sends_delete_and_accepts_an_empty_204():
    requests = []

    async def handler(request):
        requests.append((request.method, request.url.path))
        return httpx.Response(204)

    async with client_for(handler) as client:
        assert await client.renders.delete(ID) is None
    assert requests == [("DELETE", f"/v1/renders/{ID}")]


async def test_a_410_render_expired_raises_once_without_a_retry():
    calls = 0

    async def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(410, json=EXPIRED)

    async with client_for(handler) as client:
        with pytest.raises(RenderExpiredError) as caught:
            await client.renders.get(ID)
    assert isinstance(caught.value, RenderError)
    assert caught.value.code == "render_expired"
    assert caught.value.status_code == 410
    assert caught.value.request_id == "req_expired"
    assert caught.value.render_id == ID
    assert calls == 1


async def test_wait_on_an_expired_render_raises_render_expired_error():
    async def handler(request):
        return httpx.Response(200, json=FAILED_EXPIRED)

    async with client_for(handler) as client:
        assert isinstance(await client.renders.get(ID), FailedRender)
        with pytest.raises(RenderExpiredError) as caught:
            await client.renders.wait(ID)
    assert caught.value.render_id == ID
