"""The voice conductor: one simulation, conducted by a Pipecat pipeline.

A voice simulation is not a turn loop. Both directions of the line are
open at once, nobody announces the end of a turn, and the persona is a
voice agent on its own side of the call: it hears the far end with a
voice activity detector, decides the far end has finished with a turn
model, thinks with the same persona brain chat uses, and speaks through
the same speech legs. All of that is one Pipecat pipeline, and this module
assembles it, drives it, supervises it, and writes down what happened.

Chat keeps the walk. The two conductors share the persona brain, the
endings vocabulary, the limits and the record — and nothing else, because
a conversation where both sides may speak at once has no loop in it.

## The line, and the one clock everything is read from

The line is driven one **slice** at a time: the persona's audio out, the
far end's audio in, the same number of samples both ways, quiet included.
The count of samples that have crossed the line is the conversation's
whole clock — its *audio timeline* — and every interval in the record is a
pair of positions on it.

That is the decision this module exists to make. A handler's wall-clock
time says when Python got around to noticing something; a sample position
says when it happened. Under lock-step the difference was invisible,
because turns could not cross. Under full duplex it decides whether two
turns overlap at all, so nothing here is ever stamped from a clock: the
detector's own speech boundaries are corrected back by the windows it
needed to be sure, the persona's utterance is bracketed by the slices its
samples went out on, and the two ends of every span are converted from
sample positions exactly once, by :class:`AudioClock`.

It also makes CI honest and free at the same time. Timing is *rendered
into the audio* — an answer delay is quiet on the line, not a sleep — so
a live call spends three real seconds waiting out a pause and CI spends
none, through the same code, and both measure the same number.

## Every wait is for a named frame

One slice is fed into the pipeline and then a mark is put behind it, and
the next slice is not taken until that mark has come out the far end. So
"the pipeline has finished with this slice" is a fact rather than a hope,
and everything the slice caused — a detector's verdict, a turn ending, the
persona answering — happened at a sample position this module knows.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from pipecat.frames.frames import (
    ControlFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    StartFrame,
    TextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.turns.user_start import VADUserTurnStartStrategy
from pipecat.turns.user_turn_processor import UserTurnProcessor
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner

from .blob import BlobStore
from .persona import Persona, Turn
from .plugs import DuplexLine
from .recording import AudioFacts, dual_channel_wav
from .speech import (
    SAMPLE_WIDTH_BYTES,
    SAMPLES_PER_BYTE,
    SCRIPTED_PAIR,
    PersonaVoice,
    SpeechFault,
    SpeechLegs,
    SpeechProviders,
    build_legs,
    build_vad,
)
from .walk import CANCEL_DIRECTIVE, Conducted, WalkControls

logger = logging.getLogger(__name__)

LINE_SLICE_SAMPLES = SAMPLES_PER_BYTE
"""How many samples one slice of the line carries, each way.

240 samples: 30 ms at 8 kHz, 15 ms at 16 kHz, 5 ms at 48 kHz. It is
deliberately the same slice the scripted codec spends on one encoded
byte, so a scripted utterance begins and ends on a slice boundary at
every band a connection can carry. Every interval read off the timeline
is then exact rather than nearly, which is what lets a test assert a
sample position instead of a tolerance.
"""


@dataclass(frozen=True)
class ConductParameters:
    """How the persona conducts itself, in named defaults.

    The same numbers for every persona, deliberately: traits reach
    conduction through the prompt and through nothing else today. This
    block is where trait-driven conduct lands when it arrives — patience,
    eagerness, how readily somebody talks over you — and it is additive,
    so filling it reworks nothing here.

    Everything below is spent on the audio timeline rather than on a
    clock, so a live call really waits and CI really does not.
    """

    agent_opening_seconds: float = 2.0
    """How long the persona listens before deciding the agent is not going
    to speak first. A greeting arrives well inside this; silence means the
    caller opens, which is what a person does."""

    persona_pause_seconds: float = 0.4
    """The beat the persona leaves before answering. A person does not
    start speaking on the far end's last syllable, and a pipeline that did
    would measure the agent's patience rather than the agent."""

    agent_quiet_seconds: float = 12.0
    """How long the persona waits on a far end that answered with nothing
    at all before taking another turn. Hold music, a line left open, an
    agent that simply did not speak: all of them end up cheap and honest
    rather than running the simulation to its duration limit."""

    agent_turn_backstop_seconds: float = 5.0
    """How long the turn model is given to call a turn finished once the
    far end has stopped, before the pipeline calls it finished anyway.
    Only ever reached when the ears found no words in a stretch of
    speech, which is a real thing a phone line does."""

    yields_to_the_agent: bool = False
    """Whether the agent speaking cuts the persona's own utterance short.
    Off for now: moving who conducts is one change, and being interrupted
    is a behavior of its own, with a record of its own."""


