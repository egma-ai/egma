"""The single Pipecat pipeline that conducts and records a voice simulation."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
import time
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass, field, replace
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
    FunctionCallFromLLM,
    FunctionCallResultProperties,
    InputAudioRawFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    MetricsFrame,
    OutputAudioRawFrame,
    StartFrame,
    TextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSStoppedFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.metrics.metrics import STTUsageMetricsData, TTSUsageMetricsData
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.llm_service import FunctionCallParams, LLMService
from pipecat.services.settings import LLMSettings
from pipecat.turns.user_start import VADUserTurnStartStrategy
from pipecat.turns.user_turn_processor import UserTurnProcessor
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.tracing.service_decorators import traced_llm
from pipecat.workers.runner import WorkerRunner

from .blob import BlobStore
from .conversation import (
    AGENT_ENDED,
    CANCEL_DIRECTIVE,
    PERSONA_CONCLUDED,
    Conducted,
    ConversationControls,
    Ending,
    OnExecutionEnded,
    duration_limit_reached,
    turn_limit_reached,
)
from .media import (
    TRANSPORT_ARRIVAL,
    TRANSPORT_PLAYOUT,
    RemoteParticipantLeftFrame,
    VoiceMedia,
    transport_time,
)
from .model import END_CALL_TOOL_NAME, ModelFailure, PersonaReply
from .persona import SILENCE_FOLLOW_UP_LIMIT, SILENCE_WAIT_SECONDS, Persona, Turn
from .platform_logging import log_event
from .plugs import PlugError, VoiceConnection
from .provider_keys import ProviderKeyUnavailable, authentication_rejected
from .recording import AudioFacts, dual_channel_wav
from .speech import (
    SCRIPTED_PAIR,
    PersonaVoice,
    ProviderUsageMetricsData,
    SpeechFault,
    SpeechGain,
    SpeechLegs,
    SpeechProviders,
    build_legs,
    build_vad,
)
from .usage import ProviderUsage, audio_seconds_usage, characters_usage

logger = logging.getLogger(__name__)

MediaPosition = Fraction
_INPUT_SOURCE_RANGE = "egma.input_source_range"
_INTERRUPTION_AUDIO = "egma.interruption_audio"
_INTERRUPTION_CAP_END = "egma.interruption_cap_end"


@dataclass(frozen=True)
class ConductParameters:
    """The voice conduct choices that are independent of media rates."""

    agent_opening_seconds: float = 10.0
    persona_pause_seconds: float = 0.4
    agent_quiet_seconds: float = SILENCE_WAIT_SECONDS
    agent_turn_backstop_seconds: float = 5.0
    yields_to_the_agent: bool = True
    interruption_level: str = "off"

    def __post_init__(self) -> None:
        if self.interruption_level not in {"off", "occasional", "frequent"}:
            raise ValueError("interruption level must be off, occasional, or frequent")


DEFAULT_CONDUCT = ConductParameters()

PERSONA_ENDED_SILENCE: Ending = (
    "persona_concluded",
    "the agent did not respond after two persona follow-ups",
)

OnUtterance = Callable[[str, str, int, int], Awaitable[None]]
OnPartialUtterance = Callable[[str, int, int], Awaitable[None]]
OnMeasured = Callable[[str, int, int], Awaitable[None]]
OnProviderUsage = Callable[[ProviderUsage], Awaitable[None]]
OnAnswered = Callable[[], Awaitable[None]]


@dataclass(frozen=True)
class InterruptionEvidence:
    event: str
    at_unix_nano: int
    scheduled_for_unix_nano: int | None = None
    began_unix_nano: int | None = None
    ended_unix_nano: int | None = None
    overlap_ended_unix_nano: int | None = None
    reason: str | None = None
    generated_text: str | None = None
    delivered_text: str | None = None


OnInterruption = Callable[[InterruptionEvidence], None]


@dataclass
class _AgentFinished(ControlFrame):
    heard_a_turn: bool = True
    silence_follow_up: int = 0
    silence_wait_seconds: float = SILENCE_WAIT_SECONDS


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
            await self.broadcast_frame(VADUserStoppedSpeakingFrame, stop_secs=stop_secs)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if isinstance(frame, RemoteParticipantLeftFrame):
            self._conductor.agent_is_departing()
            await self._conductor.agent_input_is_closing(self.position)
            await self.finalize_active_utterance()
        if isinstance(frame, InputAudioRawFrame):
            source_start = self.position
            source_end = source_start + Fraction(frame.num_frames, frame.sample_rate)
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
        if direction == FrameDirection.DOWNSTREAM and isinstance(
            frame, UserStoppedSpeakingFrame
        ):
            await self.push_frame(_AgentFinished())


@dataclass(frozen=True)
class _RecordedInputSegment:
    source_start: MediaPosition
    source_end: MediaPosition
    recording_start_sample: int
    recording_end_sample: int


@dataclass
class _RecordedTrack:
    """Per-channel recording position. written_through is the next sample position,
    not buffer length. owed tracks inserted silence that later audio can reclaim,
    as end position and remaining length, ordered oldest first.
    """

    written_through: int | None = None
    owed: list[tuple[int, int]] = field(default_factory=list)


LONGEST_QUIET_LEDGER = 64
"""How many outstanding stretches of re-anchor quiet one channel keeps.

