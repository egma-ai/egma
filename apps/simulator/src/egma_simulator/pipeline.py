"""Pipeline assembly: what one simulation is conducted through.

One pipeline is built from one claimed spec and torn down when the
exchange is over, so nothing from one simulation can reach the next. What
the spec selects is only which legs are in it: a chat simulation is the
plug and the persona brain, and a voice simulation is the same plug and
the same brain with speech legs between them. The brain is one component
for every modality, forever — it never learns which of these it is in.

The voice legs run on Pipecat: the persona's words are spoken into audio
by one processor, the agent's audio is read back into words by another,
and both directions pass through Pipecat's own audio buffer, which is
what keeps the two speakers in step and gives the recording a channel
each. Turn-taking is deliberately *not* Pipecat's
here: the walk owns it, because limits, cancellation and the transcript
are the walk's business and are the same for chat. So the pipeline is
driven a turn at a time, and every wait below is for a specific frame
reaching the end of it — never for a length of time.

Everything a voice simulation owes its record is measured here, from what
actually flowed: the band the audio was carried at, the recording's
reference, how long each side spoke, and how long the agent was quiet
before it answered.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import logging
import sys
import wave
from array import array
from dataclasses import dataclass

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
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.workers.runner import WorkerRunner

from .blob import BlobStore
from .plugs import (
    AgentReply,
    PlatformPlug,
    PlugError,
    Utterance,
    VoicePlug,
    plug_for,
)
from .spec import SimulationSpec
from .speech import (
    SAMPLE_WIDTH_BYTES,
    SCRIPTED_PAIR,
    PersonaVoice,
    SpeechFault,
    SpeechLegs,
    SpeechProviders,
    build_legs,
    duration_seconds,
    leading_silence_seconds,
    silence,
    spoken_seconds,
    voice_from_traits,
)
from .walk import OnTiming

logger = logging.getLogger(__name__)

RECORDING_NAME = "dual-channel.wav"
"""What one simulation's recording is called inside its own blob key."""

TEARDOWN_SECONDS = 10.0
"""How long a torn-down pipeline may take to finish before it is cancelled."""

HEARD_NOTHING_SECONDS = 20.0
"""How long a listening leg may hold a whole turn of audio and say nothing
about it before the turn counts as one that carried no words.

A streaming transcriber that finds no words in a stretch of audio pushes
no frame at all — there is no empty transcript, only silence — so a turn
waiting for one waits forever, and the simulation runs to its duration
limit with nothing on the record saying why. Phone calls make that
ordinary: hold music, a line left open, a room with a television in it.

It is a backstop and not a turn-taking rule, which is why it is generous
and why it is the only wait in this file measured in time rather than in
frames. The scripted pair answers every turn it is given, so no
deterministic exchange ever reaches it.
"""

PERSONA_CHANNEL = 0
AGENT_CHANNEL = 1
"""Who is on which channel of a recording. The transcript's two labels in
the transcript's own order, so the file needs no legend to be read."""


@dataclass
class TurnSpoken(ControlFrame):
    """The mark the pipeline puts after a persona turn it has queued.

    A turn is finished being spoken when everything queued before this
    frame has come out the other end, and a frame nobody but this file
    knows about is the only thing every leg is guaranteed to pass along
    untouched. The alternative — watching for one of the speaking leg's
    own frames — is a different answer for every provider: some push the
    frames that opened the turn, some hold them back for word timing, and
    some emit the end only after an idle timeout. Then a turn boundary
    would be a fact about a vendor rather than about the exchange.
    """


class PipelineGone(RuntimeError):
    """The pipeline stopped while a turn was still being driven through it.

    Deliberately not a ``PlugError``: that word names a platform refusing
    or failing, and this is machinery inside the simulator going wrong.
    The walk reports either as a failed simulation, and the reason on the
    record is what tells a reader which of the two happened.
    """


@dataclass(frozen=True)
class AudioFacts:
    """What a voice simulation measured about its own audio."""

    measured_sample_rate_hz: int
    recording: str

    def as_report(self) -> dict:
        """The contract's audio block, exactly."""
        return {
            "measured_sample_rate_hz": self.measured_sample_rate_hz,
            "recording": self.recording,
        }