DEFAULT_CONDUCT = ConductParameters()
"""What every persona conducts itself by until something says otherwise."""


class AudioClock:
    """The conversation's own clock: sample positions, as OTLP instants.

    The line opens at one wall-clock instant, and after that nothing is
    ever asked of a clock again: a position is a count of samples that
    crossed the line, and this converts it. Every span a voice simulation
    writes is bracketed by two of these, which is what makes "these two
    turns overlapped" a fact about the audio.
    """

    def __init__(self, *, sample_rate_hz: int, opened_unix_nano: int) -> None:
        self._sample_rate_hz = sample_rate_hz
        self._opened_unix_nano = opened_unix_nano

    def at(self, sample: int) -> int:
        """The wall-clock instant one sample position happened at."""
        return self._opened_unix_nano + sample * 1_000_000_000 // self._sample_rate_hz


# -- What the conductor observes ---------------------------------------------

OnUtterance = Callable[[str, str, int, int], Awaitable[None]]
"""One turn of the transcript: who spoke, what they said, and the two
instants the audio ran between. Both ends, because both are known — see
this module's docstring."""

OnMeasured = Callable[[str, int, int], Awaitable[None]]
"""One measurement, as the interval it measured on the audio timeline."""

OnAnswered = Callable[[], Awaitable[None]]
"""The agent's answer is whole and everything it produced is on the
record — the same seam the walk announces, so evidence reaches a reader
while the conversation is still going."""


# -- The marks the pipeline is driven by --------------------------------------


@dataclass
class _SlicePassed(ControlFrame):
    """The mark behind one slice of the line.

    When it comes out of the pipeline, everything that slice caused has
    happened. A frame nobody but this file knows about is the only thing
    every leg is guaranteed to pass along untouched, and being a control
    frame rather than a system one is what keeps it strictly behind the
    data frames it is a mark for.
    """


@dataclass
class _AgentFinished(ControlFrame):
    """The agent has said its piece; the persona may answer.

    Pushed by the turn keeper the moment the turn model calls a turn
    over, and by the conductor itself where there was no turn to end —
    the opening, and a far end that answered with nothing.
    """

    heard_a_turn: bool = True
    """False where the agent never spoke, so there is no turn to record."""


@dataclass
class _PersonaSaid(ControlFrame):
    """The mark closing a persona turn the pipeline has spoken.

    Everything queued before it has come out of the speaking leg, so the
    audio held since the last mark is this turn's and all of it.
    """

    text: str = ""
    concluded: bool = False


# -- The legs, wired to the timeline ------------------------------------------


class _AgentEar(VADProcessor):
    """Hears the far end, and stamps what it hears in sample positions.

    The detector says *speech started* only once it has heard enough of
    it to be sure, and *speech stopped* only after enough silence — so
    what it reports is always late by exactly the windows it needed.
    Those windows are its own declared parameters, read back off the
    detector at the moment it speaks, so subtracting them puts the
    boundary back where the speech really was, to the sample.

    The count of samples this has heard is the conversation's clock, and
    it is kept here because here is the only place it can be right: the
    detector's verdicts are raised inside the very call that counts the
    slice they came from.
    """

    def __init__(self, *, vad_analyzer, sample_rate_hz: int) -> None:
        super().__init__(
            vad_analyzer=vad_analyzer,
            # A watchdog that forces a speech stop when audio stops
            # arriving is a clock deciding a boundary. The line here never
            # stops arriving — quiet is audio — so there is nothing for it
            # to notice and everything for it to get wrong.
            audio_idle_timeout=0.0,
        )
        self._sample_rate_hz = sample_rate_hz
        self._detector = vad_analyzer
        self.heard_samples = 0
        self.speaking_since: int | None = None
        self.utterances: list[tuple[int, int]] = []
        """Every stretch of far-end speech, opened and closed, in order."""

        @self._vad_controller.event_handler("on_speech_started")
        async def _started(_controller: object) -> None:
            self.speaking_since = max(
                0,
                self.heard_samples - self._samples(self._detector.params.start_secs),
            )

        @self._vad_controller.event_handler("on_speech_stopped")
        async def _stopped(_controller: object) -> None:
            if self.speaking_since is None:
                return
            ended = max(
                self.speaking_since,
                self.heard_samples - self._samples(self._detector.params.stop_secs),
            )
            self.utterances.append((self.speaking_since, ended))
            self.speaking_since = None

    @property
    def hearing_speech(self) -> bool:
        return self.speaking_since is not None

    def _samples(self, seconds: float) -> int:
        return round(seconds * self._sample_rate_hz)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        # Counted before the detector is given the slice, so a verdict
        # raised while this slice is being analyzed lands on a count that
        # already includes it.
        if isinstance(frame, InputAudioRawFrame):
            self.heard_samples += len(frame.audio) // SAMPLE_WIDTH_BYTES
        await super().process_frame(frame, direction)


