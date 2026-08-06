"""Pipeline assembly: what one simulation is conducted through.

One pipeline is built from one claimed spec and torn down when the
exchange is over, so nothing from one simulation can reach the next. What
the spec selects is only which legs are in it: a chat simulation is the
plug and the persona brain, and a voice simulation is the same plug and
the same brain with speech legs between them. The brain is one component
for every modality, forever — it never learns which of these it is in.

The voice legs are Pipecat's: the persona's words are spoken by a
text-to-speech service, the agent's audio is transcribed by a
speech-to-text service, and both directions run through Pipecat's own
audio buffer, which is what keeps the two speakers in step and gives the
recording a channel each. Turn-taking is deliberately *not* Pipecat's
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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from pipecat.frames.frames import (
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
    PersonaVoice,
    ScriptedSTT,
    ScriptedTTS,
    duration_seconds,
    leading_silence_seconds,
    spoken_seconds,
    voice_from_traits,
)

logger = logging.getLogger(__name__)

OnTiming = Callable[[str, float], Awaitable[None]]

RECORDING_NAME = "dual-channel.wav"
"""What one simulation's recording is called inside its own blob key."""

TEARDOWN_SECONDS = 10.0
"""How long a torn-down pipeline may take to finish before it is cancelled."""

PERSONA_CHANNEL = 0
AGENT_CHANNEL = 1
"""Who is on which channel of a recording. The transcript's two labels in
the transcript's own order, so the file needs no legend to be read."""


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
    spec: SimulationSpec, *, blobs: BlobStore, on_timing: OnTiming | None = None
) -> Assembled:
    """Build one simulation's pipeline from its spec.

    Constructing is validation and nothing else — no platform is dialled
    and no pipeline is started until the walk opens the exchange — so a
    spec that cannot be conducted fails here, honestly, before anything
    happens.
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
    )
    if spec.modality != "voice":
        return Assembled(plug=plug, voice=None)

    speech_legs = VoicePipeline(
        transport=plug,
        voice=voice_from_traits(spec.persona_traits),
        blobs=blobs,
        recording_key=f"{spec.simulation_id}/{RECORDING_NAME}",
        on_timing=on_timing,
    )
    return Assembled(plug=speech_legs, voice=speech_legs)


class _TurnSink(FrameProcessor):
    """The end of the pipeline, where a turn is known to be over.

    Two frames are what the pipeline is driven by: the end of an LLM
    response means the persona's words have all been spoken, and a
    transcription means the agent's audio has all been read. Waiting for
    those rather than for a length of time is what keeps a voice walk as
    deterministic as a chat one.
    """

    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.spoken = asyncio.Event()
        self.heard = asyncio.Event()
        self.transcript = ""
        self._persona_audio = bytearray()

    def before_speaking(self) -> None:
        self.spoken.clear()
        self._persona_audio.clear()

    def before_hearing(self) -> None:
        self.heard.clear()
        self.transcript = ""

    def spoken_audio(self) -> bytes:
        return bytes(self._persona_audio)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, StartFrame):
            self.started.set()
        elif isinstance(frame, TTSAudioRawFrame):
            self._persona_audio.extend(frame.audio)
        elif isinstance(frame, LLMFullResponseEndFrame):
            self.spoken.set()
        elif isinstance(frame, TranscriptionFrame):
            self.transcript = frame.text
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
        on_timing: OnTiming | None = None,
    ) -> None:
        self._transport = transport
        self._band_hz = transport.sample_rate_hz
        self._blobs = blobs
        self._recording_key = recording_key
        self._on_timing = on_timing

        self._tts = ScriptedTTS(voice=voice, sample_rate_hz=self._band_hz)
        self._stt = ScriptedSTT(sample_rate_hz=self._band_hz)
        self._recorder = AudioBufferProcessor(
            sample_rate=self._band_hz, num_channels=2
        )
        self._sink = _TurnSink()
        # Listening comes before speaking in the chain so that the persona's
        # own voice never reaches the transcriber: an STT service reads every
        # audio frame that passes it, and its own side's speech is not the
        # transcript.
        self._worker = PipelineWorker(
            Pipeline([self._stt, self._tts, self._recorder, self._sink]),
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

    async def open(self) -> str | None:
        await self._runner.add_workers(self._worker)
        self._running = asyncio.create_task(
            self._runner.run(), name="voice-pipeline"
        )
        await self._reach(self._sink.started)
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
        """
        self._sink.before_speaking()
        await self._worker.queue_frames(
            [
                LLMFullResponseStartFrame(),
                TextFrame(text),
                LLMFullResponseEndFrame(),
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
        self._sink.before_hearing()
        await self._worker.queue_frame(
            InputAudioRawFrame(
                audio=speech.pcm,
                sample_rate=speech.sample_rate_hz,
                num_channels=1,
            )
        )
        await self._reach(self._sink.heard)
        return self._sink.transcript

    async def _measure(self, measure: str, seconds: float) -> None:
        if self._on_timing is not None:
            await self._on_timing(measure, seconds * 1000)

    async def _reach(self, event: asyncio.Event) -> None:
        """Wait for one point in the pipeline, or say plainly that it is gone.

        Racing the wait against the pipeline's own task is what stops a
        pipeline that ended early — a leg that raised, a worker cancelled —
        from becoming a simulation that hangs until its duration limit.
        """
        if self._running is None:
            raise PlugError("the voice pipeline was driven before it was opened")
        waiting = asyncio.ensure_future(event.wait())
        try:
            done, _pending = await asyncio.wait(
                {waiting, self._running}, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            if not waiting.done():
                waiting.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await waiting
        if waiting not in done:
            raise PlugError("the voice pipeline ended before the turn did")

    async def _finish(self) -> None:
        """Stop recording, write what was heard, and end the pipeline.

        Safe in every state the walk can close from: never opened, opened
        and finished, and opened and faulted. A recording that cannot be
        written is logged and dropped — it would otherwise eat the walk's
        own answer, and the report simply carries no audio.
        """
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
    length; the shorter one is padded with quiet so a file is never half a
    conversation long. On a transport carrying audio in real time the
    buffer's quiet is the other side's clock; a counterpart that answers
    faster than real time — the loopback does — leaves a file that is each
    side in order rather than a faithful clock.
    """
    frames = max(len(persona_audio), len(agent_audio)) // SAMPLE_WIDTH_BYTES
    interleaved = array("h", bytes(frames * 2 * SAMPLE_WIDTH_BYTES))
    interleaved[PERSONA_CHANNEL::2] = _channel(persona_audio, frames)
    interleaved[AGENT_CHANNEL::2] = _channel(agent_audio, frames)
    if sys.byteorder != "little":
        interleaved.byteswap()

    written = io.BytesIO()
    with wave.open(written, "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(SAMPLE_WIDTH_BYTES)
        out.setframerate(sample_rate_hz)
        out.writeframes(interleaved.tobytes())
    return written.getvalue()


def channels_of(wav_bytes: bytes) -> tuple[bytes, bytes, int]:
    """One recording, taken apart: persona, agent, and the band it holds."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as recording:
        if recording.getnchannels() != 2:
            raise ValueError("the recording is not dual-channel")
        sample_rate_hz = recording.getframerate()
        interleaved = array("h")
        interleaved.frombytes(recording.readframes(recording.getnframes()))
    if sys.byteorder != "little":
        interleaved.byteswap()
    return (
        interleaved[PERSONA_CHANNEL::2].tobytes(),
        interleaved[AGENT_CHANNEL::2].tobytes(),
        sample_rate_hz,
    )


def _channel(pcm: bytes, frames: int) -> array:
    samples = array("h")
    samples.frombytes(pcm[: frames * SAMPLE_WIDTH_BYTES])
    if sys.byteorder != "little":
        samples.byteswap()
    samples.extend([0] * (frames - len(samples)))
    return samples