Every real silence in a call opens one that will never be claimed, so
the ledger is bounded and the oldest entries go first. Sixty-four is far
more than the stalls of one call, and forgetting the oldest costs only
the chance to close a gap opened minutes ago.
"""


RESYNC_TOLERANCE_SECONDS = 0.1
"""Clock drift tolerance before re-anchoring a recording channel.
Small delivery jitter stays contiguous. Larger gaps follow transport time.
When delayed audio catches up, remove only silence inserted by the recorder;
never overwrite real audio to force agreement with the clock.
"""


class _EvidenceRecorder(AudioBufferProcessor):
    """Place both recording channels on one transport timeline.
    Agent frames use arrival time; persona frames use transport playout time
    after pacing. Gaps remain silent so cross-channel timing reflects the simulation.
    """

    def __init__(self, *, real_time: bool = True, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        # Disable wall-clock resampler reset. A scheduling gap can exceed 0.2 seconds
        # within continuous audio; resetting would discard buffered samples.
        self._input_resampler = SOXRStreamAudioResampler(clear_after_secs=None)
        self._output_resampler = SOXRStreamAudioResampler(clear_after_secs=None)
        self._recording_ready = asyncio.Condition()
        self._processed_source_end = Fraction(0)
        self._represented_source_end = Fraction(0)
        self._last_input_frame_duration = Fraction(0)
        self._input_segments: list[_RecordedInputSegment] = []
        self._closing_source_end: MediaPosition | None = None
        self._input_closed = False
        self._agent = _RecordedTrack()
        self._persona = _RecordedTrack()
        self._origin_seconds: float | None = None
        self._origin_unix_nano = 0
        self._real_time = real_time

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

    @staticmethod
    def _transport_time(frame: Frame, named: str, whose: str) -> float:
        stamped = transport_time(frame, named)
        if stamped is None:
            raise SpeechFault(
                f"{whose} reached the recorder without its transport time"
            )
        return stamped

    async def start_recording(self) -> None:
        """Begin a recording, and a timeline for it to be written on.

        Pipecat empties its buffers from both ends of a recording, so the
        timeline is started here rather than there: the recording's zero
        is read after the pipeline has stopped, by whoever files the
        audio, and a zero cleared on the way out is a whole transcript
        stamped from the moment the line opened instead of from the first
        sample of the call.
        """
        starting = not self._recording
        await super().start_recording()
        if starting:
            self._agent = _RecordedTrack()
            self._persona = _RecordedTrack()
            self._origin_seconds = None
            self._origin_unix_nano = 0

    async def _process_recording(self, frame: Frame) -> None:
        """Put one frame on the recording, at the time it happened.

        Pipecat's own placement is replaced outright rather than extended:
        its padding rule is the defect, and running both would pad the
        very gaps this fills. Input audio is a Pipecat SystemFrame while
        output audio is an ordinary frame, so Pipecat can present both to
        this processor at once. Keep each write and its position map
        indivisible.
        """
        async with self._recording_ready:
            if isinstance(frame, InputAudioRawFrame):
                await self._record_agent(frame)
            elif isinstance(frame, OutputAudioRawFrame):
                await self._record_persona(frame)
            elif isinstance(frame, InterruptionFrame):
                self._drop_what_was_never_played(frame)
            else:
                return
            self._recording_ready.notify_all()

    async def _record_agent(self, frame: InputAudioRawFrame) -> None:
        """The agent's audio, where it arrived at the transport."""
        if self._input_closed:
            raise SpeechFault("agent audio arrived after its recorded input ended")
        source_start, source_end = self._source_range(frame)
        if source_start != self._processed_source_end or source_end < source_start:
            raise SpeechFault("agent audio reached the recorder out of order")
        arrived = self._transport_time(frame, TRANSPORT_ARRIVAL, "agent audio")
        audio = await self._resample_input_audio(frame)
        written = len(audio) // 2
        if written:
            # The resampler retains samples for the next frame. Place each returned
            # chunk
            # by its end and carry the boundary forward to keep source timing
            # continuous.
            through = arrived + float(source_end - source_start)
            began, ended = self._place(
                self._user_audio_buffer,
                self._agent,
                through - written / self.sample_rate,
                audio,
            )
            represented_start = self._represented_source_end
            represented_end = represented_start + Fraction(written, self.sample_rate)
            if represented_end > source_end:
                raise SpeechFault(
                    "pipecat's recording resampler returned more audio than it was fed"
                )
            self._represented_source_end = represented_end
            self._input_segments.append(
                _RecordedInputSegment(
                    source_start=represented_start,
                    source_end=represented_end,
                    recording_start_sample=began,
                    recording_end_sample=ended,
                )
            )
        self._processed_source_end = source_end
        self._last_input_frame_duration = source_end - source_start
        self._maybe_close_input()

    async def _record_persona(self, frame: OutputAudioRawFrame) -> None:
        """The persona's audio, where the transport plays it out."""
        played = self._transport_time(frame, TRANSPORT_PLAYOUT, "persona audio")
        audio = await self._resample_output_audio(frame)
        written = len(audio) // 2
        if not written:
            return
        through = played + frame.num_frames / frame.sample_rate
        self._place(
            self._bot_audio_buffer,
            self._persona,
            through - written / self.sample_rate,
            audio,
        )

    def _drop_what_was_never_played(self, frame: Frame) -> None:
        """Discard persona audio removed from the transport queue by an interruption.
        Update the inserted-silence ledger too, so later catch-up cannot overwrite
        audio that was played.
        """
        cleared = transport_time(frame, TRANSPORT_PLAYOUT)
        if cleared is None or self._origin_seconds is None:
            return
        heard_through = self._sample_at(cleared)
        written_through = self._persona.written_through
        if written_through is None or written_through <= heard_through:
            return
        del self._bot_audio_buffer[heard_through * 2 :]
        self._persona.written_through = heard_through
        self._persona.owed.clear()

    def _place(
        self,
        buffer: bytearray,
        track: _RecordedTrack,
        starts_at: float,
        audio: bytes,
    ) -> tuple[int, int]:
        """Write one channel's audio where its transport clock puts it.

        The first frame anybody writes fixes the recording's own zero, so
        a file always starts with the audio that opened the call.
        """
        if self._origin_seconds is None:
            self._origin_seconds = starts_at
            self._origin_unix_nano = self._wall_clock_zero(starts_at)
        wanted = self._sample_at(starts_at)
        cursor = track.written_through
        if cursor is None:
            began = wanted
        elif wanted - cursor > self._tolerance:
            # Behind its clock: the line was quiet, and the recording says
            # so. Remember the quiet, in case what follows shows it was a
            # delivery holding audio back rather than a far end holding
            # its tongue.
            track.owed.append((wanted, wanted - cursor))
            del track.owed[:-LONGEST_QUIET_LEDGER]
            began = wanted
        elif cursor - wanted > self._tolerance:
            self._give_the_quiet_back(buffer, track, cursor - wanted)
            began = cast(int, track.written_through)
        else:
            began = cursor
        ended = began + len(audio) // 2
        self._write(buffer, began, audio)
        track.written_through = ended
        return began, ended

    def _give_the_quiet_back(
        self, buffer: bytearray, track: _RecordedTrack, ahead: int
    ) -> None:
        """Reclaim recorder-inserted silence when delayed audio catches up.
        Walk newest gaps first so closing one does not move older ledger positions.
        Never reclaim real audio.
        """
        while ahead > 0 and track.owed:
            ends_at, owed = track.owed[-1]
            given = min(ahead, owed)
            del buffer[(ends_at - given) * 2 : ends_at * 2]
            if track is self._agent:
                # The agent's channel is the one a turn is looked up on,
                # so closing quiet on it moves every place already mapped
                # past the quiet. The persona's channel carries no map.
                for position, segment in enumerate(self._input_segments):
                    if segment.recording_start_sample >= ends_at:
                        self._input_segments[position] = replace(
                            segment,
                            recording_start_sample=(
                                segment.recording_start_sample - given
                            ),
                            recording_end_sample=segment.recording_end_sample - given,
                        )
            if track.written_through is not None:
                track.written_through -= given
            ahead -= given
            if given < owed:
                track.owed[-1] = (ends_at - given, owed - given)
            else:
                track.owed.pop()

    def _wall_clock_zero(self, starts_at: float) -> int:
        """Map the first recorded sample to wall time using its real-time transport
        stamp.
        This excludes processing delay. For a media clock, use placement time instead.
        """
        if not self._real_time:
            return _now()
        return _now() - round((_monotonic() - starts_at) * 1_000_000_000)

    def _sample_at(self, seconds: float) -> int:
        """One instant on the transport's clock, as a recording position.

        Audio stamped before the recording's own zero is held at its
        start. Only a frame that crossed the pipeline beside the very
        first one can be, and holding it there costs the interleave of
        those two rather than anything a listener would find.
        """
        origin = self._origin_seconds
        if origin is None or not self.sample_rate:
            return 0
        return max(0, round((seconds - origin) * self.sample_rate))

    @property
    def _tolerance(self) -> int:
        return round(RESYNC_TOLERANCE_SECONDS * self.sample_rate)

    @staticmethod
    def _write(buffer: bytearray, at_sample: int, audio: bytes) -> None:
        """Audio at one position, with quiet wherever nothing was written."""
        at = at_sample * 2
        if len(buffer) < at:
            buffer.extend(bytes(at - len(buffer)))
        through = at + len(audio)
        if len(buffer) < through:
            buffer.extend(bytes(through - len(buffer)))
        buffer[at:through] = audio

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
    def started_unix_nano(self) -> int:
        """When the recording's own zero was, on the wall clock.

        Every transcript position is an offset from here, so this is what
        makes a seek into the file land on the words the turn names.
        """
        return self._origin_unix_nano

    @property
    def bot_position(self) -> MediaPosition:
        """Where the persona's audio has been played out through."""
        if not self.sample_rate or self._persona.written_through is None:
            return Fraction(0)
        return Fraction(self._persona.written_through, self.sample_rate)

    @property
    def position(self) -> MediaPosition:
        """The last instant either side put audio on the recording."""
        if not self.sample_rate:
            return Fraction(0)
        written = [
            track.written_through
            for track in (self._agent, self._persona)
            if track.written_through is not None
        ]
        return Fraction(max(written, default=0), self.sample_rate)

    async def agent_interval(
        self,
        source_began: MediaPosition,
        source_ended: MediaPosition,
        *,
        observed_through: MediaPosition,
    ) -> tuple[MediaPosition, MediaPosition]:
        """Place one agent turn on the recording's own timeline."""
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
            reversed(self._input_segments) if at_turn_start else self._input_segments
        )
        for segment in segments:
            inside = (
                segment.source_start <= source_position < segment.source_end
                if at_turn_start
                else segment.source_start < source_position <= segment.source_end
            )
            if inside:
                return Fraction(segment.recording_start_sample, self.sample_rate) + (
                    source_position - segment.source_start
                )
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
    output attributes. The model client still owns the direct provider request,
    including its non-streaming body and timeout.
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
        self._function_call_done: asyncio.Event | None = None
        self._function_call_failure: Exception | None = None
        self._end_call_executed = False
        self.register_function(END_CALL_TOOL_NAME, self._end_call)

    async def _end_call(self, params: FunctionCallParams) -> None:
        """Execute the persona's conclusion through Pipecat's tool lifecycle."""
        done = self._function_call_done
        if done is None:
            raise RuntimeError("Pipecat executed end_call outside a persona reply")
        try:
            if params.arguments:
                raise ModelFailure(
                    "the persona model's end_call tool takes no arguments"
                )
            self._end_call_executed = True
            await params.result_callback(
                {"ended": True},
                properties=FunctionCallResultProperties(run_llm=False),
            )
        except Exception as fault:
            self._function_call_failure = fault
            raise
        finally:
            done.set()

    async def _execute_tool_calls(
        self, reply: PersonaReply, context: LLMContext
    ) -> PersonaReply:
        if not reply.tool_calls:
            return reply
        if len(reply.tool_calls) != 1:
            raise ModelFailure(
                "the persona model called more than one tool in one turn"
            )

        call = reply.tool_calls[0]
        if call.name != END_CALL_TOOL_NAME:
            raise ModelFailure(
                f"the persona model called an unavailable tool: {call.name!r}"
            )
        done = asyncio.Event()
        self._function_call_done = done
        self._function_call_failure = None
        self._end_call_executed = False
        try:
            await self.run_function_calls(
                [
                    FunctionCallFromLLM(
                        function_name=call.name,
                        tool_call_id=call.tool_call_id,
                        arguments=call.arguments,
                        context=context,
                    )
                ]
            )
            await asyncio.wait_for(done.wait(), timeout=2.0)
            if self._function_call_failure is not None:
                raise self._function_call_failure
            if not self._end_call_executed:
                raise ModelFailure(
                    "the persona model called a tool that did not execute end_call"
                )
            return replace(reply, concluded=True)
        except TimeoutError as fault:
            raise ModelFailure(
                "Pipecat did not finish the persona's end_call tool"
            ) from fault
        finally:
            self._function_call_done = None

    @traced_llm
    async def _process_context(self, context: LLMContext) -> None:
        self._reply = None
        self._failure = None
        reply = await self._persona.reply_to(context)
        if reply.usage is not None:
            # What the provider says this turn cost, onto the same bus the
            # speaking and listening legs report on. The model client already
            # read it out of the body it parsed for the words; putting it here
            # is what lets one collector at the end of the pipeline see every
            # provider request a voice simulation makes.
            await self.push_frame(
                MetricsFrame(
                    data=[
                        ProviderUsageMetricsData(
                            processor=self.name,
                            model=reply.usage.model,
                            usage=reply.usage,
                        )
                    ]
                )
            )
        if reply.text:
            await self.push_frame(LLMTextFrame(reply.text))
        reply = await self._execute_tool_calls(reply, context)
        self._reply = reply

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
        self._silence_follow_up = 0
        self._kind = "ordinary"
        self._idle = asyncio.Event()
        self._idle.set()

    @property
    def busy(self) -> bool:
        return self._waiting is not None

    def cancel_pending(self) -> None:
        if self._waiting is not None and not self._waiting.done():
            self._waiting.cancel()

    async def wait_idle(self) -> None:
        await self._idle.wait()

    async def request(
        self,
        context: LLMContext,
        due: MediaPosition,
        push: Callable[[Frame], Awaitable[None]],
        *,
        silence_follow_up: int = 0,
        kind: str = "ordinary",
    ) -> None:
        if self._waiting is not None:
            raise RuntimeError("the persona model already has a reply in flight")
        waiting = asyncio.get_running_loop().create_future()
        self._waiting = waiting
        self._idle.clear()
        self._due = due
        self._silence_follow_up = silence_follow_up
        self._kind = kind
        try:
            await push(LLMContextFrame(context=context))
            await waiting
        except BaseException:
            if self._waiting is waiting:
                waiting.cancel()
            raise

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(
            frame, InterruptionFrame
        ):
            self._conductor.persona_will_not_finish()
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
            if waiting.cancelled():
                return
            received = "".join(self._text)
            if received != reply.text:
                raise RuntimeError(
                    "Pipecat's persona response did not match its model reply"
                )
            if (
                self._kind == "deliberate"
                and not self._conductor.may_start_interruption
            ):
                self._conductor.interruption_canceled("agent_stopped_before_playout")
            elif reply.concluded and not reply.text:
                self._conductor.persona_concluded_without_speech()
            elif not self._conductor.is_ending:
                await self._conductor.wait_until(due)
                if not self._conductor.is_ending:
                    self._conductor.persona_will_speak(
                        reply.text,
                        concludes=reply.concluded,
                        silence_follow_up=self._silence_follow_up,
                        deliberate=self._kind == "deliberate",
                    )
                    await self.push_frame(LLMFullResponseStartFrame())
                    await self.push_frame(TextFrame(reply.text))
                    await self.push_frame(LLMFullResponseEndFrame())
        except asyncio.CancelledError:
            waiting.cancel()
            raise
        except Exception as fault:
            if not waiting.done():
                waiting.set_exception(fault)
        else:
            if not waiting.done():
                waiting.set_result(None)
        finally:
            self._reset()

    def _reset(self) -> None:
        canceled_deliberate = (
            self._kind == "deliberate"
            and self._waiting is not None
            and self._waiting.cancelled()
        )
        self._waiting = None
        self._due = None
        self._collecting = False
        self._text = []
        self._silence_follow_up = 0
        self._kind = "ordinary"
        self._idle.set()
        if canceled_deliberate:
            self._conductor.interruption_generation_drained()


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
        self._answer_lock = asyncio.Lock()
        self._deferred: set[asyncio.Task[None]] = set()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            self._heard.append(frame.text)
        await self.push_frame(frame, direction)
        if isinstance(frame, _AgentFinished):
            said = " ".join(piece for piece in self._heard if piece)
            self._heard.clear()
            if self._conductor.deliberate_response_owned or self._replies.busy:
                deferred = asyncio.create_task(self._answer_when_idle(frame, said))
                self._deferred.add(deferred)
                deferred.add_done_callback(self._deferred.discard)
                return
            await self._answer(
                frame.heard_a_turn,
                frame.silence_follow_up,
                frame.silence_wait_seconds,
                said=said,
            )

    async def _answer(
        self,
        heard_a_turn: bool,
        silence_follow_up: int = 0,
        silence_wait_seconds: float = SILENCE_WAIT_SECONDS,
        *,
        said: str | None = None,
    ) -> None:
        try:
            if said is None:
                said = " ".join(piece for piece in self._heard if piece)
                self._heard.clear()
            due = await self._conductor.the_agent_finished(said, heard_a_turn)
            if due is None:
                return
            await self._replies.request(
                self._persona.context(
                    self._conductor.history,
                    silence_follow_up=silence_follow_up,
                    silence_wait_seconds=silence_wait_seconds,
                ),
                due,
                self.push_frame,
                silence_follow_up=silence_follow_up,
            )
        except Exception as fault:
            self._conductor.the_brain_failed(fault)

    async def _answer_when_idle(self, frame: _AgentFinished, said: str) -> None:
        try:
            async with self._answer_lock:
                while self._replies.busy or self._conductor.deliberate_response_owned:
                    await self._replies.wait_idle()
                    await self._conductor.wait_until_interruption_idle()
                if not self._conductor.is_ending:
                    await self._answer(
                        frame.heard_a_turn,
                        frame.silence_follow_up,
                        frame.silence_wait_seconds,
                        said=said,
                    )
        except Exception as fault:
            self._conductor.the_brain_failed(fault)

    async def cleanup(self) -> None:
        for task in self._deferred:
            task.cancel()
        if self._deferred:
            await asyncio.gather(*self._deferred, return_exceptions=True)
        self._deferred.clear()
        await super().cleanup()