class _TurnKeeper(UserTurnProcessor):
    """Pipecat's turn machinery, with the end of a turn put back in band.

    The turn model's verdict arrives as an event, and an event is not a
    place in the frame stream: Pipecat runs an event handler as a task of
    its own, so a persona answering from one could answer before the
    words it is answering had passed. Only a frame can promise the order.
    So the verdict is turned into one, pushed from inside the very call
    that raised it — strictly behind the transcript, strictly ahead of the
    mark closing the slice.

    Reaching inside a base class for that is a debt owed to the pinned
    version, and a small one: the pin is deliberate and this file names it
    in one place.
    """

    async def _on_user_turn_stopped(self, controller, strategy, params) -> None:
        await super()._on_user_turn_stopped(controller, strategy, params)
        await self.push_frame(_AgentFinished())


class _PersonaBrain(FrameProcessor):
    """The pipeline's model step: the same persona brain chat conducts with.

    It never learns that it is in a voice pipeline. What reaches it is the
    agent's words and the news that the agent has finished; what leaves it
    is one turn of plain text, framed the way a model's answer is framed
    so the speaking leg knows a turn is whole.
    """

    def __init__(self, *, persona: Persona, conductor: VoiceConductor) -> None:
        super().__init__()
        self._persona = persona
        self._conductor = conductor
        self._heard: list[str] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            # A real transcriber may hand back a long turn in pieces, so
            # the pieces are joined rather than the last one kept.
            self._heard.append(frame.text)
        await self.push_frame(frame, direction)
        if isinstance(frame, _AgentFinished):
            await self._answer(frame.heard_a_turn)

    async def _answer(self, heard_a_turn: bool) -> None:
        try:
            await self._think(heard_a_turn)
        except Exception as fault:
            # The brain runs inside the pipeline now, and a pipeline
            # swallows what a processor raises into a logged error frame.
            # A model that refused is a diagnosis the record needs in the
            # words it was refused in, so it is handed to the conductor,
            # which is waiting and raises it as its own.
            self._conductor.the_brain_failed(fault)

    async def _think(self, heard_a_turn: bool) -> None:
        said = " ".join(piece for piece in self._heard if piece)
        self._heard.clear()
        if not await self._conductor.the_agent_finished(said, heard_a_turn):
            return
        reply = await self._persona.next_turn(self._conductor.history)
        if reply.concluded:
            # The persona's goodbye ends the simulation rather than being
            # said into it: the walk has always ended on the words that
            # conclude the scenario without handing them to the platform,
            # and who conducts is the only thing that changed.
            await self.push_frame(_PersonaSaid(text=reply.text, concluded=True))
            return
        await self.push_frame(LLMFullResponseStartFrame())
        await self.push_frame(TextFrame(reply.text))
        await self.push_frame(LLMFullResponseEndFrame())
        await self.push_frame(_PersonaSaid(text=reply.text))


