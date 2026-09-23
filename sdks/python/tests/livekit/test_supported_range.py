"""A worker outside the tested livekit-agents range is told so, once, at import."""

from __future__ import annotations

import logging
from importlib.metadata import PackageNotFoundError

import pytest

import egma.livekit


@pytest.mark.parametrize(
    ("installed", "warned"),
    [
        ("1.6.5", True),
        ("1.6.6", False),
        ("1.8.9", False),
        ("1.9.0", True),
        ("1.9.0rc1", True),
        ("2.0", True),
        ("not a version", False),
    ],
)
def test_the_range_check_warns_only_outside_the_tested_range(
    monkeypatch, caplog, installed, warned
):
    monkeypatch.setattr(egma.livekit, "version", lambda _name: installed)

    with caplog.at_level(logging.WARNING, logger="egma"):
        egma.livekit._warn_outside_supported_range()

    said = [record.getMessage() for record in caplog.records]
    assert bool(said) is warned
    if warned:
        assert installed in said[0]
        assert 'pip install "egma[livekit]"' in said[0]


def test_the_range_check_is_quiet_when_livekit_has_no_metadata(monkeypatch, caplog):
    def missing(_name: str) -> str:
        raise PackageNotFoundError("livekit-agents")

    monkeypatch.setattr(egma.livekit, "version", missing)

    with caplog.at_level(logging.WARNING, logger="egma"):
        egma.livekit._warn_outside_supported_range()

    assert caplog.records == []
