"""The single Pipecat pipeline that conducts and records a voice simulation."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import time
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Any, cast

from pipecat.audio.resamplers.soxr_stream_resampler import (
    SOXRStreamAudioResampler,
)
from pipecat.audio.vad.vad_analyzer import VADAnalyzer
from pipecat.frames.frames import (
    ControlFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    OutputAudioRawFrame,
    StartFrame,
    TextFrame,
    TranscriptionFrame,
    TTSStoppedFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings
from pipecat.turns.user_start import VADUserTurnStartStrategy
from pipecat.turns.user_turn_processor import UserTurnProcessor
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.tracing.service_decorators import traced_llm
from pipecat.workers.runner import WorkerRunner

from .blob import BlobStore
from .media import RemoteParticipantLeftFrame, VoiceMedia
from .model import PersonaReply
from .persona import Persona, Turn
from .platform_logging import log_event
from .plugs import PlugError, VoiceConnection
from .recording import AudioFacts, dual_channel_wav
from .speech import (
    SCRIPTED_PAIR,
    PersonaVoice,
    SpeechFault,
    SpeechLegs,
    SpeechProviders,
    build_legs,
    build_vad,
)
from .walk import (
    AGENT_ENDED,
    CANCEL_DIRECTIVE,
    PERSONA_CONCLUDED,
    Conducted,
    Ending,
    WalkControls,
    duration_limit_reached,
    turn_limit_reached,
)

logger = logging.getLogger(__name__)

MediaPosition = Fraction
_INPUT_SOURCE_RANGE = "egma.input_source_range"


@dataclass(frozen=True)
class ConductParameters:
    """The voice conduct choices that are independent of media rates."""

    agent_opening_seconds: float = 10.0
    persona_pause_seconds: float = 0.4
    agent_quiet_seconds: float = 12.0
    agent_turn_backstop_seconds: float = 5.0
    yields_to_the_agent: bool = True


DEFAULT_CONDUCT = ConductParameters()

OnUtterance = Callable[[str, str, int, int], Awaitable[None]]
OnMeasured = Callable[[str, int, int], Awaitable[None]]
OnAnswered = Callable[[], Awaitable[None]]


@dataclass
class _AgentFinished(ControlFrame):
    heard_a_turn: bool = True


@dataclass(frozen=True)
class _AgentUtterance:
    began: MediaPosition
    ended: MediaPosition
    observed_through: MediaPosition


class _AgentEar(VADProcessor):
    """Track input-media positions while Pipecat detects speech."""

    def __init__(self, *, vad_analyzer: VADAnalyzer, conductor: VoiceConductor) -> None:
        super().__init__(vad_analyzer=vad_analyzer, audio_idle_timeout=0.0)
        self._analyzer = vad_analyzer
        self._conductor = conductor
        self.position = Fraction(0)
        self.speaking_since: MediaPosition | None = None
        self.utterances: list[_AgentUtterance] = []

    async def broadcast_frame(self, frame_cls: type[Frame], **kwargs: Any) -> None:
        """Track the public VAD boundaries before passing them onward."""
        if frame_cls is VADUserStartedSpeakingFrame:
            self.speaking_since = max(
                Fraction(0),
                self.position - _seconds(kwargs.get("start_secs", 0.0)),
            )
        elif frame_cls is VADUserStoppedSpeakingFrame:
            if self.speaking_since is None:
                await super().broadcast_frame(frame_cls, **kwargs)
                return
            began = self.speaking_since
            ended = max(began, self.position - _seconds(kwargs.get("stop_secs", 0.0)))
            self.utterances.append(
                _AgentUtterance(
                    began=began,
                    ended=ended,
                    observed_through=self.position,
                )
            )
            self.speaking_since = None
        await super().broadcast_frame(frame_cls, **kwargs)

    @property
    def hearing_speech(self) -> bool:
        return self.speaking_since is not None

    async def finalize_active_utterance(self) -> None:
        """Close active speech at the final ordered media position."""
        if self.speaking_since is not None:
            # Pipecat 1.7.0 publishes a stop only after the whole VAD quiet
            # window. On departure that window is incomplete, and it exposes
            # no public progress value. This pinned counter is the only way to
            # remove quiet already observed without inventing media. The
            # abrupt-departure alignment test covers a partial stop window.
            quiet_windows = getattr(self._analyzer, "_vad_stopping_count", None)
            if not isinstance(quiet_windows, int):
                raise SpeechFault(
                    "this pipecat release no longer exposes the voice "
                    "detector's partial stop window"
                )
            stop_secs = (
                quiet_windows
                * self._analyzer.num_frames_required()
                / self._analyzer.sample_rate
            )
            await self.broadcast_frame(
                VADUserStoppedSpeakingFrame, stop_secs=stop_secs
            )

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if isinstance(frame, RemoteParticipantLeftFrame):
            self._conductor.agent_is_departing()
            await self._conductor.agent_input_is_closing(self.position)
            await self.finalize_active_utterance()
        if isinstance(frame, InputAudioRawFrame):
            source_start = self.position
            source_end = source_start + Fraction(
                frame.num_frames, frame.sample_rate
            )
            frame.metadata[_INPUT_SOURCE_RANGE] = (source_start, source_end)
            self.position = source_end
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self._conductor.media_advanced()


class _TurnBoundary(FrameProcessor):
    """Put Pipecat's public user-turn verdict into the ordered frame stream."""

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if (
            direction == FrameDirection.DOWNSTREAM
            and isinstance(frame, UserStoppedSpeakingFrame)
        ):
            await self.push_frame(_AgentFinished())