class _InterruptionScheduler(FrameProcessor):
    """Start one deliberate reply inside each eligible continuous speech segment."""

    def __init__(
        self, *, persona: Persona, conductor: VoiceConductor, replies: _PersonaReplyGate
    ) -> None:
        super().__init__()
        self._persona = persona
        self._conductor = conductor
        self._replies = replies
        self._attempt: asyncio.Task[None] | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, VADUserStartedSpeakingFrame):
                self._conductor.agent_speech_started()
            elif isinstance(frame, VADUserStoppedSpeakingFrame):
                self._conductor.agent_speech_stopped()
                self._cancel_attempt()
            elif (
                isinstance(frame, InputAudioRawFrame)
                and self._conductor.interruption_due
            ):
                if self._attempt is None and not self._replies.busy:
                    self._conductor.interruption_preparing()
                    self._attempt = asyncio.create_task(self._prepare())
            elif (
                isinstance(frame, InterruptionFrame)
                and self._conductor.deliberate_delivering
            ):
                return
        await self.push_frame(frame, direction)

    async def _prepare(self) -> None:
        assert self._persona is not None
        try:
            await self._replies.request(
                self._persona.interruption_context(self._conductor.history),
                self._conductor.position,
                self.push_frame,
                kind="deliberate",
            )
        except asyncio.CancelledError:
            raise
        except Exception as fault:
            self._conductor.interruption_provider_failed(
                f"provider_failed:{type(fault).__name__}"
            )
        finally:
            self._attempt = None

    def _cancel_attempt(self) -> None:
        if self._attempt is not None and not self._attempt.done():
            self._replies.cancel_pending()

    async def cleanup(self) -> None:
        self._replies.cancel_pending()
        if self._attempt is not None and not self._attempt.done():
            self._attempt.cancel()
            await asyncio.gather(self._attempt, return_exceptions=True)
        await super().cleanup()


