from __future__ import annotations

import asyncio
import math
import random
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from types import TracebackType
from typing import Self, TypeVar
from uuid import uuid4

import httpx
from pydantic import ValidationError

from .models import (
    CompletedRender,
    FailedRender,
    Format,
    Images,
    Render,
    RenderError,
    RenderResponse,
    View,
)

T = TypeVar("T")
_VIEWS: tuple[View, ...] = ("preview", "front", "back")
_RENDER_ID = re.compile(r"rnd_(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[a-f0-9]{32})\Z")


@dataclass
class _Context:
    render_id: str | None = None
    idempotency_key: str | None = None
    request_id: str | None = None


def _validate_id(render_id: str) -> None:
    if not _RENDER_ID.fullmatch(render_id):
        raise ValueError("render_id must be a prefixed ULID or an existing render ID")


def _views(views: Sequence[View] | None) -> tuple[View, ...]:
    result = tuple(views) if views is not None else _VIEWS
    if not result or any(view not in _VIEWS for view in result):
        raise ValueError("views must contain preview, front, or back")
    if len(set(result)) != len(result):
        raise ValueError("views must be unique")
    return result


def _submission(
    inspect_url: str,
    views: Sequence[View] | None,
    format: Format,
    idempotency_key: str | None,
    stat_trak: int | None,
) -> tuple[dict[str, object], _Context, tuple[View, ...]]:
    if not isinstance(inspect_url, str) or not 1 <= len(inspect_url) <= 32768:
        raise ValueError("inspect_url must contain 1 to 32768 characters")
    requested = _views(views)
    if format not in ("webp", "png"):
        raise ValueError("format must be webp or png")
    if stat_trak is not None and (
        type(stat_trak) is not int or not 0 <= stat_trak <= 999999
    ):
        raise ValueError("stat_trak must be an integer from 0 to 999999")
    key = str(uuid4()) if idempotency_key is None else idempotency_key
    if not re.fullmatch(r"[\x21-\x7e]{1,128}", key):
        raise ValueError(
            "idempotency_key must contain 1 to 128 visible ASCII characters"
        )
    body: dict[str, object] = {
        "inspectUrl": inspect_url, "views": list(requested), "format": format
    }
    if stat_trak is not None:
        body["statTrak"] = stat_trak
    return (
        body,
        _Context(idempotency_key=key),
        requested,
    )


def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
    retry_after = 0.0
    if response is not None:
        value = response.headers.get("Retry-After", "")
        try:
            retry_after = float(value)
        except ValueError:
            try:
                date = parsedate_to_datetime(value)
                if date.tzinfo is None:
                    date = date.replace(tzinfo=UTC)
                retry_after = (date - datetime.now(UTC)).total_seconds()
            except (ValueError, TypeError, OverflowError):
                pass
    if not math.isfinite(retry_after):
        retry_after = 0.0
    return min(10.0, max(0.2 * math.pow(2, attempt), retry_after)) + random.uniform(
        0, 0.1
    )


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


