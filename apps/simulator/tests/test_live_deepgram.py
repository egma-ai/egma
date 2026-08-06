"""Real ears, proved on their own — opt-in.

The listening leg has one job: turn speech into the words of the
transcript. This test proves exactly that and nothing else, so a failure
here names the ears. The audio is a checked-in recording of one spoken
sentence — no synthesis, no account for the other leg, no telephony — and
it is handed to the leg the way the pipeline hands over an agent's turn.

It is opt-in because CI holds no Deepgram account, and it skips — visibly
— on that one credential alone::

    DEEPGRAM_API_KEY=... uv run pytest tests/test_live_deepgram.py -v

``TEST_DEEPGRAM_API_KEY`` is read first, for a machine that keeps its test
credentials apart from its working ones.
"""

from __future__ import annotations

import wave
from pathlib import Path

import pytest
from conftest import credential, words_of

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.pipeline import VoicePipeline
from egma_simulator.plugs import AgentSpeech, Utterance
from egma_simulator.speech import PersonaVoice, SpeechProviders

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


class OneSentenceCounterpart:
    """A counterpart whose whole exchange is the recorded sentence.

    It exists so this test can stay about the ears: it never listens to
    what the persona says, and it answers with the same real speech every
    time. It is otherwise an ordinary voice plug, so what the pipeline
    does with its audio is what the pipeline does with any plug's.
    """

    def __init__(self, pcm: bytes, band: int) -> None:
        self._pcm = pcm
        self._band = band

    @property
    def provider_reference(self) -> str | None:
        return None

    @property
    def sample_rate_hz(self) -> int:
        return self._band

    async def open(self) -> AgentSpeech | None:
        return None

    async def deliver(self, speech: Utterance) -> AgentSpeech:
        del speech
        return AgentSpeech(
            audio=Utterance(pcm=self._pcm, sample_rate_hz=self._band), ended=True
        )

    async def close(self) -> None:
        return None


def a_spoken_sentence() -> tuple[bytes, int]:
    with wave.open(str(SPOKEN), "rb") as recorded:
        assert recorded.getnchannels() == 1
        assert recorded.getsampwidth() == 2
        return recorded.readframes(recorded.getnframes()), recorded.getframerate()


async def test_a_real_transcriber_reads_a_real_sentence(tmp_path: Path):
    pcm, band = a_spoken_sentence()
    legs = VoicePipeline(
        transport=OneSentenceCounterpart(pcm, band),
        voice=PersonaVoice(voice_id="unused", provider=None, speed=None),
        blobs=FilesystemBlobStore(tmp_path),
        recording_key="sim-live-deepgram/dual-channel.wav",
        speech=SpeechProviders(stt="deepgram", deepgram_api_key=DEEPGRAM_API_KEY),
    )

    await legs.open()
    try:
        answer = await legs.deliver("Anything; the counterpart does not listen.")
    finally:
        await legs.close()

    # Word for word is not what a transcriber owes — it capitalises,
    # punctuates and occasionally hears a name its own way. What it owes
    # is the sentence, and most of these words surviving is what that
    # honestly means.
    assert answer.text, "the transcriber returned nothing"
    expected = words_of(SENTENCE)
    survived = expected & words_of(answer.text)
    assert len(survived) >= len(expected) * 0.6, (
        f"the transcriber heard {answer.text!r} where the recording says "
        f"{SENTENCE!r}"
    )
