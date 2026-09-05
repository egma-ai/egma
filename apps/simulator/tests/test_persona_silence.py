"""Persona follow-ups through the actual voice, audio, and turn pipeline."""

from __future__ import annotations

import asyncio
import copy
import io
import wave
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from fractions import Fraction
from itertools import pairwise
from pathlib import Path

import pytest
from conftest import loopback_spec
from pipecat.frames.frames import TranscriptionFrame
from pipecat.processors.aggregators.llm_context import LLMContext

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.conductor import ConductParameters, VoiceConductor
from egma_simulator.conversation import Conducted, ConversationControls
from egma_simulator.media import VoiceMedia
from egma_simulator.media.scripted_transport import ScriptedTransport
from egma_simulator.model import PersonaReply
from egma_simulator.persona import Persona
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import (
    SCRIPTED_PAIR,
    ScriptedSTT,
    silence,
    voice_from_models,
)

NANOSECONDS = 1_000_000_000
GREETING = "Front desk, how can I help?"
WORDLESS_AUDIO = "Speech with no recognized words."


class AgentScript(ScriptedTransport):
    """A fixture agent can speak, wait, or stay quiet after each persona turn."""

    def __init__(self, greeting: str | None, answers: list[tuple[float, str | None]]):
        super().__init__(
            greeting=greeting,
            replies=[],
            answer_delay_seconds=0,
            ends_after_replies=False,
        )
        self.answers = list(answers)
        self.resume_after_wordless_boundary = greeting == WORDLESS_AUDIO

    async def next_input(self):
        chunk = await super().next_input()
        # Recording acknowledges an input frame before queued turn processing
        # finishes. Pace each 20ms frame so the real conductor and persona tasks
        # can run before the fixture advances the media clock again. A positive
        # delay also yields to event-loop timers on Linux; sleep(0) does not.
        await asyncio.sleep(0.001)
        return chunk

    async def persona_stopped(self) -> None:
        self._hearing.clear()
        if not self.answers:
            self._queue_audio(silence(13, self._input_rate))
            return
        delay, words = self.answers.pop(0)
        self._queue_audio(silence(delay, self._input_rate))
        if words is None:
            self._queue_audio(silence(13, self._input_rate))
        else:
            self.resume_after_wordless_boundary = words == WORDLESS_AUDIO
            self._queue_words(words)


class AgentConnection:
    provider_reference = None

    def __init__(self, transport: AgentScript):
        self.transport = transport

    async def prepare(self) -> VoiceMedia:
        return self.transport.media

    async def open(self) -> None:
        await self.transport.activate()

    async def close(self) -> None:
        self.transport.stop()


@dataclass
class Asked:
    messages: list[dict]
    transcript: list[tuple[str, str, int, int]]
    silence_on_media_clock: Fraction | None


@dataclass
class Walk:
    turns: list[tuple[str, str, int, int]] = field(default_factory=list)
    requests: list[Asked] = field(default_factory=list)
    result: Conducted | None = None
    canceled_requests: list[int] = field(default_factory=list)
    recording_started: int = 0
    recording_ended: int = 0

    @property
    def persona_turns(self) -> list[tuple[str, str, int, int]]:
        return [turn for turn in self.turns if turn[0] == "human"]


class PersonaModel:
    model_name = "silence-test-persona"

    def __init__(
        self,
        walk: Walk,
        conclude_at: int | None,
        silence_on_media_clock: Callable[[], Fraction | None],
        before_reply: Callable[[int], Awaitable[None]],
    ):
        self.walk = walk
        self.conclude_at = conclude_at
        self.silence_on_media_clock = silence_on_media_clock
        self.before_reply = before_reply

    async def reply(self, context: LLMContext) -> PersonaReply:
        self.walk.requests.append(
            Asked(
                copy.deepcopy(context.get_messages()),
                list(self.walk.turns),
                self.silence_on_media_clock(),
            )
        )
        number = len(self.walk.requests)
        try:
            await self.before_reply(number)
        except asyncio.CancelledError:
            self.walk.canceled_requests.append(number)
            raise
        return PersonaReply(
            f"Persona reply {number}.", concluded=number == self.conclude_at
        )

    async def close(self) -> None:
        return None