class RenderClient:
    """Async render client. Owns its HTTP connection pool; close after use."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://render.medalbot.cc",
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not api_key.strip():
            raise ValueError("api_key must not be empty")
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
            },
            transport=transport,
            timeout=httpx.Timeout(30, connect=10),
            follow_redirects=False,
        )
        self.renders = Renders(self)

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _bounded(
        self,
        operation: Callable[[], Awaitable[T]],
        timeout: float,
        context: _Context,
    ) -> T:
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be a positive, finite number of seconds")
        deadline = asyncio.timeout(timeout)
        try:
            async with deadline:
                return await operation()
        except TimeoutError:
            if not deadline.expired():
                raise
            raise RenderError(
                "wait_timeout",
                "Render continues; resume with renders.wait(render_id)"
                if context.render_id
                else "Submission timed out; retry with the same idempotency key",
                render_id=context.render_id,
                request_id=context.request_id,
                idempotency_key=context.idempotency_key,
            ) from None
        except RenderError as error:
            error.render_id = error.render_id or context.render_id
            error.idempotency_key = error.idempotency_key or context.idempotency_key
            error.request_id = error.request_id or context.request_id
            raise

    async def _request(
        self,
        method: str,
        path: str,
        context: _Context,
        *,
        body: dict[str, object] | None = None,
        wait: bool = False,
    ) -> Render:
        headers = {}
        if context.idempotency_key and method == "POST":
            headers["Idempotency-Key"] = context.idempotency_key
        if wait:
            headers["Prefer"] = "wait=10"
        for attempt in range(4):
            try:
                response = await self._http.request(
                    method, path, json=body, headers=headers
                )
            except httpx.TransportError:
                if attempt == 3:
                    raise RenderError(
                        "transport_error", "API connection failed after four attempts"
                    ) from None
                await asyncio.sleep(_retry_delay(None, attempt))
                continue
            context.request_id = (
                response.headers.get("x-request-id") or context.request_id
            )
            if response.status_code in (429, 502, 503, 504) and attempt < 3:
                await asyncio.sleep(_retry_delay(response, attempt))
                continue
            try:
                value = response.json()
            except ValueError:
                value = None
            data = value if isinstance(value, dict) else {}
            meta = data.get("meta")
            if isinstance(meta, dict):
                context.request_id = _text(meta.get("requestId")) or context.request_id
            if not response.is_success:
                nested = data.get("error")
                error = nested if isinstance(nested, dict) else {}
                raise RenderError(
                    _text(error.get("code")) or f"http_{response.status_code}",
                    _text(error.get("detail"))
                    or _text(error.get("message"))
                    or f"API returned HTTP {response.status_code}",
                    request_id=context.request_id,
                    status_code=response.status_code,
                )
            try:
                envelope = RenderResponse.model_validate(value)
                context.request_id = envelope.meta.request_id
                result = envelope.data
                if context.render_id and result.id != context.render_id:
                    raise ValueError("Response render ID changed")
            except (ValidationError, ValueError):
                raise RenderError(
                    "invalid_response", "API returned an invalid render response"
                ) from None
            context.render_id = result.id
            return result
        raise AssertionError("Unreachable retry state")

    async def _poll(
        self,
        context: _Context,
        expected: tuple[View, ...] | None,
        initial: Render | None = None,
    ) -> Images:
        assert context.render_id is not None
        result = initial or await self._request(
            "GET", f"/v1/renders/{context.render_id}", context
        )
        interval = 0.5
        while True:
            if isinstance(result, FailedRender):
                raise RenderError(result.error.code, result.error.detail)
            if isinstance(result, CompletedRender):
                for view in expected or ():
                    if view not in result.images:
                        raise RenderError(
                            "invalid_response", f"Completed render is missing {view}"
                        )
                return result.images
            await asyncio.sleep(interval)
            result = await self._request(
                "GET", f"/v1/renders/{context.render_id}", context
            )
            interval = min(2.0, interval * 1.5)

    async def render(
        self,
        *,
        inspect_url: str,
        views: Sequence[View] | None = None,
        format: Format = "webp",
        stat_trak: int | None = None,
        timeout: float = 120,
        idempotency_key: str | None = None,
    ) -> Images:
        """Return finished images, including cached results, within one total deadline."""
        body, context, requested = _submission(
            inspect_url, views, format, idempotency_key, stat_trak
        )

        async def run() -> Images:
            result = await self._request(
                "POST", "/v1/renders", context, body=body, wait=True
            )
            return await self._poll(context, requested, result)

        return await self._bounded(run, timeout, context)


class Renders:
    """Lower-level admission, status, and resume operations."""

    def __init__(self, client: RenderClient) -> None:
        self._client = client

    async def create(
        self,
        *,
        inspect_url: str,
        views: Sequence[View] | None = None,
        format: Format = "webp",
        stat_trak: int | None = None,
        timeout: float = 120,
        idempotency_key: str | None = None,
    ) -> Render:
        body, context, _ = _submission(
            inspect_url, views, format, idempotency_key, stat_trak
        )
        return await self._client._bounded(
            lambda: self._client._request("POST", "/v1/renders", context, body=body),
            timeout,
            context,
        )

    async def get(self, render_id: str, *, timeout: float = 120) -> Render:
        _validate_id(render_id)
        context = _Context(render_id=render_id)
        return await self._client._bounded(
            lambda: self._client._request("GET", f"/v1/renders/{render_id}", context),
            timeout,
            context,
        )

    async def wait(
        self,
        render_id: str,
        *,
        timeout: float = 120,
        views: Sequence[View] | None = None,
    ) -> Images:
        _validate_id(render_id)
        context = _Context(render_id=render_id)
        expected = _views(views) if views is not None else None
        return await self._client._bounded(
            lambda: self._client._poll(context, expected), timeout, context
        )
