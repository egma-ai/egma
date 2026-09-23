"""The dependency boundary the published wheel promises to support."""

from __future__ import annotations

import re
from importlib.metadata import PackageNotFoundError, distribution, requires

import pytest
from packaging.requirements import Requirement


def _installed(name: str) -> bool:
    try:
        distribution(name)
    except PackageNotFoundError:
        return False
    return True


needs_livekit = pytest.mark.skipif(
    not _installed("livekit-agents"), reason="LiveKit is not installed"
)
needs_pipecat = pytest.mark.skipif(
    not _installed("pipecat-ai"), reason="Pipecat is not installed"
)


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


@needs_livekit
def test_the_runtime_range_check_matches_the_livekit_extra():
    import egma.livekit

    livekit = {name: spec for name, spec, extra in _declared() if extra == "livekit"}
    declared = sorted(livekit["livekit-agents"].replace(" ", "").split(","))
    checked = sorted(egma.livekit.SUPPORTED_LIVEKIT_AGENTS.split(","))
    assert declared == checked


def test_pipecat_comes_with_the_pipecat_extra_in_the_tested_range():
    pipecat = {name: spec for name, spec, extra in _declared() if extra == "pipecat"}

    assert pipecat["pipecat-ai"].replace(" ", "") in {">=1.9,<1.12", "<1.12,>=1.9"}
    assert not any(name.startswith("livekit") for name in pipecat)


@needs_pipecat
def test_the_pipecat_runtime_range_check_matches_the_pipecat_extra():
    import egma.pipecat

    pipecat = {name: spec for name, spec, extra in _declared() if extra == "pipecat"}
    declared = sorted(pipecat["pipecat-ai"].replace(" ", "").split(","))
    assert declared == sorted(egma.pipecat.SUPPORTED_PIPECAT.split(","))


def _canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _installed_closure(name: str, extras: frozenset[str]) -> set[str]:
    """Every distribution ``pip install name[extras]`` pulls in, read off the
    installed metadata with each requirement's marker applied here."""
    found: set[str] = set()
    visited: set[tuple[str, frozenset[str]]] = set()
    pending = [(_canonical(name), extras)]
    while pending:
        current, wanted = pending.pop()
        if (current, wanted) in visited:
            continue
        visited.add((current, wanted))
        found.add(current)
        try:
            declared = distribution(current).requires or []
        except PackageNotFoundError:
            continue
        environments = [{"extra": extra} for extra in wanted] or [{"extra": ""}]
        for raw in declared:
            requirement = Requirement(raw)
            if requirement.marker is None or any(
                requirement.marker.evaluate(environment) for environment in environments
            ):
                pending.append(
                    (_canonical(requirement.name), frozenset(requirement.extras))
                )
    return found


@needs_pipecat
def test_installing_the_pipecat_extra_installs_no_livekit():
    pulled = _installed_closure("egma", frozenset({"pipecat"}))

    assert "pipecat-ai" in pulled
    assert sorted(name for name in pulled if name.startswith("livekit")) == []


def test_installing_plain_egma_installs_no_agent_framework():
    pulled = _installed_closure("egma", frozenset())

    assert not any(name.startswith(("livekit", "pipecat")) for name in pulled)
