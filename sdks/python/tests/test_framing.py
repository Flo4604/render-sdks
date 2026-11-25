import json
from typing import get_args

import httpx
import pytest

from medalbot_render import Framing, RenderClient


def test_framing_type_is_exported():
    assert get_args(Framing) == ("auto", "charm", "standard")


@pytest.mark.parametrize(
    "options",
    [
        {},
        {"framing": None},
        {"framing": "auto"},
        {"framing": "charm"},
        {"framing": "standard"},
    ],
)
@pytest.mark.parametrize("wait", [False, True])
async def test_framing_submission(options, wait):
    calls = []

    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "meta": {"requestId": "req_test"},
                "data": {
                    "id": "rnd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                    "images": {"front": "https://img.medalbot.cc/test.webp"},
                },
            },
        )

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        submit = client.render if wait else client.renders.create
        await submit(inspect_url="steam://example", views=["front"], **options)

    expected = {
        "inspectUrl": "steam://example",
        "views": ["front"],
        "format": "webp",
    }
    if options.get("framing") is not None:
        expected["framing"] = options["framing"]
    assert calls == [expected]


@pytest.mark.parametrize("framing", ["", "Charm", "unknown", 1, True, [], {}])
@pytest.mark.parametrize("wait", [False, True])
async def test_invalid_framing_does_not_submit(framing, wait):
    def handler(request):
        pytest.fail("invalid framing must not reach the API")

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        submit = client.render if wait else client.renders.create
        with pytest.raises(ValueError, match="framing must be auto, charm or standard"):
            await submit(inspect_url="steam://example", framing=framing)
