"""Shared rig for the simulator's suites.

The acceptance tests are black-box at the contract seam: the workbench
serves real HTTP on a loopback port, the simulator runs as a real child
process configured only through its environment, and every assertion reads
the workbench's records back over HTTP — nothing reaches into either
process. The rig here is exactly that wiring.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import subprocess
import sys
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

import aiohttp
import pytest
from aiohttp import web
from retell_stub import RetellStub, RunningStub, serving

from egma_simulator.contract import contract_dir
from egma_simulator.workbench.app import WorkbenchState, build_app

# Tuned far below the 5-second production default so a whole acceptance
# story fits in seconds; the behavior under test is the same loop.
HEARTBEAT_SECONDS = 0.2
CLAIM_HOLD_SECONDS = 0.5


@dataclass
class Workbench:
    """One running workbench and the addresses the suites need."""

    base_url: str
    state: WorkbenchState

    session: aiohttp.ClientSession

    async def offer(self, spec: dict) -> None:
        async with self.session.post(
            f"{self.base_url}/workbench/specs", json=spec
        ) as response:
            assert response.status == 204, await response.text()

    async def cancel(self, simulation_id: str) -> None:
        async with self.session.post(
            f"{self.base_url}/workbench/simulations/{simulation_id}/cancel"
        ) as response:
            assert response.status == 204, await response.text()

    async def records(self) -> list[dict]:
        async with self.session.get(
            f"{self.base_url}/workbench/records"
        ) as response:
            assert response.status == 200, await response.text()
            body = await response.json()
        return body["records"]

    async def wait_for(
        self,
        predicate: Callable[[list[dict]], bool],
        *,
        within_seconds: float = 30.0,
        interval: float = 0.05,
    ) -> list[dict]:
        """Poll the records until ``predicate`` holds; fail loudly if it never does."""
        deadline = asyncio.get_running_loop().time() + within_seconds
        records = await self.records()
        while not predicate(records):
            if asyncio.get_running_loop().time() > deadline:
                pytest.fail(
                    "records never satisfied the predicate; last records:\n"
                    + "\n".join(json.dumps(record) for record in records)
                )
            await asyncio.sleep(interval)
            records = await self.records()
        return records


async def _serve_workbench(state: WorkbenchState) -> AsyncIterator[Workbench]:
    runner = web.AppRunner(build_app(state))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    try:
        async with aiohttp.ClientSession() as session:
            yield Workbench(
                base_url=f"http://127.0.0.1:{port}", state=state, session=session
            )
    finally:
        await runner.cleanup()


@pytest.fixture
async def workbench() -> AsyncIterator[Workbench]:
    async for running in _serve_workbench(
        WorkbenchState(hold_seconds=CLAIM_HOLD_SECONDS)
    ):
        yield running


@pytest.fixture
async def over_granting_workbench() -> AsyncIterator[Workbench]:
    """A control plane that hands out more than the simulator asked for."""
    async for running in _serve_workbench(
        WorkbenchState(hold_seconds=CLAIM_HOLD_SECONDS, over_grant=3)
    ):
        yield running


@dataclass
class SimulatorProcess:
    """One simulator child process and the files catching its output."""

    process: subprocess.Popen
    stdout_path: Path
    stderr_path: Path
    wal_dir: Path
    blob_dir: Path
    extra_env: dict[str, str] = field(default_factory=dict)

    def blob(self, reference: str) -> bytes:
        """What a reported reference actually resolves to on disk."""
        return (self.blob_dir / reference).read_bytes()

    def output(self) -> str:
        return (
            self.stdout_path.read_text(errors="replace")
            + self.stderr_path.read_text(errors="replace")
        )

    def kill_hard(self) -> None:
        """SIGKILL: no goodbye, no cleanup — the crash the orphan sweep exists for."""
        self.process.send_signal(signal.SIGKILL)
        self.process.wait(timeout=10)

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)


@pytest.fixture
def start_simulator(
    tmp_path: Path,
) -> Callable[..., SimulatorProcess]:
    started: list[SimulatorProcess] = []

    def start(
        workbench: Workbench,
        *,
        capacity: int = 2,
        log_level: str = "INFO",
        claimant: str = "sim-under-test",
        extra_env: dict[str, str] | None = None,
    ) -> SimulatorProcess:
        stdout_path = tmp_path / f"simulator-{len(started)}.out"
        stderr_path = tmp_path / f"simulator-{len(started)}.err"
        wal_dir = tmp_path / f"wal-{len(started)}"
        blob_dir = tmp_path / f"blobs-{len(started)}"
        # Empty, and pointed at by the two variables a tokenizer corpus is
        # ever looked up through. The simulator promises it needs no such
        # corpus and fetches none; a child that quietly grew a need for
        # one would find this machine's cache and pass, which is exactly
        # the regression this starves. See the package docstring.
        starved = tmp_path / f"no-corpus-{len(started)}"
        starved.mkdir(exist_ok=True)
        env = os.environ | {
            "NLTK_DATA": str(starved),
            "HOME": str(starved),
            "EGMA_SIMULATOR_CONTROL_PLANE_URL": workbench.base_url,
            "EGMA_SIMULATOR_CLAIMANT": claimant,
            "EGMA_SIMULATOR_CAPACITY": str(capacity),
            "EGMA_SIMULATOR_HEARTBEAT_SECONDS": str(HEARTBEAT_SECONDS),
            "EGMA_SIMULATOR_CLAIM_WAIT_SECONDS": "2",
            "EGMA_SIMULATOR_WAL_DIR": str(wal_dir),
            "EGMA_SIMULATOR_BLOB_DIR": str(blob_dir),
            "EGMA_SIMULATOR_LOG_LEVEL": log_level,
        } | (extra_env or {})
        with open(stdout_path, "wb") as stdout, open(stderr_path, "wb") as stderr:
            process = subprocess.Popen(
                [sys.executable, "-m", "egma_simulator"],
                stdout=stdout,
                stderr=stderr,
                env=env,
            )
        simulator = SimulatorProcess(
            process=process,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            wal_dir=wal_dir,
            blob_dir=blob_dir,
            extra_env=extra_env or {},
        )
        started.append(simulator)
        return simulator

    yield start

    for simulator in started:
        simulator.stop()


@pytest.fixture
async def start_retell_stub() -> AsyncIterator[Callable[..., Awaitable[RunningStub]]]:
    """Start Retell-shaped stubs on loopback; each stops when the test ends.

    The keyword arguments are :class:`RetellStub`'s script — the key it
    honors, the greeting, the replies, whether the agent ends the exchange
    itself.
    """
    async with contextlib.AsyncExitStack() as stack:

        async def start(**script: object) -> RunningStub:
            return await stack.enter_async_context(serving(RetellStub(**script)))

        yield start


@pytest.fixture
def quick_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """Collapse delivery backoff so retry behavior can be tested in milliseconds.

    Only the waiting is shortened. The attempt sequence, the deadline
    arithmetic, and what is given up on are exactly the production ones.
    """
    from egma_simulator import reporting

    monkeypatch.setattr(reporting, "FIRST_BACKOFF_SECONDS", 0.001)
    monkeypatch.setattr(reporting, "MAX_BACKOFF_SECONDS", 0.005)


def load_fixture_spec(name: str) -> dict:
    with open(
        contract_dir() / "fixtures" / "spec" / "valid" / name, encoding="utf-8"
    ) as handle:
        return json.load(handle)


A_SCENARIO = "State the first point. State the second point."
"""Two sentences, so the scripted persona speaks twice and then concludes."""

A_PERSONALITY = "Terse test person; sticks to the script."


def a_spec(
    simulation_id: str,
    *,
    connection: dict,
    scenario: str,
    personality: str,
    max_turns: int,
    max_duration_seconds: int,
    modality: str = "chat",
) -> dict:
    """The envelope every spec shares: one persona, one scenario, one set of
    walls, one exchange. What differs between two specs is the connection
    block and the modality, which is exactly the difference the plug seam
    exists to absorb."""
    return {
        "contract_version": 1,
        "simulation_id": simulation_id,
        "modality": modality,
        "connection": connection,
        "persona": {"traits": {"personality": personality, "language": "en-US"}},
        "scenario": {"instructions": scenario},
        "limits": {
            "max_duration_seconds": max_duration_seconds,
            "max_turns": max_turns,
        },
    }


def scripted_spec(
    simulation_id: str,
    *,
    scenario: str = A_SCENARIO,
    personality: str = A_PERSONALITY,
    greeting: str | None = None,
    replies: list[str] | None = None,
    ends_after_replies: bool = False,
    turn_seconds: float = 0.0,
    provider_reference: str | None = None,
    max_turns: int = 60,
    max_duration_seconds: int = 600,
    credentials: dict | None = None,
) -> dict:
    """One spec against the scripted counterpart, the whole suite's staple.

    The persona's turns derive from ``scenario`` (sentence by sentence, then
    a concluding goodbye); the agent's from the plug config built here.
    """
    config: dict = {"turn_seconds": turn_seconds}
    if greeting is not None:
        config["greeting"] = greeting
    if replies is not None:
        config["replies"] = replies
    if ends_after_replies:
        config["ends_after_replies"] = True
    if provider_reference is not None:
        config["provider_reference"] = provider_reference
    return a_spec(
        simulation_id,
        connection={
            "type": "scripted",
            "config": config,
            "credentials": credentials,
        },
        scenario=scenario,
        personality=personality,
        max_turns=max_turns,
        max_duration_seconds=max_duration_seconds,
    )


def retell_spec(
    simulation_id: str,
    *,
    base_url: str,
    api_key: str,
    agent_id: str = "agent_stubbed_0001",
    scenario: str = A_SCENARIO,
    personality: str = A_PERSONALITY,
    max_turns: int = 60,
    max_duration_seconds: int = 600,
) -> dict:
    """One spec against a Retell chat connection, pointed wherever asked.

    The connection block is exactly what the control plane stores for a
    ``retell`` connection — the agent id in the config, the key in the
    credentials — plus the base URL, which is what lets the exchange land on
    a Retell-shaped stub instead of the platform itself.
    """
    return a_spec(
        simulation_id,
        connection={
            "type": "retell",
            "config": {"retellAgentId": agent_id, "baseUrl": base_url},
            "credentials": {"apiKey": api_key},
        },
        scenario=scenario,
        personality=personality,
        max_turns=max_turns,
        max_duration_seconds=max_duration_seconds,
    )


def assert_kept_secret(
    secret: str, *, records: list[dict], simulator: SimulatorProcess
) -> None:
    """A planted credential is in none of the three places it could surface.

    The reports the control plane holds, every byte the process wrote, and
    the write-ahead log on disk — all three, every time, because a secret
    kept out of two of them is still a leaked secret. Each place is checked
    to be non-empty first: scanning nothing always passes.

    Call it once the simulator has stopped, so its output is all there.
    """
    assert secret not in json.dumps(records), "a report carried the credential"

    output = simulator.output()
    assert output, "expected the simulator to have logged something"
    assert secret not in output, "a log line carried the credential"

    wal_bytes = b"".join(
        path.read_bytes() for path in simulator.wal_dir.glob("*.jsonl")
    )
    assert wal_bytes, "expected write-ahead log entries"
    assert secret.encode() not in wal_bytes, (
        "the write-ahead log carried the credential"
    )


def loopback_spec(
    simulation_id: str,
    *,
    scenario: str = A_SCENARIO,
    personality: str = A_PERSONALITY,
    voice: dict | None = None,
    greeting: str | None = None,
    replies: list[str] | None = None,
    ends_after_replies: bool = False,
    echoes_what_it_hears: bool = False,
    answer_delay_seconds: float = 0.0,
    sample_rate_hz: int | None = None,
    provider_reference: str | None = None,
    max_turns: int = 60,
    max_duration_seconds: int = 600,
    credentials: dict | None = None,
) -> dict:
    """One voice spec against the loopback counterpart.

    Deliberately the same shape as :func:`scripted_spec`: the two differ by
    modality and connection type and by nothing else, which is what makes
    "the same test over chat and over voice" a comparison rather than two
    unrelated stories.
    """
    config: dict = {"answer_delay_seconds": answer_delay_seconds}
    if greeting is not None:
        config["greeting"] = greeting
    if replies is not None:
        config["replies"] = replies
    if ends_after_replies:
        config["ends_after_replies"] = True
    if echoes_what_it_hears:
        config["echoes_what_it_hears"] = True
    if sample_rate_hz is not None:
        config["sample_rate_hz"] = sample_rate_hz
    if provider_reference is not None:
        config["provider_reference"] = provider_reference
    spec = a_spec(
        simulation_id,
        modality="voice",
        connection={
            "type": "loopback",
            "config": config,
            "credentials": credentials,
        },
        scenario=scenario,
        personality=personality,
        max_turns=max_turns,
        max_duration_seconds=max_duration_seconds,
    )
    if voice is not None:
        spec["persona"]["traits"]["voice"] = voice
    return spec


def phone_spec(
    simulation_id: str,
    *,
    scenario: str = A_SCENARIO,
    personality: str = A_PERSONALITY,
    voice: dict | None = None,
    number: str = "+15551234567",
    backend: str = "scripted",
    caller_id: str | None = None,
    greeting: str | None = None,
    replies: list[str] | None = None,
    hangs_up_after_replies: bool = False,
    answer_delay_seconds: float = 0.0,
    outcome: str | None = None,
    provider_reference: str | None = None,
    max_turns: int = 60,
    max_duration_seconds: int = 600,
    credentials: dict | None = None,
) -> dict:
    """One voice spec that dials a number.

    Deliberately the same shape as :func:`loopback_spec`: a phone
    simulation differs from every other voice one by its connection block
    and by nothing else. Which bridge places the call is the simulator's
    own configuration rather than the spec's, so ``backend`` here only
    decides whether the scripted backend's script is written into the
    spec — what the far end says, whether it hangs up, what the carrier
    answers — which only that backend reads.
    """
    config: dict = {"phoneNumber": number}
    if caller_id is not None:
        config["callerId"] = caller_id
    if backend == "scripted":
        script: dict = {"answer_delay_seconds": answer_delay_seconds}
        if greeting is not None:
            script["greeting"] = greeting
        if replies is not None:
            script["replies"] = replies
        if hangs_up_after_replies:
            script["hangs_up_after_replies"] = True
        if outcome is not None:
            script["outcome"] = outcome
        if provider_reference is not None:
            script["provider_reference"] = provider_reference
        config["scripted"] = script
    spec = a_spec(
        simulation_id,
        modality="voice",
        connection={"type": "phone", "config": config, "credentials": credentials},
        scenario=scenario,
        personality=personality,
        max_turns=max_turns,
        max_duration_seconds=max_duration_seconds,
    )
    if voice is not None:
        spec["persona"]["traits"]["voice"] = voice
    return spec


SENTINEL_TRUNK_ENV = {
    "EGMA_SIMULATOR_MEDIA_BACKEND": "livekit",
    "EGMA_SIMULATOR_LIVEKIT_URL": "ws://127.0.0.1:1",
    "EGMA_SIMULATOR_LIVEKIT_API_KEY": "SENTINEL-livekit-key-6b13c7f0a45e",
    "EGMA_SIMULATOR_LIVEKIT_API_SECRET": "SENTINEL-livekit-secret-2a9d4f6c8b71",
    "EGMA_SIMULATOR_SIP_TRUNK_ADDRESS": "egma-test.pstn.twilio.com",
    "EGMA_SIMULATOR_SIP_TRUNK_NUMBER": "+15550000000",
    "EGMA_SIMULATOR_SIP_TRUNK_USERNAME": "egma-trunk-user",
    "EGMA_SIMULATOR_SIP_TRUNK_PASSWORD": "SENTINEL-trunk-password-d5e8017a3c92",
}
"""A whole LiveKit deployment's worth of credentials, every secret one a
sentinel, pointed at a port nothing answers on.

