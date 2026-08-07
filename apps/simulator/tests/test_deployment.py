"""The deployment story, checked against the code that reads it.

Three files tell a self-hoster how to run this: `docker-compose.yml`, the
opt-in `docker-compose.phone.yml` beside it, and `.env.example`. A fourth,
this app's README, is the table they are all summarised in. Every one of
them names environment variables, and every one of them can fall behind
the module that reads them — silently, because nothing fails when a
variable is documented and unread, or read and undocumented. The second
one is the expensive kind: a self-hoster cannot set a variable nobody
told them about, and the failure is a feature that quietly never turns on.

So this file compares them, and it is deliberately about *names and
shapes* rather than about Docker. It parses no YAML and starts no
container: what it asserts is true of the text, which is what somebody
reads.

The other half is the invariant the whole deployment rests on — **the
simulator publishes nothing** — which is a claim about every compose file
in the repository at once, and so cannot be tested from inside any one of
them.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from egma_simulator import config as config_module

VARIABLE = re.compile(r"EGMA_SIMULATOR_[A-Z0-9_]+")

DOCUMENTED_ELSEWHERE = {
    # Not a deployment's to set: the simulator finds the contract package
    # by walking the repository, and this is the escape hatch for a layout
    # it cannot walk. It is in the README's table and nowhere else on
    # purpose — a compose entry for it would invite somebody to point a
    # container at a contract it was not built with.
    "EGMA_SIMULATION_CONTRACT_DIR",
}


def repository_root() -> Path:
    """The checkout this app lives in, found by what is at its top."""
    for candidate in Path(__file__).resolve().parents:
        if (candidate / "docker-compose.yml").is_file():
            return candidate
    raise AssertionError(
        "no docker-compose.yml above this test: the deployment story is "
        "what it is checked against"
    )


ROOT = repository_root()
COMPOSE_FILES = sorted(ROOT.glob("docker-compose*.yml"))


def variables_read_by_the_code() -> set[str]:
    """Every ``EGMA_SIMULATOR_*`` the simulator actually looks up."""
    source = Path(config_module.__file__).parent
    found: set[str] = set()
    for module in source.rglob("*.py"):
        found |= set(VARIABLE.findall(module.read_text(encoding="utf-8")))
    return found


def test_every_variable_the_code_reads_is_in_the_env_example():
    documented = set(
        VARIABLE.findall((ROOT / ".env.example").read_text(encoding="utf-8"))
    )
    missing = variables_read_by_the_code() - documented - DOCUMENTED_ELSEWHERE
    assert not missing, (
        f".env.example does not name {sorted(missing)}, which the simulator "
        "reads — a self-hoster cannot set a variable nobody told them about"
    )


def test_every_variable_the_code_reads_is_passed_through_by_compose():
    """A variable absent from the compose entry is not merely undocumented
    — it does not reach the container at all, whatever the operator sets in
    their shell or their .env."""
    passed: set[str] = set()
    for compose in COMPOSE_FILES:
        passed |= set(VARIABLE.findall(compose.read_text(encoding="utf-8")))
    missing = variables_read_by_the_code() - passed - DOCUMENTED_ELSEWHERE
    assert not missing, (
        f"no compose file passes {sorted(missing)} to the simulator, so a "
        "container never sees it however it is set"
    )


def test_every_variable_the_code_reads_is_in_the_readme_table():
    readme = (Path(config_module.__file__).parents[2] / "README.md").read_text(
        encoding="utf-8"
    )
    documented = set(VARIABLE.findall(readme))
    missing = variables_read_by_the_code() - documented
    assert not missing, (
        f"the configuration table does not list {sorted(missing)}"
    )


def test_nothing_is_documented_that_nothing_reads():
    """The other direction, which rots more quietly: a variable somebody
    sets carefully and nothing has read since it was renamed."""
    read = variables_read_by_the_code()
    for named in (ROOT / ".env.example", *COMPOSE_FILES):
        stale = set(VARIABLE.findall(named.read_text(encoding="utf-8"))) - read
        assert not stale, (
            f"{named.name} names {sorted(stale)}, which nothing reads"
        )


def service_block(compose: Path, service: str) -> str | None:
    """One service's own lines out of a compose file, or ``None``.

    Services sit at one indent under ``services:`` and everything of theirs
    is indented further, so the block is from that line to the next one at
    the same depth. Enough for files written by hand, which these are.
    """
    text = compose.read_text(encoding="utf-8")
    opening = re.search(rf"^  {re.escape(service)}:$", text, re.MULTILINE)
    if opening is None:
        return None
    rest = text[opening.end() :]
    closing = re.search(r"^\S|^  \S", rest, re.MULTILINE)
    return rest if closing is None else rest[: closing.start()]


@pytest.mark.parametrize("compose", COMPOSE_FILES, ids=lambda path: path.name)
def test_the_simulator_publishes_nothing_in_every_configuration(compose):
    """The invariant the deployment rests on, held across every overlay.

    The simulator claims its work rather than being sent it, so it needs no
    inbound network surface at all — and the phone overlay does not change
    that, which is the single most load-bearing sentence in the phone
    deployment story. An overlay could break it in one line, and nothing
    else in this suite would notice.
    """
    block = service_block(compose, "simulator")
    if block is None:
        return
    assert "ports:" not in block, (
        f"{compose.name} publishes a port on the simulator; every arrow "
        "points out, in every configuration"
    )


def test_a_plain_compose_up_starts_no_phone_stack():
    """The default is the first-run story, and the phone stack is not in
    it: the gateway needs a network a laptop does not have."""
    default = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    for service in ("livekit", "livekit-sip", "livekit-redis"):
        assert f"\n  {service}:" not in default, (
            f"docker-compose.yml starts {service}; the phone stack is opt-in"
        )


OVERLAY_VARIABLE = re.compile(r"\$\{(EGMA_(?:LIVEKIT|WORKBENCH)_[A-Z0-9_]+)")


@pytest.mark.parametrize("compose", COMPOSE_FILES, ids=lambda path: path.name)
def test_every_variable_an_overlay_reads_is_in_the_env_example(compose):
    """The overlays' own variables drift the same way the simulator's do.

    These are not read by any Python — the compose file is the code that
    reads them — so nothing else in this suite would notice one being
    added, renamed, or left behind.
    """
    documented = (ROOT / ".env.example").read_text(encoding="utf-8")
    named = set(OVERLAY_VARIABLE.findall(compose.read_text(encoding="utf-8")))
    missing = sorted(name for name in named if name not in documented)
    assert not missing, f"{compose.name} reads {missing}; .env.example does not"


def test_the_phone_overlay_and_its_gateway_agree_on_the_rtp_range():
    """The published range and the configured one are two halves of one
    number. Moving one without the other is a call that rings, is answered,
    and stays silent — the worst failure in the whole stack to diagnose,
    because every layer reports success."""
    overlay = (ROOT / "docker-compose.phone.yml").read_text(encoding="utf-8")
    ranges = re.findall(
        r"\$\{EGMA_LIVEKIT_SIP_RTP_PORT_START:-(\d+)\}-"
        r"\$\{EGMA_LIVEKIT_SIP_RTP_PORT_END:-(\d+)\}",
        overlay,
    )
    assert len(ranges) >= 2, "the RTP range is named once; it takes two to agree"
    assert len(set(ranges)) == 1, (
        f"the gateway's RTP range and the published one differ: {set(ranges)}"
    )
