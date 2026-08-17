"""One voice workload, timed twice: straight to the providers, and through
the Egma model gateway.

**What this is.** A proof tool, not product surface. Managed model access
puts one more network hop between the simulator and every model provider,
and the only honest way to know what that costs a voice conversation is
to run the same work both ways from the same place and read the clock.
Nothing here is imported by the simulator, and nothing the simulator does
depends on it.

**What it runs.** The same legs a real voice simulation is assembled
with, built by the same factory: Deepgram's ears and Cartesia's mouth
through :func:`egma_simulator.speech.build_legs`, driven inside a real
Pipecat pipeline, with an OpenAI chat completion between them. The whole
difference between the two paths is the address each leg is told and the
credential it is handed — which is the claim managed model access makes,
tested rather than asserted.

**What it measures**, per iteration, on both paths:

``stt_open`` and ``tts_open``
    How long each socket took to become usable. The listening leg's is
    read from the leg itself, which knows when it can hear; the speaking
    leg's is a handshake to the same address, because that service says
    nothing about when it connected.

``stt_finalization``
    From the last sample of real speech handed over to the final
    transcript coming back. Silence is fed after the sentence, exactly as
    a line carries it, so the provider's own endpointing decides when the
    turn ended rather than this file.

``llm_first_output``
    From the request leaving to the first token of the answer arriving.
    The request is streamed, because on a voice path what matters is when
    the first word exists and not when the last one does.

``llm_complete``
    From the request leaving to the answer finishing.

``tts_first_audio``
    From the words being handed to the speaking leg to the first frame of
    audio coming back.

``end_of_speech_to_first_persona_audio``
    One wall-clock span across all three, in one iteration: the last
    sample the agent spoke, to the first sample the persona speaks. This
    is the number a caller would feel, and it is measured rather than
    added up.

**Running it**, from ``apps/simulator``::

    DEEPGRAM_API_KEY=... OPENAI_API_KEY=... CARTESIA_API_KEY=... \\
    EGMA_GATEWAY_ORIGIN=https://your-gateway.example \\
    EGMA_GATEWAY_INFERENCE_KEY=... \\
    uv run --frozen python tools/gateway_latency.py --iterations 18 \\
        --out ../../results.json

Both paths leave from the same machine on the same egress, one after the
other, alternating, so a slow minute lands on both rather than on one.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import ssl
import statistics
import sys
import time
import wave
from array import array
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import aiohttp
from pipecat.frames.frames import (
    EndFrame,
    Frame,
    InputAudioRawFrame,
    TextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.workers.runner import WorkerRunner

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from egma_simulator.model import (  # noqa: E402
    MODEL_TIMEOUT_SECONDS,
    OpenAICompatibleModel,
)
from egma_simulator.speech import (  # noqa: E402
    SAMPLE_WIDTH_BYTES,
    PersonaVoice,
    SpeechProviders,
    build_legs,
)

BAND_HZ = 16_000
"""The band this workload runs at. Wideband, so neither leg is asked to
resample and neither path pays a cost the other does not."""

SLICE_MS = 20
"""How much audio one frame carries — a phone line's own slice size."""

TRAILING_SILENCE_SECONDS = 1.5
"""How much quiet follows the sentence, so the provider's endpointing
decides where the turn ended. Fed as real samples at real time, because
that is what a line carries and what the provider is listening to."""

SPOKEN = (
    Path(__file__).resolve().parents[3]
    / "fixtures"
    / "spoken-sentence"
    / "one-sentence.wav"
)
"""The workload's own utterance: one real recorded sentence, checked in,
so both paths and every run hear exactly the same words."""

DEEPGRAM_MODEL = "nova-3-general"
CARTESIA_MODEL = "sonic-3.5"
CARTESIA_VOICE = "5ee9feff-1265-424a-9d7f-8e4d431a12c7"
LLM_MODEL = os.environ.get("EGMA_LATENCY_LLM_MODEL", "gpt-4o-mini")

SYSTEM = (
    "You are a person on a phone call. Answer in one short sentence, "
    "under fifteen words. Do not ask a question."
)

STAGES = [
    "stt_open",
    "tts_open",
    "stt_finalization",
    "llm_first_output",
    "llm_complete",
    "tts_first_audio",
    "end_of_speech_to_first_persona_audio",
]


@dataclass
class Path_:
    """One of the two ways the same workload is run."""

    name: str
    stt_base_url: str | None
    tts_url: str | None
    llm_base_url: str
    stt_key: str
    tts_key: str
    llm_key: str
    """The credential each leg is handed. On the gateway path this is the
    Egma inference credential in every slot, which is the whole of what a
    managed simulator holds — it never sees a provider key."""

    llm_headers: dict[str, str] = field(default_factory=dict)


