"""The dependency boundary the published wheel promises to support."""

from __future__ import annotations

import re
from importlib.metadata import requires


def _declared() -> list[tuple[str, str, str]]:
    """Every requirement as (name, specifier, extra); extra is "" for the base."""
    found = []
    for requirement in requires("egma") or []:
        spec, _, marker = requirement.partition(";")
        name = re.match(r"[A-Za-z0-9_.-]+", spec.strip()).group(0).lower()
        extra = re.search(r"extra\s*==\s*['\"]([^'\"]+)['\"]", marker)
        found.append((name, spec.strip()[len(name) :], extra.group(1) if extra else ""))
    return found


def test_the_base_install_carries_no_agent_framework():
    base = {name for name, _, extra in _declared() if not extra}

    assert not any(name.startswith("livekit") for name in base)
    assert not any(name.startswith("pipecat") for name in base)
    assert "openai" not in base


def test_livekit_and_its_openai_bound_come_with_the_livekit_extra():
    livekit = {name: spec for name, spec, extra in _declared() if extra == "livekit"}

    assert ">=1.6.6" in livekit["livekit-agents"]
    assert "<1.9" in livekit["livekit-agents"]
    assert ">=2" in livekit["openai"]
    assert "<3" in livekit["openai"]


def test_the_runtime_range_check_matches_the_livekit_extra():
    import egma.livekit

    livekit = {name: spec for name, spec, extra in _declared() if extra == "livekit"}
    declared = sorted(livekit["livekit-agents"].replace(" ", "").split(","))
    checked = sorted(egma.livekit.SUPPORTED_LIVEKIT_AGENTS.split(","))
    assert declared == checked