@dataclass(frozen=True)
class _RecordedInputSegment:
    source_start: MediaPosition
    source_end: MediaPosition
    recording_start_sample: int
    recording_end_sample: int


class _EvidenceRecorder(AudioBufferProcessor):
    """Expose Pipecat's canonical recording cursor to the transcript."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._recording_ready = asyncio.Condition()
        self._resampled_input: dict[int, tuple[int, float]] = {}
        self._processed_source_end = Fraction(0)
        self._last_input_frame_duration = Fraction(0)
        self._input_segments: list[_RecordedInputSegment] = []
        self._closing_source_end: MediaPosition | None = None
        self._input_closed = False

    async def _resample_input_audio(self, frame: InputAudioRawFrame) -> bytes:
        audio = await super()._resample_input_audio(frame)
        self._resampled_input[frame.id] = (
            len(audio) // 2,
            self._input_resampler_delay(),
        )
        return audio

    def _input_resampler_delay(self) -> float:
        """Read the exact pending output from Pipecat's pinned recorder."""
        resampler = getattr(self, "_input_resampler", None)
        if not isinstance(resampler, SOXRStreamAudioResampler):
            raise SpeechFault(
                "the pinned pipecat release changed its recording resampler"
            )
        stream = getattr(resampler, "_soxr_stream", None)
        if stream is None:
            return 0.0
        delay = float(stream.delay())
        if delay < 0 or not math.isfinite(delay):
            raise SpeechFault(
                "the pinned pipecat release returned an invalid resampler delay"
            )
        return delay

    @staticmethod
    def _source_range(
        frame: InputAudioRawFrame,
    ) -> tuple[MediaPosition, MediaPosition]:
        source_range = frame.metadata.get(_INPUT_SOURCE_RANGE)
        if (
            not isinstance(source_range, tuple)
            or len(source_range) != 2
            or not all(isinstance(value, Fraction) for value in source_range)
        ):
            raise SpeechFault("agent audio reached the recorder without its position")
        return cast(tuple[MediaPosition, MediaPosition], source_range)

    async def _process_recording(self, frame: Frame) -> None:
        # Input audio is a Pipecat SystemFrame while output audio is a normal
        # frame, so Pipecat can present both to this processor at once. Keep
        # each recorder update and its position map indivisible.
        async with self._recording_ready:
            if isinstance(frame, InputAudioRawFrame) and self._input_closed:
                raise SpeechFault("agent audio arrived after its recorded input ended")
            await super()._process_recording(frame)
            if not isinstance(frame, InputAudioRawFrame):
                return
            source_start, source_end = self._source_range(frame)
            if source_start != self._processed_source_end or source_end < source_start:
                raise SpeechFault("agent audio reached the recorder out of order")
            try:
                written, pending = self._resampled_input.pop(frame.id)
            except KeyError as changed:
                raise SpeechFault(
                    "the pinned pipecat release skipped its recording resampler"
                ) from changed
            if written:
                represented_end_samples = (
                    float(source_end * self.sample_rate) - pending
                )
                rounded_end = round(represented_end_samples)
                if abs(represented_end_samples - rounded_end) > 1e-6:
                    raise SpeechFault(
                        "pipecat's recording resampler returned an invalid position"
                    )
                represented_end = Fraction(rounded_end, self.sample_rate)
                represented_start = represented_end - Fraction(
                    written, self.sample_rate
                )
                recording_end = len(self._user_audio_buffer) // 2
                recording_start = recording_end - written
                if represented_start < 0 or represented_end > source_end:
                    raise SpeechFault(
                        "pipecat's recording resampler returned an invalid position"
                    )
                if (
                    self._input_segments
                    and represented_start < self._input_segments[-1].source_end
                ):
                    raise SpeechFault(
                        "pipecat's recording resampler moved agent audio backwards"
                    )
                self._input_segments.append(
                    _RecordedInputSegment(
                        source_start=represented_start,
                        source_end=represented_end,
                        recording_start_sample=recording_start,
                        recording_end_sample=recording_end,
                    )
                )
            self._processed_source_end = source_end
            self._last_input_frame_duration = source_end - source_start
            self._maybe_close_input()
            self._recording_ready.notify_all()

    async def close_input_at(self, source_end: MediaPosition) -> None:
        """Close input after the recorder has written every earlier frame."""
        async with self._recording_ready:
            if (
                self._closing_source_end is not None
                and self._closing_source_end != source_end
            ):
                raise SpeechFault("agent input ended at two different positions")
            self._closing_source_end = source_end
            self._maybe_close_input()
            self._recording_ready.notify_all()

    def _maybe_close_input(self) -> None:
        if (
            self._closing_source_end is not None
            and self._processed_source_end >= self._closing_source_end
        ):
            self._input_closed = True

    @property
    def bot_position(self) -> MediaPosition:
        if not self.sample_rate:
            return Fraction(0)
        # Pipecat 1.7.0 has no public current-output cursor. This one access is
        # pinned in uv.lock and covered by the frame-level alignment test.
        return Fraction(len(self._bot_audio_buffer) // 2, self.sample_rate)

    @property
    def position(self) -> MediaPosition:
        if not self.sample_rate:
            return Fraction(0)
        samples = max(len(self._user_audio_buffer), len(self._bot_audio_buffer)) // 2
        return Fraction(samples, self.sample_rate)

    async def agent_interval(
        self,
        source_began: MediaPosition,
        source_ended: MediaPosition,
        *,
        observed_through: MediaPosition,
    ) -> tuple[MediaPosition, MediaPosition]:
        """Place one agent turn on Pipecat's canonical recorded track."""
        async with self._recording_ready:
            while True:
                if self._processed_source_end < observed_through:
                    await self._recording_ready.wait()
                    continue
                began = self._agent_position(source_began, at_turn_start=True)
                ended = self._agent_position(source_ended, at_turn_start=False)
                if began is not None and ended is not None:
                    return began, ended
                if began is None and self._mapped_past(
                    source_began, at_turn_start=True
                ):
                    raise SpeechFault(
                        "agent turn began in audio Pipecat did not record"
                    )
                if ended is None and self._mapped_past(
                    source_ended, at_turn_start=False
                ):
                    raise SpeechFault(
                        "agent turn ended in audio Pipecat did not record"
                    )
                if self._input_closed:
                    if began is None:
                        raise SpeechFault(
                            "agent turn began after Pipecat's recording ended"
                        )
                    return began, self._final_agent_end(source_ended)
                await self._recording_ready.wait()

    def _agent_position(
        self, source_position: MediaPosition, *, at_turn_start: bool
    ) -> MediaPosition | None:
        """At a gap, starts use later audio and ends use earlier audio."""
        if not self.sample_rate:
            return None
        segments = (
            reversed(self._input_segments)
            if at_turn_start
            else self._input_segments
        )
        for segment in segments:
            inside = (
                segment.source_start <= source_position < segment.source_end
                if at_turn_start
                else segment.source_start < source_position <= segment.source_end
            )
            if inside:
                return Fraction(
                    segment.recording_start_sample, self.sample_rate
                ) + (source_position - segment.source_start)
        return None

    def _mapped_past(
        self, source_position: MediaPosition, *, at_turn_start: bool
    ) -> bool:
        if not self._input_segments:
            return False
        final_end = self._input_segments[-1].source_end
        if at_turn_start:
            return final_end > source_position
        return final_end >= source_position

    def _final_agent_end(self, source_ended: MediaPosition) -> MediaPosition:
        if not self.sample_rate or not self._input_segments:
            raise SpeechFault("agent audio ended before Pipecat recorded it")
        final = self._input_segments[-1]
        unrecorded = source_ended - final.source_end
        if not 0 <= unrecorded <= self._last_input_frame_duration:
            raise SpeechFault("agent audio ended outside Pipecat's recording")
        return Fraction(final.recording_end_sample, self.sample_rate)


class _PersonaLLMService(LLMService):
    """Run Egma's existing ModelClient through Pipecat's native LLM seam.

    Pipecat owns the service lifecycle, instrumentation scope, span, input and
    output attributes. The model client still owns the provider request, so a
    generic OpenAI-compatible gateway sees the same non-streaming body and
    timeout it saw before this service existed.
    """

    def __init__(self, *, persona: Persona) -> None:
        super().__init__(
            settings=LLMSettings(
                model=persona.model_name,
                system_instruction=None,
                temperature=None,
                max_tokens=None,
                top_p=None,
                top_k=None,
                frequency_penalty=None,
                presence_penalty=None,
                seed=None,
                filter_incomplete_user_turns=False,
                user_turn_completion_config=None,
            )
        )
        self._persona = persona
        self._reply: PersonaReply | None = None
        self._failure: Exception | None = None

    @traced_llm
    async def _process_context(self, context: LLMContext) -> None:
        self._reply = None
        self._failure = None
        messages = cast(list[dict[str, str]], context.get_messages())
        reply = await self._persona.reply_to(messages)
        self._reply = reply
        await self.push_frame(LLMTextFrame(reply.text))

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMContextFrame):
            await self.push_frame(LLMFullResponseStartFrame())
            try:
                await self._process_context(frame.context)
            except Exception as fault:
                self._failure = fault
                await self.push_error(
                    "the persona model could not answer", exception=fault
                )
            finally:
                await self.push_frame(LLMFullResponseEndFrame())
            return
        await self.push_frame(frame, direction)

    def take_reply(self) -> PersonaReply:
        """The reply whose native end frame just reached the gate."""
        failure, self._failure = self._failure, None
        reply, self._reply = self._reply, None
        if failure is not None:
            raise failure
        if reply is None:
            raise RuntimeError("Pipecat ended a persona response with no reply")
        return reply


