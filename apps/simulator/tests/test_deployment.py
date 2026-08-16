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
from dataclasses import dataclass
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

OWNED_BY_THE_PLATFORM = {
    "EGMA_SIMULATOR_MODEL_PROVIDER",
    "EGMA_SIMULATOR_MODEL_NAME",
    "EGMA_SIMULATOR_MODEL_API_KEY",
    "EGMA_SIMULATOR_STT_PROVIDER",
    "EGMA_SIMULATOR_TTS_PROVIDER",
    "EGMA_SIMULATOR_VAD_PROVIDER",
    "EGMA_SIMULATOR_DEEPGRAM_API_KEY",
    "EGMA_SIMULATOR_ELEVENLABS_API_KEY",
    "EGMA_SIMULATOR_OPENAI_API_KEY",
    "EGMA_SIMULATOR_TTS_MODEL",
    "EGMA_SIMULATOR_TTS_VOICE",
    "EGMA_SIMULATOR_MEDIA_BACKEND",
    "EGMA_SIMULATOR_SIP_TRUNK_ID",
    "EGMA_SIMULATOR_SIP_TRUNK_ADDRESS",
    "EGMA_SIMULATOR_SIP_TRUNK_NUMBER",
    "EGMA_SIMULATOR_SIP_TRUNK_USERNAME",
    "EGMA_SIMULATOR_SIP_TRUNK_PASSWORD",
}
"""Settings that belong to the platform, not to any container.

Each of these is stored by the API, sealed, and handed to every simulator
on the work order it claims — so no compose file passes one and
`.env.example` names none of them. A compose entry for any of them would be
a **second place the same setting is written down**, and the two would
disagree the first time somebody changed one: the whole failure this effort
exists to remove, arriving by a new route. It would also leave every one of
them in the silent-empty `${VAR:-}` form that the bootstrap work has to be
able to say no deployment variable uses.

The code still reads them, and that is deliberate rather than left over: a
bare `egma-simulator` process — the workbench story and every contributor's
checkout — has no platform behind it and configures itself from its own
environment. A work-order value replaces whatever it found. They stay in
this app's README table for that reader, which is the reason
`EGMA_SIMULATOR_BLOB_DIR` above is there too.
"""


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
    missing = (
        variables_read_by_the_code()
        - documented
        - DOCUMENTED_ELSEWHERE
        - OWNED_BY_THE_PLATFORM
    )
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
    missing = (
        variables_read_by_the_code()
        - passed
        - DOCUMENTED_ELSEWHERE
        - OWNED_BY_THE_PLATFORM
    )
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
    up. What stays off until `egma self-host setup` has run is the
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


@pytest.mark.parametrize("compose", COMPOSE_FILES, ids=lambda path: path.name)
def test_no_compose_file_hands_a_simulator_a_setting_the_platform_owns(compose):
    """Platform readiness does not wait on carrier setup, and a setting has
    exactly one home.

    Both properties fall out of the same absence. Nothing in any compose file
    tells a simulator which providers to use or whether it may dial: the
    platform holds all of it and hands it over on the work order, so
    `docker compose up` on a machine that has never seen a carrier starts
    exactly as it always did, and there is no second copy of a setting for
    the store's copy to disagree with.
    """
    block = service_block(compose, "simulator")
    if block is None:
        return
    handed = sorted(name for name in OWNED_BY_THE_PLATFORM if name in block)
    assert not handed, (
        f"{compose.name} hands the simulator {handed}, which the platform "
        "stores and delivers on the work order — a second home for a setting "
        "is two answers that disagree the first time one of them changes"
    )


MEDIA_CREDENTIAL = ("EGMA_LIVEKIT_API_KEY", "EGMA_LIVEKIT_API_SECRET")
"""The pair the media server, the simulator and the SIP gateway
authenticate each other with."""

PUBLISHED_MEDIA_CREDENTIAL = (
    "egma-devkey",
    "egma-development-only-livekit-secret-change-it",
)
"""What that pair used to fall back to, in this file, in a public
repository. Named here so the test can say *these exact values* are gone
rather than merely that some default is absent."""


