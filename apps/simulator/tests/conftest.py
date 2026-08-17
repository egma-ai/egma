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
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path

import aiohttp
import pytest
from aiohttp import web
from retell_stub import RetellStub, RunningStub, serving

from egma_simulator.config import DEFAULT_S3_BUCKET, DEFAULT_S3_REGION
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
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """A clean environment, and somewhere harmless for the two directories.

    Whatever this machine has set is cleared first, so a developer with
    their own ``EGMA_SIMULATOR_*`` exported cannot make these pass or fail
    differently from anybody else's.

    Here rather than in one suite because two of them configure a simulator
    in process now: the one about reading the environment, and the one
    about the platform's settings replacing what it read.
    """
    for name in list(os.environ):
        if name.startswith("EGMA_SIMULATOR_"):
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("EGMA_SIMULATOR_WAL_DIR", str(tmp_path / "wal"))
    monkeypatch.setenv("EGMA_SIMULATOR_BLOB_DIR", str(tmp_path / "blobs"))
    return monkeypatch


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
    env: dict[str, str]
    """The whole environment this child was started with — which is the
    whole of what it was told, and so the only thing that can say where
    its recordings went."""

    def blob(self, reference: str) -> bytes:
        """What a reported reference actually resolves to, read out of
        whichever store this simulator was configured with.

        A reference is opaque: it carries no bucket, no directory and no
        address, so nothing about it says where to look. What says it is
        the configuration the simulator was given, which is why this
        reads that rather than opening a directory it assumed. Every
        assertion about a recording in this suite goes through here, so
        moving the store from a directory to a bucket costs this helper
        and not one test.
        """
        endpoint = self.env.get("EGMA_SIMULATOR_S3_ENDPOINT", "").strip()
        if not endpoint:
            return (self.blob_dir / reference).read_bytes()
        return object_in_storage(self.env, reference)

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
            # Blanked rather than left alone, for the same reason the two
            # directories above are pinned: this suite inherits the
            # environment it was run in, and a developer who did
            # `set -a; source .env` to drive compose has a real endpoint
            # and a real write credential exported. Left through, every
            # voice test here would need their container running and
            # would write its recordings into their store. Blank counts
            # as unset in `config.py`, so this is the filesystem store,
            # which is what a suite that costs no infrastructure means.
            # A test that wants a real store puts it back through
            # `extra_env` below.
            "EGMA_SIMULATOR_S3_ENDPOINT": "",
            "EGMA_SIMULATOR_S3_BUCKET": "",
            "EGMA_SIMULATOR_S3_REGION": "",
            "EGMA_SIMULATOR_S3_ACCESS_KEY_ID": "",
            "EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY": "",
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
            env=env,
        )
        started.append(simulator)
        return simulator

    yield start

    for simulator in started:
        simulator.stop()


# -- A real object store, or a visible skip ----------------------------------
#
# The store the deployment runs is MinIO, and what is proved against it
# here is proved against the real thing: a real bucket, a real signature,
# a real HTTP round trip. There is no fake, on purpose — an in-memory
# stand-in would agree with whatever this code believed about signatures,
# addressing and keys, which is the entire set of things that go wrong.
#
# It is the pattern the live speech and live phone suites already use, one
# notch cheaper: those need somebody's provider account, and this needs a
# container anybody can start. Where docker cannot start one the tests say
# so and skip — never silently pass, and never fail somebody's checkout for
# infrastructure they were promised they would not need.

MINIO_IMAGE = "minio/minio:RELEASE.2025-09-07T16-13-09Z"
"""The release `docker-compose.yml` runs, named again here.

The same release rather than a moving tag, and checked against the compose
file by `test_deployment.py`: proving the object-storage path against an
image nobody deploys would prove it about the wrong store the first time
the two drifted.
"""

OBJECT_STORAGE_ACCESS_KEY_ID = "SENTINEL-object-storage-key-id-6d19"
OBJECT_STORAGE_SECRET_ACCESS_KEY = "SENTINEL-object-storage-secret-3f8c1a9d47b2"
"""The credential the test store is stood up with.

Both halves are sentinels, like every other planted credential in this
suite and for the same reason: a simulator configured to write to object
storage is really holding them while it conducts, which is what makes
scanning its output prove anything. Both, rather than the secret alone,
because the simulator treats a key id as half of one credential and keeps
it out of its logs too — a claim that is worth exactly as much as the scan
behind it. MinIO refuses a root password under eight characters, so the
second is also the shortest thing that would work.
"""

