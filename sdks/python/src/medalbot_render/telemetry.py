"""Identification headers and call timings.

Every request names the SDK and carries a W3C traceparent whose trace id is fixed for one
call. Unless the caller opts out, each finished call becomes one ``sdk_call`` event; events
go to ``POST /v1/telemetry/sdk`` in batches, and a failed send is dropped. Nothing here
raises into the caller or delays a render.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import platform
import random
import re
import secrets
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _package_version
from typing import Any

import httpx

try:
    VERSION = _package_version("medalbot-render")
except PackageNotFoundError:  # pragma: no cover - only outside an installed package
    VERSION = "0.0.0"

_RUNTIME = f"{platform.python_implementation().lower()}/{platform.python_version()}"
_OS = re.sub(r"[^a-z0-9_]", "_", sys.platform.lower())[:24]

IDENTITY = {
    "User-Agent": f"medalbot-render-python/{VERSION} ({_RUNTIME}; {_OS})",
    "X-Medalbot-SDK": f"python/{VERSION}",
}

# Calls at least this slow, and every failed call, are always reported, so the sample never
# hides the calls a customer complains about. The rest are reported at the sample rate.
_SLOW_MS = 3000
_MAX_BATCH = 100
_MAX_BUFFERED = 1000
_FLUSH_SECONDS = 10.0
DEFAULT_SAMPLE_RATE = 0.25


def sample_rate(enabled: bool, rate: float) -> float | None:
    """The sample rate the client options name, or None when telemetry is off.

    ``MEDALBOT_TELEMETRY=0`` (or ``false``, ``off``) turns it off for every client.
    """
    if not enabled:
        return None
    if os.environ.get("MEDALBOT_TELEMETRY", "").strip().lower() in ("0", "false", "off"):
        return None
    if not rate > 0:
        return None
    return min(1.0, rate)


@dataclass
class Call:
    """What one call observed.

    HTTP time covers each attempt from send to the end of the body; the sleeps between
    polls and between retries are counted apart from it. ``server_ms`` sums the API's own
    ``Server-Timing`` over every response, so network and gateway time is
    ``http_ms - server_ms``.
    """

    op: str
    inflight: int
    views: int | None = None
    trace_id: str = field(default_factory=lambda: secrets.token_hex(16))
    started: float = field(default_factory=time.perf_counter)
    http_ms: float = 0
    server_ms: float = 0
    connect_ms: float = 0
    connections: int = 0
    requests: int = 0
    retries: int = 0
    backoff_ms: float = 0
    polls: int = 0
    poll_wait_ms: float = 0
    ttfb_ms: float | None = None
    status: int = 0
    request_id: str | None = None
    server_trace_id: str | None = None
    cache: str | None = None
    render_id: str | None = None

    def traceparent(self) -> str:
        return f"00-{self.trace_id}-{secrets.token_hex(8)}-01"

    def trace_hook(self, started: float) -> Callable[[str, dict[str, Any]], Awaitable[None]]:
        """An httpx ``trace`` extension that times new connections and the first byte."""
        opened: dict[str, float] = {}

        async def hook(name: str, info: dict[str, Any]) -> None:
            now = time.perf_counter()
            if name.endswith((".connect_tcp.started", ".start_tls.started")):
                opened[name.rsplit(".", 1)[0]] = now
            elif name.endswith((".connect_tcp.complete", ".start_tls.complete")):
                began = opened.pop(name.rsplit(".", 1)[0], None)
                if began is not None:
                    self.connect_ms += (now - began) * 1000
                if name.endswith(".connect_tcp.complete"):
                    self.connections += 1
            elif name.endswith(".receive_response_headers.complete") and self.ttfb_ms is None:
                self.ttfb_ms = (now - started) * 1000

        return hook

    def response(self, response: httpx.Response, started: float) -> None:
        self.requests += 1
        self.status = response.status_code
        self.http_ms += (time.perf_counter() - started) * 1000
        timing = re.search(r"(?:^|,)\s*app;dur=([\d.]+)", response.headers.get("server-timing", ""))
        if timing:
            self.server_ms += float(timing.group(1))
        self.request_id = self.request_id or response.headers.get("x-request-id")
        self.server_trace_id = self.server_trace_id or response.headers.get("x-trace-id")
        self.cache = self.cache or response.headers.get("x-render-cache")

    def failure(self, started: float) -> None:
        self.requests += 1
        self.http_ms += (time.perf_counter() - started) * 1000

    def event(self, error: BaseException | None) -> dict[str, str | int]:
        fields: dict[str, str | int] = {
            "op": self.op,
            "outcome": "ok" if error is None else "error",
            "total_ms": round((time.perf_counter() - self.started) * 1000),
            "inflight": self.inflight,
            "status": self.status,
            "trace_id": self.trace_id,
            "http_ms": round(self.http_ms),
            "server_ms": round(self.server_ms),
            "requests": self.requests,
            "retries": self.retries,
            "backoff_ms": round(self.backoff_ms),
            "polls": self.polls,
            "poll_wait_ms": round(self.poll_wait_ms),
        }
        if self.connections:
            fields["connections"] = self.connections
            fields["connect_ms"] = round(self.connect_ms)
        if error is not None:
            fields["code"] = error_code(error)
        optional = {
            "ttfb_ms": None if self.ttfb_ms is None else round(self.ttfb_ms),
            "views": self.views,
            "request_id": self.request_id and self.request_id[:64],
            "server_trace_id": self.server_trace_id and self.server_trace_id[:64],
            "cache": self.cache and self.cache[:16],
            "render_id": self.render_id,
        }
        fields.update({name: value for name, value in optional.items() if value is not None})
        return fields


def error_code(error: BaseException) -> str:
    code = getattr(error, "code", None)
    if isinstance(code, str):
        lower = code.lower()
        return lower if re.fullmatch(r"[a-z0-9_]{1,64}", lower) else "other"
    if isinstance(error, asyncio.CancelledError):
        return "cancelled"
    if isinstance(error, ValueError):
        return "invalid_input"
    return "client_error"


class Reporter:
    """Buffers events and sends them in batches with the client's own connection pool."""

    def __init__(
        self,
        http: httpx.AsyncClient,
        rate: float,
        rng: Callable[[], float] = random.random,
    ) -> None:
        self._http = http
        self._rate = rate
        self._random = rng
        self._buffer: list[dict[str, object]] = []
        self._timer: asyncio.TimerHandle | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        self._stopped = False
        self._session = secrets.token_hex(8)

    def record(self, call: Call, error: BaseException | None) -> None:
        if self._stopped:
            return
        with contextlib.suppress(Exception):
            fields = call.event(error)
            always = error is not None or int(fields["total_ms"]) >= _SLOW_MS
            if not always and self._random() >= self._rate:
                return
            if len(self._buffer) >= _MAX_BUFFERED:
                return
            self._buffer.append(
                {
                    "name": "sdk_call",
                    "t": round(time.time() * 1000),
                    "sample_rate": 1 if always else self._rate,
                    "fields": fields,
                }
            )
            if len(self._buffer) >= _MAX_BATCH:
                self._spawn()
            elif self._timer is None:
                self._timer = asyncio.get_running_loop().call_later(_FLUSH_SECONDS, self._spawn)

    def _spawn(self) -> None:
        self._timer = None
        task = asyncio.ensure_future(self._send_buffered())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _send_buffered(self) -> None:
        while self._buffer and not self._stopped:
            events, self._buffer = self._buffer[:_MAX_BATCH], self._buffer[_MAX_BATCH:]
            body = {
                "schema": 1,
                "session": self._session,
                "sdk": {"name": "python", "version": VERSION, "runtime": _RUNTIME, "os": _OS},
                "events": events,
            }
            try:
                response = await self._http.post(
                    "/v1/telemetry/sdk",
                    content=json.dumps(body),
                    headers={**IDENTITY, "Content-Type": "application/json"},
                    timeout=5,
                )
            except httpx.HTTPError:
                response = None
            # No route, or a key the route refuses: stop reporting for this client.
            if response is not None and response.status_code in (401, 403, 404, 410):
                self._stopped = True
                self._buffer = []

    async def flush(self, timeout: float = 5) -> None:
        """Send every buffered event, waiting at most ``timeout`` seconds."""
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        with contextlib.suppress(Exception):
            async with asyncio.timeout(timeout):
                if self._tasks:
                    await asyncio.gather(*self._tasks, return_exceptions=True)
                await self._send_buffered()
