"""Execution duration excludes recording, model teardown and report delivery."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta

import pytest
from conftest import loopback_spec, scripted_spec

from egma_simulator import reporting, service
from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.config import SimulatorConfig
from egma_simulator.model import ModelFailure, PersonaReply
from egma_simulator.redaction import SecretRegistry
from egma_simulator.service import RunningSimulation
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import SCRIPTED_PAIR


@pytest.mark.parametrize(
    ("modality", "outcome"),
    [
        ("chat", "completed"),
        ("chat", "failed"),
        ("chat", "metadata_failure"),
        ("chat", "canceled"),
        ("chat", "cleanup_failed"),
        ("chat", "evidence_cleanup_failed"),
        ("voice", "completed"),
        ("voice", "recording_failed"),
        ("voice", "failed"),
        ("voice", "canceled"),
        ("chat", "assembly_failed"),
        ("chat", "setup_delayed"),
    ],
)
async def test_execution_end_precedes_cleanup_and_evidence_delivery(
    tmp_path, monkeypatch, modality, outcome
):
    seconds = 0
    model_entered = asyncio.Event()
    delivered: list[dict] = []
    origin = datetime(2026, 9, 8, tzinfo=UTC)
    evidence_cleanup_calls = 0
    logs: list[tuple[str, dict[str, object]]] = []

    def moment() -> str:
        return (origin + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")

    class Model:
        model_name = "scripted"

        async def reply(self, context):
            nonlocal seconds
            seconds = 10
            model_entered.set()
            if outcome == "failed":
                raise RuntimeError("model execution failed")
            if outcome == "metadata_failure":
                raise ModelFailure(
                    "the model's answer had no words to speak",
                    diagnostic_attributes={
                        "gen_ai.response.id": "response-123",
                        "gen_ai.response.refusal_present": True,
                    },
                )
            if outcome == "canceled" and modality == "chat":
                await asyncio.Event().wait()
            return PersonaReply(text="Goodbye.", concluded=outcome != "canceled")

        async def close(self):
            nonlocal seconds
            seconds = 60
            await asyncio.sleep(0)
            if outcome == "cleanup_failed":
                raise RuntimeError("model cleanup failed after execution")

    class RecordingStore(FilesystemBlobStore):
        async def write(self, key, data):
            nonlocal seconds
            seconds = 30
            await asyncio.sleep(0)
            if outcome == "recording_failed":
                raise RuntimeError("recording upload failed")
            return await super().write(key, data)

    class ControlPlane:
        async def report(self, simulation_id, serialized):
            delivered.append(json.loads(serialized))

        async def spans(self, simulation_id, serialized):
            nonlocal seconds
            if seconds >= 60 or outcome == "assembly_failed":
                seconds = 120
                await asyncio.sleep(0)
            delivered.append(json.loads(serialized))

        async def heartbeat(self, simulation_id, claimant):
            if outcome == "canceled":
                await model_entered.wait()
                return "cancel"
            return None

    def build_model(_spec):
        nonlocal seconds
        if outcome == "assembly_failed":
            seconds = 10
            raise RuntimeError("model setup failed before execution")
        if outcome == "setup_delayed":
            seconds = 5
        return Model()

    def fail_evidence_cleanup(_simulation):
        nonlocal evidence_cleanup_calls
        evidence_cleanup_calls += 1
        if evidence_cleanup_calls > 1:
            raise RuntimeError("tool evidence finalization failed")

    monkeypatch.setattr(reporting, "moment", moment)
    monkeypatch.setattr(service, "build_model_client", build_model)

    def capture_log(_logger, _level, event_name, _body, *args, **kwargs):
        del args
        logs.append((event_name, kwargs.get("attributes") or {}))

    monkeypatch.setattr(service, "log_event", capture_log)
    if outcome == "evidence_cleanup_failed":
        monkeypatch.setattr(
            RunningSimulation,
            "_record_reported_tool_calls",
            fail_evidence_cleanup,
        )
    monkeypatch.setattr(
        service.SpeechProviders,
        "from_models",
        classmethod(lambda _cls, _models, *, vad: SCRIPTED_PAIR),
    )
    document = (loopback_spec if modality == "voice" else scripted_spec)(
        "sim-execution-timing", max_duration_seconds=30
    )
    await RunningSimulation(
        SimulationSpec.from_document(document),
        client=ControlPlane(),
        config=SimulatorConfig(
            control_plane_url="http://127.0.0.1:1",
            claimant="timing-test",
            capacity=1,
            heartbeat_seconds=3600,
            claim_wait_seconds=1,
            report_deadline_seconds=5,
            wal_dir=tmp_path / "wal",
            blob_dir=tmp_path / "blobs",
            log_level="INFO",
        ),
        secrets=SecretRegistry(),
        blobs=RecordingStore(tmp_path / "blobs"),
    ).run()

    terminal = next(
        event
        for document in delivered
        for event in document.get("events", [])
        if event["status"] != "running"
    )
    assert terminal["status"] == (
        "failed"
        if outcome == "assembly_failed"
        else "completed"
        if outcome
        in (
            "setup_delayed",
            "cleanup_failed",
            "evidence_cleanup_failed",
            "recording_failed",
        )
        else "failed"
        if outcome == "metadata_failure"
        else outcome
    )
    if outcome == "assembly_failed":
        assert not any(
            event["status"] == "running"
            for document in delivered
            for event in document.get("events", [])
        )
        assert terminal["facts"]["started_at"] == "2026-09-08T00:00:10.000000Z"
    elif outcome == "setup_delayed":
        assert terminal["facts"]["started_at"] == "2026-09-08T00:00:05.000000Z"
    else:
        assert terminal["facts"]["started_at"] == "2026-09-08T00:00:00.000000Z"
    assert terminal["facts"]["ended_at"] == "2026-09-08T00:00:10.000000Z"
    assert terminal["at"] == "2026-09-08T00:02:00.000000Z"
    if outcome in ("evidence_cleanup_failed", "recording_failed"):
        assert terminal["facts"]["evidence_error"] == "evidence_collection_error"
    if modality == "voice" and outcome == "completed":
        assert terminal["facts"]["audio"] is not None
        assert terminal["facts"]["turn_count"] > 0
    if outcome == "metadata_failure":
        finished = next(
            attributes
            for event, attributes in logs
            if event == "egma.simulation.finished"
        )
        assert finished["gen_ai.response.id"] == "response-123"
        assert finished["gen_ai.response.refusal_present"] is True
        assert terminal["reason"].endswith("the model's answer had no words to speak")
