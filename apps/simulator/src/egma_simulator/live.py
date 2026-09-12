"""GPT Live persona runtime behind Egma's existing voice connection seam."""

from __future__ import annotations

import asyncio
import contextlib
import sys
from fractions import Fraction
from typing import Any

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    LLMContextFrame,
    TTSStoppedFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.openai.live import events
from pipecat.services.openai.live.llm import OpenAILiveLLMService
from pipecat.workers.llm.backend_llm_worker import BackendLLMWorker
from pipecat.workers.runner import WorkerRunner

from .blob import BlobStore
from .conductor import (
    _INPUT_SOURCE_RANGE,
    AGENT_ENDED,
    CANCEL_DIRECTIVE,
    PERSONA_CONCLUDED,
    Conducted,
    _EvidenceRecorder,
    _PersonaLLMService,
    duration_limit_reached,
    turn_limit_reached,
)
from .conversation import ConversationControls
from .media import VoiceMedia
from .model import ModelClient
from .persona import OPENING_NUDGE, Persona
from .plugs import PlugError, VoiceConnection
from .recording import AudioFacts, dual_channel_wav
from .spec import LiveSelection
from .speech import SpeechGain
from .usage import ProviderUsage, live_duration_usage


async def _ignore_usage(_usage: ProviderUsage) -> None:
    return None


class _ConcludingBackendService(_PersonaLLMService):
    def __init__(
        self,
        *,
        persona: Persona,
        end_requested: asyncio.Event,
        usage,
        conclusion_started,
    ) -> None:
        super().__init__(persona=persona)
        self._end_requested = end_requested
        self._observe_usage = usage
        self._conclusion_started = conclusion_started

    async def _process_context(self, context: LLMContext) -> None:
        await super()._process_context(context)
        reply = self._reply
        if reply is not None and reply.usage is not None:
            await self._observe_usage(reply.usage)

    async def _end_call_succeeded(self) -> None:
        await self._conclusion_started()
        self._end_requested.set()


