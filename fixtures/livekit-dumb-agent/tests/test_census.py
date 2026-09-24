"""The SDK's LiveKit seam, on the livekit-agents version this fixture pins."""

from __future__ import annotations

from egma import export


def test_the_supported_livekit_version_exposes_its_current_provider():
    """The SDK reuses this provider so it cannot erase Cloud observability."""

    assert export._livekit_provider() is not None
