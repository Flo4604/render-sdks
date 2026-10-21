import json
from typing import get_args

import httpx
import pytest

from medalbot_render import Appearance, RenderClient, RenderError


def test_appearance_type_is_exported():
    assert get_args(Appearance) == ("default", "pattern")


@pytest.mark.parametrize(
    "options",
    [{}, {"appearance": None}, {"appearance": "default"}, {"appearance": "pattern"}],
)
@pytest.mark.parametrize("wait", [False, True])
async def test_appearance_submission(options, wait):
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
    if options.get("appearance") is not None:
        expected["appearance"] = options["appearance"]
    assert calls == [expected]


@pytest.mark.parametrize("appearance", ["", "Pattern", "unknown", 1, True, [], {}])
@pytest.mark.parametrize("wait", [False, True])
async def test_invalid_appearance_does_not_submit(appearance, wait):
    def handler(request):
        pytest.fail("invalid appearance must not reach the API")

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        submit = client.render if wait else client.renders.create
        with pytest.raises(ValueError, match="appearance must be default or pattern"):
            await submit(inspect_url="steam://example", appearance=appearance)


@pytest.mark.parametrize("wait", [False, True])
async def test_unsupported_appearance_preserves_server_error(wait):
    calls = []

    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(
            422,
            json={
                "meta": {"requestId": "req_appearance"},
                "error": {
                    "code": "unsupported_appearance",
                    "detail": "Pattern lighting is unavailable for these views",
                },
            },
        )

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        submit = client.render if wait else client.renders.create
        with pytest.raises(RenderError) as caught:
            await submit(
                inspect_url="steam://example",
                appearance="pattern",
                idempotency_key="appearance-test",
            )

    assert len(calls) == 1
    assert calls[0]["appearance"] == "pattern"
    assert calls[0]["views"] == ["preview", "front", "back"]
    assert caught.value.code == "unsupported_appearance"
    assert caught.value.status_code == 422
    assert caught.value.detail == "Pattern lighting is unavailable for these views"
    assert caught.value.request_id == "req_appearance"
    assert caught.value.idempotency_key == "appearance-test"