def test_no_development_media_credential_is_left_in_the_deployment_description():
    """The media server does not run on a credential anyone can read.

    This is a finding rather than a precaution. A running deployment was
    checked and found using the pair below: all three containers fell back
    to it, and nothing in the CLI, the skills or the documentation ever
    replaced them. Published to loopback the exposure is small — and the
    deployment description invites a wider bind for testing from another
    machine, at which point the media server accepts anyone who read the
    repository.

    `egma self-host` generates a pair for the workspace instead. What is
    asserted here is the half a behavioural test cannot reach: that no
    default is left in the files a self-hoster copies, and that all three
    containers read the same two variables, so no two of them can end up
    holding different halves of one password.

    **The form this pair is read in changed once the bootstrap work landed.**
    It used to be asserted as the silent-empty `${VAR:-}` — no default, which
    was the whole of the fix at the time — and an empty value still started
    the media server with no password and took the simulator down with it,
    naming neither variable. It is the required `${VAR:?…}` now, so Compose
    refuses and says which of the two is missing. The rest of the bootstrap
    set is held to the same form below.
    """
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    example = (ROOT / ".env.example").read_text(encoding="utf-8")

    for published in PUBLISHED_MEDIA_CREDENTIAL:
        assert published not in compose, (
            f"docker-compose.yml still carries {published!r}; a deployment "
            "started from this file authenticates its media server with a "
            "value every reader of this repository holds"
        )
        assert published not in example, (
            f".env.example still carries {published!r}; a self-hoster who "
            "copies it to .env is back on the published pair"
        )

    for name in MEDIA_CREDENTIAL:
        read = [
            found
            for found in interpolations(compose, "docker-compose.yml")
            if found.name == name
        ]
        assert len(read) == 3, (
            f"docker-compose.yml reads {name} {len(read)} time(s); the media "
            "server, the simulator and the SIP gateway all read it, and one "
            "of them left out is one container holding a different password"
        )
        forms = sorted({found.operator for found in read})
        assert forms == [":?"], (
            f"{name} does not use the required form in docker-compose.yml: "
            f"{forms}. This pair is generated per workspace and has no default "
            "anywhere; a value written here is a credential the whole world "
            "already has, and an empty one is a media server that starts on no "
            "password and a simulator that never starts at all"
        )


REQUIRED_IN_THE_ENVIRONMENT = {
    "EGMA_ENCRYPTION_KEY": (
        "seals every stored credential and every platform setting. A default "
        "is a deployment sealed with a key printed in a public repository, "
        "which is not sealed"
    ),
    "EGMA_AUTH_SECRET": (
        "signs browser sessions. A default is every reader of this repository "
        "able to mint one"
    ),
    "EGMA_SIMULATOR_SERVICE_TOKEN": (
        "is what a simulator shows to claim work, and a claim answer carries a "
        "customer's live credentials to whoever holds it"
    ),
    "EGMA_LIVEKIT_API_KEY": "is half the password egma's own parts hold",
    "EGMA_LIVEKIT_API_SECRET": "is the other half",
    "EGMA_S3_ACCESS_KEY_ID": (
        "opens the store every recording lives in, with rights to replace one"
    ),
    "EGMA_S3_SECRET_ACCESS_KEY": "is that credential's secret half",
    "EGMA_S3_READ_ACCESS_KEY_ID": (
        "is what playback links are signed with, and a leak of it reads every "
        "recording a deployment holds"
    ),
    "EGMA_S3_READ_SECRET_ACCESS_KEY": "is that credential's secret half",
    "EGMA_BASE_URL": (
        "is the address this platform answers as, and every agent repository "
        "binds to what it says"
    ),
}
"""The bootstrap set: what a deployment must state before it may start.

Each of these is a secret the deployment cannot invent, or the address it
announces itself as. **Not one of them may have a default**, because a
default here is a value every reader of this repository already holds — the
finding that took the media pair's default away, one file wider.

They are the required `${VAR:?…}` form, so an absent one stops Compose with
the variable's name and what to do about it, rather than starting a platform
that looks healthy and is not.

What is deliberately **not** here is anything the deployment creates for
itself. The stores' own users and databases, every port and every bind are
values this file chooses and then uses consistently — a self-hoster who sets
none of them gets the deployment the README documents, and the two binds
default to loopback because that is a security decision this file makes
rather than one it asks for. Per-container tuning is not here either, for
the reason the spec gives: how many simulations one simulator takes at once
is a property of the host, not of the deployment.

**A store address is missing from this list on purpose, and is not
unguarded.** `DATABASE_URL` and `CLICKHOUSE_URL` are what the API and the
grader actually read, and this file builds each of them out of the store it
starts beside them — so under Compose the address of a container this file
creates cannot go missing. Both processes refuse to start without one and
name it, which is what covers every other way of running them: a bare
process, an override, somebody's managed Postgres. See the API's own
configuration tests.
"""

