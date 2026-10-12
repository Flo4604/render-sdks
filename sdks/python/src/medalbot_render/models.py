from __future__ import annotations

from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    StringConstraints,
    TypeAdapter,
)

View = Literal["preview", "front", "back"]
Format = Literal["png", "webp"]
RenderId = Annotated[str, StringConstraints(pattern=r"^rnd_(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[a-f0-9]{32})$")]
Images = dict[View, str]
_url = TypeAdapter(HttpUrl)


def _validate_url(value: str) -> str:
    _url.validate_python(value)
    return value


ImageUrl = Annotated[str, AfterValidator(_validate_url)]


class _Model(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True, extra="forbid")


class Failure(_Model):
    code: str
    detail: str


class CompletedRender(_Model):
    id: RenderId
    images: dict[View, ImageUrl] = Field(min_length=1, max_length=3)


class PendingRender(_Model):
    id: RenderId
    status: Literal["queued", "rendering", "processing"]


class FailedRender(_Model):
    id: RenderId
    status: Literal["failed"]
    error: Failure


Render = CompletedRender | PendingRender | FailedRender


class _Meta(_Model):
    request_id: str = Field(alias="requestId", min_length=1)


class RenderResponse(_Model):
    meta: _Meta
    data: Render


class RenderError(Exception):
    """API, rendering, or local deadline error with resume information."""

    def __init__(
        self,
        code: str,
        detail: str,
        *,
        render_id: str | None = None,
        request_id: str | None = None,
        idempotency_key: str | None = None,
        status_code: int | None = None,
    ) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.render_id = render_id
        self.request_id = request_id
        self.idempotency_key = idempotency_key
        self.status_code = status_code
