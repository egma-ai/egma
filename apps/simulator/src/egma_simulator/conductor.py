"""The single Pipecat pipeline that conducts and records a voice simulation."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Any

from pipecat.audio.vad.vad_analyzer import VADAnalyzer
from pipecat.frames.frames import (
    ControlFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
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
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.turns.user_start import VADUserTurnStartStrategy
from pipecat.turns.user_turn_processor import UserTurnProcessor
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner

from .blob import BlobStore
from .media import VoiceMedia
from .persona import Persona, Turn
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


class _AgentEar(VADProcessor):
    """Track input-media positions while Pipecat detects speech."""

    def __init__(self, *, vad_analyzer: VADAnalyzer, conductor: VoiceConductor) -> None:
        super().__init__(vad_analyzer=vad_analyzer, audio_idle_timeout=0.0)
        self._conductor = conductor
        self.position = Fraction(0)
        self.speaking_since: MediaPosition | None = None
        self.utterances: list[tuple[MediaPosition, MediaPosition]] = []

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
            self.utterances.append((began, ended))
            self.speaking_since = None
        await super().broadcast_frame(frame_cls, **kwargs)

    @property
    def hearing_speech(self) -> bool:
        return self.speaking_since is not None

    async def finalize_active_utterance(self) -> None:
        """Close speech at the last media position when its participant leaves."""
        if self.speaking_since is not None:
            await self.broadcast_frame(VADUserStoppedSpeakingFrame, stop_secs=0.0)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if isinstance(frame, InputAudioRawFrame):
            self.position += Fraction(frame.num_frames, frame.sample_rate)
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


class _EvidenceRecorder(AudioBufferProcessor):
    """Expose Pipecat's canonical recording cursor to the transcript."""

    @property
    def bot_position(self) -> MediaPosition:
        if not self.sample_rate:
            return Fraction(0)
        # Pipecat 1.7.0 has no public current-output cursor. This one access is
        # pinned in uv.lock and covered by the frame-level alignment test.
        return Fraction(len(self._bot_audio_buffer) // 2, self.sample_rate)


class _PersonaBrain(FrameProcessor):
    """Run the shared persona brain without stopping input system frames."""

    def __init__(self, *, persona: Persona, conductor: VoiceConductor) -> None:
        super().__init__()
        self._persona = persona
        self._conductor = conductor
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
            reply = await self._persona.next_turn(self._conductor.history)
            if reply.concluded:
                await self._conductor.persona_concluded(reply.text)
                return
            await self._conductor.wait_until(due)
            if self._conductor.is_ending:
                return
            self._conductor.persona_will_speak(reply.text)
            await self.push_frame(LLMFullResponseStartFrame())
            await self.push_frame(TextFrame(reply.text))
            await self.push_frame(LLMFullResponseEndFrame())
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
        return self._ending is not None or self._controls.cause is not None

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
        brain = _PersonaBrain(persona=self._persona, conductor=self)
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
        except Exception:
            logger.exception("the recording could not be written; reporting none")
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
            raise PlugError(
                f"the {media.transport_name} disconnected before the simulation ended"
            )
        ear = self._ear
        if ear is None:
            return
        if media is not None and media.ended.is_set() and not self._agent_departed:
            await self._agent_left()
        if self._agent_departed:
            if ear.hearing_speech or self._heard_so_far < len(ear.utterances):
                return
            self._ending = AGENT_ENDED
            return
        if self._owes_a_turn or ear.hearing_speech:
            return
        if self._heard_so_far < len(ear.utterances):
            return

        if self._record.persona_last_stopped_at is None and not ear.utterances:
            if ear.position >= _seconds(self._parameters.agent_opening_seconds):
                await self._ask_the_persona(heard_a_turn=False)
            return
        if self._record.persona_last_stopped_at is None:
            return
        if ear.position - self._record.quiet_since >= _seconds(
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
            began = ear.utterances[self._heard_so_far][0]
            ended = ear.utterances[-1][1]
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
        if self._agent_departed or (
            self._media is not None and self._media.ended.is_set()
        ):
            self._agent_departed = True
            self._ending = AGENT_ENDED
            self._owes_a_turn = False
            self.media_advanced()
            return None
        self._owes_a_turn = True
        if stopped_at is None:
            return ear.position
        return stopped_at + _seconds(self._parameters.persona_pause_seconds)

    async def wait_until(self, due: MediaPosition) -> None:
        while self._position < due and not self.is_ending:
            self._activity.clear()
            if self._position >= due or self.is_ending:
                return
            await self._activity.wait()

    def persona_will_speak(self, text: str) -> None:
        self._pending_persona_text = text
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
        if text is None:
            return
        began = self._persona_began or self._position
        ended = self._persona_ended or began
        self._persona_began = None
        self._persona_ended = None
        await self._measure("persona_speech_duration", began, ended)
        await self._took_a_turn("human", text, began, ended)
        self._record.persona_last_stopped_at = ended
        self._record.quiet_since = max(self._record.quiet_since, ended)
        self._owes_a_turn = False
        self.media_advanced()

    async def persona_concluded(self, text: str) -> None:
        at = self._position
        await self._took_a_turn("human", text, at, at, apply_turn_limit=False)
        if self._ending is None:
            self._ending = PERSONA_CONCLUDED
        self._owes_a_turn = False
        self.media_advanced()

    def _talked_over(self, began: MediaPosition) -> bool:
        if began < self._record.quiet_since:
            return True
        return self._persona_began is not None and self._persona_began < began

    @property
    def _position(self) -> MediaPosition:
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
            raise PlugError(
                f"the {self._media.transport_name} disconnected before the "
                "simulation ended"
            )
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
        try:
            done, _pending = await asyncio.wait(
                {taking, faulted, stopped, self._running},
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            for unfinished in (taking, faulted, stopped):
                if not unfinished.done():
                    unfinished.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await unfinished
        if taking in done:
            return taking.result()
        if faulted in done:
            self._raise_fault()
        if stopped in done:
            raise _Stopped()
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