MAY_BE_ABSENT = {
    # The platform's own settings. They are seeded into the platform's store
    # on boot for anything it does not already hold, and a platform holding
    # none of them starts and reports `setup required` naming each one —
    # which is the whole difference this effort made. Requiring them here
    # would put readiness back behind carrier paperwork.
    "EGMA_PERSONA_MODEL_PROVIDER": "seeded",
    "EGMA_PERSONA_MODEL": "seeded",
    "EGMA_PERSONA_MODEL_API_KEY": "seeded",
    "EGMA_PERSONA_MODEL_REASONING_EFFORT": "seeded",
    "EGMA_PERSONA_STT_PROVIDER": "seeded",
    "EGMA_PERSONA_STT_MODEL": "seeded",
    "EGMA_PERSONA_STT_API_KEY": "seeded",
    "EGMA_PERSONA_TTS_PROVIDER": "seeded",
    "EGMA_PERSONA_TTS_API_KEY": "seeded",
    "EGMA_PERSONA_TTS_MODEL": "seeded",
    "EGMA_PERSONA_TTS_VOICE": "seeded",
    "EGMA_PERSONA_VAD_PROVIDER": "seeded",
    "EGMA_MEDIA_BACKEND": "seeded",
    "EGMA_PHONE_TRUNK_ADDRESS": "seeded",
    "EGMA_PHONE_SOURCE_NUMBER": "seeded",
    "EGMA_PHONE_TRUNK_USERNAME": "seeded",
    "EGMA_PHONE_TRUNK_PASSWORD": "seeded",
    # The default judge, which is a project's rather than the deployment's.
    # All three or none, and none is an ordinary deployment: the
    # deterministic graders judge for free either way.
    "EGMA_JUDGE_PROVIDER": "a judge belongs to the project that chose it",
    "EGMA_JUDGE_MODEL": "a judge belongs to the project that chose it",
    "EGMA_JUDGE_API_KEY": "a judge belongs to the project that chose it",
    # Mail, which is optional and load-bearing in being optional: with none,
    # an invitation hands its link back to whoever sent it.
    "EGMA_SMTP_URL": "optional by design",
    "EGMA_MAIL_FROM": "optional by design",
    # Per-container tuning. The spec puts these out of scope by name: how many
    # simulations one simulator takes at once and how often the grader sweeps
    # are properties of the host, not of the deployment.
    "EGMA_SIMULATOR_CLAIMANT": "per-container tuning",
    "EGMA_SIMULATOR_HEARTBEAT_SECONDS": "per-container tuning",
    "EGMA_SIMULATOR_CLAIM_WAIT_SECONDS": "per-container tuning",
    "EGMA_SIMULATOR_REPORT_DEADLINE_SECONDS": "per-container tuning",
    "EGMA_GRADER_CLAIMANT": "per-container tuning",
    "EGMA_GRADER_HEARTBEAT_SECONDS": "per-container tuning",
    "EGMA_GRADER_LEASE_SECONDS": "per-container tuning",
    "EGMA_GRADER_SWEEP_SECONDS": "per-container tuning",
    "EGMA_GRADER_TRACE_IDLE_SECONDS": "per-container tuning",
    # Facts about the network a container sits on rather than about the
    # deployment, and each one's empty value is a real answer: egma's own
    # default endpoint, egma's own default model, an address the server works
    # out for itself.
    "EGMA_SIMULATOR_MODEL_BASE_URL": "a property of this container's network",
    "EGMA_SIMULATOR_STT_MODEL": "empty means egma's own default",
    # These two are the platform's settings first — it seeds and holds
    # `speech_to_text_model` and `persona_model_reasoning_effort`, and what it
    # holds wins over anything written here. Empty is also a real answer on
    # its own: the listening leg asks for its own provider's default, and the
    # model call carries no reasoning field at all, which is what a model that
    # has never heard of one needs. The cartesia key is empty for the reason
    # every other provider key is absent from this container: the platform
    # holds it and hands it over on the work order.
    "EGMA_SIMULATOR_MODEL_REASONING_EFFORT": "empty sends no reasoning field",
    "EGMA_SIMULATOR_CARTESIA_API_KEY": "seeded",
    "EGMA_LIVEKIT_ADVERTISE_IP": "empty is right for every ordinary deployment",
    "EGMA_LIVEKIT_SIP_EXTERNAL_IP": "empty means ask a STUN server",
    # Empty is right for the MinIO this file runs, which ignores regions; the
    # API refuses to start pointed at Amazon's own S3 without one. The two
    # beside it fall back to it, so their chains end empty as well — which is
    # the same decision reached twice rather than a second one.
    "EGMA_S3_REGION": "empty is right for the store this file runs",
    "EGMA_BLOB_REGION": "falls back to EGMA_S3_REGION, which may be empty",
    "EGMA_SIMULATOR_S3_REGION": "falls back to EGMA_S3_REGION, which may be empty",
    # The workbench overlay, which `docker compose up` does not start. Empty is
    # the ordinary case and the useful one: every fixture is queued as written
    # and the phone fixture dials an obvious placeholder, so setting this is
    # what turns a demo into a real call rather than what makes one work.
    "EGMA_WORKBENCH_PHONE_NUMBER": "empty queues every fixture as written",
}
"""Every variable the deployment description may leave empty, and why.

**This is the list the guard below is really about.** A variable written
`${VAR:-}` is absent and empty at once, and nothing says so: the container
starts, the health check passes, and the failure arrives minutes later as a
provider or carrier refusal naming nothing about configuration. That was the
original failure, and every setting in the deployment was written that way.

So an empty default is now a decision somebody records here rather than a
shape somebody reaches for. Each name above is one the platform, a project or
the host answers for instead — never one a deployment needs in order to run.
"""