class _PersonaReplyGate(FrameProcessor):
    """Hold model chunks until Egma applies conclusion and speaking timing."""

    def __init__(
        self, *, service: _PersonaLLMService, conductor: VoiceConductor
    ) -> None:
        super().__init__()
        self._service = service
        self._conductor = conductor
        self._waiting: asyncio.Future[None] | None = None
        self._due: MediaPosition | None = None
        self._collecting = False
        self._text: list[str] = []

    async def request(
        self,
        messages: list[dict[str, str]],
        due: MediaPosition,
        push: Callable[[Frame], Awaitable[None]],
    ) -> None:
        if self._waiting is not None:
            raise RuntimeError("the persona model already has a reply in flight")
        waiting = asyncio.get_running_loop().create_future()
        self._waiting = waiting
        self._due = due
        try:
            context = LLMContext(messages=cast(Any, messages))
            await push(LLMContextFrame(context=context))
            await waiting
        except BaseException:
            if self._waiting is waiting:
                self._reset()
            raise

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction != FrameDirection.DOWNSTREAM or self._waiting is None:
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, LLMFullResponseStartFrame):
            self._collecting = True
            self._text = []
            return
        if self._collecting and isinstance(frame, LLMTextFrame):
            self._text.append(frame.text)
            return
        if self._collecting and isinstance(frame, LLMFullResponseEndFrame):
            await self._finish_reply()
            return
        await self.push_frame(frame, direction)

    async def _finish_reply(self) -> None:
        waiting = self._waiting
        due = self._due
        assert waiting is not None
        assert due is not None
        try:
            reply = self._service.take_reply()
            received = "".join(self._text)
            if received != reply.text:
                raise RuntimeError(
                    "Pipecat's persona response did not match its model reply"
                )
            if not self._conductor.is_ending:
                await self._conductor.wait_until(due)
                if not self._conductor.is_ending:
                    self._conductor.persona_will_speak(
                        reply.text, concludes=reply.concluded
                    )
                    await self.push_frame(LLMFullResponseStartFrame())
                    await self.push_frame(TextFrame(reply.text))
                    await self.push_frame(LLMFullResponseEndFrame())
        except asyncio.CancelledError:
            waiting.cancel()
            raise
        except Exception as fault:
            waiting.set_exception(fault)
        else:
            waiting.set_result(None)
        finally:
            self._reset()

    def _reset(self) -> None:
        self._waiting = None
        self._due = None
        self._collecting = False
        self._text = []