async def walk_silence(
    tmp_path: Path,
    *,
    greeting: str | None = GREETING,
    answers: list[tuple[float, str | None]] | None = None,
    conclude_at: int | None = None,
    max_turns: int = 12,
    stop: str | None = None,
    stop_at_persona_turn: int = 1,
    parameters: ConductParameters | None = None,
    interrupt_second_request: bool = False,
) -> Walk:
    spec = SimulationSpec.from_document(loopback_spec("sim-persona-silence"))
    transport = AgentScript(greeting, answers or [])
    conductor = VoiceConductor(
        connection=AgentConnection(transport),
        voice=voice_from_models(spec.models),
        blobs=FilesystemBlobStore(tmp_path),
        recording_key="silence.wav",
        speech=SCRIPTED_PAIR,
        parameters=parameters or ConductParameters(),
    )
    walk = Walk()
    controls = ConversationControls()

    async def utterance(speaker: str, text: str, began: int, ended: int):
        walk.turns.append((speaker, text, began, ended))
        if (
            speaker == "agent"
            and not text.strip()
            and transport.resume_after_wordless_boundary
        ):
            # Blank transcription ends through Pipecat's wall-clock backstop.
            # Resume the accelerated fixture only after that boundary is
            # recorded, so queued media cannot outrun the pending turn.
            transport.resume_after_wordless_boundary = False
            transport._queue_audio(silence(13, transport._input_rate))
        if speaker == "human" and len(walk.persona_turns) == stop_at_persona_turn:
            if stop == "cancel":
                controls.request_cancel()
            elif stop == "duration":
                controls.trip_duration_limit()

    async def measured(*_args):
        return None

    def silence_on_media_clock() -> Fraction | None:
        # Observe the actual timer clock, without replacing the timer or its
        # frame processing. Transcript timestamps use a separate output cursor.
        stopped = conductor._record.persona_last_stopped_at
        return None if stopped is None else conductor._position - stopped

    async def before_reply(number: int) -> None:
        if interrupt_second_request and number == 2:
            transport.resume_after_wordless_boundary = True
            transport._queue_words(WORDLESS_AUDIO)
            await asyncio.Event().wait()  # Real VAD interrupts this model request.

    walk.result = await conductor.conduct(
        persona=Persona(
            authored=spec.persona,
            scenario_instructions="Ask the agent one question.",
            model=PersonaModel(walk, conclude_at, silence_on_media_clock, before_reply),
        ),
        max_turns=max_turns,
        max_duration_seconds=20,
        controls=controls,
        name="sim:persona-silence-test",
        on_utterance=utterance,
        on_measured=measured,
    )
    assert conductor.audio is not None
    with wave.open(io.BytesIO((tmp_path / "silence.wav").read_bytes())) as recording:
        duration = recording.getnframes() / recording.getframerate()
    walk.recording_started = conductor.audio.started_unix_nano
    walk.recording_ended = walk.recording_started + round(duration * NANOSECONDS)
    return walk


def assert_ten_seconds(gap: int) -> None:
    # The recorder's input and output resampling cursors can differ by <100ms.
    # Keep that transcript alignment margin separate from the strict timer
    # assertion below, which observes the actual media clock at model request.
    assert 9.9 <= gap / NANOSECONDS < 10.25


async def test_persona_follows_up_twice_after_ten_seconds_then_hangs_up(tmp_path):
    walk = await walk_silence(tmp_path)

    assert walk.result is not None
    assert walk.result.status == "completed"
    assert walk.result.ending == "persona_concluded"
    assert (
        walk.result.reason == "the agent did not respond after two persona follow-ups"
    )
    assert len(walk.requests) == 3  # Normal reply, first follow-up, second follow-up.
    assert len(walk.persona_turns) == 3
    for request in walk.requests[1:]:
        assert request.silence_on_media_clock is not None
        assert Fraction(10) <= request.silence_on_media_clock < Fraction(41, 4)
    for earlier, later in pairwise(walk.persona_turns):
        assert_ten_seconds(later[2] - earlier[3])
    assert_ten_seconds(walk.recording_ended - walk.persona_turns[-1][3])


async def test_silence_instruction_uses_the_same_wait_as_the_timer(tmp_path):
    walk = await walk_silence(
        tmp_path, parameters=ConductParameters(agent_quiet_seconds=2.0)
    )

    assert walk.result is not None and walk.result.ending == "persona_concluded"
    assert len(walk.requests) == 3
    for request in walk.requests[1:]:
        assert request.silence_on_media_clock is not None
        assert Fraction(2) <= request.silence_on_media_clock < Fraction(9, 4)
        assert "has not replied for 2 seconds" in request.messages[-1]["content"]