class _PersonaMouth(FrameProcessor):
    """The end of the pipeline: what the persona has to say, and when a
    slice is through.

    Speech leaves the pipeline here rather than being played as it is
    made, because on a duplex line the persona's own audio has to be
    placed on the same clock as the far end's. So a whole utterance is
    gathered, handed to the line, and the line's own slices are what say
    where it began and ended.
    """

    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.slice_passed = asyncio.Event()
        self.to_say: list[_Utterance] = []
        self._audio = bytearray()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, StartFrame):
            self.started.set()
        elif isinstance(frame, TTSAudioRawFrame):
            self._audio.extend(frame.audio)
        elif isinstance(frame, _PersonaSaid):
            self.to_say.append(
                _Utterance(
                    text=frame.text,
                    pcm=bytes(self._audio),
                    concluded=frame.concluded,
                )
            )
            self._audio.clear()
        elif isinstance(frame, _SlicePassed):
            self.slice_passed.set()
        await self.push_frame(frame, direction)


@dataclass
class _Utterance:
    """One persona turn, decided and spoken, waiting for the line."""

    text: str
    pcm: bytes
    concluded: bool = False
    began_at: int | None = None
    said: int = 0

    @property
    def samples(self) -> int:
        return len(self.pcm) // SAMPLE_WIDTH_BYTES

    @property
    def finished(self) -> bool:
        return self.said >= self.samples


class PipelineGone(RuntimeError):
    """The pipeline stopped while the conversation was still being driven.

    Deliberately not a ``PlugError``: that word names a platform refusing
    or failing, and this is machinery inside the simulator going wrong.
    """


@dataclass
class _Record:
    """What the conductor is keeping about the conversation so far."""

    history: list[Turn] = field(default_factory=list)
    turns: int = 0
    persona_last_stopped_at: int | None = None
    """Where the persona's last utterance ended, which is what the agent's
    answer is measured from."""

    first_answer_measured: bool = False


