"""The dependency boundary the published wheel promises to support."""

from __future__ import annotations

import re
from importlib.metadata import PackageNotFoundError, distribution, requires

from installed_frameworks import needs_pipecat
from packaging.requirements import Requirement


def _declared() -> list[tuple[str, str, str]]:
    """Every requirement as (name, specifier, extra); extra is "" for the base."""
    found = []
    for requirement in requires("egma") or []:
        spec, _, marker = requirement.partition(";")
        name = re.match(r"[A-Za-z0-9_.-]+", spec.strip()).group(0).lower()
        extra = re.search(r"extra\s*==\s*['\"]([^'\"]+)['\"]", marker)
        found.append((name, spec.strip()[len(name) :], extra.group(1) if extra else ""))
    return found


def test_the_base_install_carries_no_agent_framework_and_keeps_openai_2():
    base = {name: spec for name, spec, extra in _declared() if not extra}

    assert not any(name.startswith(("livekit", "pipecat")) for name in base)
    # LiveKit Agents 1.6 does not bound OpenAI itself and breaks on OpenAI 3,
    # so the bound holds for a LiveKit worker that installs plain egma.
    assert ">=2" in base["openai"]
    assert "<3" in base["openai"]


def test_livekit_comes_with_the_livekit_extra():
    livekit = {name: spec for name, spec, extra in _declared() if extra == "livekit"}

    assert ">=1.6.6" in livekit["livekit-agents"]
    assert "<1.9" in livekit["livekit-agents"]


def test_pipecat_comes_with_the_pipecat_extra_and_no_livekit():
    pipecat = {name: spec for name, spec, extra in _declared() if extra == "pipecat"}

    assert ">=1.9" in pipecat["pipecat-ai"]
    assert "<1.12" in pipecat["pipecat-ai"]
    assert not any(name.startswith("livekit") for name in pipecat)


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
