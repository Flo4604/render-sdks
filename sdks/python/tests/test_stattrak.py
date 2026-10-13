import json

import httpx
import pytest

from medalbot_render import RenderClient


@pytest.mark.parametrize("counter", [None, 0, 1337, 999999])
@pytest.mark.parametrize("wait", [False, True])
async def test_stat_trak_submission(counter, wait):
    calls = []

    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={
            "meta": {"requestId": "req_test"},
            "data": {
                "id": "rnd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "images": {"front": "https://img.medalbot.cc/test.webp"},
            },
        })

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        submit = client.render if wait else client.renders.create
        await submit(inspect_url="steam://example", views=["front"], stat_trak=counter)
    assert len(calls) == 1
    if counter is None:
        assert "statTrak" not in calls[0]
    else:
        assert calls[0]["statTrak"] == counter
        assert type(calls[0]["statTrak"]) is int


@pytest.mark.parametrize("counter", [-1, 1000000, 1.5, 0.0, True, "42"])
@pytest.mark.parametrize("wait", [False, True])
async def test_invalid_stat_trak_does_not_submit(counter, wait):
    def handler(request):
        pytest.fail("invalid counter must not reach the API")

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        submit = client.render if wait else client.renders.create
        with pytest.raises(ValueError, match="stat_trak must be an integer"):
            await submit(inspect_url="steam://example", stat_trak=counter)