WRONG_OBJECT_STORAGE_SECRET_ACCESS_KEY = "SENTINEL-object-storage-wrong-91ae7c30"
"""A write credential the store will refuse, and a sentinel like the real
one.

What it buys is the other half of the scan: a credential that works is
never mentioned by anybody, and a credential that does not is what a
client complains about — with the request it signed, at the level somebody
turns on when recordings are not arriving."""

OBJECT_STORAGE_START_SECONDS = 300.0
OBJECT_STORAGE_READY_SECONDS = 60.0
"""How long the store is given to arrive, and then to answer.

The first is generous because the first run on a machine fetches the
image, which is 175 MB and is not this suite's to be fast at. The second
is the container itself, which takes about a second.

These two are a budget rather than a limit, and what makes them safe is
`OBJECT_STORAGE_TIMEOUT_SECONDS` in `test_object_storage.py`: pytest's own
timeout covers a fixture as well as a test, so a suite whose fixture
budget outran it would turn a slow image pull into a red failure instead
of the visible skip this fixture promises. The module's marker is set
above the sum of these, which is what keeps the fixture's own refusal the
one that fires.
"""

OBJECT_STORAGE_BUCKET = DEFAULT_S3_BUCKET
"""The bucket the deployment creates on first start, read from the code
that names it rather than restated — one name, so the suite cannot end up
proving something about a bucket no deployment has."""


@dataclass
class ObjectStorage:
    """One real object store, and the settings a simulator reaches it by."""

    endpoint: str
    bucket: str

    @property
    def env(self) -> dict[str, str]:
        """What to hand a simulator so its recordings land here.

        Naming the endpoint is the whole of what selects object storage,
        exactly as naming a media backend is the whole of what selects a
        bridge — so this dictionary *is* the choice, and a suite that
        leaves it out is a suite running on the filesystem store.
        """
        return {
            "EGMA_SIMULATOR_S3_ENDPOINT": self.endpoint,
            "EGMA_SIMULATOR_S3_BUCKET": self.bucket,
            "EGMA_SIMULATOR_S3_ACCESS_KEY_ID": OBJECT_STORAGE_ACCESS_KEY_ID,
            "EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY": (
                OBJECT_STORAGE_SECRET_ACCESS_KEY
            ),
        }


def object_client(env: Mapping[str, str]):
    """A client for the store these settings name, built here rather than
    borrowed from the simulator.

    Reading a recording back through the simulator's own store object
    would prove that the code agrees with itself. This builds its own
    client from the same environment a deployment sets, so what it proves
    is that some other reader — which is every reader in the deployment —
    finds the bytes where the reference says they are.
    """
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=env["EGMA_SIMULATOR_S3_ENDPOINT"],
        aws_access_key_id=env["EGMA_SIMULATOR_S3_ACCESS_KEY_ID"],
        aws_secret_access_key=env["EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY"],
        region_name=env.get("EGMA_SIMULATOR_S3_REGION", DEFAULT_S3_REGION),
        config=Config(s3={"addressing_style": "path"}),
    )


def object_in_storage(env: Mapping[str, str], reference: str) -> bytes:
    """The bytes one reference names, out of the store these settings name."""
    answer = object_client(env).get_object(
        Bucket=env.get("EGMA_SIMULATOR_S3_BUCKET", OBJECT_STORAGE_BUCKET),
        Key=reference,
    )
    return answer["Body"].read()


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _answering(url: str, *, within_seconds: float) -> bool:
    deadline = time.monotonic() + within_seconds
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as answer:
                if answer.status == 200:
                    return True
        except (urllib.error.URLError, OSError, TimeoutError):
            pass
        time.sleep(0.2)
    return False


