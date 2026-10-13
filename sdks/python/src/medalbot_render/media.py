from __future__ import annotations

import re
from typing import Literal
from urllib.parse import urlsplit

ImageVariant = Literal["small", "card", "zoom"]
_original = re.compile(
    r"https?://([^/\s\x00-\x1f\x7f\\?#]+)/v1/([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])\.(?:webp|png)"
)


def image_url(original: str, variant: ImageVariant) -> str:
    """Build a public derivative URL without fetching or changing the original."""
    if variant not in ("small", "card", "zoom"):
        raise ValueError("Image variant must be small, card, or zoom")
    match = _original.fullmatch(original)
    if not match or "@" in match[1]:
        raise ValueError("Expected an absolute HTTP(S) original image URL with path /v1/<canonical SHA-256>.webp or .png and no credentials, query, or fragment")
    parsed = urlsplit(original)
    if not parsed.hostname:
        raise ValueError("Original image URL must have a host")
    # Access validates malformed and out-of-range ports.
    _ = parsed.port
    return f"{parsed.scheme}://{parsed.netloc}/d/v1/{match[2]}_{variant}.webp"