async def test_silence_instruction_reaches_model_but_never_spoken_history(tmp_path):
    walk = await walk_silence(tmp_path)

    assert len(walk.requests) == 3
    for number, request in enumerate(walk.requests[1:], start=1):
        instruction = request.messages[-1]
        assert instruction["role"] == "user"
        assert "10" in instruction["content"]
        assert str(number) in instruction["content"]
        history = [
            {"role": "assistant" if speaker == "human" else "user", "content": text}
            for speaker, text, _began, _ended in request.transcript
        ]
        assert request.messages[1:-1] == history
        assert all(text != instruction["content"] for _speaker, text, *_ in walk.turns)
    assert [turn[1] for turn in walk.persona_turns] == [
        "Persona reply 1.",
        "Persona reply 2.",
        "Persona reply 3.",
    ]


async def test_real_agent_answer_resets_two_followup_allowance(tmp_path):
    walk = await walk_silence(
        tmp_path,
        answers=[(0, None), (0, "Yes, I am here. What did you need?")],
    )

    assert walk.result is not None and walk.result.ending == "persona_concluded"
    # Initial reply, first follow-up, normal answer to resumed agent,
    # then a fresh pair of follow-ups before hanging up.
    assert len(walk.requests) == 5
    assert [turn[0] for turn in walk.turns] == [
        "agent",
        "human",
        "human",
        "agent",
        "human",
        "human",
        "human",
    ]
    resumed = walk.requests[2]
    assert resumed.messages[-1] == {
        "role": "user",
        "content": "Yes, I am here. What did you need?",
    }
    assert_ten_seconds(walk.persona_turns[3][2] - walk.persona_turns[2][3])
    assert_ten_seconds(walk.persona_turns[4][2] - walk.persona_turns[3][3])
    assert_ten_seconds(walk.recording_ended - walk.persona_turns[-1][3])


async def test_initial_opening_is_not_one_of_the_two_followups(tmp_path):
    walk = await walk_silence(tmp_path, greeting=None)

    assert walk.result is not None
    assert walk.result.status == "completed"
    assert walk.result.ending == "persona_concluded"
    assert (
        walk.result.reason == "the agent did not respond after two persona follow-ups"
    )
    assert len(walk.requests) == 3
    assert len(walk.persona_turns) == 3
    for earlier, later in pairwise(walk.persona_turns):
        assert_ten_seconds(later[2] - earlier[3])
    assert_ten_seconds(walk.recording_ended - walk.persona_turns[-1][3])


async def test_persona_does_not_follow_up_while_agent_is_still_speaking(tmp_path):
    long_answer = "I am checking that information for you. " * 80
    walk = await walk_silence(tmp_path, answers=[(9, long_answer)], conclude_at=2)

    assert walk.result is not None and walk.result.ending == "persona_concluded"
    assert len(walk.requests) == 2
    assert walk.requests[1].messages[-1] == {"role": "user", "content": long_answer}
    agent_turn = [turn for turn in walk.turns if turn[0] == "agent"][-1]
    assert (agent_turn[3] - agent_turn[2]) / NANOSECONDS > 10


@pytest.mark.parametrize(
    ("stop", "max_turns", "status", "ending", "requests"),
    [
        ("cancel", 12, "canceled", "canceled", 1),
        ("duration", 12, "completed", "limit_reached", 1),
        (None, 3, "completed", "limit_reached", 2),
    ],
)
async def test_existing_stop_conditions_take_priority_over_followups(
    tmp_path, stop, max_turns, status, ending, requests
):
    walk = await walk_silence(tmp_path, stop=stop, max_turns=max_turns)

    assert walk.result is not None
    assert (walk.result.status, walk.result.ending) == (status, ending)
    assert len(walk.requests) == requests


