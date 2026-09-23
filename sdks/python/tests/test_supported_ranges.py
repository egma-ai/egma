"""The tested framework ranges, read from the extras and checked at import.

The ``[livekit]`` and ``[pipecat]`` extras in ``pyproject.toml`` hold each
range. The SDK reads them back from its installed metadata and logs once
when the installed framework is outside, so the range is written once.
"""

from __future__ import annotations

import logging

import pytest

from egma import _frameworks

RANGES = [
    pytest.param("livekit-agents", "livekit", "1.6.6", "1.9", id="livekit"),
    pytest.param("pipecat-ai", "pipecat", "1.9", "1.12", id="pipecat"),
]


@pytest.mark.parametrize(("distribution", "extra", "floor", "ceiling"), RANGES)
def test_the_range_is_read_from_the_extra(distribution, extra, floor, ceiling):
    declared = _frameworks.supported_range(distribution, extra)

    assert declared is not None
    assert (declared.floor, declared.ceiling) == (floor, ceiling)
    assert declared.text == f">={floor},<{ceiling}"


@pytest.mark.parametrize(
    ("distribution", "extra", "installed", "warned"),
    [
        ("livekit-agents", "livekit", "1.6.5", True),
        ("livekit-agents", "livekit", "1.6.6", False),
        ("livekit-agents", "livekit", "1.8.9", False),
        ("livekit-agents", "livekit", "1.9.0", True),
        ("livekit-agents", "livekit", "1.9.0rc1", True),
        ("pipecat-ai", "pipecat", "1.8.1", True),
        ("pipecat-ai", "pipecat", "1.9.0", False),
        ("pipecat-ai", "pipecat", "1.11.4", False),
        ("pipecat-ai", "pipecat", "1.12.0", True),
        ("pipecat-ai", "pipecat", "2.0", True),
        ("pipecat-ai", "pipecat", "not a version", False),
        ("pipecat-ai", "pipecat", "unknown", False),
    ],
)
def test_the_range_check_warns_only_outside_the_range(
    monkeypatch, caplog, distribution, extra, installed, warned
):
    monkeypatch.setattr(_frameworks, "installed_version", lambda _name: installed)

    with caplog.at_level(logging.WARNING, logger="egma"):
        _frameworks.warn_outside_range(distribution, extra)

    said = [record.getMessage() for record in caplog.records]
    assert bool(said) is warned
    if warned:
        assert installed in said[0]
        assert f'pip install "egma[{extra}]"' in said[0]


def test_an_undeclared_framework_has_no_range():
    assert _frameworks.supported_range("livekit-agents", "pipecat") is None
    assert _frameworks.supported_range("no-such-framework", "livekit") is None
