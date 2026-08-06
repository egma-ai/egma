"""What the claim loop does with an answer it did not expect.

The capacity a claim declares is a request, and the answer is the control
plane's to compose. A simulator that trusted the answer would overload on a
bad one, and a simulator that raised on it would take its own in-flight work
down with it. Neither is acceptable, so the loop takes what fits, refuses
the rest out loud, and keeps going.

These are the runtime's own defences, tested with the workbench's clamping
deliberately out of the way — a well-behaved control plane can never
exercise them.
"""

from __future__ import annotations

import asyncio

import pytest
from conftest import scripted_spec

from egma_simulator.config import SimulatorConfig
from egma_simulator.redaction import SecretRegistry
from egma_simulator.service import SimulatorService
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
    assert "past the 2 declared" in caplog.text


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
    assert "does not speak the" in caplog.text


def test_credentials_from_an_accepted_spec_are_registered_for_redaction(tmp_path):
    service = a_service(tmp_path)
    executor = RecordingExecutor(capacity=2)
    service._accept(
        [scripted_spec("sim-secret", credentials={"apiKey": "hunter2-not-real"})],
        executor,
    )
    assert service._secrets.redact("saw hunter2-not-real here") == "saw [redacted] here"


def test_a_spec_naming_an_unplugged_connection_type_is_refused(tmp_path, caplog):
    """No plug for the type: the claim is refused out loud, nothing reported."""
    service = a_service(tmp_path, capacity=4)
    executor = RecordingExecutor(capacity=4)

    unplugged = scripted_spec("sim-unplugged")
    unplugged["connection"]["type"] = "a-platform-with-no-plug-yet"
    good = scripted_spec("sim-plugged")

    service._accept([unplugged, good], executor)

    assert [spec.simulation_id for spec in executor.accepted] == ["sim-plugged"]
    assert "no platform plug" in caplog.text


def test_the_typed_spec_reads_what_the_document_says():
    spec = SimulationSpec.from_document(
        scripted_spec("sim-typed", scenario="Hello there.", max_turns=7)
    )
    assert spec.simulation_id == "sim-typed"
    assert spec.modality == "chat"
    assert spec.scenario_instructions == "Hello there."
    assert spec.limits.max_turns == 7
    assert spec.connection_type == "scripted"
    assert spec.persona_traits["language"] == "en-US"


def test_the_typed_spec_refuses_a_document_that_breaks_the_contract():
    from egma_simulator.contract import ContractViolation

    broken = scripted_spec("sim-bad")
    broken["modality"] = "telepathy"
    with pytest.raises(ContractViolation):
        SimulationSpec.from_document(broken)