@pytest.mark.parametrize(
    ("stop", "max_turns", "status", "ending"),
    [
        ("cancel", 12, "canceled", "canceled"),
        ("duration", 12, "completed", "limit_reached"),
        (None, 2, "completed", "limit_reached"),
    ],
)
async def test_silent_agent_keeps_explicit_stop_ending(
    tmp_path, stop, max_turns, status, ending
):
    walk = await walk_silence(
        tmp_path,
        greeting=None,
        stop=stop,
        stop_at_persona_turn=2,
        max_turns=max_turns,
    )

    assert walk.result is not None
    assert (walk.result.status, walk.result.ending) == (status, ending)
    assert len(walk.requests) == 2
    assert len(walk.persona_turns) == 2
    assert walk.recording_ended > walk.recording_started


@pytest.fixture
def unrecognized_speech(monkeypatch):
    """Real speech/VAD boundaries, but the STT leg finds no words in one clip."""
    transcribe = ScriptedSTT.run_stt

    async def omit_selected_words(self, audio):
        async for frame in transcribe(self, audio):
            if isinstance(frame, TranscriptionFrame) and frame.text == WORDLESS_AUDIO:
                frame.text = ""
            yield frame

    monkeypatch.setattr(ScriptedSTT, "run_stt", omit_selected_words)


async def test_wordless_agent_speech_keeps_followup_count_and_timer(
    tmp_path, unrecognized_speech
):
    walk = await walk_silence(
        tmp_path,
        answers=[(0, None), (0, WORDLESS_AUDIO)],
        parameters=ConductParameters(agent_turn_backstop_seconds=0.5),
    )

    assert walk.result is not None and walk.result.ending == "persona_concluded"
    assert len(walk.requests) == 3
    assert [turn[0] for turn in walk.turns] == [
        "agent",
        "human",
        "human",
        "agent",
        "human",
    ]
    assert walk.turns[3][1] == ""  # The wordless speech remains evidence.
    assert_ten_seconds(walk.persona_turns[2][2] - walk.persona_turns[1][3])
    assert_ten_seconds(walk.recording_ended - walk.persona_turns[-1][3])


async def test_wordless_opening_does_not_prevent_persona_opening(
    tmp_path, unrecognized_speech
):
    walk = await walk_silence(
        tmp_path,
        greeting=WORDLESS_AUDIO,
        parameters=ConductParameters(agent_turn_backstop_seconds=0.5),
    )

    assert walk.result is not None
    assert walk.result.status == "completed"
    assert walk.result.ending == "persona_concluded"
    assert (
        walk.result.reason == "the agent did not respond after two persona follow-ups"
    )
    assert walk.turns[0][0:2] == ("agent", "")
    assert len(walk.requests) == 3
    assert_ten_seconds(walk.persona_turns[0][2] - walk.recording_started)
    for earlier, later in pairwise(walk.persona_turns):
        assert_ten_seconds(later[2] - earlier[3])


async def test_wordless_interruption_resumes_pending_normal_persona_reply(
    tmp_path, unrecognized_speech
):
    walk = await walk_silence(
        tmp_path,
        answers=[(0, "Yes, what documents do you need?")],
        interrupt_second_request=True,
        conclude_at=3,
        parameters=ConductParameters(agent_turn_backstop_seconds=0.5),
    )

    assert walk.canceled_requests == [2]
    assert walk.result is not None and walk.result.ending == "persona_concluded"
    assert len(walk.requests) == 3
    assert [turn[1] for turn in walk.persona_turns] == [
        "Persona reply 1.",
        "Persona reply 3.",
    ]
    assert walk.turns[-2][0:2] == ("agent", "")
    # Resume the interrupted normal request, without turning the wordless
    # audio into a new question or adding a silence follow-up instruction.
    assert walk.requests[2].messages == walk.requests[1].messages


async def test_silence_request_canceled_before_audio_does_not_spend_followup(
    tmp_path, unrecognized_speech
):
    walk = await walk_silence(
        tmp_path,
        interrupt_second_request=True,
        parameters=ConductParameters(agent_turn_backstop_seconds=0.5),
    )

    assert walk.canceled_requests == [2]
    assert walk.result is not None and walk.result.ending == "persona_concluded"
    assert len(walk.requests) == 4
    assert [turn[1] for turn in walk.persona_turns] == [
        "Persona reply 1.",
        "Persona reply 3.",
        "Persona reply 4.",
    ]
    first_attempt = walk.requests[1].messages[-1]
    retry = walk.requests[2].messages[-1]
    assert retry == first_attempt  # The same first follow-up is still available.
    assert walk.requests[3].messages[-1] != retry