class _Collector(FrameProcessor):
    """Watches what comes out of a leg, and when.

    Deliberately not a mock of anything: it sits after the real service in
    a real pipeline and reads the frames that service really emitted.

    Every transcript is kept with the moment it arrived, because a
    streaming transcriber settles part of an utterance while the speaker
    is still talking. Which of those is the *finalization* depends on when
    the speaking stopped, and that is not this processor's to decide.
    """

    def __init__(self) -> None:
        super().__init__()
        self.transcripts: list[tuple[float, str]] = []
        self.first_audio_at: float | None = None
        self.audio_bytes: int = 0

    @property
    def transcript(self) -> str:
        return " ".join(text for _, text in self.transcripts).strip()

    def settled_after(self, moment: float) -> float | None:
        """When the transcript first settled at or after this moment."""
        for at, _ in self.transcripts:
            if at >= moment:
                return at
        return None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            self.transcripts.append((time.monotonic(), frame.text.strip()))
        elif isinstance(frame, TTSAudioRawFrame):
            if self.first_audio_at is None:
                self.first_audio_at = time.monotonic()
            self.audio_bytes += len(frame.audio)
        await self.push_frame(frame, direction)


async def _handshake_ms(address: str) -> float:
    """How long a socket to this address takes to become usable.

    A plain TCP and TLS handshake to the address a leg is told, which is
    what "connection open" means on a path where one end is a relay: it is
    the cost of reaching the endpoint, comparable between the two paths
    because it is measured the same way on both.
    """
    parsed = urlsplit(address.replace("wss://", "https://").replace("ws://", "http://"))
    secure = parsed.scheme == "https"
    port = parsed.port or (443 if secure else 80)
    began = time.monotonic()
    reader, writer = await asyncio.open_connection(
        parsed.hostname,
        port,
        ssl=ssl.create_default_context() if secure else None,
        server_hostname=parsed.hostname if secure else None,
    )
    opened = (time.monotonic() - began) * 1000
    writer.close()
    try:
        await writer.wait_closed()
    except (ConnectionError, ssl.SSLError):
        pass
    del reader
    return opened


QUIET_SAMPLE = 600
"""Below this, a sample is the room rather than the speaker.

The recording is trimmed to the words *and a short pause each side*, so
the end of the file is not the end of the speaking — and a finalization
measured from the end of the file would be measured from after the
provider had already finished, which is how a real number comes out
negative. This is what finds the last sample anybody actually spoke.
"""


def _speech_ends_at(pcm: bytes) -> int:
    """The byte offset just past the last sample of real speech."""
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) // SAMPLE_WIDTH_BYTES * SAMPLE_WIDTH_BYTES])
    if sys.byteorder != "little":
        samples.byteswap()
    for index in range(len(samples) - 1, -1, -1):
        if abs(samples[index]) >= QUIET_SAMPLE:
            return (index + 1) * SAMPLE_WIDTH_BYTES
    return len(pcm)


def _spoken_sentence() -> bytes:
    with wave.open(str(SPOKEN), "rb") as recorded:
        assert recorded.getnchannels() == 1, "the workload's utterance is mono"
        assert recorded.getsampwidth() == SAMPLE_WIDTH_BYTES
        assert recorded.getframerate() == BAND_HZ, (
            f"the workload runs at {BAND_HZ} Hz and the recording is "
            f"{recorded.getframerate()} Hz"
        )
        return recorded.readframes(recorded.getnframes())


async def _run_pipeline(processors: list[FrameProcessor]) -> tuple[PipelineWorker, Any]:
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
    running = asyncio.create_task(runner.run())
    return worker, running


async def _llm(
    session: aiohttp.ClientSession, path: Path_, said: str
) -> tuple[float, float, str]:
    """One streamed completion: when the first word existed, when the last did.

    Streamed rather than waited for, because a voice path cares about the
    first token. The simulator's own client is non-streaming today and is
    exercised once per path beside this, so both shapes are proved to
    cross the gateway.
    """
    began = time.monotonic()
    first: float | None = None
    said_back: list[str] = []
    async with session.post(
        f"{path.llm_base_url}/chat/completions",
        json={
            "model": LLM_MODEL,
            "stream": True,
            "max_tokens": 40,
            "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": said},
            ],
        },
        headers={"Authorization": f"Bearer {path.llm_key}", **path.llm_headers},
        timeout=aiohttp.ClientTimeout(total=MODEL_TIMEOUT_SECONDS),
    ) as answer:
        answer.raise_for_status()
        async for raw in answer.content:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            body = line[len("data:") :].strip()
            if body == "[DONE]":
                break
            piece = json.loads(body)
            delta = piece.get("choices", [{}])[0].get("delta", {}).get("content")
            if delta:
                if first is None:
                    first = time.monotonic()
                said_back.append(delta)
    complete = time.monotonic()
    return (
        ((first or complete) - began) * 1000,
        (complete - began) * 1000,
        "".join(said_back).strip() or "Thanks very much.",
    )


