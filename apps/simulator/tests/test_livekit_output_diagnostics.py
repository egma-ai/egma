from __future__ import annotations

import logging
from typing import Any

import pytest

from egma_simulator.media.room import (
    _LiveKitOutputDiagnostics,
    _ObservedAudioSource,
)


class _Client:
    def __init__(self, *, connected: bool, source: object | None) -> None:
        self._connected = connected
        self._audio_source = source


def _attributes(record: logging.LogRecord) -> dict[str, object]:
    return record.__dict__["_egma_log_attributes"]


@pytest.mark.asyncio
async def test_livekit_output_diagnostics_distinguish_accepted_and_refused_writes(
    caplog: pytest.LogCaptureFixture,
) -> None:
    diagnostics = _LiveKitOutputDiagnostics()

    async def accepted(_frame: Any) -> bool:
        return True

    async def refused(_frame: Any) -> bool:
        return False

    assert await diagnostics.write(
        _Client(connected=True, source=object()), accepted, object()
    )
    assert not await diagnostics.write(
        _Client(connected=False, source=None), refused, object()
    )

    caplog.set_level(logging.INFO, logger="egma_simulator.media.room")
    diagnostics.report()

    record = caplog.records[-1]
    assert getattr(record, "otel.event.name") == "egma.media.livekit_output"
    assert _attributes(record) == {
        "livekit.audio.attempted_frames": 2,
        "livekit.audio.accepted_frames": 1,
        "livekit.audio.rejected_frames": 1,
        "livekit.audio.not_connected_frames": 1,
        "livekit.audio.no_source_frames": 0,
        "livekit.audio.exception_type": "",
        "livekit.audio.invalid_state_frames": 0,
    }


@pytest.mark.asyncio
async def test_observed_audio_source_delegates_and_preserves_its_interface() -> None:
    diagnostics = _LiveKitOutputDiagnostics()
    captured: list[object] = []

    class _Source:
        queued_duration = 1.25

        async def capture_frame(self, frame: object) -> None:
            captured.append(frame)

        def clear_queue(self) -> str:
            return "cleared"

    source = _Source()
    observed = _ObservedAudioSource(source, diagnostics)
    frame = object()

    await observed.capture_frame(frame)

    assert captured == [frame]
    assert observed.queued_duration == 1.25
    assert observed.clear_queue() == "cleared"


@pytest.mark.asyncio
async def test_observed_audio_source_preserves_and_classifies_capture_failure() -> None:
    diagnostics = _LiveKitOutputDiagnostics()
    failure = RuntimeError("native capture InvalidState")

    class _Source:
        async def capture_frame(self, _frame: object) -> None:
            raise failure

    observed = _ObservedAudioSource(_Source(), diagnostics)
    with pytest.raises(RuntimeError) as raised:
        await observed.capture_frame(object())

    assert raised.value is failure
    assert diagnostics.exception_type == "RuntimeError"
    assert diagnostics.invalid_state == 1
