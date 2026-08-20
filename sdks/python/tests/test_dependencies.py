"""The dependency boundary the published wheel promises to support."""

from __future__ import annotations

from importlib.metadata import requires


def test_openai_stays_on_the_major_livekit_1_6_supports():
    declared = requires("egma") or []
    openai = next(
        (requirement for requirement in declared if requirement.startswith("openai")),
        None,
    )

    assert openai is not None
    assert ">=2" in openai
    assert "<3" in openai