class _PersonaBrain(FrameProcessor):
    """Run the shared persona brain without stopping input system frames."""

    def __init__(
        self,
        *,
        persona: Persona,
        conductor: VoiceConductor,
        replies: _PersonaReplyGate,
    ) -> None:
        super().__init__()
        self._persona = persona
        self._conductor = conductor
        self._replies = replies
        self._heard: list[str] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            self._heard.append(frame.text)
        await self.push_frame(frame, direction)
        if isinstance(frame, _AgentFinished):
            await self._answer(frame.heard_a_turn)

    async def _answer(self, heard_a_turn: bool) -> None:
        try:
            said = " ".join(piece for piece in self._heard if piece)
            self._heard.clear()
            due = await self._conductor.the_agent_finished(said, heard_a_turn)
            if due is None:
                return
            await self._replies.request(
                self._persona.messages(self._conductor.history),
                due,
                self.push_frame,
            )
        except Exception as fault:
            self._conductor.the_brain_failed(fault)


class _Timeline(FrameProcessor):
    """Read accepted output frames on the same side as the recorder."""

    def __init__(
        self,
        conductor: VoiceConductor,
        media: VoiceMedia,
        recorder: _EvidenceRecorder,
    ) -> None:
        super().__init__()
        self._conductor = conductor
        self._media = media
        self._recorder = recorder
        self.started = asyncio.Event()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, StartFrame):
            self.started.set()
        elif isinstance(frame, InputAudioRawFrame):
            self._media.input_recorded(frame)
        elif isinstance(frame, OutputAudioRawFrame):
            self._conductor.persona_audio(
                frame, recorded_until=self._recorder.bot_position
            )
        elif isinstance(frame, TTSStoppedFrame):
            await self._conductor.persona_stopped()
        elif isinstance(frame, RemoteParticipantLeftFrame):
            frame.completed.set()
            self._conductor.media_advanced()
        await self.push_frame(frame, direction)


