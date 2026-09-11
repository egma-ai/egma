"""Acceptance regressions for deliberate persona interruptions.

These tests use only the simulation assembly/conduct boundary, media output, and
reported recording/evidence. They intentionally do not inspect conductor state.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    StartFrame,
    TextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from test_voice import spec_for

from egma_simulator import conductor as conductor_module
from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.conductor import ConductParameters, VoiceConductor
from egma_simulator.conversation import ConversationControls
from egma_simulator.media import PlayoutClock, VoiceMedia, arrived_at, played_out_at
from egma_simulator.media.scripted_transport import ScriptedTransport
from egma_simulator.model import ModelClient, PersonaReply, ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.recording import channels_of
from egma_simulator.speech import (
    ScriptedSTT,
    ScriptedTTS,
    SpeechLegs,
    encode_speech,
    silence,
    voice_from_models,
)

pytestmark = pytest.mark.timeout(6)


class _Connection:
    def __init__(
        self,
        transport: ScriptedTransport,
        *output: FrameProcessor,
        after_output: bool = False,
    ) -> None:
        self.transport = transport
        self.output = output
        self.after_output = after_output

    @property
    def provider_reference(self) -> None:
        return None

    @property
    def far_end_left(self) -> bool:
        return self.transport.ended.is_set()

    async def prepare(self) -> VoiceMedia:
        media = self.transport.media
        return VoiceMedia(
            input=media.input,
            output=(
                (*media.output, *self.output)
                if self.after_output
                else (*self.output, *media.output)
            ),
            ended=media.ended,
            input_recorded=media.input_recorded,
            real_time=media.real_time,
        )

    async def open(self) -> None:
        await self.transport.activate()

    async def close(self) -> None:
        self.transport.stop()


class _ExactSecondTTS(FrameProcessor):
    """Emit fixed one-second frames so the cap lands on an exact boundary."""

    def __init__(self) -> None:
        super().__init__()
        self.rate = 0
        self.canceled = asyncio.Event()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction == FrameDirection.UPSTREAM and isinstance(
            frame, InterruptionFrame
        ):
            self.canceled.set()
        if isinstance(frame, StartFrame):
            self.rate = frame.audio_out_sample_rate
        if (
            direction == FrameDirection.DOWNSTREAM
            and isinstance(frame, TextFrame)
            and not isinstance(frame, TranscriptionFrame)
        ):
            await self.push_frame(TTSStartedFrame())
            for value in range(1, 5):
                await self.push_frame(
                    TTSAudioRawFrame(
                        audio=bytes((value, 0)) * self.rate,
                        sample_rate=self.rate,
                        num_channels=1,
                    )
                )
            await self.push_frame(TTSStoppedFrame())
        await self.push_frame(frame, direction)


class _ActAfterAcceptedAudio(FrameProcessor):
    def __init__(self, action) -> None:
        super().__init__()
        self.action = action
        self.accepted = asyncio.Event()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(
            frame, OutputAudioRawFrame
        ):
            await self.push_frame(frame, direction)
            self.accepted.set()
            self.action()
            return
        await self.push_frame(frame, direction)


class _HeldModel(ModelClient):
    def __init__(self, replies: list[str]) -> None:
        self._replies = iter(replies)
        self.calls: list[list[dict[str, str]]] = []
        self.called = asyncio.Event()
        self.release = asyncio.Event()
        self.closed = asyncio.Event()

    @property
    def model_name(self) -> str:
        return "held-model"

    async def reply(self, context) -> PersonaReply:
        messages = list(context.get_messages())
        self.calls.append(messages)
        self.called.set()
        await self.release.wait()
        return PersonaReply(next(self._replies), concluded=False)

    async def close(self) -> None:
        self.closed.set()


async def _conduct_with(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    model: ModelClient,
    tts: FrameProcessor,
    greeting: str,
    replies: list[str],
    controls: ConversationControls | None = None,
    max_duration_seconds: float = 30,
    interruption_level: str = "frequent",
    simulation_name: str = "sim:interruption-acceptance",
    output_after_transport: tuple[FrameProcessor, ...] = (),
    transport: ScriptedTransport | None = None,
):
    spec = spec_for(
        scenario="Interrupt briefly, then answer each completed agent turn.",
        greeting=greeting,
        replies=replies,
        max_turns=8,
        max_duration_seconds=max_duration_seconds,
    )
    transport = transport or ScriptedTransport(
        greeting=greeting,
        replies=replies,
        answer_delay_seconds=0,
        ends_after_replies=True,
    )
    connection = _Connection(transport, *output_after_transport, after_output=True)
    legs = SpeechLegs(
        stt=ScriptedSTT(),
        tts=tts,
        voice=voice_from_models(spec.models),
    )
    monkeypatch.setattr(conductor_module, "build_legs", lambda *_args, **_kwargs: legs)
    conductor = VoiceConductor(
        connection=connection,
        voice=legs.voice,
        blobs=FilesystemBlobStore(tmp_path),
        recording_key=f"{spec.simulation_id}/dual-channel.wav",
        parameters=ConductParameters(interruption_level=interruption_level),
    )
    spans: list[tuple[str, str, int, int]] = []
    interruptions: list[object] = []

    async def on_utterance(speaker: str, text: str, began: int, ended: int) -> None:
        spans.append((speaker, text, began, ended))

    async def on_measured(_measure: str, _began: int, _ended: int) -> None:
        return None

    conducted = await conductor.conduct(
        persona=Persona(
            authored=spec.persona,
            scenario_instructions=spec.scenario_instructions,
            model=model,
        ),
        max_turns=spec.limits.max_turns,
        max_duration_seconds=spec.limits.max_duration_seconds,
        controls=controls or ConversationControls(),
        name=simulation_name,
        on_utterance=on_utterance,
        on_measured=on_measured,
        on_interruption=interruptions.append,
    )
    return conducted, spans, conductor.audio, transport, interruptions


async def test_exact_three_second_boundary_cancels_unused_audio_without_text_lie(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    full = "This generated sentence contains a tail that the caller never hears."
    model = _HeldModel([full, "Normal answer."])
    model.release.set()
    tts = _ExactSecondTTS()

    _conducted, spans, audio, _transport, interruptions = await _conduct_with(
        tmp_path,
        monkeypatch,
        model=model,
        tts=tts,
        greeting="Please keep speaking continuously while the caller interrupts. " * 10,
        replies=["Thanks."],
    )

    deliberate = next(turn for turn in spans if turn[0] == "human")
    assert deliberate[3] - deliberate[2] <= 3_000_000_000
    assert deliberate[1] == ""
    assert tts.canceled.is_set()
    delivered = next(event for event in interruptions if event.event == "delivered")
    assert delivered.generated_text == full
    assert delivered.delivered_text is None
    assert delivered.began_unix_nano is not None
    assert delivered.ended_unix_nano is not None
    assert delivered.overlap_ended_unix_nano is not None
    assert 0 < delivered.ended_unix_nano - delivered.began_unix_nano <= 3_000_000_000

    assert audio is not None
    persona, agent, _rate = channels_of((tmp_path / audio.recording).read_bytes())
    assert any(
        persona[offset : offset + 2] != b"\x00\x00"
        and agent[offset : offset + 2] != b"\x00\x00"
        for offset in range(0, min(len(persona), len(agent)), 2)
    )


async def test_cancel_while_interruption_generation_is_held_finishes_all_owned_work(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    model = _HeldModel(["A reply that must never be released."])
    controls = ConversationControls()
    tts = _ExactSecondTTS()
    running = asyncio.create_task(
        _conduct_with(
            tmp_path,
            monkeypatch,
            model=model,
            tts=tts,
            greeting="The agent keeps talking long enough to start an interruption. "
            * 12,
            replies=[],
            controls=controls,
            max_duration_seconds=60,
        )
    )

    await asyncio.wait_for(model.called.wait(), 1)
    controls.request_cancel()
    conducted, spans, _audio, _transport, interruptions = await asyncio.wait_for(
        running, timeout=1
    )

    assert conducted.status == "canceled"
    assert not [turn for turn in spans if turn[0] == "human"]
    canceled = [event for event in interruptions if event.event == "canceled"]
    assert len(canceled) == 1
    assert canceled[0].reason == "simulation_stopped"
    assert canceled[0].at_unix_nano is not None


@pytest.mark.parametrize(
    ("level", "minimum", "maximum"),
    [("occasional", 6.0, 10.0), ("frequent", 2.0, 4.0)],
)
async def test_policy_uses_seeded_delay_in_the_selected_range(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    level: str,
    minimum: float,
    maximum: float,
):
    delays: list[int] = []
    for run in ("first", "second"):
        spec = spec_for()
        model = ScriptedModel("One brief interruption. Then answer normally.")
        tts = ScriptedTTS(voice=voice_from_models(spec.models))
        _result, _spans, _audio, _transport, events = await _conduct_with(
            tmp_path / run,
            monkeypatch,
            model=model,
            tts=tts,
            greeting="The agent maintains one continuous explanation. " * 18,
            replies=["The agent finishes after the interruption."],
            interruption_level=level,
            simulation_name="sim:stable-seed",
        )
        scheduled = next(event for event in events if event.event == "scheduled")
        assert scheduled.at_unix_nano is not None
        assert scheduled.scheduled_for_unix_nano is not None
        delay = scheduled.scheduled_for_unix_nano - scheduled.at_unix_nano
        assert int(minimum * 1_000_000_000) <= delay <= int(maximum * 1_000_000_000)
        delays.append(delay)

    assert delays[0] == delays[1]


async def test_off_never_schedules_or_overlaps(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    spec = spec_for()
    model = ScriptedModel("Answer after the agent finishes.")
    tts = ScriptedTTS(voice=voice_from_models(spec.models))
    _result, spans, _audio, _transport, events = await _conduct_with(
        tmp_path,
        monkeypatch,
        model=model,
        tts=tts,
        greeting="The agent maintains one continuous explanation. " * 18,
        replies=["Done."],
        interruption_level="off",
    )

    assert events == []
    agents = [turn for turn in spans if turn[0] == "agent"]
    people = [turn for turn in spans if turn[0] == "human"]
    assert all(
        not (human[2] < agent[3] and agent[2] < human[3])
        for human in people
        for agent in agents
    )


async def test_run_cancel_after_first_accepted_interruption_audio_wins_immediately(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    controls = ConversationControls()
    accepted = _ActAfterAcceptedAudio(controls.request_cancel)
    model = _HeldModel(["Generated interruption text with an unplayed tail."])
    model.release.set()
    tts = _ExactSecondTTS()
    greeting = "The agent continues speaking while cancellation arrives. " * 12
    transport = ScriptedTransport(
        greeting=greeting,
        replies=[],
        answer_delay_seconds=0,
        ends_after_replies=False,
    )
    conducted, spans, _audio, _transport, events = await _conduct_with(
        tmp_path,
        monkeypatch,
        model=model,
        tts=tts,
        greeting=greeting,
        replies=[],
        controls=controls,
        output_after_transport=(accepted,),
        transport=transport,
    )

    assert accepted.accepted.is_set()
    assert conducted.status == "canceled"
    human = [turn for turn in spans if turn[0] == "human"]
    assert all(turn[1] == "" for turn in human)
    canceled = [event for event in events if event.event == "canceled"]
    assert canceled and canceled[-1].reason == "simulation_stopped"
    assert canceled[-1].at_unix_nano is not None


@pytest.mark.parametrize("ending", ["disconnect", "duration_limit"])
async def test_external_end_while_interruption_generation_is_held_cleans_up(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    ending: str,
):
    model = _HeldModel(["This pending interruption must not escape."])
    controls = ConversationControls()
    transport = ScriptedTransport(
        greeting="The agent keeps talking during pending generation. " * 12,
        replies=[],
        answer_delay_seconds=0,
        ends_after_replies=False,
    )
    running = asyncio.create_task(
        _conduct_with(
            tmp_path,
            monkeypatch,
            model=model,
            tts=_ExactSecondTTS(),
            greeting="unused",
            replies=[],
            controls=controls,
            max_duration_seconds=60,
            transport=transport,
        )
    )
    await asyncio.wait_for(model.called.wait(), 1)
    if ending == "disconnect":
        transport.ended.set()
    else:
        controls.trip_duration_limit()

    conducted, spans, _audio, _transport, events = await asyncio.wait_for(
        running, 2.5 if ending == "disconnect" else 1
    )
    assert not [turn for turn in spans if turn[0] == "human"]
    canceled = [event for event in events if event.event == "canceled"]
    assert len(canceled) == 1
    assert canceled[0].at_unix_nano is not None
    assert conducted.status == "completed"


@pytest.mark.parametrize("ending", ["disconnect", "duration_limit"])
async def test_external_end_after_first_accepted_interruption_frame_stops_playout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    ending: str,
):
    controls = ConversationControls()
    transport = ScriptedTransport(
        greeting="The agent keeps talking while output is accepted. " * 12,
        replies=[],
        answer_delay_seconds=0,
        ends_after_replies=False,
    )
    action = (
        transport.ended.set if ending == "disconnect" else controls.trip_duration_limit
    )
    accepted = _ActAfterAcceptedAudio(action)
    model = _HeldModel(["Generated interruption with a long unplayed tail."])
    model.release.set()

    conducted, spans, _audio, _transport, events = await _conduct_with(
        tmp_path,
        monkeypatch,
        model=model,
        tts=_ExactSecondTTS(),
        greeting="unused",
        replies=[],
        controls=controls,
        transport=transport,
        output_after_transport=(accepted,),
    )
    assert accepted.accepted.is_set()
    assert all(turn[1] == "" for turn in spans if turn[0] == "human")
    canceled = [event for event in events if event.event == "canceled"]
    assert len(canceled) == 1
    assert canceled[0].began_unix_nano is not None
    assert canceled[0].ended_unix_nano is not None
    assert canceled[0].ended_unix_nano - canceled[0].began_unix_nano <= 1_000_000_000
    assert conducted.status == "completed"


class _ControlledInput(FrameProcessor):
    """A test transport input whose public say method creates agent segments."""

    def __init__(self) -> None:
        super().__init__()
        self.rate = 0
        self.position = 0.0
        self.ready = asyncio.Event()
        self._active = asyncio.Event()
        self._pending: asyncio.Queue[tuple[bytes, asyncio.Event]] = asyncio.Queue()
        self._pump: asyncio.Task[None] | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if isinstance(frame, StartFrame):
            self.rate = frame.audio_in_sample_rate
            self.ready.set()
            self._pump = self.create_task(self._run(), name="controlled-agent-input")
        elif isinstance(frame, (EndFrame, CancelFrame)) and self._pump is not None:
            await self.cancel_task(self._pump)

    async def say(self, text: str) -> None:
        await self.ready.wait()
        carried = asyncio.Event()
        await self._pending.put(
            (encode_speech(text, self.rate) + silence(0.7, self.rate), carried)
        )
        await carried.wait()

    async def _run(self) -> None:
        while True:
            audio, carried = await self._pending.get()
            width = max(2, round(0.02 * self.rate) * 2)
            for offset in range(0, len(audio), width):
                piece = audio[offset : offset + width]
                frame = InputAudioRawFrame(piece, self.rate, 1)
                arrived_at(frame, self.position)
                self.position += frame.num_frames / frame.sample_rate
                await self.push_frame(frame)
            carried.set()


class _ControlledOutput(FrameProcessor):
    def __init__(self, input_stream: _ControlledInput) -> None:
        super().__init__()
        self.input = input_stream
        self.playout = PlayoutClock()
        self.accepted = asyncio.Event()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(
            frame, OutputAudioRawFrame
        ):
            played_out_at(
                frame,
                self.playout.place(
                    self.input.position, frame.num_frames / frame.sample_rate
                ),
            )
            self.accepted.set()
        elif direction == FrameDirection.DOWNSTREAM and isinstance(
            frame, InterruptionFrame
        ):
            played_out_at(frame, self.input.position)
            self.playout.cleared()
        await self.push_frame(frame, direction)


class _ControlledConnection:
    def __init__(self) -> None:
        self.input = _ControlledInput()
        self.output = _ControlledOutput(self.input)
        self.ended = asyncio.Event()

    @property
    def provider_reference(self) -> None:
        return None

    @property
    def far_end_left(self) -> bool:
        return self.ended.is_set()

    async def prepare(self) -> VoiceMedia:
        return VoiceMedia(
            input=(self.input,),
            output=(self.output,),
            ended=self.ended,
            real_time=False,
        )

    async def open(self) -> None:
        await self.input.ready.wait()

    async def close(self) -> None:
        self.ended.set()


class _PausedFirstTTS(_ExactSecondTTS):
    def __init__(self) -> None:
        super().__init__()
        self.release = asyncio.Event()
        self.started_texts: list[str] = []
        self.three_started = asyncio.Event()

    async def _speak_text(self, text: str) -> None:
        self.started_texts.append(text)
        if len(self.started_texts) >= 3:
            self.three_started.set()
        await self.push_frame(TTSStartedFrame())
        for value in range(1, 5):
            await self.push_frame(
                TTSAudioRawFrame(bytes((value, 0)) * self.rate, self.rate, 1)
            )
            if len(self.started_texts) == 1 and value == 1:
                self.accepted_first.set()
                await self.release.wait()
        await self.push_frame(TTSStoppedFrame())

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await FrameProcessor.process_frame(self, frame, direction)
        if direction == FrameDirection.UPSTREAM and isinstance(
            frame, InterruptionFrame
        ):
            self.canceled.set()
        if isinstance(frame, StartFrame):
            self.rate = frame.audio_out_sample_rate
        if (
            direction == FrameDirection.DOWNSTREAM
            and isinstance(frame, TextFrame)
            and not isinstance(frame, TranscriptionFrame)
        ):
            if not hasattr(self, "accepted_first"):
                self.accepted_first = asyncio.Event()
            await self._speak_text(frame.text)
        await self.push_frame(frame, direction)


class _ImmediateSequenceModel(ModelClient):
    def __init__(self) -> None:
        self.calls: list[list[dict[str, str]]] = []

    @property
    def model_name(self) -> str:
        return "immediate-sequence"

    async def reply(self, context) -> PersonaReply:
        messages = list(context.get_messages())
        self.calls.append(messages)
        deliberate = any(
            "Interrupt now" in message.get("content", "") for message in messages
        )
        if deliberate:
            return PersonaReply("Brief deliberate interruption.", concluded=False)
        ordinary_calls = sum(
            not any("Interrupt now" in message.get("content", "") for message in call)
            for call in self.calls
        )
        return PersonaReply(f"Ordinary answer {ordinary_calls}.", concluded=False)

    async def close(self) -> None:
        return None


async def test_agent_stop_and_restart_during_deliberate_playout_preserves_one_owner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    spec = spec_for(scenario="Answer both completed agent segments.", max_turns=8)
    connection = _ControlledConnection()
    tts = _PausedFirstTTS()
    tts.accepted_first = asyncio.Event()
    model = _ImmediateSequenceModel()
    legs = SpeechLegs(stt=ScriptedSTT(), tts=tts, voice=voice_from_models(spec.models))
    monkeypatch.setattr(conductor_module, "build_legs", lambda *_args, **_kwargs: legs)
    conductor = VoiceConductor(
        connection=connection,
        voice=legs.voice,
        blobs=FilesystemBlobStore(tmp_path),
        recording_key="restart/dual-channel.wav",
        parameters=ConductParameters(interruption_level="frequent"),
    )
    spans: list[tuple[str, str, int, int]] = []
    events: list[object] = []

    async def utterance(speaker: str, text: str, began: int, ended: int) -> None:
        spans.append((speaker, text, began, ended))

    async def measured(_name: str, _began: int, _ended: int) -> None:
        return None

    running = asyncio.create_task(
        conductor.conduct(
            persona=Persona(
                authored=spec.persona,
                scenario_instructions=spec.scenario_instructions,
                model=model,
            ),
            max_turns=8,
            max_duration_seconds=60,
            controls=ConversationControls(),
            name="sim:restart-during-delivery",
            on_utterance=utterance,
            on_measured=measured,
            on_interruption=events.append,
        )
    )
    first_carried = asyncio.create_task(
        connection.input.say(
            "First continuous segment is long enough to trigger overlap. " * 10
        )
    )
    await asyncio.wait_for(tts.accepted_first.wait(), 1)
    await asyncio.wait_for(first_carried, 1)
    # Let the public turn analyzer publish the completed first boundary before
    # the next VAD start arrives; media frames otherwise outrun its async analysis.
    await asyncio.sleep(0.4)
    await asyncio.wait_for(
        connection.input.say(
            "Second completed agent segment arrives before playout finishes."
        ),
        1,
    )

    assert len(model.calls) == 1
    assert tts.started_texts == ["Brief deliberate interruption."]
    tts.release.set()
    await asyncio.wait_for(tts.three_started.wait(), 1)
    connection.ended.set()
    await asyncio.wait_for(running, 1)

    assert tts.started_texts == [
        "Brief deliberate interruption.",
        "Ordinary answer 1.",
        "Ordinary answer 2.",
    ]
    delivered = [event for event in events if event.event == "delivered"]
    assert len(delivered) == 1
    assert delivered[0].ended_unix_nano - delivered[0].began_unix_nano <= 3_000_000_000
    assert delivered[0].delivered_text is None
    assert [turn[1] for turn in spans if turn[0] == "agent"] == [
        "First continuous segment is long enough to trigger overlap. " * 10,
        "Second completed agent segment arrives before playout finishes.",
    ]


async def test_frequent_cooldown_arms_the_same_continuous_segment_at_twelve_seconds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    spec = spec_for(scenario="Interrupt each eligible long segment.", max_turns=10)
    connection = _ControlledConnection()
    tts = _ExactSecondTTS()
    model = _ImmediateSequenceModel()
    legs = SpeechLegs(stt=ScriptedSTT(), tts=tts, voice=voice_from_models(spec.models))
    monkeypatch.setattr(conductor_module, "build_legs", lambda *_args, **_kwargs: legs)
    conductor = VoiceConductor(
        connection=connection,
        voice=legs.voice,
        blobs=FilesystemBlobStore(tmp_path),
        recording_key="cooldown/dual-channel.wav",
        parameters=ConductParameters(interruption_level="frequent"),
    )
    spans: list[tuple[str, str, int, int]] = []
    events: list[object] = []
    delivered = asyncio.Event()

    async def utterance(speaker: str, text: str, began: int, ended: int) -> None:
        spans.append((speaker, text, began, ended))

    async def measured(_name: str, _began: int, _ended: int) -> None:
        return None

    def interruption(event: object) -> None:
        events.append(event)
        if event.event == "delivered":
            delivered.set()

    controls = ConversationControls()
    running = asyncio.create_task(
        conductor.conduct(
            persona=Persona(
                authored=spec.persona,
                scenario_instructions=spec.scenario_instructions,
                model=model,
            ),
            max_turns=10,
            max_duration_seconds=90,
            controls=controls,
            name="sim:frequent-cooldown",
            on_utterance=utterance,
            on_measured=measured,
            on_interruption=interruption,
        )
    )
    await connection.input.say("First eligible continuous agent segment. " * 14)
    await asyncio.wait_for(delivered.wait(), 2)
    first = next(event for event in events if event.event == "delivered")

    delivered.clear()
    await connection.input.say(
        "Second continuous segment begins inside cooldown and keeps speaking. " * 35
    )
    await asyncio.wait_for(delivered.wait(), 3)
    deliveries = [event for event in events if event.event == "delivered"]
    schedules = [event for event in events if event.event == "scheduled"]
    assert len(deliveries) == 2
    assert len(schedules) == 2
    second_schedule = schedules[1]
    second_delivery = deliveries[1]

    assert second_schedule.at_unix_nano < first.ended_unix_nano + 12_000_000_000
    assert second_schedule.scheduled_for_unix_nano == (
        first.ended_unix_nano + 12_000_000_000
    )
    assert second_delivery.began_unix_nano >= second_schedule.scheduled_for_unix_nano
    assert (
        second_delivery.ended_unix_nano - second_delivery.began_unix_nano
        <= 3_000_000_000
    )

    controls.trip_duration_limit()
    await asyncio.wait_for(running, 1)
    assert len([event for event in events if event.event == "scheduled"]) == 2
    assert len([event for event in events if event.event == "delivered"]) == 2