@dataclass(frozen=True)
class Assembled:
    """One simulation's pipeline: what the walk drives, and what it measured."""

    plug: PlatformPlug
    """Text in, text out — the walk never learns which modality it is in."""

    voice: VoicePipeline | None
    """The speech legs, for a voice simulation; ``None`` for a chat one."""

    @property
    def audio(self) -> dict | None:
        """The contract's audio block once the exchange is over, else ``None``."""
        if self.voice is None or self.voice.audio is None:
            return None
        return self.voice.audio.as_report()


def assemble(
    spec: SimulationSpec,
    *,
    blobs: BlobStore,
    speech: SpeechProviders = SCRIPTED_PAIR,
    on_timing: OnTiming | None = None,
) -> Assembled:
    """Build one simulation's pipeline from its spec.

    Constructing is validation and nothing else — no platform is dialled
    and no pipeline is started until the walk opens the exchange — so a
    spec that cannot be conducted fails here, honestly, before anything
    happens.

    ``speech`` is where a deployment's choice of real providers enters,
    and the only place: the spec says what the simulation is, the
    configuration says what carries it. Left alone it is the scripted
    pair, so a caller with nothing to say about providers gets exactly
    the pipeline it always got.
    """
    factory = plug_for(spec.connection_type)
    if factory is None:
        raise PlugError(
            f"no platform plug for connection type {spec.connection_type!r}"
        )
    plug = factory(
        modality=spec.modality,
        config=spec.connection_config,
        credentials=spec.credentials,
        simulation_id=spec.simulation_id,
    )
    if spec.modality != "voice":
        return Assembled(plug=plug, voice=None)

    speech_legs = VoicePipeline(
        transport=plug,
        voice=voice_from_traits(spec.persona_traits),
        speech=speech,
        blobs=blobs,
        recording_key=f"{spec.simulation_id}/{RECORDING_NAME}",
        on_timing=on_timing,
    )
    return Assembled(plug=speech_legs, voice=speech_legs)


class _TurnSink(FrameProcessor):
    """The end of the pipeline, where a turn is known to be over.

    Two frames are what the pipeline is driven by: the mark closing a
    persona turn means their words have all been spoken, and a
    transcription means the agent's audio has all been read. Waiting for
    those rather than for a length of time is what keeps a voice walk as
    deterministic as a chat one.
    """

    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.spoken = asyncio.Event()
        self.heard = asyncio.Event()
        self._heard_pieces: list[str] = []
        self._persona_audio = bytearray()

    @property
    def words_heard(self) -> str:
        """What the transcriber made of the agent's last turn. One turn's
        words — the transcript is the whole record, and that is the
        reporter's.

        A real transcriber may hand back a long turn in pieces, so the
        pieces are joined rather than the last one kept; the scripted one
        answers a turn in one piece and reads back exactly as before.
        """
        return " ".join(self._heard_pieces)

    def before_speaking(self) -> None:
        self.spoken.clear()
        self._persona_audio.clear()

    def before_hearing(self) -> None:
        self.heard.clear()
        self._heard_pieces.clear()

    def spoken_audio(self) -> bytes:
        return bytes(self._persona_audio)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, StartFrame):
            self.started.set()
        elif isinstance(frame, TTSAudioRawFrame):
            self._persona_audio.extend(frame.audio)
        elif isinstance(frame, TurnSpoken):
            self.spoken.set()
        elif isinstance(frame, TranscriptionFrame):
            self._heard_pieces.append(frame.text)
            self.heard.set()
        await self.push_frame(frame, direction)


