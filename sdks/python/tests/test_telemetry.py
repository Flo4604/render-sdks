import json
import re
import tomllib
from pathlib import Path

import httpx
import pytest

from medalbot_render import RenderClient, RenderError
from medalbot_render.telemetry import VERSION

ID = "rnd_01ARZ3NDEKTSV4RRFFQ69G5FAV"
URL = "https://img.medalbot.cc/example.webp"


@pytest.fixture(autouse=True)
def _telemetry_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MEDALBOT_TELEMETRY", raising=False)


def envelope(data):
    return {"meta": {"requestId": "req_fixture"}, "data": data}


class Server:
    """Queues the render once, then completes it, and records every request."""

    def __init__(self, telemetry_status=202, fail=False):
        self.requests: list[httpx.Request] = []
        self.telemetry_status = telemetry_status
        self.fail = fail

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/v1/telemetry/sdk":
            return httpx.Response(self.telemetry_status)
        if self.fail:
            return httpx.Response(
                422,
                headers={"X-Request-Id": "req_failed"},
                json={"meta": {"requestId": "req_failed"}, "error": {"code": "unsupported_item", "detail": "x"}},
            )
        if request.method == "POST":
            return httpx.Response(
                202,
                headers={
                    "X-Request-Id": "req_submit",
                    "X-Trace-Id": "a" * 32,
                    "X-Render-Cache": "miss",
                    "Server-Timing": "app;dur=1890.25",
                },
                json=envelope({"id": ID, "status": "queued"}),
            )
        return httpx.Response(
            200,
            headers={"X-Request-Id": "req_poll", "Server-Timing": "app;dur=3.5"},
            json=envelope({"id": ID, "images": {"front": URL}}),
        )

    def renders(self):
        return [r for r in self.requests if r.url.path != "/v1/telemetry/sdk"]

    def batches(self):
        return [json.loads(r.content) for r in self.requests if r.url.path == "/v1/telemetry/sdk"]


def client(server, **options):
    return RenderClient(api_key="fixture", transport=httpx.MockTransport(server), **options)


async def test_every_request_names_the_sdk_and_carries_one_trace_per_call():
    server = Server()
    async with client(server, telemetry=False) as c:
        await c.render(inspect_url="steam://example", views=["front"])
        await c.render(inspect_url="steam://example", views=["front"])
    requests = server.renders()
    for request in requests:
        assert re.fullmatch(
            rf"medalbot-render-python/{re.escape(VERSION)} \([a-z]+/[\d.]+; [a-z0-9_]+\)",
            request.headers["User-Agent"],
        )
        assert request.headers["X-Medalbot-SDK"] == f"python/{VERSION}"
    parents = [r.headers["traceparent"] for r in requests]
    for value in parents:
        assert re.fullmatch(r"00-[0-9a-f]{32}-[0-9a-f]{16}-01", value)
    trace = [value.split("-")[1] for value in parents]
    assert trace[0] == trace[1], "submit and poll share a trace"
    assert parents[0] != parents[1], "each request has its own span"
    assert trace[0] != trace[2], "calls have their own trace"


async def test_a_render_call_reports_its_timings_server_ids_and_counts():
    server = Server()
    async with client(server, telemetry_sample_rate=1) as c:
        assert await c.render(inspect_url="steam://example", views=["front"]) == {"front": URL}
        await c.flush_telemetry()
    [batch] = server.batches()
    assert batch["schema"] == 1
    assert re.fullmatch(r"[0-9a-f]{16}", batch["session"])
    assert batch["sdk"]["name"] == "python"
    assert batch["sdk"]["version"] == VERSION
    [event] = batch["events"]
    assert event["name"] == "sdk_call"
    assert event["sample_rate"] == 1
    fields = event["fields"]
    assert fields["op"] == "render"
    assert fields["outcome"] == "ok"
    assert fields["views"] == 1
    assert fields["requests"] == 2
    assert fields["polls"] == 1
    assert fields["retries"] == 0
    assert fields["server_ms"] == 1894
    assert fields["poll_wait_ms"] >= 450
    assert fields["total_ms"] >= fields["poll_wait_ms"]
    assert fields["request_id"] == "req_submit"
    assert fields["server_trace_id"] == "a" * 32
    assert fields["cache"] == "miss"
    assert fields["render_id"] == ID
    assert fields["trace_id"] == server.renders()[0].headers["traceparent"].split("-")[1]
    assert fields["inflight"] == 0
    report = next(r for r in server.requests if r.url.path == "/v1/telemetry/sdk")
    assert report.headers["Authorization"] == "Bearer fixture"
    assert b"fixture" not in report.content and b"steam://" not in report.content


async def test_a_failed_call_is_always_reported_with_its_code():
    server = Server(fail=True)
    async with client(server, telemetry_sample_rate=0.000001) as c:
        with pytest.raises(RenderError):
            await c.render(inspect_url="steam://example")
    [event] = server.batches()[0]["events"]
    assert event["sample_rate"] == 1
    assert event["fields"]["outcome"] == "error"
    assert event["fields"]["code"] == "unsupported_item"
    assert event["fields"]["status"] == 422
    assert event["fields"]["request_id"] == "req_failed"


async def test_closing_the_client_sends_buffered_timings():
    server = Server()
    async with client(server, telemetry_sample_rate=1) as c:
        await c.render(inspect_url="steam://example", views=["front"])
        assert server.batches() == []
    assert len(server.batches()) == 1


async def test_telemetry_off_sends_nothing_from_the_option_or_the_environment(monkeypatch):
    server = Server()
    async with client(server, telemetry=False) as c:
        await c.render(inspect_url="steam://example", views=["front"])
    monkeypatch.setenv("MEDALBOT_TELEMETRY", "0")
    async with client(server) as c:
        await c.render(inspect_url="steam://example", views=["front"])
    assert server.batches() == []


async def test_a_refused_or_failing_report_never_reaches_the_caller():
    server = Server(telemetry_status=404)
    async with client(server, telemetry_sample_rate=1) as c:
        await c.render(inspect_url="steam://example", views=["front"])
        await c.flush_telemetry()
        await c.render(inspect_url="steam://example", views=["front"])
        await c.flush_telemetry()
    assert len(server.batches()) == 1

    async def broken(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/telemetry/sdk":
            raise httpx.ConnectError("refused")
        return await Server()(request)

    async with client(broken, telemetry_sample_rate=1) as c:
        await c.render(inspect_url="steam://example", views=["front"])


def test_the_reported_version_is_the_package_version():
    project = tomllib.loads((Path(__file__).parent.parent / "pyproject.toml").read_text())
    assert VERSION == project["project"]["version"]
