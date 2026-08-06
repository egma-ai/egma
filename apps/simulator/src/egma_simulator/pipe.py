"""One simulation walks one Pipecat pipeline, built from its spec, torn down after.

This is the echo pipe: the trivial simulation that proves the whole loop.
The persona's turns are derived deterministically from the spec — the
scenario's instructions, sentence by sentence — and an echo stands where
the agent under test will stand once the platform plugs land. No model, no
network, no audio: what this pipe proves is that a claimed spec becomes a
running Pipecat pipeline whose turns are observed, limited, cancelable, and
reported as they happen. The caller brain and the real plugs replace the
processors here without touching anything outside this module.

Built on the current Pipecat surface (``PipelineWorker``/``WorkerRunner``);
the ``PipelineTask``/``PipelineRunner`` names are deprecated aliases slated
for removal in 2.0.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from pipecat.frames.frames import DataFrame, Frame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.workers.runner import WorkerRunner


@dataclass
class PersonaTurnFrame(DataFrame):
    """One turn spoken by the persona — the human side of the transcript."""

    text: str


@dataclass
class AgentTurnFrame(DataFrame):
    """One turn spoken by the agent under test — here, the echo."""

    text: str


class EchoAgent(FrameProcessor):
    """Stands where the agent under test will stand: echoes every persona turn.

    Also the keeper of the spec's turn budget, both speakers counted. A turn
    the budget cannot pay for is swallowed rather than pushed — a limit
    ending is deliberate, and never the agent failing.
    """

    def __init__(self, *, turn_budget: int, pacing_seconds: float) -> None:
        super().__init__()
        self._budget = turn_budget
        self._pacing_seconds = pacing_seconds

    def _spend(self) -> bool:
        if self._budget < 1:
            return False
        self._budget -= 1
        return True

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if not isinstance(frame, PersonaTurnFrame):
            await self.push_frame(frame, direction)
            return

        if not self._spend():
            return
        await self.push_frame(frame, direction)

        if self._pacing_seconds > 0:
            await asyncio.sleep(self._pacing_seconds)
        if not self._spend():
            return
        await self.push_frame(AgentTurnFrame(text=frame.text), direction)


OnTurn = Callable[[str, str], Awaitable[None]]


class TurnRecorder(FrameProcessor):
    """The pipe's last stop: hands every turn that flowed to the reporter."""

    def __init__(self, on_turn: OnTurn) -> None:
        super().__init__()
        self._on_turn = on_turn

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, PersonaTurnFrame):
            await self._on_turn("human", frame.text)
        elif isinstance(frame, AgentTurnFrame):
            await self._on_turn("agent", frame.text)
        await self.push_frame(frame, direction)


_SENTENCES = re.compile(r"[^.!?]+[.!?]*")


def persona_script(instructions: str) -> list[str]:
    """The persona's turns, derived deterministically from the scenario.

    Sentence by sentence: the same spec conducts the same conversation
    every time, which is the property the caller brain must keep when it
    replaces this.
    """
    sentences = [
        sentence.strip() for sentence in _SENTENCES.findall(instructions)
    ]
    return [sentence for sentence in sentences if sentence] or [instructions.strip()]


class PipeControls:
    """The two hands that may stop a running pipe, and the record of which did.

    A cancel directive and the duration limit both stop the pipeline through
    its own cancel; what differs is what the stop means, so the first cause
    to be delivered is remembered and the others find the pipe already
    stopped. Delivery waits for the pipeline to have started — Pipecat owns
    the pipe's lifecycle, and a cancel slipped under a starting pipeline
    would be lost — so a cause arriving earlier is parked and delivered by
    the started handler.
    """

    def __init__(self) -> None:
        self._worker: PipelineWorker | None = None
        self._started = False
        self._parked: str | None = None
        self.delivered_cause: str | None = None
        self.cancel_requested = False

    def attach(self, worker: PipelineWorker) -> None:
        self._worker = worker

    async def mark_started(self) -> None:
        self._started = True
        if self._parked is not None and self.delivered_cause is None:
            await self._deliver(self._parked)

    async def request_cancel(self) -> None:
        self.cancel_requested = True
        await self._stop_for("cancel directive")

    async def trip_duration_limit(self) -> None:
        await self._stop_for("duration limit")

    async def _stop_for(self, cause: str) -> None:
        if self.delivered_cause is not None:
            return
        if self._worker is None or not self._started:
            self._parked = cause
            return
        await self._deliver(cause)

    async def _deliver(self, cause: str) -> None:
        self.delivered_cause = cause
        assert self._worker is not None
        await self._worker.cancel(reason=cause)