class VoicePipeline:
    """The speech legs around a voice plug, wearing the walk's text seam.

    From the outside it is an ordinary platform plug: open, deliver a
    persona turn, close. Inside, every turn is spoken, carried to the
    counterpart as audio, and heard back — and the audio of both sides is
    recorded as it passes.
    """

    def __init__(
        self,
        *,
        transport: VoicePlug,
        voice: PersonaVoice,
        blobs: BlobStore,
        recording_key: str,
        speech: SpeechProviders = SCRIPTED_PAIR,
        on_timing: OnTiming | None = None,
    ) -> None:
        self._transport = transport
        self._band_hz = transport.sample_rate_hz
        self._blobs = blobs
        self._recording_key = recording_key
        self._on_timing = on_timing

        self._legs = build_legs(
            speech, voice=voice, sample_rate_hz=self._band_hz
        )
        self._recorder = AudioBufferProcessor(
            sample_rate=self._band_hz, num_channels=2
        )
        self._sink = _TurnSink()
        # Listening comes before speaking in the chain so that the persona's
        # own voice never reaches the transcriber: an STT service reads every
        # audio frame that passes it, and its own side's speech is not the
        # transcript.
        self._worker = PipelineWorker(
            Pipeline(
                [self._legs.stt, self._legs.tts, self._recorder, self._sink]
            ),
            params=PipelineParams(
                audio_in_sample_rate=self._band_hz,
                audio_out_sample_rate=self._band_hz,
            ),
            # The walk owns turn-taking, the limits and the clock; a pipeline
            # that cancelled itself for being quiet would be a second, hidden
            # limit with no record of having tripped.
            idle_timeout_secs=None,
            enable_turn_tracking=False,
            enable_rtvi=False,
        )
        # Signals belong to the simulator process, which already stops the
        # honest way; a runner that installed its own handlers would take
        # the whole service down with one pipeline.
        self._runner = WorkerRunner(handle_sigint=False)
        self._running: asyncio.Task | None = None

        self._tracks: tuple[bytes, bytes, int] | None = None
        self.audio: AudioFacts | None = None
        """What the exchange measured about its own audio, once it is over."""

        self._faulted = asyncio.Event()
        self._fault = ""

        @self._worker.event_handler("on_pipeline_error")
        async def _remember_fault(_worker: object, error: object) -> None:
            # A leg refusing a turn — a key the provider will not take, a
            # plan that does not cover the voice — reaches here and
            # nowhere else: error frames travel back up the pipeline, away
            # from the sink. Without this the refusal is a log line, the
            # turn quietly carries no audio, and the simulation stalls
            # until its duration limit with nothing on the record saying
            # why. What is kept is the provider's own words.
            self._fault = str(getattr(error, "error", error))
            self._faulted.set()

        @self._recorder.event_handler("on_track_audio_data")
        async def _keep_tracks(
            _processor: object,
            user_audio: bytes,
            bot_audio: bytes,
            sample_rate: int,
            _num_channels: int,
        ) -> None:
            # Pipecat names its two tracks from a pipeline that hosts the
            # agent: the *user* is whoever speaks into the pipeline, which
            # here is the agent under test, and the *bot* is the voice this
            # pipeline gives the persona. The swap is written out rather
            # than assumed — and the recording tests would fail loudly if
            # it were ever the other way round.
            persona_so_far, agent_so_far, _ = self._tracks or (b"", b"", 0)
            self._tracks = (
                persona_so_far + bot_audio,
                agent_so_far + user_audio,
                sample_rate,
            )

    @property
    def provider_reference(self) -> str | None:
        return self._transport.provider_reference

    @property
    def legs(self) -> SpeechLegs:
        """The mouth and ears this pipeline was assembled with."""
        return self._legs

    @property
    def speaking_voice(self) -> PersonaVoice:
        """The voice the speaking leg was built with — read back off the
        legs themselves, so what this answers is what the persona spoke
        with, default and all."""
        return self._legs.voice

    async def open(self) -> str | None:
        await self._runner.add_workers(self._worker)
        self._running = asyncio.create_task(
            self._runner.run(), name="voice-pipeline"
        )
        await self._reach(self._sink.started)
        # A listening leg that connects does so once the pipeline starts,
        # and drops anything handed to it before that lands. The greeting
        # is the very next thing to arrive, so it is waited for here.
        await self._legs.ready()
        await self._recorder.start_recording()

        greeting = await self._transport.open()
        if greeting is None or greeting.audio is None:
            return None
        return await self._hear(greeting.audio)

    async def deliver(self, text: str) -> AgentReply:
        spoken = await self._speak(text)
        answer = await self._transport.deliver(spoken)
        if answer.audio is None:
            return AgentReply(text=None, ended=answer.ended)
        return AgentReply(text=await self._hear(answer.audio), ended=answer.ended)

    async def close(self) -> None:
        try:
            await self._transport.close()
        finally:
            await self._finish()

    async def _speak(self, text: str) -> Utterance:
        """The persona's turn, spoken — the audio is what leaves here.

        The turn is framed the way a language model's answer is framed,
        because that is what it is from the legs' seat: the persona brain
        is this pipeline's model, and the frames that open and close a
        model's answer are what tell the speaking leg a turn is whole.
        The pipeline's own mark goes last, and is what says the turn came
        all the way through — see :class:`TurnSpoken`.
        """
        self._before_turn()
        self._sink.before_speaking()
        await self._worker.queue_frames(
            [
                LLMFullResponseStartFrame(),
                TextFrame(text),
                LLMFullResponseEndFrame(),
                TurnSpoken(),
            ]
        )
        await self._reach(self._sink.spoken)
        pcm = self._sink.spoken_audio()
        await self._measure(
            "persona_speech_duration", duration_seconds(pcm, self._band_hz)
        )
        return Utterance(pcm=pcm, sample_rate_hz=self._band_hz)

    async def _hear(self, speech: Utterance) -> str:
        """The agent's answer, measured and then read for its words."""
        await self._measure(
            "time_to_first_word",
            leading_silence_seconds(speech.pcm, speech.sample_rate_hz),
        )
        await self._measure(
            "agent_speech_duration",
            spoken_seconds(speech.pcm, speech.sample_rate_hz),
        )
        self._before_turn()
        self._sink.before_hearing()
        # The audio is one whole turn — the plug hands over nothing less —
        # so the pipeline knows exactly where the agent started and stopped
        # speaking and says so, twice over. It marks the boundary with the
        # frames a transcriber commits on, and it carries the turn's last
        # word into the pause a real line would have had after it, because
        # hearing the speaker stop is what a transcriber trusts and being
        # told is what it merely races. The pause is added to what is heard
        # and never to what was measured: the numbers above are the
        # agent's, not this pipeline's.
        heard = speech.pcm + silence(
            self._legs.trailing_quiet_seconds, speech.sample_rate_hz
        )
        await self._worker.queue_frames(
            [
                VADUserStartedSpeakingFrame(),
                InputAudioRawFrame(
                    audio=heard,
                    sample_rate=speech.sample_rate_hz,
                    num_channels=1,
                ),
                VADUserStoppedSpeakingFrame(),
            ]
        )
        if not await self._reach(self._sink.heard, within=HEARD_NOTHING_SECONDS):
            logger.info(
                "the listening leg found no words in a turn of audio; the "
                "turn is recorded as one that carried none"
            )
            return ""
        return self._sink.words_heard

    async def _measure(self, measure: str, seconds: float) -> None:
        if self._on_timing is not None:
            await self._on_timing(measure, seconds * 1000)

    async def _reach(
        self, event: asyncio.Event, *, within: float | None = None
    ) -> bool:
        """Wait for one point in the pipeline, or say plainly what stopped it.

        Racing the wait against the pipeline's own task is what stops a
        pipeline that ended early — a leg that raised, a worker cancelled —
        from becoming a simulation that hangs until its duration limit. A
        leg that refused this turn is raced the same way and for the same
        reason, and its refusal is quoted rather than summarised: what a
        provider says about a key or a plan is the whole diagnosis.

        ``within`` gives up rather than raising, answering ``False``. Only
        one caller uses it, and :data:`HEARD_NOTHING_SECONDS` says why.
        """
        if self._running is None:
            raise PipelineGone("the voice pipeline was driven before it was opened")
        waiting = asyncio.ensure_future(event.wait())
        faulted = asyncio.ensure_future(self._faulted.wait())
        try:
            done, _pending = await asyncio.wait(
                {waiting, faulted, self._running},
                return_when=asyncio.FIRST_COMPLETED,
                timeout=within,
            )
        finally:
            for unfinished in (waiting, faulted):
                if not unfinished.done():
                    unfinished.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await unfinished
        if waiting in done:
            return True
        if faulted in done:
            raise SpeechFault(f"a speech leg refused this turn: {self._fault}")
        if not done:
            return False
        raise PipelineGone("the voice pipeline ended before the turn did")

    def _before_turn(self) -> None:
        """Forget any earlier refusal, so a turn answers for itself.

        A leg can complain between turns — a transcriber reconnecting says
        so — and an exchange that carried on regardless is an exchange
        that was fine. What ends a simulation is a refusal landing while a
        turn is waiting on the leg that refused.
        """
        self._faulted.clear()
        self._fault = ""

    async def _finish(self) -> None:
        """Stop recording, write what was heard, and end the pipeline.

        Safe in every state the walk can close from: never opened, opened
        and finished, and opened and faulted. A recording that cannot be
        written is logged and dropped — it would otherwise eat the walk's
        own answer, and the report simply carries no audio.
        """
        try:
            await self._end_pipeline()
        finally:
            # The legs were built when the pipeline was assembled, so they
            # have something to release even if the exchange never opened.
            await self._legs.aclose()

    async def _end_pipeline(self) -> None:
        if self._running is None:
            return
        try:
            with contextlib.suppress(Exception):
                await self._recorder.stop_recording()
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
        await self._write_recording()

    async def _write_recording(self) -> None:
        if self._tracks is None:
            return
        persona_audio, agent_audio, measured_band_hz = self._tracks
        if not persona_audio and not agent_audio:
            return
        try:
            reference = await self._blobs.write(
                self._recording_key,
                dual_channel_wav(persona_audio, agent_audio, measured_band_hz),
            )
        except Exception:
            logger.exception("the recording could not be written; reporting none")
            return
        self.audio = AudioFacts(
            measured_sample_rate_hz=measured_band_hz, recording=reference
        )