class _InterruptionAudioLimit(FrameProcessor):
    """Keep deliberate speech handed to transport within three seconds."""

    def __init__(self, conductor: VoiceConductor) -> None:
        super().__init__()
        self._conductor = conductor
        self._frames = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction != FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return
        if (
            isinstance(frame, TTSStoppedFrame)
            and self._conductor.discarding_deliberate_audio
        ):
            self._conductor.deliberate_audio_discarded()
            await self.push_frame(frame, direction)
            return
        if (
            isinstance(frame, TTSAudioRawFrame)
            and self._conductor.discarding_deliberate_audio
        ):
            return
        if (
            isinstance(frame, TTSAudioRawFrame)
            and self._conductor.deliberate_response_owned
        ):
            if not (
                self._conductor.deliberate_delivering
                or self._conductor.deliberate_audio_queued
            ):
                if not self._conductor.may_start_interruption:
                    self._conductor.interruption_canceled(
                        "agent_stopped_before_playout"
                    )
                    await self.push_frame(InterruptionFrame())
                    return
                self._frames = 0
                self._conductor.interruption_audio_queued()
            frame.metadata[_INTERRUPTION_AUDIO] = True
            limit = frame.sample_rate * 3
            remaining = max(0, limit - self._frames)
            if remaining == 0:
                return
            if frame.num_frames > remaining:
                bytes_per_frame = len(frame.audio) // frame.num_frames
                frame = TTSAudioRawFrame(
                    frame.audio[: remaining * bytes_per_frame],
                    frame.sample_rate,
                    frame.num_channels,
                    context_id=frame.context_id,
                )
                self._conductor.interruption_audio_capped()
            self._frames += frame.num_frames
            if self._frames == limit:
                self._conductor.interruption_audio_capped()
                frame.metadata[_INTERRUPTION_CAP_END] = True
        await self.push_frame(frame, direction)