It is what the acceptance suite plants on a simulator so that the
credentials a real phone deployment holds are really in the process while
it succeeds and while it fails — which is the only way scanning its output
proves anything.
"""

TRUNK_SENTINELS = tuple(
    value for value in SENTINEL_TRUNK_ENV.values() if value.startswith("SENTINEL-")
)
"""The planted values that must appear in nothing the simulator emits."""

SCRIPTED_TRUNK_ENV = SENTINEL_TRUNK_ENV | {"EGMA_SIMULATOR_MEDIA_BACKEND": "scripted"}
"""The same planted deployment, placing its calls through the scripted
bridge instead. The LiveKit and trunk secrets are still in the process,
which is the point: a simulator holding them must not emit them whichever
bridge it is dialling through."""


def credential(*names: str) -> str:
    """The first of these environment variables that carries a value.

    The opt-in tests read a ``TEST_``-prefixed name first, so a machine can
    keep the credentials it tests with apart from the ones it works with,
    and fall back to the provider's own plain name.
    """
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def words_of(said: str) -> set[str]:
    """The words of one turn, as a transcriber would have to have heard them.

    Real transcription is not a codec: it capitalises, punctuates, and
    sometimes hears "Thursday" as "thursday". So a live comparison is on
    words rather than on strings, and what is asserted is that most of
    them survived — which is what "these words were really heard" can
    honestly mean.
    """
    return {
        word.strip(".,!?;:").lower() for word in said.split() if word.strip(".,!?;:")
    }


def assert_one_speaker_to_a_channel(
    recording: bytes, turns: list[tuple[str, str]]
) -> None:
    """Each turn is on its own speaker's channel and on neither other one.

    The recording is read the only way a listener could read it — the
    samples of each channel, transcribed — so this says what a person
    would hear, not what the simulator believed it wrote.
    """
    from egma_simulator.pipeline import channels_of
    from egma_simulator.speech import decode_speech

    persona_audio, agent_audio, band = channels_of(recording)
    said = {
        "human": decode_speech(persona_audio, band),
        "agent": decode_speech(agent_audio, band),
    }
    for speaker, text in turns:
        other = "agent" if speaker == "human" else "human"
        assert text in said[speaker], (speaker, text)
        assert text not in said[other], (speaker, text)


# -- Record readers: the acceptance suite's entire vocabulary -----------------


def events_for(records: list[dict], simulation_id: str, kind: str) -> list[dict]:
    return [
        record["event"]
        for record in records
        if record["kind"] == "report"
        and record["simulation_id"] == simulation_id
        and record["event"]["kind"] == kind
    ]


def status_events_for(records: list[dict], simulation_id: str) -> list[str]:
    return [event["status"] for event in events_for(records, simulation_id, "status")]


def terminal_event_for(records: list[dict], simulation_id: str) -> dict | None:
    for event in events_for(records, simulation_id, "status"):
        if event["status"] in ("completed", "failed", "canceled"):
            return event
    return None


def heartbeats_for(records: list[dict], simulation_id: str) -> list[dict]:
    return [
        record
        for record in records
        if record["kind"] == "heartbeat" and record["simulation_id"] == simulation_id
    ]


def has_terminal(simulation_id: str) -> Callable[[list[dict]], bool]:
    def check(records: list[dict]) -> bool:
        return terminal_event_for(records, simulation_id) is not None

    return check


def all_terminal(simulation_ids: list[str]) -> Callable[[list[dict]], bool]:
    def check(records: list[dict]) -> bool:
        return all(
            terminal_event_for(records, simulation_id) is not None
            for simulation_id in simulation_ids
        )

    return check