class _ObservedLiveService(OpenAILiveLLMService):
    def __init__(
        self,
        *,
        transcript,
        turn_finished,
        usage,
        session_started,
        end_requested,
        backend_final_sent,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._observe_transcript = transcript
        self._observe_turn_finished = turn_finished
        self._observe_usage = usage
        self._observe_session_started = session_started
        self._end_requested = end_requested
        self._backend_final_sent = backend_final_sent
        self.session_id: str | None = None

    async def _run_client_delegation(self, delegation):
        await super()._run_client_delegation(delegation)
        if self._end_requested.is_set():
            self._backend_final_sent()

    async def conclusion_playout_target(self, evidence: _LiveEvidence) -> int:
        async with self._assistant_turn.lock:
            return evidence.assistant_turns_finished + int(self._assistant_turn.open)

    async def _handle_evt_session_started(self, evt: events.SessionStartedEvent):
        self.session_id = evt.session.id
        self._observe_session_started()
        await super()._handle_evt_session_started(evt)

    async def _handle_evt_transcript_delta(self, evt: events.TranscriptDeltaEvent):
        await self._observe_transcript(evt)
        await super()._handle_evt_transcript_delta(evt)

    async def _end_turn(self, role: str):
        turn = self._user_turn if role == "user" else self._assistant_turn
        was_open = turn.open
        await super()._end_turn(role)
        if was_open:
            await self._observe_turn_finished(role)

    async def _report_usage(self, usage: events.Usage):
        await self._observe_usage(usage)

    async def _handle_evt_session_closed(self, evt: events.SessionClosedEvent):
        # The close handler runs while EndFrame is crossing the service. Pushing a
        # metrics frame from that handler can wait behind EndFrame and prevent the
        # close acknowledgement from being recorded. Egma emits the cumulative
        # session usage after shutdown, so record it here and let the base handler
        # complete without another metrics frame.
        if evt.usage is not None:
            await self._observe_usage(evt.usage)
        await super()._handle_evt_session_closed(evt.model_copy(update={"usage": None}))


class _LiveEvidence(FrameProcessor):
    """Add source positions and expose transport/lifecycle events."""

    def __init__(self, *, agent_left: asyncio.Event, assistant_finished):
        super().__init__()
        self.position = Fraction(0)
        self.agent_left = agent_left
        self._assistant_finished = assistant_finished
        self.assistant_turns_finished = 0
        self.assistant_turn_finished = asyncio.Condition()

    async def wait_for_assistant_turn_after(self, count: int) -> None:
        async with self.assistant_turn_finished:
            await self.assistant_turn_finished.wait_for(
                lambda: self.assistant_turns_finished > count
            )

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        from .media import RemoteParticipantLeftFrame

        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            start = self.position
            self.position += Fraction(frame.num_frames, frame.sample_rate)
            frame.metadata[_INPUT_SOURCE_RANGE] = (start, self.position)
        elif isinstance(frame, RemoteParticipantLeftFrame):
            frame.completed.set()
            self.agent_left.set()
        elif isinstance(frame, TTSStoppedFrame):
            await self._assistant_finished("assistant")
            async with self.assistant_turn_finished:
                self.assistant_turns_finished += 1
                self.assistant_turn_finished.notify_all()
        await self.push_frame(frame, direction)


class _TranscriptLedger:
    def __init__(
        self,
        *,
        on_partial=None,
        on_utterance=None,
        on_measured=None,
        max_turns: int = 32,
    ) -> None:
        self.session_started_unix_nano = 0
        self.fragments: list[tuple[str, str, int, int]] = []
        self.max_turns = max_turns
        self.turns_finished = 0
        self.on_utterance = on_utterance
        self.on_measured = on_measured
        self.last_persona_ended: int | None = None
        self.first_response_measured = False
        self.pending: dict[str, list[tuple[str, int, int]]] = {
            "agent": [],
            "human": [],
        }
        self.limit_reached = asyncio.Event()
        self.flushed = False

    async def observe(self, evt: events.TranscriptDeltaEvent) -> None:
        if not evt.delta or evt.start_ms is None or evt.end_ms is None:
            return
        speaker = "agent" if evt.role == "user" else "human"
        if not self.session_started_unix_nano:
            return
        began = self.session_started_unix_nano + evt.start_ms * 1_000_000
        ended = self.session_started_unix_nano + evt.end_ms * 1_000_000
        self.fragments.append((speaker, evt.delta, began, ended))
        self.pending[speaker].append((evt.delta, began, ended))

    async def finish(self, role: str, on_utterance=None) -> None:
        speaker = "agent" if role == "user" else "human"
        fragments = self.pending[speaker]
        if not fragments:
            return
        self.pending[speaker] = []
        text = "".join(fragment[0] for fragment in fragments).strip()
        if text:
            began = min(fragment[1] for fragment in fragments)
            ended = max(fragment[2] for fragment in fragments)
            callback = on_utterance or self.on_utterance
            if callback is not None:
                await callback(
                    speaker,
                    text,
                    began,
                    ended,
                )
            if speaker == "human":
                self.last_persona_ended = ended
            elif self.on_measured is not None:
                if self.last_persona_ended is not None:
                    if began >= self.last_persona_ended:
                        if not self.first_response_measured:
                            await self.on_measured(
                                "first_response_latency", self.last_persona_ended, began
                            )
                        await self.on_measured(
                            "turn_response_latency", self.last_persona_ended, began
                        )
                    self.first_response_measured = True
                await self.on_measured("agent_speech_duration", began, ended)
            self.turns_finished += 1
            if self.turns_finished >= self.max_turns:
                self.limit_reached.set()

    async def flush(self, on_utterance) -> int:
        if self.flushed:
            return self.turns_finished
        self.flushed = True
        await self.finish("user", on_utterance)
        self.pending["human"] = []
        return self.turns_finished


class LiveConductor:
    """Conduct a continuous GPT Live session over any VoiceConnection."""

    def __init__(
        self,
        *,
        connection: VoiceConnection,
        selection: LiveSelection,
        backend_model: ModelClient,
        blobs: BlobStore,
        recording_key: str,
        speech_volume: float,
        _base_url: str = "wss://api.openai.com/v1/live/sessions",
    ) -> None:
        self._connection = connection
        self._selection = selection
        if selection.adapter != "openai_live" or selection.key is None:
            raise ValueError("the claimed GPT Live selection is not executable")
        self._backend_model = backend_model
        self._blobs = blobs
        self._recording_key = recording_key
        self._speech_volume = speech_volume
        self._base_url = _base_url
        self.audio: AudioFacts | None = None
        self.evidence_error: str | None = None

    @property
    def provider_reference(self) -> str | None:
        return self._connection.provider_reference

    async def conduct(
        self,
        *,
        persona: Persona,
        max_turns: int,
        max_duration_seconds: float,
        controls: ConversationControls,
        name: str,
        on_utterance,
        on_measured,
        on_partial_utterance=None,
        on_interruption=None,
        on_answered=None,
        on_provider_usage=None,
        on_execution_ended=None,
    ) -> Conducted:
        del on_interruption
        media: VoiceMedia | None = None
        worker: PipelineWorker | None = None
        backend: BackendLLMWorker | None = None
        running: asyncio.Task | None = None
        agent_track = bytearray()
        persona_track = bytearray()
        recording_rate = 0
        concluded = asyncio.Event()
        end_requested = asyncio.Event()
        conclusion_target: int | None = None
        agent_left = asyncio.Event()
        faulted = asyncio.Event()
        fault: BaseException | None = None
        latest_usage: events.Usage | None = None
        opened = 0
        ledger: _TranscriptLedger | None = None
        recorder: _EvidenceRecorder | None = None
        limit_during_goodbye = False
        callback_fault: BaseException | None = None
        owned_tasks: set[asyncio.Task] = set()

        async def observe_usage(usage: events.Usage) -> None:
            nonlocal latest_usage
            reported = usage.seconds or 0
            known = 0 if latest_usage is None else (latest_usage.seconds or 0)
            if latest_usage is None or reported >= known:
                latest_usage = usage

        try:
            media = await controls.guard(self._connection.prepare())

            def transport_lost() -> PlugError:
                return PlugError(
                    f"the {media.transport_name} disconnected before the "
                    "simulation ended"
                )

            async def wait_for_transport_failure() -> None:
                await media.failed.wait()
                raise transport_lost()

            opened = __import__("time").time_ns()
            ledger = _TranscriptLedger(
                on_partial=on_partial_utterance,
                on_utterance=on_utterance,
                on_measured=on_measured,
                max_turns=max_turns,
            )

            async def turn_finished(role: str) -> None:
                if role == "user":
                    await ledger.finish(role)
                    if on_answered is not None:
                        await on_answered()

            evidence = _LiveEvidence(
                agent_left=agent_left, assistant_finished=ledger.finish
            )
            live: _ObservedLiveService | None = None

            async def conclusion_started() -> None:
                nonlocal conclusion_target
                assert live is not None
                conclusion_target = await live.conclusion_playout_target(evidence)

            def backend_final_sent() -> None:
                concluded.set()

            backend_service = _ConcludingBackendService(
                persona=persona,
                end_requested=end_requested,
                usage=(
                    on_provider_usage
                    if on_provider_usage is not None
                    else _ignore_usage
                ),
                conclusion_started=conclusion_started,
            )
            backend = BackendLLMWorker(
                llm=backend_service,
                context=persona.context([]),
            )
            live = _ObservedLiveService(
                api_key=self._selection.key,
                base_url=self._base_url,
                settings=OpenAILiveLLMService.Settings(
                    model=self._selection.model,
                    voice=self._selection.voice_id,
                    system_instruction=persona.live_prompt(),
                ),
                delegation=OpenAILiveLLMService.ClientDelegation(backend=backend),
                transcript=ledger.observe,
                turn_finished=turn_finished,
                usage=observe_usage,
                session_started=lambda: setattr(
                    ledger, "session_started_unix_nano", __import__("time").time_ns()
                ),
                end_requested=end_requested,
                backend_final_sent=backend_final_sent,
            )
            recorder = _EvidenceRecorder(
                num_channels=2, auto_start_recording=True, real_time=media.real_time
            )

            @recorder.event_handler("on_track_audio_data")
            async def recorded(_p, agent_audio, caller_audio, sample_rate, _channels):
                nonlocal recording_rate
                agent_track.extend(agent_audio)
                persona_track.extend(caller_audio)
                recording_rate = sample_rate

            pipeline = Pipeline(
                [
                    *media.input,
                    live,
                    SpeechGain(self._speech_volume),
                    *media.output,
                    evidence,
                    recorder,
                ]
            )
            worker = PipelineWorker(
                pipeline,
                params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
                idle_timeout_secs=None,
                enable_tracing=True,
                enable_turn_tracking=False,
                enable_rtvi=False,
            )

            @worker.event_handler("on_pipeline_error")
            async def pipeline_error(_worker, frame):
                nonlocal fault
                fault = getattr(frame, "exception", None) or RuntimeError(str(frame))
                faulted.set()

            runner = WorkerRunner(handle_sigint=False)
            await runner.add_workers(worker)
            running = asyncio.create_task(runner.run(), name=f"live-pipeline:{name}")
            owned_tasks.add(running)
            await controls.guard(
                self._connection.open(), agent_failed=wait_for_transport_failure()
            )
            await worker.queue_frame(
                LLMContextFrame(
                    LLMContext(
                        messages=[
                            {
                                "role": "system",
                                "content": persona.live_prompt(),
                            },
                            {"role": "developer", "content": OPENING_NUDGE},
                        ]
                    )
                )
            )

            duration = asyncio.create_task(asyncio.sleep(max_duration_seconds))
            stopped = asyncio.create_task(controls.guard(asyncio.Event().wait()))
            departure = asyncio.create_task(media.ended.wait())
            pipeline_failed = asyncio.create_task(faulted.wait())
            media_failed = asyncio.create_task(media.failed.wait())
            done_call = asyncio.create_task(concluded.wait())
            turn_limit = asyncio.create_task(ledger.limit_reached.wait())
            watchers = {
                duration,
                stopped,
                departure,
                pipeline_failed,
                media_failed,
                done_call,
                turn_limit,
            }
            owned_tasks.update(watchers)
            done, pending = await asyncio.wait(
                {*watchers, running},
                return_when=asyncio.FIRST_COMPLETED,
            )
            triggered = set(done)
            if running in done:
                error = running.exception()
                if error is not None:
                    raise error
                agent_left.set()
            if pipeline_failed in done:
                assert fault is not None
                raise fault
            if media_failed in done:
                raise transport_lost()
            if duration in done:
                controls.trip_duration_limit()
            if done_call in done:
                assert conclusion_target is not None
                goodbye = asyncio.create_task(
                    evidence.wait_for_assistant_turn_after(conclusion_target)
                )
                owned_tasks.add(goodbye)
                goodbye_watchers = watchers - {done_call}
                goodbye_done, _ = await asyncio.wait(
                    {goodbye, *goodbye_watchers, running},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                triggered.update(goodbye_done)
                if running in goodbye_done:
                    error = running.exception()
                    if error is not None:
                        raise error
                    agent_left.set()
                if pipeline_failed in goodbye_done:
                    assert fault is not None
                    raise fault
                if media_failed in goodbye_done:
                    raise transport_lost()
                if duration in goodbye_done:
                    controls.trip_duration_limit()
                if goodbye in goodbye_done:
                    await ledger.finish("assistant")
                limit_during_goodbye = ledger.limit_reached.is_set()
                if media.ended.is_set():
                    triggered.add(departure)
                if goodbye not in goodbye_done:
                    goodbye.cancel()
                    await asyncio.gather(goodbye, return_exceptions=True)
            if controls.cause == CANCEL_DIRECTIVE:
                result = Conducted(
                    "canceled", "canceled", None, self.provider_reference
                )
            elif controls.cause is not None:
                ending, reason = duration_limit_reached(max_duration_seconds)
                result = Conducted("completed", ending, reason, self.provider_reference)
            elif departure in triggered or running in triggered:
                ending, reason = AGENT_ENDED
                result = Conducted("completed", ending, reason, self.provider_reference)
            elif concluded.is_set() and not limit_during_goodbye:
                ending, reason = PERSONA_CONCLUDED
                result = Conducted("completed", ending, reason, self.provider_reference)
            elif ledger.limit_reached.is_set():
                ending, reason = turn_limit_reached(max_turns)
                result = Conducted("completed", ending, reason, self.provider_reference)
            else:
                ending, reason = AGENT_ENDED
                result = Conducted("completed", ending, reason, self.provider_reference)
            return result
        except Exception as error:
            if isinstance(error, PlugError):
                raise
            raise
        finally:
            active_error = sys.exception()
            for task in owned_tasks:
                if task is not running and not task.done():
                    task.cancel()
            await asyncio.gather(
                *(task for task in owned_tasks if task is not running),
                return_exceptions=True,
            )
            if on_execution_ended is not None:
                try:
                    on_execution_ended()
                except BaseException as error:
                    callback_fault = error
            if worker is not None:
                with contextlib.suppress(Exception):
                    await worker.queue_frame(
                        CancelFrame()
                        if controls.cause == CANCEL_DIRECTIVE or fault is not None
                        else EndFrame()
                    )
            if backend is not None:
                with contextlib.suppress(Exception):
                    await backend.queue_frame(
                        CancelFrame()
                        if controls.cause == CANCEL_DIRECTIVE or fault is not None
                        else EndFrame()
                    )
            if running is not None:
                try:
                    await asyncio.wait_for(asyncio.shield(running), timeout=10.0)
                except TimeoutError:
                    pass
                except BaseException as error:
                    if callback_fault is None:
                        callback_fault = error
                if not running.done():
                    running.cancel()
                    await asyncio.gather(running, return_exceptions=True)
            with contextlib.suppress(Exception):
                await self._connection.close()
            if latest_usage is not None and on_provider_usage is not None:
                measured = live_duration_usage(
                    latest_usage,
                    selection_model=self._selection.model,
                    session_id=getattr(locals().get("live"), "session_id", None),
                )
                if measured is not None:
                    try:
                        await on_provider_usage(measured)
                    except BaseException as error:
                        if callback_fault is None:
                            callback_fault = error
            if ledger is not None:
                try:
                    await ledger.flush(on_utterance)
                except BaseException as error:
                    if callback_fault is None:
                        callback_fault = error
            if recording_rate and (agent_track or persona_track):
                try:
                    reference = await self._blobs.write(
                        self._recording_key,
                        dual_channel_wav(
                            bytes(persona_track), bytes(agent_track), recording_rate
                        ),
                    )
                    started = recorder.started_unix_nano if recorder else opened
                    self.audio = AudioFacts(reference, started)
                except Exception:
                    self.evidence_error = "evidence_collection_error"
            if callback_fault is not None and active_error is None:
                raise callback_fault