@pytest.fixture(scope="session")
def object_storage() -> Iterator[ObjectStorage]:
    """A MinIO of this session's own, on a port nothing else has.

    Session-scoped because starting one costs a second or two and every
    test that wants one wants the same one; published on loopback and on
    an ephemeral port so two checkouts building at once cannot collide.

    The bucket is made here rather than assumed, which is the same thing
    `docker-compose.yml` does with a one-shot job: a fresh volume arrives
    empty, and a store with no bucket in it refuses every write with an
    error about a bucket nobody was told to create.

    Every way this can fail ends in a skip that says what happened —
    docker missing, docker refusing, an image that would not come, a
    container that never answered. Never a failure: a contributor was
    promised the suite costs them no infrastructure, and a red line here
    would be this suite breaking that promise rather than the code
    breaking anything. See the two budgets above.
    """
    port = _free_port()
    name = f"egma-test-minio-{os.getpid()}-{port}"
    try:
        started = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--detach",
                "--name",
                name,
                "--publish",
                f"127.0.0.1:{port}:9000",
                "--env",
                f"MINIO_ROOT_USER={OBJECT_STORAGE_ACCESS_KEY_ID}",
                "--env",
                f"MINIO_ROOT_PASSWORD={OBJECT_STORAGE_SECRET_ACCESS_KEY}",
                MINIO_IMAGE,
                "server",
                "/data",
            ],
            capture_output=True,
            text=True,
            timeout=OBJECT_STORAGE_START_SECONDS,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as unavailable:
        pytest.skip(
            "docker could not start an object store "
            f"({type(unavailable).__name__}), so the object-storage path is "
            f"not proved here; `docker run -p 9000:9000 {MINIO_IMAGE} server "
            "/data` is the whole of what these tests need"
        )
    if started.returncode != 0:
        pytest.skip(
            f"docker refused to start {MINIO_IMAGE}, so the object-storage "
            f"path is not proved here: {started.stderr.strip()}"
        )

    endpoint = f"http://127.0.0.1:{port}"
    try:
        if not _answering(
            f"{endpoint}/minio/health/live",
            within_seconds=OBJECT_STORAGE_READY_SECONDS,
        ):
            pytest.skip(
                f"{MINIO_IMAGE} started but never answered its health probe "
                f"at {endpoint}, so the object-storage path is not proved here"
            )
        storage = ObjectStorage(endpoint=endpoint, bucket=OBJECT_STORAGE_BUCKET)
        object_client(storage.env).create_bucket(Bucket=storage.bucket)
        yield storage
    finally:
        subprocess.run(
            ["docker", "rm", "--force", name], capture_output=True, timeout=60
        )


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
    mock_tools: list[dict] | None = None,
    platform: dict | None = None,
) -> dict:
    """The envelope every spec shares: one persona, one scenario, one set of
    walls, one exchange. What differs between two specs is the connection
    block and the modality, which is exactly the difference the plug seam
    exists to absorb.

    ``mock_tools`` is left off the document entirely when there are none,
    rather than sent as an empty list: absent is what the control plane
    really sends for a project that mocks nothing, and a spec that said
    ``[]`` would be exercising a shape nothing produces."""
    spec = {
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
    if mock_tools:
        spec["mock_tools"] = mock_tools
    if platform:
        # Left off the document entirely when the platform holds nothing,
        # for the reason `mock_tools` is: that is what the control plane
        # really sends for a deployment nobody has configured, and a spec
        # carrying an empty block would be exercising a shape nothing
        # produces.
        spec["platform"] = platform
    return spec


def scripted_spec(
    simulation_id: str,
    *,
    scenario: str = A_SCENARIO,
    personality: str = A_PERSONALITY,
    greeting: str | None = None,
    replies: list[str | None] | None = None,
    ends_after_replies: bool = False,
    turn_seconds: float = 0.0,
    provider_reference: str | None = None,
    tool_calls: list[dict] | None = None,
    max_turns: int = 60,
    max_duration_seconds: int = 600,
    credentials: dict | None = None,
    platform: dict | None = None,
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
    if tool_calls is not None:
        config["tool_calls"] = tool_calls
    return a_spec(
        simulation_id,
        connection={
            "type": "scripted",
            "config": config,
            "credentials": credentials,
        },
        platform=platform,
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
    platform: dict | None = None,
) -> dict:
    """One voice spec that dials a number.

    Deliberately the same shape as :func:`loopback_spec`: a phone
    simulation differs from every other voice one by its connection block
    and by nothing else. ``backend`` here only decides whether the
    scripted backend's script is written into the spec — what the far end
    says, whether it hangs up, what the carrier answers — which only that
    backend reads. Which bridge really places the call is the deployment's:
    this container's own configuration with the platform's carrier, which
    ``platform`` is how a test supplies.
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
        platform=platform,
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

    The transcript already proves the words. This reads audible stretches
    from the recording itself and proves that their two channels map to the
    same speakers, in the same order.
    """
    heard = speech_in_the_recording(recording)
    assert [speaker for speaker, _began, _ended in heard] == [
        speaker for speaker, _text in turns
    ]


def speech_in_the_recording(recording: bytes) -> list[tuple[str, int, int]]:
    """Every stretch of speech a listener could find, in sample positions.

    Read the way a listener would read it, one slice of the line at a
    time: loud is somebody talking and quiet is nobody, on each channel
    separately, and the results put back in the order they were spoken.
    What comes out is the conversation as the audio holds it, which is
    what a turn span claims to be about.
    """
    from egma_simulator.recording import channels_of
    from egma_simulator.speech import SAMPLE_WIDTH_BYTES, carries_speech

    persona_audio, agent_audio, band = channels_of(recording)
    window_samples = max(1, round(band * 0.005))
    width = window_samples * SAMPLE_WIDTH_BYTES
    heard: list[tuple[str, int, int]] = []
    for speaker, channel in (("human", persona_audio), ("agent", agent_audio)):
        opened: int | None = None
        slices = range(0, len(channel) - width + 1, width)
        for position, offset in enumerate(slices):
            speaking = carries_speech(channel[offset : offset + width])
            if speaking and opened is None:
                opened = position
            elif not speaking and opened is not None:
                heard.append(
                    (
                        speaker,
                        opened * window_samples,
                        position * window_samples,
                    )
                )
                opened = None
        if opened is not None:
            heard.append(
                (speaker, opened * window_samples, len(channel) // SAMPLE_WIDTH_BYTES)
            )
    return sorted(heard, key=lambda run: run[1])


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


def spans_for(records: list[dict], simulation_id: str) -> list[dict]:
    """Every span the workbench's OTLP sink recorded for one simulation,
    in arrival order — the record with its flush number kept."""
    return [
        record
        for record in records
        if record["kind"] == "span" and record["simulation_id"] == simulation_id
    ]


def span_attribute(span: dict, key: str) -> str | None:
    for entry in span.get("attributes", []):
        if entry["key"] == key:
            return entry["value"]["stringValue"]
    return None


TURN_SPANS = {"human_turn": "human", "agent_turn": "agent"}


def turns_for(records: list[dict], simulation_id: str) -> list[tuple[str, str]]:
    """The transcript, read where the transcript is: the turn spans.

    The speaker rides the span name and the words ride the one attribute
    the vocabulary declares, so a turn is those two and nothing else. This
    is how every suite here reads a conversation — the report door carries
    the lifecycle alone.
    """
    return [
        (
            TURN_SPANS[record["span"]["name"]],
            span_attribute(record["span"], "egma.turn.text") or "",
        )
        for record in spans_for(records, simulation_id)
        if record["span"]["name"] in TURN_SPANS
    ]


def measures_for(records: list[dict], simulation_id: str) -> list[str]:
    """Every measurement taken, named, in the order it was taken.

    A timing span is named for the measure it takes, so the names *are*
    the measurements — and the conversation's own spans are named for what
    they are, which is what tells the two apart.
    """
    conversation = {*TURN_SPANS, "simulation", "tool_call"}
    return [
        record["span"]["name"]
        for record in spans_for(records, simulation_id)
        if record["span"]["name"] not in conversation
    ]


def milliseconds_of(span: dict) -> float:
    """One timing span's measurement: its own duration, and nothing beside it."""
    return (
        int(span["endTimeUnixNano"]) - int(span["startTimeUnixNano"])
    ) / 1_000_000


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
