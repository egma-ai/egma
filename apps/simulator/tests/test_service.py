"""Test excess or malformed claims without the workbench's normal clamping.
The simulator must accept only valid work within capacity and keep running.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import UTC, datetime

from conftest import loopback_spec, scripted_spec

from egma_simulator import service as service_module
from egma_simulator.client import ClaimedSpec, ClaimFailure
from egma_simulator.config import SimulatorConfig
from egma_simulator.redaction import SecretRegistry
from egma_simulator.service import SimulatorService, resources_for_claim
from egma_simulator.spec import SimulationSpec


class RecordingExecutor:
    """Counts what it was handed and pretends everything is still running."""

    def __init__(self, capacity: int) -> None:
        self._capacity = capacity
        self.accepted: list[SimulationSpec] = []

    @property
    def free_capacity(self) -> int:
        return self._capacity - len(self.accepted)

    def submit(self, spec: SimulationSpec) -> None:
        if self.free_capacity < 1:
            raise RuntimeError("submit called with no free capacity")
        self.accepted.append(spec)

    async def wait_for_room(self) -> None:  # pragma: no cover - never full here
        await asyncio.sleep(0)

    def cancel_all(self) -> None: ...

    async def drain(self) -> None: ...


def a_service(tmp_path, capacity: int = 2) -> SimulatorService:
    config = SimulatorConfig(
        control_plane_url="http://127.0.0.1:1",
        claimant="test",
        capacity=capacity,
        heartbeat_seconds=5.0,
        claim_wait_seconds=1.0,
        report_deadline_seconds=1.0,
        wal_dir=tmp_path,
        blob_dir=tmp_path / "blobs",
        log_level="INFO",
    )
    return SimulatorService(config, secrets=SecretRegistry())


def test_an_over_granting_answer_is_clamped_not_raised_on(tmp_path, caplog):
    """The surplus is refused; nothing in flight is disturbed."""
    service = a_service(tmp_path, capacity=2)
    executor = RecordingExecutor(capacity=2)
    documents = [scripted_spec(f"sim-over-{n}") for n in range(5)]

    service._accept(documents, executor)  # must not raise

    assert [spec.simulation_id for spec in executor.accepted] == [
        "sim-over-0",
        "sim-over-1",
    ]
    assert "exceeded simulator capacity" in caplog.text


def test_a_spec_that_does_not_speak_the_contract_never_becomes_a_simulation(
    tmp_path, caplog
):
    """Refusing to conduct is not a simulation that went wrong."""
    service = a_service(tmp_path, capacity=4)
    executor = RecordingExecutor(capacity=4)

    broken = scripted_spec("sim-broken")
    del broken["limits"]
    unreadable = {"contract_version": 1}
    good = scripted_spec("sim-good")

    service._accept([broken, unreadable, good], executor)

    # The good one still gets through: one bad document does not spoil the
    # rest of the answer.
    assert [spec.simulation_id for spec in executor.accepted] == ["sim-good"]
    assert "did not match the work contract" in caplog.text


def test_credentials_from_an_accepted_spec_are_registered_for_redaction(tmp_path):
    service = a_service(tmp_path)
    executor = RecordingExecutor(capacity=2)
    service._accept(
        [scripted_spec("sim-secret", credentials={"apiKey": "hunter2-not-real"})],
        executor,
    )
    assert service._secrets.redact("saw hunter2-not-real here") == "saw [redacted] here"


def test_a_persistent_service_does_not_retain_claim_deadlines(tmp_path):
    service = a_service(tmp_path)
    executor = RecordingExecutor(capacity=1)

    service._accept(
        [ClaimedSpec(scripted_spec("sim-standing"), datetime.now(UTC))], executor
    )

    assert service._claimed_at == {}
    assert service._hard_stop is None


def test_a_spec_naming_an_unplugged_connection_type_is_refused(tmp_path, caplog):
    """No plug for the type: the claim is refused out loud, nothing reported."""
    service = a_service(tmp_path, capacity=4)
    executor = RecordingExecutor(capacity=4)

    unplugged = scripted_spec("sim-unplugged")
    unplugged["connection"]["connection_type"] = "a-connection-with-no-plug-yet"
    good = scripted_spec("sim-plugged")

    service._accept([unplugged, good], executor)

    assert [spec.simulation_id for spec in executor.accepted] == ["sim-plugged"]
    assert "no adapter for its connection type" in caplog.text


class RefusingClient:
    """A control plane that turns down every claim the same way.

    Counts the attempts and raises ``enough`` once there have been the
    asked-for number of them, so the test waits on the loop having really
    gone round rather than on a clock.
    """

    def __init__(self, *, attempts_wanted: int) -> None:
        self.attempts = 0
        self.enough = asyncio.Event()
        self._wanted = attempts_wanted

    async def claim(
        self,
        claimant: str,
        capacity: int,
        modalities: tuple[str, ...] | None = None,
    ) -> list[dict]:
        self.attempts += 1
        if self.attempts >= self._wanted:
            self.enough.set()
        raise ClaimFailure("claim answered 404: Route POST:/v1/claims not found")


async def test_a_claim_failure_that_never_changes_is_said_once_not_forever(
    tmp_path, caplog, monkeypatch
):
    """An outage is one piece of news, however long it lasts.

    A control plane that is down, or that does not answer this question
    yet, fails the identical way on every retry. Written out each time,
    that is one sentence a second for the length of the outage — megabytes
    a day of a log nobody can read. The repeats stay at DEBUG for whoever
    wants to count them.
    """
    monkeypatch.setattr(service_module, "CLAIM_RETRY_SECONDS", 0.001)
    caplog.set_level(logging.DEBUG, logger="egma_simulator.service")
    service = a_service(tmp_path)
    client = RefusingClient(attempts_wanted=25)

    claiming = asyncio.create_task(
        service._claim_forever(client, RecordingExecutor(capacity=2))
    )
    await client.enough.wait()
    claiming.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await claiming

    shouted = [record for record in caplog.records if record.levelno == logging.WARNING]
    assert len(shouted) == 1, [record.getMessage() for record in shouted]
    assert "claim did not land" in shouted[0].getMessage()
    assert client.attempts >= 25, "the loop kept trying, quietly"


def test_a_daytona_claim_replaces_only_media_and_recording_resources(
    tmp_path, monkeypatch
):
    config = SimulatorConfig(
        control_plane_url="http://127.0.0.1:1",
        claimant="egma-voice-runtime",
        capacity=1,
        heartbeat_seconds=5.0,
        claim_wait_seconds=1.0,
        report_deadline_seconds=1.0,
        wal_dir=tmp_path,
        blob_dir=tmp_path / "blobs",
        log_level="INFO",
        mode="one-shot",
        modalities=("voice",),
        runtime="daytona",
    )
    document = loopback_spec("sim_123")
    document["runtime"] = {
        "kind": "daytona_voice",
        "media": {
            "backend": "livekit",
            "livekit_url": "wss://livekit.example",
            "livekit_room_name": "egma-sim-sim_123",
            "livekit_room_token": "room-token",
            "livekit_api_token": "api-token",
        },
        "storage": {
            "backend": "s3",
            "endpoint": "https://s3.example",
            "bucket": "recordings",
            "region": "us-east-1",
            "access_key_id": "temporary-access",
            "secret_access_key": "temporary-secret",
            "session_token": "temporary-session",
        },
    }
    spec = SimulationSpec.from_document(document)
    standing_blobs = object()
    built: dict = {}

    def fake_s3(**settings):
        built.update(settings)
        return "claimed-store"

    monkeypatch.setattr(service_module, "S3BlobStore", fake_s3)

    claimed_config, claimed_blobs = resources_for_claim(
        config, spec, standing_blobs
    )

    assert claimed_config.media is not None
    assert claimed_config.media.livekit_room_name == "egma-sim-sim_123"
    assert claimed_config.media.livekit_room_token == "room-token"
    assert claimed_blobs == "claimed-store"
    assert built == {
        "endpoint": "https://s3.example",
        "bucket": "recordings",
        "region": "us-east-1",
        "access_key_id": "temporary-access",
        "secret_access_key": "temporary-secret",
        "session_token": "temporary-session",
    }