SHIPPED_COMPOSE_FILES = ("docker-compose.yml", "docker-compose.workbench.yml")
"""Every compose file this repository ships, which is what the guards read.

Named rather than globbed, and that is the difference between guarding the
deployment and guarding somebody's laptop: `docker-compose.override.yml` is
gitignored and belongs to whoever wrote it, so a developer's own override must
not be able to fail this suite. What must not escape is anything a self-hoster
receives from us — and the workbench overlay is one of those, which is why the
guards below are not the deployment description alone.
"""


@dataclass(frozen=True)
class Interpolation:
    """One `${…}` in a compose file, read the way Compose reads it."""

    name: str
    where: str
    #: `:-` `-` `:?` `?` `:+` `+`, or empty for a bare `${VAR}`.
    operator: str
    #: Whatever follows the operator — a default, a message, or an alternate.
    tail: str
    #: Whether an unset variable leaves this expression empty.
    hollow: bool


BODY = re.compile(r"([A-Z0-9_]+)(:-|-|:\?|\?|:\+|\+)?(.*)", re.DOTALL)
ONE_EXPRESSION = re.compile(r"\A\$\{.*\}\Z", re.DOTALL)


def interpolations(text: str, where: str = "") -> list[Interpolation]:
    """Every `${…}` in some compose text, nested ones included.

    Written as a scanner rather than as one regular expression because the
    question is not what the text looks like — it is **what an unset variable
    leaves behind**, and Compose answers that differently for six operators and
    recursively for a default that is itself an expression. A pattern that
    matched `${VAR:-}` and stopped would call `${VAR}`, `${VAR-}`, `${VAR:- }`
    and `${NEW:-${OTHER:-}}` safe, and every one of those puts an empty string
    into a container exactly as the original failure did.

    So braces are counted, the body is split into name, operator and tail, and
    the tail is read again — which is what makes a chain of defaults ending in
    nothing a hollow variable rather than a clever one.
    """
    found: list[Interpolation] = []
    at = 0
    while (start := text.find("${", at)) != -1:
        depth, cursor = 0, start
        while cursor < len(text):
            if text.startswith("${", cursor):
                depth += 1
                cursor += 2
                continue
            if text[cursor] == "}":
                depth -= 1
                if depth == 0:
                    break
            cursor += 1
        if depth != 0:
            break  # An unbalanced `${`: there is nothing more to read here.
        at = cursor + 1
        parsed = BODY.fullmatch(text[start + 2 : cursor])
        if parsed is None:
            continue  # Not a variable — compose files carry `$$` and `${1}`.
        name, operator, tail = parsed.group(1), parsed.group(2) or "", parsed.group(3)
        nested = interpolations(tail, where)
        found.append(
            Interpolation(
                name=name,
                where=where,
                operator=operator,
                tail=tail,
                hollow=is_hollow(operator, tail, nested),
            )
        )
        found.extend(nested)
    return found