async def one_iteration(
    path: Path_, session: aiohttp.ClientSession, spoken: bytes
) -> dict[str, float | str]:
    """The whole workload once: hear a sentence, think, and start speaking."""
    providers = SpeechProviders(
        stt="deepgram",
        tts="cartesia",
        vad="silero",
        stt_key=path.stt_key,
        tts_key=path.tts_key,
        stt_model=DEEPGRAM_MODEL,
        tts_model=CARTESIA_MODEL,
        tts_voice=CARTESIA_VOICE,
        **({"stt_base_url": path.stt_base_url} if path.stt_base_url else {}),
        **({"tts_base_url": path.tts_url} if path.tts_url else {}),
    )
    legs = build_legs(
        providers,
        voice=PersonaVoice(voice_id=CARTESIA_VOICE, provider="cartesia", speed=None),
        sample_rate_hz=BAND_HZ,
    )

    ears = _Collector()
    mouth = _Collector()
    listening, listening_task = await _run_pipeline([legs.stt, ears])
    speaking, speaking_task = await _run_pipeline([legs.tts, mouth])

    measured: dict[str, float | str] = {}
    carrying: asyncio.Task[None] | None = None
    try:
        # The listening leg says itself when it can hear; the speaking leg
        # says nothing, so its socket is timed at the address it was told.
        opening = time.monotonic()
        await legs.ready()
        measured["stt_open"] = (time.monotonic() - opening) * 1000
        measured["tts_open"] = await _handshake_ms(
            path.tts_url or "wss://api.cartesia.ai/tts/websocket"
        )

        # The sentence, at real time, one slice at a time — the way a line
        # carries it — and then quiet, so the provider's own endpointing
        # decides where the turn ended.
        slice_bytes = BAND_HZ * SLICE_MS // 1000 * SAMPLE_WIDTH_BYTES
        quiet = bytes(
            round(TRAILING_SILENCE_SECONDS * BAND_HZ) * SAMPLE_WIDTH_BYTES
        )
        line = spoken + quiet
        last_word_at = _speech_ends_at(spoken)
        stopped = asyncio.Event()
        end_of_speech: float | None = None

        async def carry_the_line() -> None:
            """The far end talking, and then not, at real time.

            **It keeps running while the rest of the turn happens**, which
            is what a line does: the agent stops speaking and the line
            carries their silence on, while the persona is already
            thinking. Feeding all of it first and only then starting to
            think would add the length of the pause to every measurement
            on both paths — an artefact of the harness, in the number the
            harness exists to report.
            """
            nonlocal end_of_speech
            for offset in range(0, len(line), slice_bytes):
                if end_of_speech is None and offset >= last_word_at:
                    end_of_speech = time.monotonic()
                    stopped.set()
                carried = line[offset : offset + slice_bytes]
                await listening.queue_frame(
                    InputAudioRawFrame(
                        audio=carried.ljust(slice_bytes, b"\x00"),
                        sample_rate=BAND_HZ,
                        num_channels=1,
                    )
                )
                await asyncio.sleep(SLICE_MS / 1000)

        carrying = asyncio.create_task(carry_the_line())  # noqa: RUF006
        await stopped.wait()
        assert end_of_speech is not None

        settled: float | None = None
        for _ in range(300):
            settled = ears.settled_after(end_of_speech)
            if settled is not None:
                break
            await asyncio.sleep(0.01)
        if settled is None or not ears.transcript:
            raise RuntimeError("the listening leg never finished the utterance")
        measured["stt_finalization"] = (settled - end_of_speech) * 1000
        measured["heard"] = ears.transcript

        first_output, complete, reply = await _llm(session, path, ears.transcript)
        measured["llm_first_output"] = first_output
        measured["llm_complete"] = complete
        measured["said"] = reply

        handed_over = time.monotonic()
        await speaking.queue_frame(TextFrame(reply))
        for _ in range(1500):
            if mouth.first_audio_at is not None:
                break
            await asyncio.sleep(0.01)
        if mouth.first_audio_at is None:
            raise RuntimeError("the speaking leg never returned audio")
        measured["tts_first_audio"] = (mouth.first_audio_at - handed_over) * 1000
        measured["end_of_speech_to_first_persona_audio"] = (
            mouth.first_audio_at - end_of_speech
        ) * 1000
    finally:
        if carrying is not None:
            carrying.cancel()
            try:
                await carrying
            except (asyncio.CancelledError, RuntimeError):
                pass
        for worker, task in ((listening, listening_task), (speaking, speaking_task)):
            try:
                await worker.queue_frame(EndFrame())
                await asyncio.wait_for(task, timeout=10)
            except (TimeoutError, asyncio.CancelledError, RuntimeError):
                task.cancel()
        await legs.aclose()

    return measured