class VoiceConductor:
    """One voice simulation: a Pipecat pipeline on one full-duplex line."""

    def __init__(
        self,
        *,
        line: DuplexLine,
        voice: PersonaVoice,
        blobs: BlobStore,
        recording_key: str,
        speech: SpeechProviders = SCRIPTED_PAIR,
        parameters: ConductParameters = DEFAULT_CONDUCT,
    ) -> None:
        self._line = line
        self._band_hz = line.sample_rate_hz
        self._blobs = blobs
        self._recording_key = recording_key
        self._parameters = parameters

        self._legs = build_legs(speech, voice=voice, sample_rate_hz=self._band_hz)
        self._vad = build_vad(
            speech,
            sample_rate_hz=self._band_hz,
            window_samples=LINE_SLICE_SAMPLES,
        )

        # What conducting is given, and only conducting: a conductor is
        # assembled from a spec and told the rest when it is set going.
        self._persona: Persona | None = None
        self._max_turns = 0
        self._controls = WalkControls()

        self._record = _Record()
        self._clock: AudioClock | None = None
        self._position = 0
        self._ear: _AgentEar | None = None
        self._mouth: _PersonaMouth | None = None
        self._worker: PipelineWorker | None = None
        self._runner: WorkerRunner | None = None
        self._running: asyncio.Task | None = None

        self._heard_so_far = 0
        """How many far-end utterances the conductor has already recorded."""

        self._ending: tuple[str, str | None] | None = None
        self._speaking: _Utterance | None = None
        self._may_speak_from: int | None = None
        self._owes_a_turn = False
        self._hangup_grace_until: int | None = None
        self._brain_fault: BaseException | None = None
        self._closed = False

        self._persona_track = bytearray()
        self._agent_track = bytearray()

        self._on_utterance: OnUtterance | None = None
        self._on_measured: OnMeasured | None = None
        self._on_answered: OnAnswered | None = None

        self.audio: AudioFacts | None = None
        """What the exchange measured about its own audio, once it is over."""

        self._faulted = asyncio.Event()
        self._fault = ""

    # -- What the outside asks of it -----------------------------------------

    @property
    def provider_reference(self) -> str | None:
        return self._line.provider_reference

    @property
    def legs(self) -> SpeechLegs:
        """The mouth and ears this simulation was assembled with."""
        return self._legs

    @property
    def vad(self) -> object:
        """The leg that hears whether the agent is speaking."""
        return self._vad

    @property
    def speaking_voice(self) -> PersonaVoice:
        """The voice the speaking leg was really built with."""
        return self._legs.voice

    @property
    def history(self) -> list[Turn]:
        """The transcript so far, from the persona brain's seat."""
        return self._record.history

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
        """Conduct one voice simulation, and say how it went.

        The endings are the walk's, unchanged and for the same reasons:
        the persona concluding, the agent ending the exchange, either
        limit, and the cancel directive. What changed is who noticed.
        """
        self._persona = persona
        self._on_utterance = on_utterance
        self._on_measured = on_measured
        self._on_answered = on_answered
        self._max_turns = max_turns
        self._controls = controls

        watchdog = asyncio.create_task(
            _duration_watchdog(max_duration_seconds, controls),
            name=f"{name}:watchdog",
        )
        try:
            await self._open(name)
            await self._drive()
        except _Stopped:
            await self._say_no_more()
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
            return self._ended(
                "limit_reached",
                f"the duration limit ({max_duration_seconds}s) tripped",
            )
        ending, reason = self._ending or (
            "limit_reached",
            f"the turn limit ({max_turns} turns) tripped",
        )
        return self._ended(ending, reason)

    def _ended(self, ending: str, reason: str | None) -> Conducted:
        return Conducted(
            status="completed",
            ending=ending,
            reason=reason,
            provider_reference=self.provider_reference,
        )

    # -- Assembly and teardown ------------------------------------------------

    async def _open(self, name: str) -> None:
        ear = _AgentEar(vad_analyzer=self._vad, sample_rate_hz=self._band_hz)
        mouth = _PersonaMouth()
        turns = _TurnKeeper(
            user_turn_strategies=UserTurnStrategies(
                start=[
                    VADUserTurnStartStrategy(
                        enable_interruptions=self._parameters.yields_to_the_agent
                    )
                ],
            ),
            user_turn_stop_timeout=self._parameters.agent_turn_backstop_seconds,
        )
        assert self._persona is not None
        brain = _PersonaBrain(persona=self._persona, conductor=self)

        self._ear = ear
        self._mouth = mouth
        self._worker = PipelineWorker(
            Pipeline([ear, self._legs.stt, turns, brain, self._legs.tts, mouth]),
            params=PipelineParams(
                audio_in_sample_rate=self._band_hz,
                audio_out_sample_rate=self._band_hz,
            ),
            # Limits, cancellation and the clock are this conductor's; a
            # pipeline that cancelled itself for being quiet would be a
            # second, hidden limit with no record of having tripped. Its
            # own turn tracing is off for the same reason the record is
            # written here: sequential bot turns cannot say that two
            # people spoke at once.
            idle_timeout_secs=None,
            enable_turn_tracking=False,
            enable_rtvi=False,
        )
        # Signals belong to the simulator process, which already stops the
        # honest way; a runner that installed its own handlers would take
        # the whole service down with one pipeline.
        self._runner = WorkerRunner(handle_sigint=False)

        @self._worker.event_handler("on_pipeline_error")
        async def _remember_fault(_worker: object, error: object) -> None:
            # A leg refusing a turn — a key the provider will not take, a
            # plan that does not cover the voice — reaches here and
            # nowhere else: error frames travel back up the pipeline, away
            # from the end everything else is read from.
            self._fault = str(getattr(error, "error", error))
            self._faulted.set()

        await self._runner.add_workers(self._worker)
        self._running = asyncio.create_task(
            self._runner.run(), name=f"voice-pipeline:{name}"
        )
        await self._reach(mouth.started)
        # A listening leg that connects does so once the pipeline starts,
        # and drops anything handed to it before that lands.
        await self._legs.ready()

        await self._line.open()
        self._clock = AudioClock(
            sample_rate_hz=self._band_hz, opened_unix_nano=_now()
        )

    async def close(self) -> None:
        """End the pipeline, hang up, and write down what was heard.

        Safe in every state a simulation can reach it from: assembled and
        never conducted, conducted to an ending, and conducted into a
        fault. Conducting calls it on its way out, whatever happened, and
        a failure to hang up is logged rather than raised — it would
        otherwise eat the conductor's own answer.
        """
        if self._closed:
            return
        self._closed = True
        try:
            await self._end_pipeline()
        finally:
            try:
                await self._line.close()
            except Exception:
                logger.exception("closing the line failed")
            await self._legs.aclose()
        await self._write_recording()

    async def _end_pipeline(self) -> None:
        if self._running is None or self._worker is None:
            return
        try:
            await self._worker.queue_frame(EndFrame())
            await asyncio.wait_for(
                asyncio.shield(self._running), timeout=TEARDOWN_SECONDS
            )
        except Exception as unfinished:
            logger.warning("the voice pipeline did not end cleanly: %r", unfinished)
        finally:
            if not self._running.done():
                self._running.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self._running

    async def _write_recording(self) -> None:
        if not self._persona_track and not self._agent_track:
            return
        try:
            reference = await self._blobs.write(
                self._recording_key,
                dual_channel_wav(
                    bytes(self._persona_track), bytes(self._agent_track), self._band_hz
                ),
            )
        except Exception:
            logger.exception("the recording could not be written; reporting none")
            return
        self.audio = AudioFacts(
            measured_sample_rate_hz=self._band_hz, recording=reference
        )

    # -- Driving the line -----------------------------------------------------

    async def _drive(self) -> None:
        """Carry the line one slice at a time until the exchange is over."""
        assert self._mouth is not None
        while self._ending is None:
            self._stop_if_asked()
            outgoing = await self._outgoing()
            incoming = await self._line.exchange(outgoing)
            self._persona_track += outgoing
            self._agent_track += incoming
            await self._feed(incoming)
            self._position += LINE_SLICE_SAMPLES
            await self._after_the_slice()

    async def _feed(self, incoming: bytes) -> None:
        """Give the pipeline one slice, and wait for it to come through."""
        assert self._worker is not None and self._mouth is not None
        self._mouth.slice_passed.clear()
        await self._worker.queue_frames(
            [
                InputAudioRawFrame(
                    audio=incoming, sample_rate=self._band_hz, num_channels=1
                ),
                _SlicePassed(),
            ]
        )
        await self._reach(self._mouth.slice_passed)

    async def _outgoing(self) -> bytes:
        """The slice of the persona's own voice going out right now."""
        slice_bytes = LINE_SLICE_SAMPLES * SAMPLE_WIDTH_BYTES
        if self._speaking is None:
            await self._maybe_start_speaking()
        speaking = self._speaking
        if speaking is None:
            return bytes(slice_bytes)
        taken = speaking.pcm[
            speaking.said * SAMPLE_WIDTH_BYTES :
        ][:slice_bytes]
        speaking.said += len(taken) // SAMPLE_WIDTH_BYTES
        return taken.ljust(slice_bytes, b"\x00")

    async def _maybe_start_speaking(self) -> None:
        """Open the persona's next utterance, once it is due and ready.

        Two things have to be true, and they are different in kind. The
        persona is *due* to speak at a position on the audio timeline —
        the beat it leaves after the agent stops, which is conduct and is
        named in the parameters. Its words are *ready* when they are out
        of the speaking leg, which is how long the brain and the mouth
        took and is not conduct at all. So the utterance opens at
        whichever of the two is later, and the line keeps flowing quiet
        in the meantime rather than freezing while the persona thinks:
        both directions stay open, which is the whole point.
        """
        assert self._mouth is not None
        if self._may_speak_from is None or self._position < self._may_speak_from:
            return
        if not self._mouth.to_say:
            return
        utterance = self._mouth.to_say.pop(0)
        self._owes_a_turn = False
        self._may_speak_from = None
        if utterance.concluded:
            await self._say_nothing_more(utterance)
            return
        utterance.began_at = self._position
        self._speaking = utterance

    async def _say_no_more(self) -> None:
        """A stop landed while the persona was still speaking.

        What went out went out: the turn is on the record for exactly the
        stretch of line it occupied, ending at the last sample that
        crossed rather than at the end of what the persona meant to say.
        The walk records a turn the moment the persona decides it, so a
        cancelled exchange keeps its last turn there too — this is the
        same fact, measured off the audio instead of assumed whole.
        """
        spoken = self._speaking
        self._speaking = None
        if spoken is None or spoken.began_at is None or spoken.said == 0:
            return
        ended = spoken.began_at + spoken.said
        await self._measure("persona_speech_duration", spoken.began_at, ended)
        await self._took_a_turn("human", spoken.text, spoken.began_at, ended)

    async def _say_nothing_more(self, utterance: _Utterance) -> None:
        """The persona concluded: the words go on the record unspoken.

        One instant, honestly — the scenario is concluded the moment the
        persona decides it is, and nothing was ever said into the line.
        """
        await self._took_a_turn(
            "human", utterance.text, self._position, self._position
        )
        if self._ending is None:
            self._ending = ("persona_concluded", "the persona concluded the scenario")

    async def _after_the_slice(self) -> None:
        """Read what this slice changed, and decide what happens next."""
        assert self._ear is not None
        if self._speaking is not None and self._speaking.finished:
            spoken = self._speaking
            self._speaking = None
            assert spoken.began_at is not None
            ended_at = spoken.began_at + spoken.samples
            await self._measure("persona_speech_duration", spoken.began_at, ended_at)
            await self._took_a_turn("human", spoken.text, spoken.began_at, ended_at)
            self._record.persona_last_stopped_at = ended_at
            if self._ending is not None:
                return

        if self._ending is not None:
            return
        if self._line.far_end_left:
            await self._far_end_left()
            return
        await self._maybe_ask_the_persona()

    async def _far_end_left(self) -> None:
        """The agent is off the line; keep only what it managed to say."""
        assert self._ear is not None
        still_being_heard = self._ear.hearing_speech or self._heard_so_far < len(
            self._ear.utterances
        )
        if still_being_heard and self._position < self._hangup_grace():
            # Its last words are still being heard out. The line is quiet
            # now, so this costs the exchange a few slices of silence and
            # the record gets the whole of what was said. The grace is
            # fixed the first time it is asked for, or it would be a
            # deadline that moves away every time it is approached.
            return
        self._ending = ("agent_ended", "the agent ended the exchange")

    def _hangup_grace(self) -> int:
        if self._hangup_grace_until is None:
            self._hangup_grace_until = self._position + self._samples(
                self._parameters.agent_turn_backstop_seconds
            )
        return self._hangup_grace_until

    async def _maybe_ask_the_persona(self) -> None:
        """The two moments nothing in the pipeline will announce.

        The turn model says when the agent has finished talking. It cannot
        say when the agent was never going to talk — at the opening, and
        when an answer carried no sound at all — and both are ordinary on
        a phone line. So the conductor says it, at a position the
        parameters name rather than at whatever moment code ran.
        """
        assert self._ear is not None
        if self._owes_a_turn or self._speaking is not None:
            return
        if self._mouth is not None and self._mouth.to_say:
            return
        if self._ear.hearing_speech or self._heard_so_far < len(self._ear.utterances):
            return

        quiet_since = self._record.persona_last_stopped_at
        if quiet_since is None and not self._ear.utterances:
            if self._position >= self._samples(
                self._parameters.agent_opening_seconds
            ):
                await self._ask_the_persona(heard_a_turn=False)
            return
        if quiet_since is None:
            return
        if self._position - quiet_since >= self._samples(
            self._parameters.agent_quiet_seconds
        ):
            logger.info(
                "the far end answered with no sound at all; the persona takes "
                "another turn rather than waiting out the duration limit"
            )
            await self._ask_the_persona(heard_a_turn=False)

    async def _ask_the_persona(self, *, heard_a_turn: bool) -> None:
        assert self._worker is not None and self._mouth is not None
        self._owes_a_turn = True
        self._may_speak_from = self._position
        self._mouth.slice_passed.clear()
        await self._worker.queue_frames(
            [_AgentFinished(heard_a_turn=heard_a_turn), _SlicePassed()]
        )
        await self._reach(self._mouth.slice_passed)

    # -- What the pipeline tells the conductor --------------------------------

    async def the_agent_finished(self, said: str, heard_a_turn: bool) -> bool:
        """The agent's turn is over. Record it, and say whether to answer.

        Called from inside the pipeline, by the brain, before it thinks —
        so the transcript the persona is answering is already on the
        record, in the order it happened.
        """
        assert self._ear is not None
        stopped_at: int | None = None
        if heard_a_turn and self._heard_so_far < len(self._ear.utterances):
            began, ended = self._ear.utterances[self._heard_so_far]
            self._heard_so_far = len(self._ear.utterances)
            stopped_at = ended
            quiet_from = self._record.persona_last_stopped_at or 0
            # In the order the intervals close, so no measurement is ever
            # stamped before the one taken ahead of it.
            await self._measure("time_to_first_word", quiet_from, began)
            if self._record.persona_last_stopped_at is not None:
                if not self._record.first_answer_measured:
                    self._record.first_answer_measured = True
                    await self._measure("first_response_latency", quiet_from, began)
                await self._measure("turn_response_latency", quiet_from, began)
            await self._took_a_turn("agent", said, began, ended)
            await self._measure("agent_speech_duration", began, ended)
            self._record.persona_last_stopped_at = None
        if self._on_answered is not None:
            await self._on_answered()
        if self._ending is not None:
            return False
        # The persona is now owed a turn, and where it may open it is a
        # position on the audio timeline rather than the moment this code
        # ran: one beat after the agent stopped speaking. Where the agent
        # never spoke there is nothing to leave a beat after, and the
        # conductor has already said where — see :meth:`_ask_the_persona`.
        self._owes_a_turn = True
        if stopped_at is not None:
            self._may_speak_from = stopped_at + self._samples(
                self._parameters.persona_pause_seconds
            )
        return True

    def the_brain_failed(self, fault: BaseException) -> None:
        """The persona's brain raised inside the pipeline. Keep it, whole.

        Remembered rather than raised: the raiser is a processor task, and
        an exception there becomes a log line. The conductor is waiting on
        this slice, and :meth:`_reach` raises this instead of returning —
        so a model that refused ends the simulation in the model's own
        words, exactly as it did when the walk called it.
        """
        if self._brain_fault is None:
            self._brain_fault = fault
        self._faulted.set()

    async def _took_a_turn(
        self, speaker: str, text: str, began: int, ended: int
    ) -> None:
        assert self._clock is not None
        self._record.history.append(
            Turn("human" if speaker == "human" else "agent", text)
        )
        self._record.turns += 1
        if self._on_utterance is not None:
            await self._on_utterance(
                speaker, text, self._clock.at(began), self._clock.at(ended)
            )
        if self._record.turns >= self._max_turns and self._ending is None:
            self._ending = (
                "limit_reached",
                f"the turn limit ({self._max_turns} turns) tripped",
            )

    async def _measure(self, measure: str, began: int, ended: int) -> None:
        assert self._clock is not None
        if self._on_measured is not None:
            await self._on_measured(
                measure, self._clock.at(began), self._clock.at(max(ended, began))
            )

    # -- Waiting, and being stopped -------------------------------------------

    def _samples(self, seconds: float) -> int:
        return round(seconds * self._band_hz)

    def _stop_if_asked(self) -> None:
        if self._controls.cause is not None:
            raise _Stopped()

    async def _reach(self, event: asyncio.Event) -> None:
        """Wait for one point in the pipeline, or say plainly what stopped it.

        Racing the wait against the pipeline's own task is what stops a
        pipeline that ended early — a leg that raised, a worker cancelled —
        from becoming a simulation that hangs until its duration limit. A
        leg that refused this turn is raced the same way and its refusal
        quoted rather than summarised: what a provider says about a key or
        a plan is the whole diagnosis. A stop cause landing is raced too,
        which is what makes a cancel land inside one heartbeat however
        deep in a turn it arrives.
        """
        if self._running is None:
            raise PipelineGone("the voice pipeline was driven before it was opened")
        waiting = asyncio.ensure_future(event.wait())
        faulted = asyncio.ensure_future(self._faulted.wait())
        stopped = asyncio.ensure_future(self._controls.guard(_never()))
        try:
            done, _pending = await asyncio.wait(
                {waiting, faulted, stopped, self._running},
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            for unfinished in (waiting, faulted, stopped):
                if not unfinished.done():
                    unfinished.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await unfinished
        if waiting in done:
            return
        if faulted in done:
            if self._brain_fault is not None:
                raise self._brain_fault
            raise SpeechFault(f"a speech leg refused this turn: {self._fault}")
        if stopped in done:
            raise _Stopped()
        raise PipelineGone("the voice pipeline ended before the conversation did")


class _Stopped(Exception):
    """Internal: a stop cause landed while the conversation was running."""


TEARDOWN_SECONDS = 10.0
"""How long a torn-down pipeline may take to finish before it is cancelled."""


async def _never() -> None:
    """Something that never finishes, so a guard only ever answers a stop."""
    await asyncio.Event().wait()


async def _duration_watchdog(
    max_duration_seconds: float, controls: WalkControls
) -> None:
    """The duration limit, on the wall clock and outside the pipeline.

    Deliberately real time rather than audio time, and deliberately not
    Pipecat's: a call's budget is a budget of somebody's afternoon, and
    Pipecat has no maximum-call-duration of its own to lean on.
    """
    await asyncio.sleep(max_duration_seconds)
    controls.trip_duration_limit()


def _now() -> int:
    """The one wall-clock instant a voice simulation reads: when the line
    opened. Every other instant on the record is a sample position
    converted from it."""
    return time.time_ns()
