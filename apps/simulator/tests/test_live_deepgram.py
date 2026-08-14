"""Real ears, proved on their own — opt-in.

The listening leg has one job: turn speech into the words of the
transcript. This test proves exactly that and nothing else, so a failure
here names the ears. The audio is a checked-in recording of one spoken
sentence — no synthesis, no account for the other leg, no telephony — and
it is carried to the leg the way a real line carries it: one slice at a
time, down a duplex line, through the same conductor a live simulation
uses.

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

import wave
from pathlib import Path

import pytest
from conftest import credential, words_of

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.conductor import VoiceConductor
from egma_simulator.model import ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.speech import (
    SAMPLE_WIDTH_BYTES,
    PersonaVoice,
    SpeechProviders,
)
from egma_simulator.walk import WalkControls

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


class OneSentenceLine:
    """A duplex line whose whole far end is the recorded sentence.

    It exists so this test can stay about the ears: it never listens to
    what the persona says, and it carries the same real speech every time.
    It is otherwise an ordinary line — the same slices in both directions,
    quiet included — so what the conductor does with its audio is what the
    conductor does with any line's.
    """

    def __init__(self, pcm: bytes, band: int) -> None:
        self._band = band
        self._saying = pcm + bytes(
            round(QUIET_AFTER_SECONDS * band) * SAMPLE_WIDTH_BYTES
        )
        self._left = False

    @property
    def provider_reference(self) -> str | None:
        return None

    @property
    def sample_rate_hz(self) -> int:
        return self._band

    @property
    def measured_band_hz(self) -> int | None:
        return self._band

    @property
    def far_end_left(self) -> bool:
        return self._left

    async def open(self) -> None:
        return None

    async def exchange(self, outgoing: bytes) -> bytes:
        wanted = len(outgoing)
        spoken, self._saying = self._saying[:wanted], self._saying[wanted:]
        if not self._saying:
            # Everything the recording had is on the line; the far end has
            # nothing left to say and goes, which is what ends the exchange.
            self._left = True
        return spoken.ljust(wanted, b"\x00")

    async def close(self) -> None:
        return None


def a_spoken_sentence() -> tuple[bytes, int]:
    with wave.open(str(SPOKEN), "rb") as recorded:
        assert recorded.getnchannels() == 1
        assert recorded.getsampwidth() == 2
        return recorded.readframes(recorded.getnframes()), recorded.getframerate()


async def test_a_real_transcriber_reads_a_real_sentence(tmp_path: Path):
    pcm, band = a_spoken_sentence()
    conductor = VoiceConductor(
        line=OneSentenceLine(pcm, band),
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
            traits={},
            scenario_instructions="Anything; the line does not listen.",
            model=ScriptedModel("Anything; the line does not listen."),
        ),
        max_turns=8,
        max_duration_seconds=120,
        controls=WalkControls(),
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
