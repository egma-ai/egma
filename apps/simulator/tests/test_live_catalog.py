"""Every visible catalog entry, both ways to reach it — opt-in.

**What a catalog entry promises.** A provider-job pair becomes visible
only when all three paths behind it exist: customer-owned execution,
managed execution through the Egma model gateway, and a live proof using
the recommended default. The first two are held down by the deterministic
suites — strict provider-shaped servers, the 2x2 access matrix, the
gateway's own black-box tests. **This file is the third.** It runs the
recommended default of every visible entry against the real provider,
twice: once straight at the provider with a provider key, and once
through the deployed Egma model gateway with an inference credential.

Nothing here is a mock and nothing here is deterministic. It is opt-in
because CI holds no provider account and no deployed gateway, and it
skips — visibly, never failing — on the credentials it does not have::

    OPENAI_API_KEY=... DEEPGRAM_API_KEY=... CARTESIA_API_KEY=... \\
    EGMA_GATEWAY_ORIGIN=https://... EGMA_GATEWAY_INFERENCE_KEY=... \\
    uv run pytest tests/test_live_catalog.py -v

The direct half runs on provider keys alone; the gateway half needs the
two gateway values as well and skips without them. **The two halves are
deliberately separable**: a provider account that works and a gateway
that does not is a different failure from either of them being broken,
and a run that could not tell them apart would be worth less than one
that names which.

**Spend is kept small on purpose.** One short utterance, one short
sentence to speak, one short question to answer, once per entry per path.
The recorded evidence is what the run is for; a longer workload would
prove the same thing and cost more.

The grader's own provider client is proved separately, in
``apps/grader/test/live-catalog.test.ts``. It is a second caller of one
of these entries and it does not share this one's client, so the
specification asks for both.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from pipecat.frames.frames import (
    EndFrame,
    Frame,
    InputAudioRawFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    TextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.workers.runner import WorkerRunner

from egma_simulator.model import OpenAICompatibleModel
from egma_simulator.speech import (
    SAMPLE_WIDTH_BYTES,
    SELECTED_STT_LEG,
    PersonaVoice,
    SpeechProviders,
    build_legs,
)
from egma_simulator.spec import GATEWAY_ROUTE

BAND_HZ = 16_000
"""The band this proof runs at. Wideband, so neither leg is asked to
resample and neither path pays a cost the other does not."""

SLICE_MS = 20
"""How much audio one frame carries — a phone line's own slice size."""

TRAILING_SILENCE_SECONDS = 1.5
"""How much quiet follows the sentence, so a provider's own endpointing
has something to end the turn on."""

SPOKEN = (
    Path(__file__).resolve().parents[3]
    / "fixtures"
    / "spoken-sentence"
    / "one-sentence.wav"
)
"""The proof's utterance: one real recorded sentence, checked in, so
every entry and every path hears exactly the same words."""

HEARD = "thursday"
"""One word every transcriber must return, whatever it does with the
punctuation and the capitals around it. Asserting the whole sentence
would fail on a comma."""

TO_SAY = "Thursday at ten works."
"""What every speaking leg is asked to say. Short, because this proves
that audio comes back rather than that a lot of it does."""

ASKED = "Reply with exactly the word: Relayed."
"""What every thinking leg is asked. Short, and its answer is checkable
without judging anything."""


@dataclass(frozen=True)
class Entry:
    """One visible catalog entry, and the default this release proved.

    **These are the provider catalog's own values, restated here** because
    the catalog is release data in the control plane and this process
    cannot import it. A deterministic test in the gateway suite reads this
    literal out of this file and holds it against the catalog, so a
    recommended default that moves without its live proof moving fails
    there rather than being discovered by a customer.
    """

    provider: str
    job: str
    model: str
    voice: str | None = None