def is_hollow(operator: str, tail: str, nested: list[Interpolation]) -> bool:
    """Whether an unset variable leaves this expression empty.

    - no operator — Compose warns and substitutes empty. A warning in a build
      log is not a refusal, and the container starts either way.
    - `:-` and `-` — empty when what follows them is empty, whitespace, or one
      nested expression that is itself hollow. A chain of fallbacks ending in
      nothing ends in nothing.
    - `:+` and `+` — the alternate is used only when the variable is *set*, so
      an unset one is empty by construction.
    - `:?` and `?` — the required form, which is the only one that refuses.
    """
    if operator in ("", ":+", "+"):
        return True
    if operator in (":?", "?"):
        return False
    if tail.strip() == "":
        return True
    return (
        ONE_EXPRESSION.fullmatch(tail.strip()) is not None
        and len(nested) > 0
        and nested[0].hollow
    )


def shipped_interpolations() -> list[Interpolation]:
    """Every `${…}` in every compose file this repository ships."""
    found: list[Interpolation] = []
    for name in SHIPPED_COMPOSE_FILES:
        found.extend(
            interpolations((ROOT / name).read_text(encoding="utf-8"), name)
        )
    return found


def hollow_variables() -> set[str]:
    """Every variable some shipped compose file leaves empty when it is unset."""
    return {read.name for read in shipped_interpolations() if read.hollow}


@pytest.mark.parametrize("name", sorted(REQUIRED_IN_THE_ENVIRONMENT))
def test_a_bootstrap_variable_refuses_to_start_the_platform_when_absent(name):
    """The change that closes the original failure, held in the file it lives in.

    A deployment started without one of these does not start at all, and
    Compose names the variable and what to do about it. Before this, every one
    of them had a default — a published development value, or nothing — so a
    platform started any way but through the CLI came up hollow, reported
    itself ready, and failed minutes later on the first simulation.
    """
    read = [found for found in shipped_interpolations() if found.name == name]
    assert read, (
        f"no compose file reads {name}, so no container can be given it: it "
        f"{REQUIRED_IN_THE_ENVIRONMENT[name]}"
    )
    wrong = sorted(
        f"{found.where}:${{{name}{found.operator}…"
        for found in read
        if found.operator != ":?"
    )
    assert not wrong, (
        f"{name} is read as {wrong} rather than in the required "
        f"${{{name}:?…}} form. It {REQUIRED_IN_THE_ENVIRONMENT[name]}, so a "
        "deployment that does not state it must be refused at start with the "
        "variable's name — not started hollow and failed later by a provider "
        "that names nothing about configuration"
    )
    for found in read:
        # What Compose prints after the variable's name, and the only sentence
        # a self-hoster meeting this refusal gets. Two things are checked
        # because two things are needed to act: where the value belongs, and
        # how to come by one. A name alone sends somebody to read this file.
        assert ".env" in found.tail, (
            f"{name} is required without saying where the value goes. Name the "
            f"file it belongs in; this one says {found.tail.strip()!r}"
        )
        assert "openssl" in found.tail or "egma self-host" in found.tail, (
            f"{name} is required without saying how to come by a value. Name "
            "the command that makes one, or the egma command that generates it; "
            f"this one says {found.tail.strip()!r}"
        )


