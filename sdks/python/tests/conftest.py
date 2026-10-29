import pytest


@pytest.fixture(autouse=True)
def _telemetry_off(monkeypatch: pytest.MonkeyPatch) -> None:
    # Tests that count requests see only the render calls; test_telemetry.py turns it back on.
    monkeypatch.setenv("MEDALBOT_TELEMETRY", "0")
