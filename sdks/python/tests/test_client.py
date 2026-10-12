import asyncio
import json
import time

import httpx
import pytest

from medalbot_render import RenderClient, RenderError

ID = "rnd_01ARZ3NDEKTSV4RRFFQ69G5FAV"
URL = "https://img.medalbot.cc/example.webp"


def render(status="completed", views=("preview", "front", "back")):
    data = {"id": ID}
    if status == "completed":
        data["images"] = {view: URL for view in views}
    else:
        data["status"] = status
    return {"meta": {"requestId": "req_1"}, "data": data}


async def test_cached_and_queued_have_same_result():
    calls = []

    async def handler(request):
        calls.append(request)
        return httpx.Response(
            200, json=render("queued" if len(calls) == 1 else "completed")
        )

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        queued = await client.render(inspect_url="steam://example")
        cached = await client.render(inspect_url="steam://example")
    assert queued == cached
    assert queued["front"] == URL
    assert len(calls) == 3
    assert calls[0].headers["Prefer"] == "wait=10"
    assert calls[0].headers["Authorization"] == "Bearer test"
    assert calls[0].url == "https://render.medalbot.cc/v1/renders"
    assert calls[1].method == "GET"
    assert json.loads(calls[0].content) == {
        "inspectUrl": "steam://example",
        "views": ["preview", "front", "back"],
        "format": "webp",
    }


async def test_timeout_includes_submission_and_retains_key():
    async def handler(request):
        await asyncio.sleep(5)
        return httpx.Response(200, json=render())

    started = time.monotonic()
    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        with pytest.raises(RenderError) as caught:
            await client.render(
                inspect_url="steam://example", timeout=0.02, idempotency_key="retained"
            )
    assert time.monotonic() - started < 1
    assert caught.value.code == "wait_timeout"
    assert caught.value.idempotency_key == "retained"
    assert caught.value.render_id is None


async def test_timeout_after_admission_and_resume():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            200, json=render("queued" if len(calls) == 1 else "completed")
        )

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        with pytest.raises(RenderError) as caught:
            await client.render(inspect_url="steam://example", timeout=0.02)
        assert caught.value.render_id == ID
        assert caught.value.idempotency_key
        images = await client.renders.wait(caught.value.render_id)
        assert images["front"] == URL
    assert [r.method for r in calls] == ["POST", "GET"]


async def test_cancellation_stops_http_without_cancelling_shared_job():
    started, stopped = asyncio.Event(), asyncio.Event()
    calls = []

    async def handler(request):
        calls.append(request)
        started.set()
        try:
            await asyncio.sleep(5)
        finally:
            stopped.set()
        return httpx.Response(200, json=render())

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        task = asyncio.create_task(client.render(inspect_url="steam://example"))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped.is_set()
    assert len(calls) == 1
    assert calls[0].method == "POST"


async def test_terminal_failure_has_resume_fields_without_poll():
    failed = render("failed")
    failed["data"]["error"] = {"code": "capture_failed", "detail": "Capture failed"}
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=failed, headers={"x-request-id": "req_1"})

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        with pytest.raises(RenderError) as caught:
            await client.render(
                inspect_url="steam://example", idempotency_key="retained"
            )
    assert caught.value.code == "capture_failed"
    assert caught.value.render_id == ID
    assert caught.value.request_id == "req_1"
    assert caught.value.idempotency_key == "retained"
    assert len(calls) == 1


async def test_retry_preserves_generated_idempotency_key():
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            raise httpx.ConnectError("broken", request=request)
        if len(calls) == 2:
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(200, json=render())

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        await client.render(inspect_url="steam://example")
    assert len(calls) == 3
    assert len({r.headers["Idempotency-Key"] for r in calls}) == 1
    assert all(r.headers["Prefer"] == "wait=10" for r in calls)


@pytest.mark.parametrize(
    "body,expected_code",
    [
        (
            {
                "meta": {"requestId": "api_req"},
                "error": {
                    "status": 400,
                    "code": "invalid_inspect",
                    "detail": "Invalid inspect URL",
                    "title": "Bad request",
                    "type": "https://render.medalbot.cc/problems/invalid_inspect",
                },
            },
            "invalid_inspect",
        ),
        (
            {
                "error": {"code": "AUTHENTICATION_REQUIRED", "message": "Invalid key"},
                "meta": {"requestId": "gateway_req"},
            },
            "AUTHENTICATION_REQUIRED",
        ),
        (None, "http_401"),
    ],
)
async def test_errors_normalize_api_gateway_and_non_json(body, expected_code):
    def handler(request):
        if body is None:
            return httpx.Response(
                401, text="private proxy details", headers={"x-request-id": "proxy_req"}
            )
        return httpx.Response(401, json=body)

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        with pytest.raises(RenderError) as caught:
            await client.render(inspect_url="steam://example")
    assert caught.value.code == expected_code
    assert caught.value.status_code == 401
    assert caught.value.request_id
    assert caught.value.idempotency_key
    assert "private proxy details" not in str(caught.value)