class _InterruptionPlayout(FrameProcessor):
    """Cancel unused synthesis only after the bounded final frame is accepted."""

    def __init__(self, conductor: VoiceConductor) -> None:
        super().__init__()
        self._conductor = conductor

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if direction != FrameDirection.DOWNSTREAM or not isinstance(
            frame, OutputAudioRawFrame
        ):
            return
        if frame.metadata.get(_INTERRUPTION_AUDIO) is True:
            if not self._conductor.interruption_playout_may_continue():
                return
            self._conductor.interruption_playout_started()
        if frame.metadata.get(_INTERRUPTION_CAP_END) is True:
            await self.push_frame(InterruptionFrame(), FrameDirection.UPSTREAM)
            await self.push_frame(TTSStoppedFrame())


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
        elif isinstance(frame, TTSAudioRawFrame):
            self._conductor.persona_audio(
                frame, recorded_until=self._recorder.bot_position
            )
        elif isinstance(frame, TTSStoppedFrame):
            await self._conductor.persona_stopped()
        elif isinstance(frame, InterruptionFrame):
            self._conductor.persona_interrupted(
                heard_through=self._recorder.bot_position
            )
        elif isinstance(frame, RemoteParticipantLeftFrame):
            frame.completed.set()
            self._conductor.media_advanced()
        await self.push_frame(frame, direction)


class _UsageLedger(FrameProcessor):
    """Every provider request this pipeline made, in one place.

    **One collector rather than a callback per leg**, because the legs do not
    agree about who counts. Cartesia and Deepgram return no usage at all and
    Pipecat counts what Egma sent them; OpenAI's realtime transcription and the
    persona's chat completions return their own figures and those are what is
    billed. A metrics frame is a system frame, so every one of them flows past
    here whichever service raised it, and this is the only place that has to
    know which leg speaks to whom.

    It reports and never stores: the record is authored as a span by whoever
    built this conductor, so a bill reaches the platform on the same ordered,
    replayable path a transcript does.
    """

    def __init__(
        self,
        *,
        speech: SpeechProviders,
        report: Callable[[ProviderUsage], Awaitable[None]],
    ) -> None:
        super().__init__()
        self._speech = speech
        self._report = report

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, MetricsFrame):
            for datum in frame.data:
                usage = self._usage_of(datum)
                if usage is not None:
                    await self._report(usage)
        await self.push_frame(frame, direction)

    def _usage_of(self, datum: object) -> ProviderUsage | None:
        if isinstance(datum, ProviderUsageMetricsData):
            # Already whole: a leg that holds the provider's own numbers built
            # this and there is nothing here to add to it.
            return datum.usage
        if isinstance(datum, STTUsageMetricsData):
            provider = self._speech.stt_provider
            model = self._speech.stt_model
            if provider is None or model is None:
                return None
            return audio_seconds_usage(
                datum.value.audio_seconds,
                provider=provider,
                model=model,
                operation=self._speech.stt,
            )
        if isinstance(datum, TTSUsageMetricsData):
            provider = self._speech.tts_provider
            model = self._speech.tts_model
            if provider is None or model is None:
                return None
            return characters_usage(
                datum.value,
                provider=provider,
                model=model,
                operation=self._speech.tts,
            )
        # Every other metric — time to first byte, processing time — is a
        # timing fact and not a bill. The measure catalog owns those.
        return None


