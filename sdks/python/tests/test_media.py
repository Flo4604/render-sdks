import pytest

from medalbot_render import image_url

HASH = "A" * 43
ORIGINAL = f"https://img.medalbot.cc/v1/{HASH}.webp"


@pytest.mark.parametrize("origin", ["https://img.medalbot.cc", "http://localhost:8080", "https://images.example:8443", "http://[::1]:8080"])
@pytest.mark.parametrize("format", ["webp", "png"])
@pytest.mark.parametrize("variant", ["small", "card", "zoom"])
def test_media_url(origin, format, variant):
    assert image_url(f"{origin}/v1/{HASH}.{format}", variant) == f"{origin}/d/v1/{HASH}_{variant}.webp"


@pytest.mark.parametrize("value", [
    f"/v1/{HASH}.webp", ORIGINAL + "?", ORIGINAL + "?w=20", ORIGINAL + "#", ORIGINAL + "#x",
    ORIGINAL.replace("https:", "file:"), ORIGINAL.replace("img.medalbot.cc", "user:pass@img.medalbot.cc"),
    ORIGINAL.replace("img.medalbot.cc", "@img.medalbot.cc"), ORIGINAL.replace("img.medalbot.cc", "img.medalbot.cc:65536"),
    ORIGINAL.replace("/v1/", "/x/../v1/"), ORIGINAL.replace("/v1/", "/v1%2F"),
    ORIGINAL.replace(HASH, HASH[:-1] + "B"), ORIGINAL.replace(HASH, HASH + "="),
    ORIGINAL.replace(".webp", ".jpg"), ORIGINAL.replace(".webp", ".webp.webp"),
    ORIGINAL + "\n", " " + ORIGINAL, ORIGINAL.replace("img.medalbot.cc", "img.\x00medalbot.cc"),
    ORIGINAL.replace("img.medalbot.cc", "img.\u00a0medalbot.cc"), ORIGINAL.replace("/v1/", "\\v1/"),
    image_url(ORIGINAL, "card"),
])
def test_invalid_original(value):
    with pytest.raises(ValueError):
        image_url(value, "card")


def test_invalid_variant():
    with pytest.raises(ValueError):
        image_url(ORIGINAL, "huge")  # type: ignore[arg-type]