@pytest.mark.parametrize(
    "body",
    [
        {"id": ID},
        render("failed"),
        {"meta": {"requestId": "req_1"}, "data": {"id": ID, "images": {"front": URL}}},
        {
            "meta": {"requestId": "req_1"},
            "data": {"id": ID, "images": {"front": {"url": URL}}},
        },
        render("surprise"),
    ],
)
async def test_invalid_response_fails_without_hanging(body):
    async with RenderClient(
        api_key="test",
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=body)),
    ) as client:
        with pytest.raises(RenderError, match="invalid|missing") as caught:
            await client.render(inspect_url="steam://example")
    assert caught.value.code == "invalid_response"


async def test_requested_views_and_lower_level_create():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=render(views=("front",)))

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        admitted = await client.renders.create(
            inspect_url="steam://example", views=["front"], format="png"
        )
        assert "Prefer" not in calls[0].headers
        assert json.loads(calls[0].content)["format"] == "png"
        images = await client.renders.wait(admitted.id, views=["front"])
        assert "preview" not in images
        with pytest.raises(KeyError):
            images["back"]
        await client.renders.get(ID)
        with pytest.raises(RenderError, match="missing back"):
            await client.render(inspect_url="steam://example", views=["back"])


async def test_changing_id_is_rejected():
    async with RenderClient(
        api_key="test",
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=render())),
    ) as client:
        with pytest.raises(RenderError) as caught:
            await client.renders.get("rnd_" + "c" * 32)
        assert caught.value.code == "invalid_response"


async def test_retry_after_is_inside_total_deadline():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(503, headers={"Retry-After": "120"})

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        with pytest.raises(RenderError) as caught:
            await client.render(inspect_url="steam://example", timeout=0.02)
    assert caught.value.code == "wait_timeout"
    assert len(calls) == 1


async def test_transport_retries_are_bounded(monkeypatch):
    monkeypatch.setattr("medalbot_render.client._retry_delay", lambda response, attempt: 0)
    calls = []

    def handler(request):
        calls.append(request)
        raise httpx.ConnectError("private details")

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        with pytest.raises(RenderError) as caught:
            await client.render(inspect_url="steam://example")
    assert caught.value.code == "transport_error"
    assert caught.value.idempotency_key
    assert len(calls) == 4
    assert "private details" not in str(caught.value)


async def test_deadline_interrupts_trickling_body_and_closes_stream():
    closed = asyncio.Event()

    class SlowBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            while True:
                yield b" "
                await asyncio.sleep(0.005)

        async def aclose(self):
            closed.set()

    def handler(request):
        return httpx.Response(200, stream=SlowBody())

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        with pytest.raises(RenderError) as caught:
            await client.render(inspect_url="steam://example", timeout=0.025)
    assert caught.value.code == "wait_timeout"
    assert closed.is_set()


async def test_cancelled_before_scheduling_submits_nothing():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=render())

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        task = asyncio.create_task(client.render(inspect_url="steam://example"))
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert not calls


async def test_non_json_success_is_invalid_response():
    async with RenderClient(
        api_key="test",
        transport=httpx.MockTransport(
            lambda r: httpx.Response(200, text="<html>proxy</html>")
        ),
    ) as client:
        with pytest.raises(RenderError) as caught:
            await client.render(inspect_url="steam://example")
    assert caught.value.code == "invalid_response"


async def test_invalid_arguments_fail_before_http():
    def handler(request):
        pytest.fail("Invalid arguments must not reach the API")

    async with RenderClient(
        api_key="test", transport=httpx.MockTransport(handler)
    ) as client:
        for options in (
            {"views": []},
            {"views": ["front", "front"]},
            {"idempotency_key": ""},
            {"timeout": 0},
        ):
            with pytest.raises(ValueError):
                await client.render(inspect_url="steam://example", **options)
        with pytest.raises(ValueError):
            await client.renders.get("../invalid")


def test_retry_after_supports_http_dates():
    from datetime import UTC, datetime, timedelta
    from email.utils import format_datetime

    from medalbot_render.client import _retry_delay

    date = format_datetime(datetime.now(UTC) + timedelta(seconds=5), usegmt=True)
    delay = _retry_delay(httpx.Response(429, headers={"Retry-After": date}), 0)
    assert 3.9 <= delay <= 5.1

@pytest.mark.parametrize("render_id", [ID, "rnd_" + "a" * 32])
async def test_resumes_both_ulid_and_saved_uuid_ids(render_id):
    async def handler(request):
        assert request.url.path == f"/v1/renders/{render_id}"
        body = render()
        body["data"]["id"] = render_id
        return httpx.Response(200, json=body)

    async with RenderClient(api_key="test", transport=httpx.MockTransport(handler)) as client:
        assert (await client.renders.wait(render_id))["front"] == URL