def test_no_variable_in_a_shipped_compose_file_is_hollow_when_it_is_absent():
    """The regression this whole seam exists for: a new bootstrap variable that
    is empty when nobody set it.

    That shape is why the original failure was silent. It makes an absent
    setting an empty setting, and an empty setting starts every container,
    passes every health check, and reports the platform ready — so the first
    anybody hears of it is a carrier refusal minutes later that names nothing
    about configuration.

    The guard is deliberately in this direction. Asserting that the ten
    required variables are still required catches somebody undoing this work,
    which is the unlikely half; nobody would notice a *new* variable arriving
    empty, which is exactly how this failure was built the first time. So every
    hollow variable in every file we ship has to be one `MAY_BE_ABSENT`
    explains, and a name that is not there fails until somebody writes down why
    the platform can run without it.

    `${VAR:-}` is only the commonest spelling of it. See `is_hollow` for the
    others, each of which reaches a container as the same empty string.
    """
    unexplained = sorted(hollow_variables() - set(MAY_BE_ABSENT))
    assert not unexplained, (
        f"the compose files this repository ships leave {unexplained} empty "
        "when nobody sets them. An absent one of those is an empty one, and "
        "nothing says so — every container starts, every health check passes, "
        "and the platform reports itself ready. Use the required ${VAR:?…} "
        "form and add it to REQUIRED_IN_THE_ENVIRONMENT, or say in "
        "MAY_BE_ABSENT who answers for it instead: the platform's own store, a "
        "project, or the host."
    )


def test_nothing_is_excused_that_no_longer_needs_excusing():
    """The allow-list above tells a story about the files we ship, and a story
    about a variable that has moved on is a story nobody checks."""
    stale = sorted(set(MAY_BE_ABSENT) - hollow_variables())
    assert not stale, (
        f"MAY_BE_ABSENT excuses {stale}, which no shipped compose file leaves "
        "empty any more. Drop them, so the list stays the list of live decisions"
    )
    both = sorted(set(MAY_BE_ABSENT) & set(REQUIRED_IN_THE_ENVIRONMENT))
    assert not both, f"{both} is called required and optional at once"


@pytest.mark.parametrize("name", sorted(REQUIRED_IN_THE_ENVIRONMENT))
def test_env_example_supplies_no_value_for_a_variable_that_must_be_stated(name):
    """The file the README tells everybody to copy may not answer for them.

    A required variable with a value in `.env.example` is a required variable
    in name only: the copy supplies it, the deployment starts, and nobody is
    ever asked. `EGMA_BASE_URL` is the one that showed why this needs a guard
    rather than care — a copied `http://localhost:3101` is correct on a laptop
    and wrong on every deployment anybody else reaches, and wrong in the quiet
    way, because the platform runs perfectly while every agent repository is
    refused a directory away from the cause.
    """
    for line in (ROOT / ".env.example").read_text(encoding="utf-8").splitlines():
        if not line.startswith(f"{name}="):
            continue
        assert line.strip() == f"{name}=", (
            f".env.example answers {name} for the reader — the line is "
            f"{line.strip()!r}. It has no default anywhere else on purpose, so "
            "a value here is the default arriving by the one route nobody "
            "checks: the file the README says to copy. Leave it empty and say "
            "in the comment above it what to put there."
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
