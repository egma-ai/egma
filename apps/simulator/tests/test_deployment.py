"""The deployment story, checked against the code that reads it.

Two files tell a self-hoster how to run this: `docker-compose.yml` — which
carries the phone stack too, since there is no overlay to ask for any more —
and `.env.example`. A third, this app's README, is the table they are all
summarised in. Every one of
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
    # Not this deployment's either, and it is the absence that says so.
    # The compose deployment runs object storage, so a simulator container
    # writes no audio to its own filesystem and has no recordings
    # directory at all — a compose entry naming one would be a path
    # nothing reads, on a volume a self-hoster would then expect to find
    # recordings on. It stays documented for the other way of running the
    # simulator: a bare process, which is what the workbench story and
    # every contributor's checkout use.
    "EGMA_SIMULATOR_BLOB_DIR",
}
"""Variables the code reads that no compose file passes, each for its own
stated reason. Everything else must reach the container, because a
variable a compose entry leaves out never arrives however it is set."""


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
    sets carefully and nothing has read since it was renamed.

    The two READMEs are in this direction too, and only this one: a
    variable they name and nothing reads is a paragraph telling somebody
    to do something with no effect, which is worse than silence.
    """
    read = variables_read_by_the_code() | DOCUMENTED_ELSEWHERE
    named_files = (
        ROOT / ".env.example",
        ROOT / "README.md",
        Path(config_module.__file__).parents[2] / "README.md",
        *COMPOSE_FILES,
    )
    for named in named_files:
        stale = set(VARIABLE.findall(named.read_text(encoding="utf-8"))) - read
        assert not stale, (
            f"{named} names {sorted(stale)}, which nothing reads"
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


def test_a_plain_compose_up_starts_the_whole_phone_stack():
    """The phone stack is the default stack, not an overlay to ask for.

    It was opt-in until the self-hosted release, and the reversal is the
    point rather than an accident: a platform that cannot place a phone
    call is not the product, so `egma self-host up` — and a plain
    `docker compose up`, which is the same containers — brings all three
    up. What stays off until `egma self-host phone setup` has run is the
    simulator's *media backend*, because a simulator told to dial with no
    trunk refuses to start and platform readiness must never wait on
    carrier setup. That is asserted below.
    """
    default = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    for service in ("livekit", "livekit-sip", "livekit-redis"):
        assert f"\n  {service}:" in default, (
            f"docker-compose.yml does not start {service}; the phone stack "
            "is part of the default deployment"
        )


def test_no_phone_overlay_is_left_to_ask_for_by_name():
    """The overlay is gone, and a leftover copy of it would be a second
    deployment story telling somebody to do something with no effect."""
    assert not (ROOT / "docker-compose.phone.yml").exists(), (
        "docker-compose.phone.yml is back; the phone stack is in the default "
        "compose file and there is no overlay to ask for"
    )


def test_the_default_stack_dials_nothing_until_phone_setup_has_run():
    """Platform readiness does not wait on carrier setup.

    A simulator whose media backend is named starts checking for a trunk
    at startup and refuses to run without one — so a default that named a
    backend would make `docker compose up` fail on a machine that has
    never seen a carrier, which is every machine on its first run.
    """
    default = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    named = "EGMA_SIMULATOR_MEDIA_BACKEND: ${EGMA_SIMULATOR_MEDIA_BACKEND:-}"
    assert named in default, (
        "docker-compose.yml gives the simulator a media backend by default; a "
        "simulator told to dial with no trunk refuses to start, so a first "
        "`up` on a machine with no carrier would fail"
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


def test_the_gateway_and_its_published_ports_agree_on_the_rtp_range():
    """The published range and the configured one are two halves of one
    number. Moving one without the other is a call that rings, is answered,
    and stays silent — the worst failure in the whole stack to diagnose,
    because every layer reports success."""
    overlay = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    ranges = re.findall(
        r"\$\{EGMA_LIVEKIT_SIP_RTP_PORT_START:-(\d+)\}-"
        r"\$\{EGMA_LIVEKIT_SIP_RTP_PORT_END:-(\d+)\}",
        overlay,
    )
    assert len(ranges) >= 2, "the RTP range is named once; it takes two to agree"
    assert len(set(ranges)) == 1, (
        f"the gateway's RTP range and the published one differ: {set(ranges)}"
    )


def test_the_gateway_listens_on_the_port_it_is_published_on():
    """The SIP port is one number, inside the container and out.

    The gateway *announces* the port it listens on, so a gateway listening
    on 5060 behind a host publishing 5070 tells the carrier to send its
    in-dialog requests — a BYE, a re-INVITE — to a port nothing answers
    on. What that looks like is a call that connects and then will not
    hang up cleanly, which is a long way from the variable that caused it.

    Found by running a platform on a moved port and reading the gateway's
    own startup line.
    """
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    variable = r"\$\{EGMA_LIVEKIT_SIP_PORT:-5060\}"
    assert re.search(rf"^\s*sip_port: {variable}$", compose, re.MULTILINE), (
        "the gateway's sip_port is fixed while its published port moves; the "
        "two are one number"
    )
    published = re.findall(rf'"{variable}:{variable}/(?:udp|tcp)"', compose)
    assert len(published) == 2, (
        "the published SIP port does not map to the same port inside the "
        f"container; found {len(published)} of the two mappings"
    )


def test_the_object_store_under_test_is_the_one_the_deployment_runs():
    """The image the suite proves against and the images a self-hoster gets
    are one release, named in three places.

    Drift here is quiet and expensive: the object-storage tests would keep
    passing against whatever they happened to pull while the deployment ran
    something else, which is exactly the assurance those tests exist to
    give up front.

    Three places, because the store and the one-shot job that makes its
    bucket both name it, and they are the same image on purpose — the job
    is `mc` out of the server's own release. Counting rather than merely
    finding it, so the two compose entries cannot drift apart while a test
    that only asked "is it in there anywhere" keeps passing.
    """
    from conftest import MINIO_IMAGE

    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    named = compose.count(f"image: {MINIO_IMAGE}")
    assert named == 2, (
        f"docker-compose.yml names {MINIO_IMAGE} {named} time(s); the object "
        "store and the job that creates its bucket are both it, and the tests "
        "prove the object-storage path against that same release"
    )
