"""Real ears, proved on their own — opt-in.

The listening leg has one job: turn speech into the words of the
transcript. This test proves exactly that and nothing else, so a failure
here names the ears. The audio is a checked-in recording of one spoken
sentence — no synthesis, no account for the other leg, no telephony — and
it enters the same Pipecat pipeline a live simulation uses.

Silero listens for *whether* anybody is speaking, because the scripted
detector reads the test codec and this recording is a real voice. That is
one line of configuration and no second code path: the detector is chosen
at assembly exactly as the ears are.

It is opt-in because CI holds no Deepgram account, and it skips — visibly
— on that one credential alone::

    DEEPGRAM_API_KEY=... uv run pytest tests/test_live_deepgram.py -v

``TEST_DEEPGRAM_API_KEY`` is read first, for a machine that keeps its test
credentials apart from its working ones.
"""

from __future__ import annotations

import asyncio
import contextlib
import wave
from pathlib import Path

import pytest
from conftest import credential, words_of
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    StartFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.conductor import VoiceConductor
from egma_simulator.conversation import ConversationControls
from egma_simulator.media import VoiceMedia
from egma_simulator.model import ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.spec import AuthoredPersona
from egma_simulator.speech import (
    SAMPLE_WIDTH_BYTES,
    PersonaVoice,
    SpeechProviders,
)

DEEPGRAM_API_KEY = credential("TEST_DEEPGRAM_API_KEY", "DEEPGRAM_API_KEY")

pytestmark = pytest.mark.skipif(
    not DEEPGRAM_API_KEY,
    reason=(
        "no live Deepgram credential: set TEST_DEEPGRAM_API_KEY to hear a "
        "real transcriber read a real sentence"
    ),
)

SPOKEN = (
    Path(__file__).resolve().parents[3]
    / "fixtures"
    / "spoken-sentence"
    / "one-sentence.wav"
)
SENTENCE = "Move my Tuesday cleaning to Thursday, please."

QUIET_AFTER_SECONDS = 3.0
"""How much quiet follows the sentence on the line. Enough for the
detector to hear the speaker stop and the turn model to call the turn
over, spent in audio rather than on a clock."""


FRAME_SECONDS = 0.02


class _OneSentenceInput(FrameProcessor):
    """Put one real recording into a running Pipecat pipeline."""

    def __init__(self, pcm: bytes, band: int) -> None:
        super().__init__()
        self._band = band
        self._saying = pcm + bytes(
            round(QUIET_AFTER_SECONDS * band) * SAMPLE_WIDTH_BYTES
        )
        self._active = asyncio.Event()
        self.ended = asyncio.Event()
        self._pump: asyncio.Task | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if isinstance(frame, StartFrame):
            self._pump = self.create_task(self._run(), name="one-sentence-input")
        elif isinstance(frame, (EndFrame, CancelFrame)):
            self.ended.set()
            if self._pump is not None and not self._pump.done():
                self._pump.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._pump

    async def _run(self) -> None:
        await self._active.wait()
        width = round(FRAME_SECONDS * self._band) * SAMPLE_WIDTH_BYTES
        chunks = [
            self._saying[offset : offset + width]
            for offset in range(0, len(self._saying), width)
        ]
        for position, audio in enumerate(chunks):
            if position == len(chunks) - 1:
                self.ended.set()
            await self.push_frame(
                InputAudioRawFrame(
                    audio=audio,
                    sample_rate=self._band,
                    num_channels=1,
                )
            )
            await asyncio.sleep(FRAME_SECONDS)

    def open(self) -> None:
        self._active.set()


class OneSentenceConnection:
    """A voice connection whose far end is one checked-in sentence."""

    def __init__(self, pcm: bytes, band: int) -> None:
        self._input = _OneSentenceInput(pcm, band)

    @property
    def provider_reference(self) -> str | None:
        return None

    @property
    def far_end_left(self) -> bool:
        return self._input.ended.is_set()

    async def prepare(self) -> VoiceMedia:
        return VoiceMedia(input=(self._input,), output=(), ended=self._input.ended)

    async def open(self) -> None:
        self._input.open()

    async def close(self) -> None:
        self._input.ended.set()


def a_spoken_sentence() -> tuple[bytes, int]:
    with wave.open(str(SPOKEN), "rb") as recorded:
        assert recorded.getnchannels() == 1
        assert recorded.getsampwidth() == 2
        return recorded.readframes(recorded.getnframes()), recorded.getframerate()


async def test_a_real_transcriber_reads_a_real_sentence(tmp_path: Path):
    pcm, band = a_spoken_sentence()
    conductor = VoiceConductor(
        connection=OneSentenceConnection(pcm, band),
        voice=PersonaVoice(voice_id="unused", provider=None, speed=None),
        blobs=FilesystemBlobStore(tmp_path),
        recording_key="sim-live-deepgram/dual-channel.wav",
        speech=SpeechProviders(
            stt="deepgram", vad="silero", stt_key=DEEPGRAM_API_KEY
        ),
    )
    heard: list[tuple[str, str]] = []

    async def on_utterance(speaker: str, text: str, began: int, ended: int) -> None:
        heard.append((speaker, text))

    async def on_measured(measure: str, began: int, ended: int) -> None:
        return None

    await conductor.conduct(
        persona=Persona(
            authored=AuthoredPersona(
                name="Alex", personality="Patient.", language="en-US"
            ),
            scenario_instructions="Anything; the line does not listen.",
            model=ScriptedModel("Anything; the line does not listen."),
        ),
        max_turns=8,
        max_duration_seconds=120,
        controls=ConversationControls(),
        name="sim:live-deepgram",
        on_utterance=on_utterance,
        on_measured=on_measured,
    )

    # Word for word is not what a transcriber owes — it capitalises,
    # punctuates and occasionally hears a name its own way. What it owes
    # is the sentence, and most of these words surviving is what that
    # honestly means.
    said = " ".join(text for speaker, text in heard if speaker == "agent")
    assert said.strip(), f"the transcriber returned nothing: {heard}"
    expected = words_of(SENTENCE)
    survived = expected & words_of(said)
    assert len(survived) >= len(expected) * 0.6, (
        f"the transcriber heard {said!r} where the recording says {SENTENCE!r}"
    )