@dataclass
class _Record:
    history: list[Turn] = field(default_factory=list)
    turns: int = 0
    persona_last_stopped_at: MediaPosition | None = None
    quiet_since: MediaPosition = Fraction(0)
    first_answer_measured: bool = False


class PipelineGone(RuntimeError):
    """The one Pipecat pipeline stopped before the conversation did."""


class VoiceConductor:
    """One voice simulation on one continuously running Pipecat pipeline."""

    def __init__(
        self,
        *,
        connection: VoiceConnection,
        voice: PersonaVoice,
        blobs: BlobStore,
        recording_key: str,
        speech: SpeechProviders = SCRIPTED_PAIR,
        parameters: ConductParameters = DEFAULT_CONDUCT,
    ) -> None:
        self._connection = connection
        self._blobs = blobs
        self._recording_key = recording_key
        self._parameters = parameters
        self._legs = build_legs(speech, voice=voice)
        self._vad = build_vad(speech)

        self._persona: Persona | None = None
        self._max_turns = 0
        self._controls = WalkControls()
        self._on_utterance: OnUtterance | None = None
        self._on_measured: OnMeasured | None = None
        self._on_answered: OnAnswered | None = None

        self._media: VoiceMedia | None = None
        self._ear: _AgentEar | None = None
        self._worker: PipelineWorker | None = None
        self._runner: WorkerRunner | None = None
        self._running: asyncio.Task | None = None
        self._recorder: _EvidenceRecorder | None = None

        self._record = _Record()
        self._heard_so_far = 0
        self._ending: Ending | None = None
        self._agent_departed = False
        self._owes_a_turn = False
        self._opened_unix_nano = 0

        self._pending_persona_text: str | None = None
        self._pending_persona_concludes = False
        self._persona_began: MediaPosition | None = None
        self._persona_ended: MediaPosition | None = None

        self._agent_track = bytearray()
        self._persona_track = bytearray()
        self._recording_rate = 0

        self._activity = asyncio.Event()
        self._faulted = asyncio.Event()
        self._fault = ""
        self._brain_fault: BaseException | None = None
        self._closed = False

        self.audio: AudioFacts | None = None

    @property
    def provider_reference(self) -> str | None:
        return self._connection.provider_reference

    @property
    def legs(self) -> SpeechLegs:
        return self._legs

    @property
    def vad(self) -> VADAnalyzer:
        return self._vad

    @property
    def speaking_voice(self) -> PersonaVoice:
        return self._legs.voice

    @property
    def history(self) -> list[Turn]:
        return self._record.history

    @property
    def is_ending(self) -> bool:
        return (
            self._ending is not None
            or self._agent_departed
            or self._controls.cause is not None
        )

    async def conduct(
        self,
        *,
        persona: Persona,
        max_turns: int,
        max_duration_seconds: float,
        controls: WalkControls,
        name: str,
        on_utterance: OnUtterance,
        on_measured: OnMeasured,
        on_answered: OnAnswered | None = None,
    ) -> Conducted:
        self._persona = persona
        self._max_turns = max_turns
        self._controls = controls
        self._on_utterance = on_utterance
        self._on_measured = on_measured
        self._on_answered = on_answered

        watchdog = asyncio.create_task(
            _duration_watchdog(max_duration_seconds, controls),
            name=f"{name}:watchdog",
        )
        try:
            await self._open(name)
            await self._run()
        except _Stopped:
            pass
        finally:
            watchdog.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watchdog
            await self.close()

        if controls.cause == CANCEL_DIRECTIVE:
            return Conducted(
                status="canceled",
                ending="canceled",
                reason=None,
                provider_reference=self.provider_reference,
            )
        if controls.cause is not None:
            return self._ended(duration_limit_reached(max_duration_seconds))
        return self._ended(self._ending or turn_limit_reached(max_turns))

    def _ended(self, named: Ending) -> Conducted:
        ending, reason = named
        return Conducted(
            status="completed",
            ending=ending,
            reason=reason,
            provider_reference=self.provider_reference,
        )

    async def _open(self, name: str) -> None:
        self._media = await self._unless_stopped(self._connection.prepare())
        self._opened_unix_nano = _now()

        ear = _AgentEar(vad_analyzer=self._vad, conductor=self)
        turns = UserTurnProcessor(
            user_turn_strategies=UserTurnStrategies(
                start=[
                    VADUserTurnStartStrategy(
                        enable_interruptions=self._parameters.yields_to_the_agent
                    )
                ]
            ),
            user_turn_stop_timeout=self._parameters.agent_turn_backstop_seconds,
        )
        turn_boundary = _TurnBoundary()
        assert self._persona is not None
        model = _PersonaLLMService(persona=self._persona)
        replies = _PersonaReplyGate(service=model, conductor=self)
        brain = _PersonaBrain(persona=self._persona, conductor=self, replies=replies)
        recorder = _EvidenceRecorder(num_channels=2, auto_start_recording=True)
        media = self._media
        timeline = _Timeline(self, media, recorder)

        @recorder.event_handler("on_track_audio_data")
        async def _recorded(
            _processor: object,
            agent_audio: bytes,
            persona_audio: bytes,
            sample_rate: int,
            _num_channels: int,
        ) -> None:
            self._agent_track.extend(agent_audio)
            self._persona_track.extend(persona_audio)
            self._recording_rate = sample_rate

        pipeline = Pipeline(
            [
                *media.input,
                ear,
                self._legs.stt,
                turns,
                turn_boundary,
                brain,
                model,
                replies,
                self._legs.tts,
                *media.output,
                recorder,
                timeline,
            ]
        )
        worker = PipelineWorker(
            pipeline,
            params=PipelineParams(),
            idle_timeout_secs=None,
            # Native service spans inherit the simulation root already
            # attached by RunningSimulation. Pipecat's interaction-cycle
            # turn tracer stays off: Egma turn spans alone own transcript.
            enable_tracing=True,
            enable_turn_tracking=False,
            enable_rtvi=False,
        )

        @worker.event_handler("on_pipeline_error")
        async def _remember_fault(_worker: object, error: object) -> None:
            self._fault = str(getattr(error, "error", error))
            self._faulted.set()
            self.media_advanced()

        self._ear = ear
        self._recorder = recorder
        self._worker = worker
        self._runner = WorkerRunner(handle_sigint=False)
        await self._runner.add_workers(worker)
        self._running = asyncio.create_task(
            self._runner.run(), name=f"voice-pipeline:{name}"
        )
        await self._reach_event(timeline.started)
        await self._reach_step(self._legs.ready())
        try:
            await self._reach_step(self._connection.open())
        except (PipelineGone, SpeechFault) as refused:
            # Transport processors start only once Pipecat receives its
            # StartFrame. A join refusal therefore arrives as a pipeline
            # fault while the connection's open step is pending. Keep it a
            # platform refusal instead of calling it a speech-leg failure.
            transport = (
                self._media.transport_name
                if self._media is not None
                else "voice transport"
            )
            raise PlugError(
                f"the voice connection could not open through the {transport}: "
                f"{refused}"
            ) from refused
        self.media_advanced()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            await self._end_pipeline()
        finally:
            try:
                await self._connection.close()
            except Exception:
                logger.exception("closing the voice connection failed")
            await self._legs.aclose()
        await self._write_recording()

    async def _end_pipeline(self) -> None:
        if self._running is None or self._worker is None:
            return
        try:
            await self._worker.queue_frame(EndFrame())
            await asyncio.wait_for(asyncio.shield(self._running), timeout=10.0)
        except Exception as unfinished:
            logger.warning("the voice pipeline did not end cleanly: %r", unfinished)
        finally:
            if not self._running.done():
                self._running.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self._running

    async def _write_recording(self) -> None:
        if not self._recording_rate or (
            not self._persona_track and not self._agent_track
        ):
            return
        try:
            reference = await self._blobs.write(
                self._recording_key,
                dual_channel_wav(
                    bytes(self._persona_track),
                    bytes(self._agent_track),
                    self._recording_rate,
                ),
            )
        except Exception as failure:
            log_event(
                logger,
                logging.ERROR,
                "egma.simulation.recording_failed",
                "simulation recording upload failed",
                attributes={"error.type": type(failure).__name__},
                exc_info=True,
            )
            return
        self.audio = AudioFacts(recording=reference)

    async def _run(self) -> None:
        while self._ending is None:
            self._activity.clear()
            await self._evaluate()
            if self._ending is not None:
                return
            if self._activity.is_set():
                continue
            await self._next_activity()

    async def _evaluate(self) -> None:
        self._stop_if_asked()
        media = self._media
        if media is not None and media.failed.is_set():
            raise self._transport_lost()
        ear = self._ear
        if ear is None:
            return
        if media is not None and media.ended.is_set() and not self._agent_departed:
            await self._agent_left()
        if self._agent_departed:
            if media is not None and not media.ended.is_set():
                return
            if ear.hearing_speech or self._heard_so_far < len(ear.utterances):
                return
            self._ending = AGENT_ENDED
            return
        if self._owes_a_turn or ear.hearing_speech:
            return
        if self._heard_so_far < len(ear.utterances):
            return

        if self._record.persona_last_stopped_at is None and not ear.utterances:
            if self._position >= _seconds(self._parameters.agent_opening_seconds):
                await self._ask_the_persona(heard_a_turn=False)
            return
        if self._record.persona_last_stopped_at is None:
            return
        if self._position - self._record.quiet_since >= _seconds(
            self._parameters.agent_quiet_seconds
        ):
            await self._ask_the_persona(heard_a_turn=False)

    async def _ask_the_persona(self, *, heard_a_turn: bool) -> None:
        if self._worker is None:
            raise PipelineGone("the persona was asked before the pipeline started")
        self._owes_a_turn = True
        await self._worker.queue_frame(_AgentFinished(heard_a_turn=heard_a_turn))

    async def the_agent_finished(
        self, said: str, heard_a_turn: bool
    ) -> MediaPosition | None:
        ear = self._ear
        if ear is None:
            return None
        stopped_at: MediaPosition | None = None
        if heard_a_turn and self._heard_so_far < len(ear.utterances):
            source_began = ear.utterances[self._heard_so_far].began
            source_ended = ear.utterances[-1].ended
            observed_through = ear.utterances[-1].observed_through
            recorder = self._recorder
            if recorder is None:
                raise PipelineGone("the agent finished before the recorder started")
            began, ended = await recorder.agent_interval(
                source_began,
                source_ended,
                observed_through=observed_through,
            )
            self._heard_so_far = len(ear.utterances)
            stopped_at = ended
            answering = self._record.persona_last_stopped_at is not None
            if self._talked_over(began):
                if answering:
                    self._record.first_answer_measured = True
            else:
                quiet_from = self._record.quiet_since
                await self._measure("time_to_first_word", quiet_from, began)
                if answering:
                    if not self._record.first_answer_measured:
                        self._record.first_answer_measured = True
                        await self._measure(
                            "first_response_latency", quiet_from, began
                        )
                    await self._measure("turn_response_latency", quiet_from, began)
            await self._took_a_turn("agent", said, began, ended)
            await self._measure("agent_speech_duration", began, ended)
            self._record.persona_last_stopped_at = None
            self._record.quiet_since = max(self._record.quiet_since, ended)
        if self._on_answered is not None:
            await self._on_answered()
        if self._ending is not None:
            return None
        if self._agent_departed:
            self._owes_a_turn = False
            self.media_advanced()
            return None
        if self._media is not None and self._media.ended.is_set():
            self._agent_departed = True
            self._ending = AGENT_ENDED
            self._owes_a_turn = False
            self.media_advanced()
            return None
        self._owes_a_turn = True
        if stopped_at is None:
            return self._position
        return stopped_at + _seconds(self._parameters.persona_pause_seconds)

    async def wait_until(self, due: MediaPosition) -> None:
        while self._position < due and not self.is_ending:
            self._activity.clear()
            if self._position >= due or self.is_ending:
                return
            await self._activity.wait()

    def persona_will_speak(self, text: str, *, concludes: bool = False) -> None:
        self._pending_persona_text = text
        self._pending_persona_concludes = concludes
        self._persona_began = None
        self._persona_ended = None

    def persona_audio(
        self,
        frame: OutputAudioRawFrame,
        *,
        recorded_until: MediaPosition,
    ) -> None:
        if self._pending_persona_text is None:
            return
        if self._persona_began is None:
            duration = Fraction(frame.num_frames, frame.sample_rate)
            self._persona_began = max(Fraction(0), recorded_until - duration)
        self._persona_ended = recorded_until
        self.media_advanced()

    async def persona_stopped(self) -> None:
        text, self._pending_persona_text = self._pending_persona_text, None
        concludes, self._pending_persona_concludes = (
            self._pending_persona_concludes,
            False,
        )
        if text is None:
            return
        began = self._persona_began
        ended = self._persona_ended
        self._persona_began = None
        self._persona_ended = None
        if began is None or ended is None or ended <= began:
            raise SpeechFault(
                "the persona's transcript turn ended without recorded audio"
            )
        await self._measure("persona_speech_duration", began, ended)
        await self._took_a_turn(
            "human", text, began, ended, apply_turn_limit=not concludes
        )
        self._record.persona_last_stopped_at = ended
        self._record.quiet_since = max(self._record.quiet_since, ended)
        if concludes and not self.is_ending:
            self._ending = PERSONA_CONCLUDED
        self._owes_a_turn = False
        self.media_advanced()

    def _talked_over(self, began: MediaPosition) -> bool:
        if began < self._record.quiet_since:
            return True
        return self._persona_began is not None and self._persona_began < began

    @property
    def _position(self) -> MediaPosition:
        if self._recorder is not None:
            return self._recorder.position
        return Fraction(0) if self._ear is None else self._ear.position

    async def _took_a_turn(
        self,
        speaker: str,
        text: str,
        began: MediaPosition,
        ended: MediaPosition,
        *,
        apply_turn_limit: bool = True,
    ) -> None:
        self._record.history.append(
            Turn("human" if speaker == "human" else "agent", text)
        )
        self._record.turns += 1
        if self._on_utterance is not None:
            await self._on_utterance(
                speaker, text, self._at(began), self._at(ended)
            )
        if (
            apply_turn_limit
            and self._record.turns >= self._max_turns
            and self._ending is None
        ):
            self._ending = turn_limit_reached(self._max_turns)
            self.media_advanced()

    async def _measure(
        self, measure: str, began: MediaPosition, ended: MediaPosition
    ) -> None:
        if ended < began:
            raise ValueError(
                f"{measure} was measured over a backwards media interval"
            )
        if self._on_measured is not None:
            await self._on_measured(measure, self._at(began), self._at(ended))

    def _at(self, position: MediaPosition) -> int:
        nanos = position.numerator * 1_000_000_000 // position.denominator
        return self._opened_unix_nano + nanos

    def media_advanced(self) -> None:
        self._activity.set()

    def agent_is_departing(self) -> None:
        """Stop new persona work while the ordered departure marker drains."""
        self._agent_departed = True
        self._owes_a_turn = False
        self.media_advanced()

    async def agent_input_is_closing(self, source_end: MediaPosition) -> None:
        """Tell the recorder where the ordered final input frame ended."""
        if self._recorder is None:
            raise PipelineGone("agent input ended before the recorder started")
        await self._recorder.close_input_at(source_end)

    def the_brain_failed(self, fault: BaseException) -> None:
        if self._brain_fault is None:
            self._brain_fault = fault
        self._faulted.set()
        self.media_advanced()

    def _raise_fault(self) -> None:
        if self._brain_fault is not None:
            raise self._brain_fault
        raise SpeechFault(f"a voice pipeline component refused: {self._fault}")

    def _stop_if_asked(self) -> None:
        if self._controls.cause is not None:
            raise _Stopped()

    def _transport_lost(self) -> PlugError:
        transport = (
            self._media.transport_name
            if self._media is not None
            else "voice transport"
        )
        return PlugError(
            f"the {transport} disconnected before the simulation ended"
        )

    async def _agent_left(self) -> None:
        """Finish any active input turn before recording a normal departure."""
        self._agent_departed = True
        if self._ear is not None:
            await self._ear.finalize_active_utterance()
        self.media_advanced()

    async def _next_activity(self) -> None:
        if self._running is None or self._media is None:
            raise PipelineGone("the voice pipeline was not running")
        changed = asyncio.ensure_future(self._activity.wait())
        faulted = asyncio.ensure_future(self._faulted.wait())
        stopped = asyncio.ensure_future(self._controls.guard(_never()))
        failed = asyncio.ensure_future(self._media.failed.wait())
        ended = (
            None
            if self._agent_departed
            else asyncio.ensure_future(self._media.ended.wait())
        )
        waiting = {changed, faulted, stopped, failed, self._running}
        if ended is not None:
            waiting.add(ended)
        try:
            done, _pending = await asyncio.wait(
                waiting,
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            for unfinished in (changed, faulted, stopped, failed, ended):
                if unfinished is None:
                    continue
                if not unfinished.done():
                    unfinished.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await unfinished
        if faulted in done:
            self._raise_fault()
        if stopped in done:
            raise _Stopped()
        if failed in done:
            raise self._transport_lost()
        if ended is not None and ended in done:
            await self._agent_left()
            return
        if changed in done:
            return
        raise PipelineGone("the voice pipeline ended before the conversation did")

    async def _reach_event(self, event: asyncio.Event) -> None:
        await self._reach(event.wait())

    async def _reach_step(self, step: Coroutine[Any, Any, Any]) -> Any:
        return await self._reach(step)

    async def _reach(self, step: Awaitable[Any]) -> Any:
        if self._running is None:
            raise PipelineGone("the voice pipeline was not running")
        taking = asyncio.ensure_future(step)
        faulted = asyncio.ensure_future(self._faulted.wait())
        stopped = asyncio.ensure_future(self._controls.guard(_never()))
        failed = (
            asyncio.ensure_future(self._media.failed.wait())
            if self._media is not None
            else None
        )
        waiting = {taking, faulted, stopped, self._running}
        if failed is not None:
            waiting.add(failed)
        try:
            done, _pending = await asyncio.wait(
                waiting,
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            for unfinished in (taking, faulted, stopped, failed):
                if unfinished is None:
                    continue
                if not unfinished.done():
                    unfinished.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await unfinished
        if faulted in done:
            self._raise_fault()
        if stopped in done:
            raise _Stopped()
        if failed is not None and failed in done:
            raise self._transport_lost()
        if taking in done:
            return taking.result()
        raise PipelineGone("the voice pipeline ended while it was opening")

    async def _unless_stopped(self, step: Coroutine[Any, Any, Any]) -> Any:
        taking = asyncio.ensure_future(step)
        stopped = asyncio.ensure_future(self._controls.guard(_never()))
        try:
            done, _pending = await asyncio.wait(
                {taking, stopped}, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            for unfinished in (taking, stopped):
                if not unfinished.done():
                    unfinished.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await unfinished
        if taking in done:
            return taking.result()
        raise _Stopped()


class _Stopped(Exception):
    pass


async def _never() -> None:
    await asyncio.Event().wait()


async def _duration_watchdog(
    max_duration_seconds: float, controls: WalkControls
) -> None:
    await asyncio.sleep(max_duration_seconds)
    controls.trip_duration_limit()


def _seconds(value: float) -> Fraction:
    return Fraction(round(value * 1_000_000_000), 1_000_000_000)


def _now() -> int:
    return time.time_ns()