CATALOG = (
    Entry(provider="openai", job="llm", model="gpt-4o-mini"),
    Entry(provider="deepgram", job="stt", model="nova-3-general"),
    Entry(provider="openai", job="stt", model="gpt-live-transcribe"),
    Entry(
        provider="cartesia",
        job="tts",
        model="sonic-3.5",
        voice="5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    ),
    Entry(provider="openai", job="tts", model="gpt-4o-mini-tts", voice="alloy"),
)

PROVIDER_KEY_NAMES = {
    "openai": "OPENAI_API_KEY",
    "deepgram": "DEEPGRAM_API_KEY",
    "cartesia": "CARTESIA_API_KEY",
}


def _credential(name: str) -> str | None:
    """A credential, preferring the test-only spelling of its name.

    The same shape every other opt-in file here uses, so a machine that
    keeps its test credentials apart from its working ones does not have
    to choose between them.
    """
    for spelling in (f"TEST_{name}", name):
        value = os.environ.get(spelling, "").strip()
        if value:
            return value
    return None


@dataclass(frozen=True)
class Reach:
    """One of the two ways the same entry is reached.

    ``base`` is where the leg is told to go and ``key`` is what it is
    handed. **On the gateway path the key is the Egma inference
    credential in every slot** — which is the whole of what a managed
    simulator holds. It never sees a provider key, and that is the claim
    this file is here to test rather than assert.
    """

    name: str
    base: str | None
    key: str


def _reaches(entry: Entry) -> list[Reach]:
    """Both ways to reach one entry, or the ones this run can take."""
    reaches: list[Reach] = []
    provider_key = _credential(PROVIDER_KEY_NAMES[entry.provider])
    if provider_key:
        reaches.append(Reach(name="direct", base=None, key=provider_key))

    origin = os.environ.get("EGMA_GATEWAY_ORIGIN", "").strip().rstrip("/")
    gateway_key = _gateway_credential()
    suffix = GATEWAY_ROUTE.get(entry.provider, {}).get(entry.job)
    if origin and gateway_key and suffix:
        reaches.append(Reach(name="gateway", base=f"{origin}{suffix}", key=gateway_key))
    return reaches


def _gateway_credential() -> str | None:
    """What this run presents to the Egma model gateway.

    **Two shapes, because the product has two**, and either one proves the
    same thing about a route. A self-hosted deployment holds a real
    inference key and sends it as it stands. Hosted Egma holds no key at
    all: it signs a short-lived assertion of the organization it is acting
    for with the key it shares with the gateway, and the gateway checks
    that on its own without asking anybody. Whichever this machine has is
    what a leg is handed.
    """
    key = _credential("EGMA_GATEWAY_INFERENCE_KEY")
    if key:
        return key

    signing = _credential("EGMA_GATEWAY_INTERNAL_KEY")
    organization = os.environ.get("EGMA_GATEWAY_ORGANIZATION_ID", "").strip()
    if not signing or not organization:
        return None

    payload = (
        base64.urlsafe_b64encode(
            json.dumps(
                {"o": organization, "x": int(time.time()) + 3600},
                separators=(",", ":"),
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    signature = (
        base64.urlsafe_b64encode(
            hmac.new(signing.encode(), payload.encode(), hashlib.sha256).digest()
        )
        .decode()
        .rstrip("=")
    )
    return f"egma_ig_{payload}.{signature}"


def _cases() -> list[tuple[Entry, Reach]]:
    return [(entry, reach) for entry in CATALOG for reach in _reaches(entry)]


def _identify(case: tuple[Entry, Reach]) -> str:
    entry, reach = case
    return f"{entry.provider}-{entry.job}-{reach.name}"


COMPANION = {
    "stt": Entry(provider="deepgram", job="stt", model="nova-3-general"),
    "tts": Entry(
        provider="cartesia",
        job="tts",
        model="sonic-3.5",
        voice="5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    ),
}
"""The other leg of the pair, for the leg that is not under test.

**A voice pipeline has a mouth and ears whichever of them is being
proved**, and under managed access the simulator refuses to *build* a
pair where either leg has no gateway route — because a leg with no
address would otherwise open a connection straight at the provider
holding an Egma credential. So the leg that is not being driven is still
configured as a real managed leg. It is constructed and never started, so
it opens nothing and costs nothing; what it does is keep this proof
running the same factory a managed simulation runs, refusal check and
all, rather than a relaxed version of it.
"""


def _pair(entry: Entry, reach: Reach) -> SpeechProviders:
    """One managed or direct speech pair, with this entry as the leg under test."""
    speaking = entry if entry.job == "tts" else COMPANION["tts"]
    listening = entry if entry.job == "stt" else COMPANION["stt"]

    def base(of: Entry) -> str | None:
        if reach.name != "gateway":
            return None
        origin = os.environ["EGMA_GATEWAY_ORIGIN"].strip().rstrip("/")
        return f"{origin}{GATEWAY_ROUTE[of.provider][of.job]}"

    return SpeechProviders(
        # The catalog's word for a provider, translated to the leg that
        # serves it by the product's own map rather than by this file — so
        # what is proved here is the adapter a persona really gets.
        stt=SELECTED_STT_LEG.get(listening.provider, listening.provider),
        tts=speaking.provider,
        stt_key=reach.key,
        tts_key=reach.key,
        stt_model=listening.model,
        tts_model=speaking.model,
        tts_voice=speaking.voice,
        stt_base_url=base(listening),
        tts_base_url=base(speaking),
        managed=reach.name == "gateway",
    )


class _Heard(FrameProcessor):
    """What came out of a real leg, kept so a test can read it back.

    Deliberately not a mock of anything: it sits after the real service in
    a real pipeline and reads the frames that service really emitted.
    """

    def __init__(self) -> None:
        super().__init__()
        self.transcripts: list[str] = []
        self.audio_bytes = 0
        self.first_audio_at: float | None = None

    @property
    def transcript(self) -> str:
        return " ".join(self.transcripts).strip()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            self.transcripts.append(frame.text.strip())
        elif isinstance(frame, TTSAudioRawFrame):
            if self.first_audio_at is None:
                self.first_audio_at = time.monotonic()
            self.audio_bytes += len(frame.audio)
        await self.push_frame(frame, direction)


async def _running(processors: list[FrameProcessor]) -> tuple[PipelineWorker, Any]:
    worker = PipelineWorker(
        Pipeline(processors),
        params=PipelineParams(
            audio_in_sample_rate=BAND_HZ, audio_out_sample_rate=BAND_HZ
        ),
        idle_timeout_secs=None,
        enable_turn_tracking=False,
        enable_rtvi=False,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    return worker, asyncio.create_task(runner.run())


async def _stop(worker: PipelineWorker, task: Any) -> None:
    try:
        await worker.queue_frame(EndFrame())
        await asyncio.wait_for(task, timeout=10)
    except (TimeoutError, asyncio.CancelledError, RuntimeError):
        task.cancel()


def _the_sentence() -> bytes:
    with wave.open(str(SPOKEN)) as recorded:
        assert recorded.getframerate() == BAND_HZ
        return recorded.readframes(recorded.getnframes())


async def _transcribed(entry: Entry, reach: Reach) -> str:
    """One recorded sentence through one real listening leg."""
    providers = _pair(entry, reach)
    legs = build_legs(
        providers,
        voice=PersonaVoice(voice_id="unused", provider=None, speed=None),
        sample_rate_hz=BAND_HZ,
    )
    heard = _Heard()
    worker, task = await _running([legs.stt, heard])
    try:
        await legs.ready()
        line = _the_sentence() + bytes(
            round(TRAILING_SILENCE_SECONDS * BAND_HZ) * SAMPLE_WIDTH_BYTES
        )
        slice_bytes = BAND_HZ * SLICE_MS // 1000 * SAMPLE_WIDTH_BYTES
        for offset in range(0, len(line), slice_bytes):
            carried = line[offset : offset + slice_bytes]
            await worker.queue_frame(
                InputAudioRawFrame(
                    audio=carried.ljust(slice_bytes, b"\x00"),
                    sample_rate=BAND_HZ,
                    num_channels=1,
                )
            )
            await asyncio.sleep(SLICE_MS / 1000)

        # The frame the detector in a real pipeline pushes when the far end
        # stops talking. A streaming leg that endpoints for itself ignores
        # it; the realtime leg is built in local-VAD mode and commits the
        # utterance on it, which is where egma keeps the turn boundary.
        await worker.queue_frame(VADUserStoppedSpeakingFrame())

        for _ in range(1500):
            if heard.transcript:
                break
            await asyncio.sleep(0.02)
        return heard.transcript
    finally:
        await _stop(worker, task)
        await legs.aclose()


async def _spoken(entry: Entry, reach: Reach) -> int:
    """One short sentence through one real speaking leg."""
    providers = _pair(entry, reach)
    legs = build_legs(
        providers,
        voice=PersonaVoice(
            voice_id=entry.voice or "unused", provider=entry.provider, speed=None
        ),
        sample_rate_hz=BAND_HZ,
    )
    spoke = _Heard()
    worker, task = await _running([legs.tts, spoke])
    try:
        # The three frames the conductor really pushes around a persona
        # turn. A bare text frame is not what a speaking leg is given, and
        # a leg that aggregates would hold it until the pipeline closed —
        # which would make this proof pass or fail on the harness rather
        # than on the provider.
        await worker.queue_frame(LLMFullResponseStartFrame())
        await worker.queue_frame(TextFrame(TO_SAY))
        await worker.queue_frame(LLMFullResponseEndFrame())
        for _ in range(1500):
            if spoke.audio_bytes > 0:
                break
            await asyncio.sleep(0.02)
        return spoke.audio_bytes
    finally:
        await _stop(worker, task)
        await legs.aclose()


async def _thought(entry: Entry, reach: Reach) -> str:
    """One short question through the simulator's own model client.

    The product's client rather than a request this file writes, because
    what has to cross is the shape the simulator really sends.
    """
    model = OpenAICompatibleModel(
        base_url=reach.base or "https://api.openai.com/v1",
        api_key=reach.key,
        model_name=entry.model,
    )
    try:
        answered = await model.reply(
            [
                {"role": "system", "content": "Answer with one word and nothing else."},
                {"role": "user", "content": ASKED},
            ]
        )
        return answered.text
    finally:
        await model.close()


@pytest.mark.parametrize("case", _cases(), ids=_identify)
def test_a_visible_catalog_entry_works_on_this_path(
    case: tuple[Entry, Reach],
) -> None:
    """The recommended default, against the real provider, both ways.

    One test rather than one per job, because what is being proved is one
    thing: that this entry, on this path, does the work its catalog row
    says it does. Which of the three jobs it is decides how it is asked,
    and nothing else.
    """
    entry, reach = case

    if entry.job == "stt":
        heard = asyncio.run(_transcribed(entry, reach))
        assert HEARD in heard.lower(), (
            f"{entry.provider} {entry.job} on the {reach.name} path returned "
            f"{heard!r}, which is not the sentence that was spoken"
        )
    elif entry.job == "tts":
        bytes_back = asyncio.run(_spoken(entry, reach))
        assert bytes_back > 4_000, (
            f"{entry.provider} {entry.job} on the {reach.name} path returned "
            f"{bytes_back} bytes of audio, which is not a spoken sentence"
        )
    else:
        said = asyncio.run(_thought(entry, reach))
        assert "relayed" in said.lower(), (
            f"{entry.provider} {entry.job} on the {reach.name} path answered "
            f"{said!r}"
        )


def test_this_run_reached_both_paths_for_every_entry() -> None:
    """The check that a green run really was the proof it looks like.

    Every case above skips silently by not existing when its credential is
    absent, which is right for a file CI collects and cannot run — and
    wrong for a person who set the credentials and wants to know the whole
    matrix was covered. So the matrix itself is asserted once, and it is
    the assertion an evidence record is written from.
    """
    reached = {(entry.provider, entry.job, reach.name) for entry, reach in _cases()}
    missing = [
        f"{entry.provider}/{entry.job} {path}"
        for entry in CATALOG
        for path in ("direct", "gateway")
        if (entry.provider, entry.job, path) not in reached
    ]
    if missing:
        pytest.skip(
            "this run holds no credential for: " + ", ".join(missing)
        )
    assert len(reached) == len(CATALOG) * 2