@dataclass
class _Record:
    history: list[Turn] = field(default_factory=list)
    turns: int = 0
    persona_last_stopped_at: MediaPosition | None = None
    quiet_since: MediaPosition = Fraction(0)
    first_answer_measured: bool = False
    silence_follow_ups: int = 0
    persona_response_pending: bool = False


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
        self._speech = speech
        self._legs = build_legs(speech, voice=voice)
        self._vad = build_vad(speech)

        self._persona: Persona | None = None
        self._max_turns = 0
        self._controls = ConversationControls()
        self._on_utterance: OnUtterance | None = None
        self._on_measured: OnMeasured | None = None
        self._on_partial_utterance: OnPartialUtterance | None = None
        self._on_interruption: OnInterruption | None = None
        self._on_answered: OnAnswered | None = None
        self._on_provider_usage: OnProviderUsage | None = None

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
        self._pending_silence_follow_up = 0
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
        self._ignored_pipeline_faults = 0
        self._interruption_model_fault_observed = False
        self._control_tasks: set[asyncio.Task[None]] = set()
        self._discard_deliberate_audio = False
        self._random = random.Random()
        self._agent_speech_began: MediaPosition | None = None
        self._agent_speech_ended: MediaPosition | None = None
        self._interruption_due_at: MediaPosition | None = None
        self._interruption_attempted = False
        self._interruption_state = "listening"
        self._interruption_idle = asyncio.Event()
        self._interruption_idle.set()
        self._segment_waiting_for_interruption_owner = False
        self._last_interruption_end: MediaPosition | None = None
        self._deliberate_capped = False

        self.audio: AudioFacts | None = None
        self.evidence_error: str | None = None

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

    @property
    def position(self) -> MediaPosition:
        return self._position

    @property
    def deliberate_response_owned(self) -> bool:
        return self._interruption_state in {
            "preparing",
            "ready",
            "awaiting_playout",
            "delivering",
        }

    @property
    def deliberate_delivering(self) -> bool:
        return self._interruption_state == "delivering"

    @property
    def deliberate_audio_queued(self) -> bool:
        return self._interruption_state == "awaiting_playout"

    @property
    def deliberate_audio_capped(self) -> bool:
        return self._deliberate_capped

    @property
    def discarding_deliberate_audio(self) -> bool:
        return self._discard_deliberate_audio

    @property
    def may_start_interruption(self) -> bool:
        ear = self._ear
        return (
            not self.is_ending
            and ear is not None
            and ear.hearing_speech
            and self._interruption_state in {"preparing", "ready"}
        )

    @property
    def interruption_due(self) -> bool:
        return (
            self._interruption_due_at is not None
            and self._position >= self._interruption_due_at
            and self._interruption_state == "scheduled"
        )

    def agent_speech_started(self) -> None:
        self._agent_speech_began = self._position
        self._agent_speech_ended = None
        self._interruption_attempted = False
        if self.deliberate_response_owned:
            self._segment_waiting_for_interruption_owner = True
            return
        self._arm_interruption_for_active_segment()

    def _arm_interruption_for_active_segment(self) -> None:
        self._segment_waiting_for_interruption_owner = False
        if self.is_ending or self._agent_speech_ended is not None:
            self._interruption_due_at = None
            return
        level = self._parameters.interruption_level
        policy = {"occasional": ((6.0, 10.0), 30.0), "frequent": ((2.0, 4.0), 12.0)}
        selected = policy.get(level)
        if selected is None:
            self._interruption_due_at = None
            return
        delay_range, cooldown = selected
        delay = self._random.uniform(*delay_range)
        due_at = self._agent_speech_began + _seconds(delay)
        if self._last_interruption_end is not None:
            due_at = max(due_at, self._last_interruption_end + _seconds(cooldown))
        self._interruption_due_at = due_at
        self._interruption_state = "scheduled"
        self._report_interruption(
            InterruptionEvidence(
                event="scheduled",
                at_unix_nano=self._at(self._position),
                scheduled_for_unix_nano=self._at(self._interruption_due_at),
            )
        )
        log_event(
            logger,
            logging.INFO,
            "egma.persona.interruption_scheduled",
            "a deliberate interruption was scheduled",
            attributes={"egma.interruption.delay_seconds": delay},
        )

    def agent_speech_stopped(self) -> None:
        self._agent_speech_ended = self._position
        self._segment_waiting_for_interruption_owner = False
        self._interruption_due_at = None
        if self._interruption_state in {
            "scheduled",
            "preparing",
            "ready",
            "awaiting_playout",
        }:
            self.interruption_canceled("agent_stopped_before_playout")

    def interruption_preparing(self) -> None:
        if self._interruption_state != "scheduled":
            return
        self._interruption_attempted = True
        self._interruption_due_at = None
        self._interruption_state = "preparing"
        self._interruption_idle.clear()

    async def wait_until_interruption_idle(self) -> None:
        await self._interruption_idle.wait()

    def interruption_audio_queued(self) -> None:
        self._interruption_state = "awaiting_playout"
        self._deliberate_capped = False

    def interruption_playout_started(self) -> None:
        if self._interruption_state == "awaiting_playout":
            self._interruption_state = "delivering"

    def interruption_playout_may_continue(self) -> bool:
        media = self._media
        if self._controls.cause is not None:
            self.interruption_canceled("simulation_stopped", force=True)
            return False
        if media is not None and media.failed.is_set():
            self.interruption_canceled("transport_failed", force=True)
            return False
        if self._agent_departed or (media is not None and media.ended.is_set()):
            self.interruption_canceled("agent_disconnected", force=True)
            return False
        return True

    def deliberate_audio_discarded(self) -> None:
        self._discard_deliberate_audio = False

    def interruption_audio_capped(self) -> None:
        self._deliberate_capped = True

    def interruption_canceled(self, reason: str, *, force: bool = False) -> None:
        cancelable = {"scheduled", "preparing", "ready", "awaiting_playout"}
        if force:
            cancelable.add("delivering")
        if self._interruption_state not in cancelable:
            return
        was_delivering = self._interruption_state == "delivering"
        was_awaiting_playout = self._interruption_state == "awaiting_playout"
        began = self._persona_began if was_delivering else None
        ended = self._persona_ended if was_delivering else None
        self._interruption_state = "listening"
        self._interruption_idle.set()
        self._interruption_due_at = None
        generated_text = self._pending_persona_text
        self._pending_persona_text = None
        if was_delivering or was_awaiting_playout:
            self._discard_deliberate_audio = True
        if force and self._worker is not None:
            flush = asyncio.create_task(self._worker.queue_frame(InterruptionFrame()))
            self._control_tasks.add(flush)
            flush.add_done_callback(self._control_tasks.discard)
        self._report_interruption(
            InterruptionEvidence(
                event="canceled",
                at_unix_nano=self._at(self._position),
                began_unix_nano=None if began is None else self._at(began),
                ended_unix_nano=None if ended is None else self._at(ended),
                reason=reason,
                generated_text=generated_text,
            )
        )
        log_event(
            logger,
            logging.INFO,
            "egma.persona.interruption_canceled",
            "a deliberate interruption was canceled",
            attributes={"egma.interruption.cancel_reason": reason},
        )
        self.media_advanced()
        if self._segment_waiting_for_interruption_owner:
            self._arm_interruption_for_active_segment()

    def _report_interruption(self, evidence: InterruptionEvidence) -> None:
        if self._on_interruption is not None:
            self._on_interruption(evidence)

    def interruption_generation_drained(self) -> None:
        """The reply gate's idle signal resumes any deferred normal turn."""
        self.media_advanced()

    def interruption_provider_failed(self, reason: str) -> None:
        if self._interruption_model_fault_observed:
            self._interruption_model_fault_observed = False
        else:
            self._ignored_pipeline_faults += 1
        self.interruption_canceled(reason)

    async def conduct(
        self,
        *,
        persona: Persona,
        max_turns: int,
        max_duration_seconds: float,
        controls: ConversationControls,
        name: str,
        on_utterance: OnUtterance,
        on_measured: OnMeasured,
        on_partial_utterance: OnPartialUtterance | None = None,
        on_interruption: OnInterruption | None = None,
        on_answered: OnAnswered | None = None,
        on_provider_usage: OnProviderUsage | None = None,
        on_execution_ended: OnExecutionEnded | None = None,
    ) -> Conducted:
        self._persona = persona
        self._max_turns = max_turns
        self._controls = controls
        self._on_utterance = on_utterance
        self._on_measured = on_measured
        self._on_partial_utterance = on_partial_utterance
        self._on_interruption = on_interruption
        self._on_answered = on_answered
        self._on_provider_usage = on_provider_usage
        self._random.seed(name)

        watchdog = asyncio.create_task(
            _duration_watchdog(max_duration_seconds, controls),
            name=f"{name}:watchdog",
        )
        startup_finished = False
        conducted: Conducted | None = None
        execution_fault: BaseException | None = None
        try:
            try:
                await self._open(name)
                startup_finished = True
                await self._run()
            except _Stopped:
                pass
            conducted = self._result(startup_finished, max_duration_seconds, max_turns)
        except BaseException as fault:
            execution_fault = fault
            raise
        finally:
            # The loop has finished the exchange, including queued speech.
            # Recording upload and connection teardown are not call duration.
            if on_execution_ended is not None:
                on_execution_ended()
            watchdog.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watchdog
            try:
                await self.close()
            except Exception as cleanup_fault:
                log_event(
                    logger,
                    logging.ERROR,
                    "egma.simulation.cleanup_failed",
                    "voice resources cleanup failed",
                    attributes={
                        "egma.cleanup_operation": "voice_resources_close",
                        "error.type": type(cleanup_fault).__name__,
                    },
                    exc_info=True,
                )
                if conducted is None and execution_fault is None:
                    raise

        assert conducted is not None
        return conducted

    def _result(
        self, startup_finished: bool, max_duration_seconds: float, max_turns: int
    ) -> Conducted:
        controls = self._controls
        if controls.cause == CANCEL_DIRECTIVE:
            return Conducted(
                status="canceled",
                ending="canceled",
                reason=None,
                provider_reference=self.provider_reference,
            )
        if controls.cause is not None and not startup_finished:
            explain = getattr(self._connection, "startup_duration_failure", None)
            if callable(explain):
                raise PlugError(explain(max_duration_seconds))
        if controls.cause is not None:
            return self._ended(duration_limit_reached(max_duration_seconds))
        return self._ended(self._ending or turn_limit_reached(max_turns))

    async def _provider_spent(self, usage: ProviderUsage) -> None:
        """One provider request this conversation made, handed upward."""
        if self._on_provider_usage is not None:
            await self._on_provider_usage(usage)

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
        interruptions = _InterruptionScheduler(
            persona=self._persona, conductor=self, replies=replies
        )
        interruption_limit = _InterruptionAudioLimit(self)
        interruption_playout = _InterruptionPlayout(self)
        media = self._media
        recorder = _EvidenceRecorder(
            num_channels=2,
            auto_start_recording=True,
            real_time=media.real_time,
        )
        timeline = _Timeline(self, media, recorder)
        ledger = _UsageLedger(speech=self._speech, report=self._provider_spent)

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
                interruptions,
                brain,
                model,
                replies,
                self._legs.tts,
                interruption_limit,
                SpeechGain(self._legs.voice.speech_volume),
                *media.output,
                interruption_playout,
                recorder,
                timeline,
                ledger,
            ]
        )
        worker = PipelineWorker(
            pipeline,
            # **The usage half of Pipecat's metrics, switched on.** Without it
            # every service's usage report is a no-op, and the characters a
            # speaking leg was handed and the seconds a listening leg was sent
            # are counted by nobody — so a voice simulation would show the
            # persona's own token cost and nothing else. `enable_metrics` is
            # its gate: the usage flag alone does nothing.
            params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
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
            if self._agent_departed:
                return
            exception = getattr(error, "exception", None)
            processor = getattr(error, "processor", None)
            if self._ignored_pipeline_faults:
                self._ignored_pipeline_faults -= 1
                return
            if self.deliberate_response_owned:
                if processor is model:
                    self._interruption_model_fault_observed = True
                self.interruption_canceled(
                    "speech_provider_failed",
                    force=self.deliberate_delivering,
                )
                return
            if isinstance(exception, ProviderKeyUnavailable):
                self._brain_fault = exception
            elif authentication_rejected(exception):
                for leg, provider, customer_funded in (
                    (
                        self._legs.stt,
                        self._speech.stt_provider,
                        self._speech.stt_customer_funded,
                    ),
                    (
                        self._legs.tts,
                        self._speech.tts_provider,
                        self._speech.tts_customer_funded,
                    ),
                ):
                    if processor is leg and customer_funded and provider is not None:
                        self._brain_fault = ProviderKeyUnavailable(provider)
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
        self.interruption_canceled("simulation_closed")
        cleanup_fault: Exception | None = None
        try:
            await self._end_pipeline()
        finally:
            try:
                await self._connection.close()
            except Exception:
                logger.exception("closing the voice connection failed")
            try:
                await self._legs.aclose()
            except Exception as fault:
                cleanup_fault = fault
            await self._write_recording()
        if cleanup_fault is not None:
            raise cleanup_fault

    async def _end_pipeline(self) -> None:
        if self._running is None or self._worker is None:
            return
        try:
            if self._control_tasks:
                await asyncio.gather(*self._control_tasks, return_exceptions=True)
                self._control_tasks.clear()
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
            self.evidence_error = "evidence_collection_error"
            log_event(
                logger,
                logging.ERROR,
                "egma.simulation.recording_failed",
                "simulation recording upload failed",
                attributes={"error.type": type(failure).__name__},
                exc_info=True,
            )
            return
        self.audio = AudioFacts(
            recording=reference,
            started_unix_nano=self._recording_began_unix_nano,
        )

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

        if self._record.persona_last_stopped_at is None and not any(
            turn.speaker == "human" for turn in self._record.history
        ):
            if self._position >= _seconds(self._parameters.agent_opening_seconds):
                await self._ask_the_persona(heard_a_turn=False)
            return
        if self._record.persona_last_stopped_at is None:
            return
        if self._position - self._record.quiet_since >= _seconds(
            self._parameters.agent_quiet_seconds
        ):
            if self._record.silence_follow_ups >= SILENCE_FOLLOW_UP_LIMIT:
                self._ending = PERSONA_ENDED_SILENCE
            else:
                await self._ask_the_persona(heard_a_turn=False)

    async def _ask_the_persona(self, *, heard_a_turn: bool) -> None:
        if self._worker is None:
            raise PipelineGone("the persona was asked before the pipeline started")
        self._owes_a_turn = True
        follow_up = (
            self._record.silence_follow_ups + 1
            if not heard_a_turn and self._record.persona_last_stopped_at is not None
            else 0
        )
        await self._worker.queue_frame(
            _AgentFinished(
                heard_a_turn=heard_a_turn,
                silence_follow_up=follow_up,
                silence_wait_seconds=self._parameters.agent_quiet_seconds,
            )
        )

    async def the_agent_finished(
        self, said: str, heard_a_turn: bool
    ) -> MediaPosition | None:
        ear = self._ear
        if ear is None:
            return None
        stopped_at: MediaPosition | None = None
        received_words = False
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
                if answering:
                    if not self._record.first_answer_measured:
                        self._record.first_answer_measured = True
                        await self._measure("first_response_latency", quiet_from, began)
                    await self._measure("turn_response_latency", quiet_from, began)
            await self._took_a_turn("agent", said, began, ended)
            await self._measure("agent_speech_duration", began, ended)
            received_words = bool(said.strip())
            if received_words:
                self._record.silence_follow_ups = 0
                self._record.persona_response_pending = True
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
        if (
            heard_a_turn
            and not received_words
            and (stopped_at is None or not self._record.persona_response_pending)
        ):
            # A wordless or already-consumed boundary is not a new response.
            # Keep waiting from the last persona turn without asking the model
            # to answer an empty message or resetting its follow-up allowance.
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

    def persona_will_speak(
        self,
        text: str,
        *,
        concludes: bool = False,
        silence_follow_up: int = 0,
        deliberate: bool = False,
    ) -> None:
        self._pending_persona_text = text
        self._pending_persona_concludes = concludes
        self._pending_silence_follow_up = silence_follow_up
        self._persona_began = None
        self._persona_ended = None
        if deliberate:
            self._interruption_state = "ready"

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
            # Count an audible follow-up even if the agent interrupts it.
            # A model request canceled before audio uses no allowance.
            if self._pending_silence_follow_up:
                self._record.silence_follow_ups += 1
                self._pending_silence_follow_up = 0
        self._persona_ended = recorded_until
        self.media_advanced()

    def persona_interrupted(self, *, heard_through: MediaPosition) -> None:
        """Start waiting from the last audio heard before an interruption.

        The transport throws away what it had queued and not yet played,
        so the persona stopped where the recording stops holding it — not
        where the speech leg had already run to.
        """
        ended = self._persona_ended
        began = self._persona_began
        if ended is not None:
            ended = min(ended, heard_through)
            if began is not None and ended < began:
                ended = began
            self._record.persona_last_stopped_at = ended
            self._record.quiet_since = max(self._record.quiet_since, ended)
        self._pending_persona_text = None
        self._pending_persona_concludes = False
        self._pending_silence_follow_up = 0
        self._persona_began = None
        self._persona_ended = None
        self._owes_a_turn = False
        self.media_advanced()

    def persona_will_not_finish(self) -> None:
        """Forget transcript state before TTS completes an interrupted context."""
        self._pending_persona_text = None
        self._pending_persona_concludes = False
        self._pending_silence_follow_up = 0

    async def persona_stopped(self) -> None:
        text, self._pending_persona_text = self._pending_persona_text, None
        self._pending_silence_follow_up = 0
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
        deliberate = self.deliberate_response_owned
        if deliberate and self._deliberate_capped:
            await self._took_partial_persona_turn(began, ended)
        else:
            await self._took_a_turn(
                "human", text, began, ended, apply_turn_limit=not concludes
            )
        if deliberate:
            overlap_end = min(ended, self._agent_speech_ended or ended)
            capped = self._deliberate_capped
            self._report_interruption(
                InterruptionEvidence(
                    event="delivered",
                    at_unix_nano=self._at(ended),
                    began_unix_nano=self._at(began),
                    ended_unix_nano=self._at(ended),
                    overlap_ended_unix_nano=self._at(overlap_end),
                    generated_text=text if capped else None,
                    delivered_text=None if capped else text,
                )
            )
            self._last_interruption_end = ended
            self._interruption_state = "listening"
            self._interruption_idle.set()
            self._deliberate_capped = False
            log_event(
                logger,
                logging.INFO,
                "egma.persona.interruption_delivered",
                "a deliberate interruption reached playout",
                attributes={
                    "egma.recording.start_ns": self._at(began),
                    "egma.recording.end_ns": self._at(ended),
                    "egma.interruption.overlap_end_ns": self._at(overlap_end),
                },
            )
            if self._segment_waiting_for_interruption_owner:
                self._arm_interruption_for_active_segment()
        self._record.persona_last_stopped_at = ended
        self._record.persona_response_pending = False
        self._record.quiet_since = max(self._record.quiet_since, ended)
        if concludes and not self.is_ending:
            self._ending = PERSONA_CONCLUDED
        self._owes_a_turn = False
        self.media_advanced()

    def persona_concluded_without_speech(self) -> None:
        """End on a valid end action that requested no speech."""
        if not self.is_ending:
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
            await self._on_utterance(speaker, text, self._at(began), self._at(ended))
        if (
            apply_turn_limit
            and self._record.turns >= self._max_turns
            and self._ending is None
        ):
            self._ending = turn_limit_reached(self._max_turns)
            self.media_advanced()

    async def _took_partial_persona_turn(
        self, began: MediaPosition, ended: MediaPosition
    ) -> None:
        """Record audible speech without guessing which generated words played."""
        self._record.history.append(Turn("human", ""))
        self._record.turns += 1
        if self._on_partial_utterance is not None:
            await self._on_partial_utterance("human", self._at(began), self._at(ended))
        elif self._on_utterance is not None:
            await self._on_utterance("human", "", self._at(began), self._at(ended))
        if self._record.turns >= self._max_turns and self._ending is None:
            self._ending = turn_limit_reached(self._max_turns)
            self.media_advanced()

    async def _measure(
        self, measure: str, began: MediaPosition, ended: MediaPosition
    ) -> None:
        if ended < began:
            raise ValueError(f"{measure} was measured over a backwards media interval")
        if self._on_measured is not None:
            await self._on_measured(measure, self._at(began), self._at(ended))

    def _at(self, position: MediaPosition) -> int:
        nanos = position.numerator * 1_000_000_000 // position.denominator
        return self._recording_began_unix_nano + nanos

    @property
    def _recording_began_unix_nano(self) -> int:
        """The instant the recording's own zero stands for.

        Positions are offsets into the recording, so a transcript span
        only seeks to the right words while this is the wall-clock time
        of the recording's first sample. Until the first audio is placed
        there is no recording yet, and the moment the line was opened is
        the closest honest answer.
        """
        recorder = self._recorder
        if recorder is not None and recorder.started_unix_nano:
            return recorder.started_unix_nano
        return self._opened_unix_nano

    def media_advanced(self) -> None:
        self._activity.set()

    def agent_is_departing(self) -> None:
        """Stop new persona work while the ordered departure marker drains."""
        self._agent_departed = True
        self.interruption_canceled("agent_disconnected", force=True)
        self._owes_a_turn = False
        self.media_advanced()

    async def agent_input_is_closing(self, source_end: MediaPosition) -> None:
        """Tell the recorder where the ordered final input frame ended."""
        if self._recorder is None:
            raise PipelineGone("agent input ended before the recorder started")
        await self._recorder.close_input_at(source_end)

    def the_brain_failed(self, fault: BaseException) -> None:
        if self._agent_departed:
            return
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
            self.interruption_canceled("simulation_stopped", force=True)
            raise _Stopped()

    def _transport_lost(self) -> PlugError:
        self.interruption_canceled("transport_failed", force=True)
        transport = (
            self._media.transport_name if self._media is not None else "voice transport"
        )
        return PlugError(f"the {transport} disconnected before the simulation ended")

    async def _agent_left(self) -> None:
        """Finish any active input turn before recording a normal departure."""
        self._agent_departed = True
        self.interruption_canceled("agent_disconnected", force=True)
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
    max_duration_seconds: float, controls: ConversationControls
) -> None:
    await asyncio.sleep(max_duration_seconds)
    controls.trip_duration_limit()


def _seconds(value: float) -> Fraction:
    return Fraction(round(value * 1_000_000_000), 1_000_000_000)


def _now() -> int:
    return time.time_ns()


def _monotonic() -> float:
    """The clock a real-time transport stamps its frames from."""
    return time.monotonic()