def dual_channel_wav(
    persona_audio: bytes, agent_audio: bytes, sample_rate_hz: int
) -> bytes:
    """Both sides of one exchange, one speaker to a channel.

    The persona on channel 0 and the agent on channel 1, in the order the
    transcript labels them, so each side can be heard alone when a
    transcript looks wrong. The two tracks come from the pipeline's audio
    buffer, which holds each speaker's audio and keeps the pair the same
    length; the shorter one is padded with quiet so a file never runs out
    halfway through the exchange. On a transport carrying audio in real
    time the buffer's quiet is the other side's clock; a counterpart that
    answers faster than real time — the loopback does — leaves a file that
    is each side in order rather than a faithful clock.
    """
    frames = max(len(persona_audio), len(agent_audio)) // SAMPLE_WIDTH_BYTES
    interleaved = array("h", bytes(frames * 2 * SAMPLE_WIDTH_BYTES))
    interleaved[PERSONA_CHANNEL::2] = _samples(persona_audio, frames)
    interleaved[AGENT_CHANNEL::2] = _samples(agent_audio, frames)

    written = io.BytesIO()
    with wave.open(written, "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(SAMPLE_WIDTH_BYTES)
        out.setframerate(sample_rate_hz)
        out.writeframes(_as_pcm(interleaved))
    return written.getvalue()


def channels_of(wav_bytes: bytes) -> tuple[bytes, bytes, int]:
    """One recording, taken apart: persona, agent, and the band it holds."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as recording:
        if recording.getnchannels() != 2:
            raise ValueError("the recording is not dual-channel")
        sample_rate_hz = recording.getframerate()
        interleaved = _samples(
            recording.readframes(recording.getnframes()), recording.getnframes() * 2
        )
    return (
        _as_pcm(interleaved[PERSONA_CHANNEL::2]),
        _as_pcm(interleaved[AGENT_CHANNEL::2]),
        sample_rate_hz,
    )


def _samples(pcm: bytes, frames: int) -> array:
    """PCM read as signed 16-bit samples, padded with quiet to ``frames``.

    ``array`` holds samples in this machine's byte order while PCM is
    always little-endian, so the two agree only on a little-endian
    machine and a swap is what makes them agree anywhere else.
    """
    samples = array("h")
    samples.frombytes(pcm[: frames * SAMPLE_WIDTH_BYTES])
    if sys.byteorder != "little":
        samples.byteswap()
    samples.extend([0] * (frames - len(samples)))
    return samples


def _as_pcm(samples: array) -> bytes:
    """Signed 16-bit samples written back out as little-endian PCM."""
    if sys.byteorder == "little":
        return samples.tobytes()
    little_endian = array("h", samples)
    little_endian.byteswap()
    return little_endian.tobytes()