@dataclass(frozen=True)
class Conducted:
    """How one walk of the pipe ended."""

    status: str
    """``completed`` or ``canceled`` — conducting never fails by walking."""

    ending: str
    """The contract's ending for that status."""


async def conduct(
    *,
    scenario_instructions: str,
    max_turns: int,
    max_duration_seconds: float,
    pacing_seconds: float,
    on_turn: OnTurn,
    controls: PipeControls,
    name: str,
) -> Conducted:
    """Walk one simulation through one ephemeral pipeline, and say how it went."""
    script = persona_script(scenario_instructions)
    # Both speakers counted, so a script of n sentences wants 2n turns; the
    # spec's budget clips that, and a clipped walk is a limit ending.
    wanted_turns = 2 * len(script)
    expected_turns = min(wanted_turns, max_turns)
    clipped = wanted_turns > max_turns

    echo = EchoAgent(turn_budget=max_turns, pacing_seconds=pacing_seconds)
    turns_flowed = 0
    done_naturally = asyncio.Event()

    worker: PipelineWorker

    async def record_turn(speaker: str, text: str) -> None:
        nonlocal turns_flowed
        turns_flowed += 1
        await on_turn(speaker, text)
        if turns_flowed >= expected_turns and not done_naturally.is_set():
            done_naturally.set()
            # The script has fully flowed. Only now may the EndFrame enter:
            # queued any earlier it would sit in the worker's push queue,
            # and a cancel directive behind it could not preempt the walk.
            await worker.stop_when_done()

    recorder = TurnRecorder(record_turn)
    worker = PipelineWorker(
        Pipeline([echo, recorder]),
        name=name,
        # The bare pipe wants none of the voice-session conveniences: no
        # RTVI processor injected around it, no speech-turn tracking, and
        # no idle cancellation — the spec's limits are the only clock.
        enable_rtvi=False,
        enable_turn_tracking=False,
        idle_timeout_secs=None,
    )
    controls.attach(worker)

    @worker.event_handler("on_pipeline_started")
    async def _on_started(worker: PipelineWorker, frame: Frame) -> None:
        await controls.mark_started()

    for sentence in script:
        await worker.queue_frame(PersonaTurnFrame(text=sentence))

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)

    watchdog = asyncio.create_task(
        _duration_watchdog(max_duration_seconds, controls),
        name=f"{name}:watchdog",
    )
    try:
        await runner.run()
    finally:
        watchdog.cancel()
        try:
            await watchdog
        except asyncio.CancelledError:
            pass

    if done_naturally.is_set():
        # A cause delivered in the walk's last instants stopped nothing;
        # what happened is that the conversation ended, so that is the record.
        ending = "limit_reached" if clipped else "persona_concluded"
        return Conducted(status="completed", ending=ending)
    if controls.delivered_cause == "cancel directive":
        return Conducted(status="canceled", ending="canceled")
    if controls.delivered_cause == "duration limit":
        return Conducted(status="completed", ending="limit_reached")
    raise RuntimeError(
        f"the pipe stopped {turns_flowed} turn(s) into an expected "
        f"{expected_turns} with no cause delivered"
    )


async def _duration_watchdog(
    max_duration_seconds: float, controls: PipeControls
) -> None:
    await asyncio.sleep(max_duration_seconds)
    await controls.trip_duration_limit()