async def product_client_check(path: Path_) -> str:
    """The simulator's own model client, over the same path, once.

    The streamed request above is a stopwatch; this is the shape the
    product really sends. Running it proves the gateway carries the
    simulator's own call and not only the one this file writes.
    """
    client = OpenAICompatibleModel(
        base_url=path.llm_base_url, api_key=path.llm_key, model_name=LLM_MODEL
    )
    try:
        answer = await client.reply(
            [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": "Say the single word: relayed."},
            ]
        )
        return answer.text
    finally:
        await client.close()


def summarise(runs: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for stage in STAGES:
        values = sorted(
            float(run[stage])
            for run in runs
            if isinstance(run.get(stage), (int, float))
        )
        if not values:
            continue
        out[stage] = {
            "n": len(values),
            "p50": statistics.median(values),
            "p95": values[min(len(values) - 1, max(0, round(0.95 * len(values)) - 1))],
            "min": values[0],
            "max": values[-1],
        }
    return out


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=18)
    parser.add_argument("--out", type=Path, default=Path("gateway-latency.json"))
    parser.add_argument(
        "--only", choices=["direct", "gateway"], help="run one path rather than both"
    )
    asked = parser.parse_args()

    origin = os.environ["EGMA_GATEWAY_ORIGIN"].rstrip("/")
    inference = os.environ["EGMA_GATEWAY_INFERENCE_KEY"]
    socket_origin = origin.replace("https://", "wss://").replace("http://", "ws://")

    paths = {
        "direct": Path_(
            name="direct",
            stt_base_url=None,
            tts_url=None,
            llm_base_url="https://api.openai.com/v1",
            stt_key=os.environ["DEEPGRAM_API_KEY"],
            tts_key=os.environ["CARTESIA_API_KEY"],
            llm_key=os.environ["OPENAI_API_KEY"],
        ),
        "gateway": Path_(
            name="gateway",
            stt_base_url=f"{origin}/deepgram",
            tts_url=f"{socket_origin}/cartesia/tts/websocket",
            llm_base_url=f"{origin}/openai/v1",
            # Every slot holds the Egma inference credential. A simulator on
            # managed model access holds no provider key at all, and this is
            # what that looks like.
            stt_key=inference,
            tts_key=inference,
            llm_key=inference,
        ),
    }
    if asked.only:
        paths = {asked.only: paths[asked.only]}

    spoken = _spoken_sentence()
    results: dict[str, list[dict[str, Any]]] = {name: [] for name in paths}

    async with aiohttp.ClientSession() as session:
        for name, path in paths.items():
            said = await product_client_check(path)
            print(f"[{name}] the simulator's own model client answered: {said!r}")

        for index in range(asked.iterations):
            # Alternating, so a slow minute lands on both paths rather than
            # on whichever one happened to be running through it.
            for name, path in paths.items():
                try:
                    measured = await one_iteration(path, session, spoken)
                except Exception as fault:  # noqa: BLE001
                    print(f"[{name}] iteration {index + 1} failed: {fault!r}")
                    continue
                results[name].append({"iteration": index + 1, **measured})
                print(
                    f"[{name}] {index + 1}/{asked.iterations} "
                    + " ".join(
                        f"{stage}={float(measured[stage]):.0f}ms"
                        for stage in STAGES
                        if stage in measured
                    )
                )

    report = {
        "workload": {
            "utterance": str(SPOKEN.relative_to(SPOKEN.parents[3])),
            "band_hz": BAND_HZ,
            "stt": {"provider": "deepgram", "model": DEEPGRAM_MODEL},
            "llm": {"provider": "openai", "model": LLM_MODEL},
            "tts": {
                "provider": "cartesia",
                "model": CARTESIA_MODEL,
                "voice": CARTESIA_VOICE,
            },
            "iterations": asked.iterations,
            "gateway_origin": origin,
        },
        "summary": {name: summarise(runs) for name, runs in results.items()},
        "runs": results,
    }
    asked.out.write_text(json.dumps(report, indent=2))
    print(f"\nwrote {asked.out}")

    for name, stages in report["summary"].items():
        print(f"\n{name}")
        for stage, numbers in stages.items():
            print(
                f"  {stage:<38} n={numbers['n']:<3} "
                f"p50={numbers['p50']:.0f}ms p95={numbers['p95']:.0f}ms"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
