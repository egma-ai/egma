"""One simulation walks one exchange: persona and plug, turn by turn.

The walk is the plug-blind, model-blind middle: it opens the exchange
through the plug, lets the persona and the agent alternate, records every
turn as it flows, measures each answer, and names how it all ended. Four
deliberate endings — the persona concluding, the agent ending, the turn
limit, the duration limit — plus the cancel directive; each is reported
distinctly, and a limit ending is never the agent failing.

Two hands may stop a running walk from outside its own loop: a cancel
directive honored at a heartbeat, and the duration watchdog. Both act
through :class:`WalkControls`, and the first cause to land is the one the
record shows — a cause arriving after the walk already ended changes
nothing, because what happened is the record.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from typing import Any

from .persona import Persona, Turn
from .plugs import PlatformPlug

logger = logging.getLogger(__name__)

OnTurn = Callable[[str, str], Awaitable[None]]
OnTiming = Callable[[str, float], Awaitable[None]]
OnToolCall = Callable[[str, str | None], Awaitable[None]]
OnSpeech = Callable[[str, float], Awaitable[None]]
"""How long one side's audio ran for one turn, ear to ear. Voice only, and
reported from where the audio is actually observed — the pipeline — because
a transcript cannot carry it and a clock around the turn would be timing
this process rather than the conversation."""

# The two causes a WalkControls can carry. Writer and reader both name
# these constants, so a stop can never be misread as the other cause.
CANCEL_DIRECTIVE = "cancel directive"
DURATION_LIMIT = "duration limit"


class _WalkStopped(Exception):
    """Internal: a stop cause landed while the walk awaited something."""


class WalkControls:
    """The two hands that may stop a walk, and the record of which did."""

    def __init__(self) -> None:
        self._stopped = asyncio.Event()
        self.cause: str | None = None

    def request_cancel(self) -> None:
        """A cancel directive, honored at the walk's next opportunity."""
        self._stop_for(CANCEL_DIRECTIVE)

    def trip_duration_limit(self) -> None:
        self._stop_for(DURATION_LIMIT)

    def _stop_for(self, cause: str) -> None:
        if self.cause is None:
            self.cause = cause
            self._stopped.set()

    async def guard(self, coroutine: Coroutine[Any, Any, Any]) -> Any:
        """Await one step of the walk, unless a stop cause lands first.

        The step runs as its own task, raced against the stop signal; when
        the stop wins, the step is cancelled and ``_WalkStopped`` raised so
        the walk can name the cause. Cancellation of the walk itself — the
        service tearing down — passes straight through.
        """
        step = asyncio.ensure_future(coroutine)
        interrupter = asyncio.ensure_future(self._stopped.wait())
        try:
            done, _pending = await asyncio.wait(
                {step, interrupter}, return_when=asyncio.FIRST_COMPLETED
            )
        except asyncio.CancelledError:
            step.cancel()
            raise
        finally:
            interrupter.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await interrupter

        if step in done:
            return step.result()

        step.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await step
        raise _WalkStopped()


@dataclass(frozen=True)
class Conducted:
    """How one walk ended."""

    status: str
    """``completed`` or ``canceled`` — conducting never fails by walking;
    a fault raises instead, and the service reports the failure."""

    ending: str
    """The contract's ending for that status."""

    reason: str | None
    """The prose the report carries — which limit tripped, whose act the
    ending was — or ``None`` where the ending speaks for itself."""

    provider_reference: str | None
    """The platform's own identifier for the exchange, from the plug."""


async def conduct(
    *,
    persona: Persona,
    plug: PlatformPlug,
    max_turns: int,
    max_duration_seconds: float,
    on_turn: OnTurn,
    on_timing: OnTiming | None,
    controls: WalkControls,
    name: str,
    on_tool_call: OnToolCall | None = None,
) -> Conducted:
    """Walk one simulation through one exchange, and say how it went."""
    loop = asyncio.get_running_loop()
    history: list[Turn] = []

    async def record(speaker: str, text: str) -> None:
        history.append(Turn(speaker, text))
        await on_turn(speaker, text)

    def budget_spent() -> bool:
        return len(history) >= max_turns

    def ended(ending: str, reason: str | None) -> Conducted:
        return Conducted(
            status="completed",
            ending=ending,
            reason=reason,
            provider_reference=plug.provider_reference,
        )

    def limit_by_turns() -> Conducted:
        return ended("limit_reached", f"the turn limit ({max_turns} turns) tripped")

    watchdog = asyncio.create_task(
        _duration_watchdog(max_duration_seconds, controls),
        name=f"{name}:watchdog",
    )
    try:
        greeting = await controls.guard(plug.open())
        if greeting is not None:
            await record("agent", greeting)

        while True:
            # The persona's move — unless the budget is already spent.
            if budget_spent():
                return limit_by_turns()
            reply = await controls.guard(persona.next_turn(history))
            await record("human", reply.text)
            if reply.concluded:
                return ended(
                    "persona_concluded", "the persona concluded the scenario"
                )

            # The agent's move — not asked for when its answer could not
            # be recorded anyway: the limit ends the walk before a phantom
            # exchange happens off the record.
            if budget_spent():
                return limit_by_turns()
            asked_at = loop.time()
            answer = await controls.guard(plug.deliver(reply.text))
            if on_timing is not None:
                await on_timing(
                    "turn_response_latency", (loop.time() - asked_at) * 1000
                )
            # What the agent did while answering, before what it said: a
            # tool call happened during the turn, and only a platform that
            # exposes one reports any at all.
            if on_tool_call is not None:
                for call in answer.tool_calls:
                    await on_tool_call(call.name, call.arguments)
            if answer.text is not None:
                await record("agent", answer.text)
            if answer.ended:
                return ended("agent_ended", "the agent ended the exchange")
    except _WalkStopped:
        if controls.cause == CANCEL_DIRECTIVE:
            return Conducted(
                status="canceled",
                ending="canceled",
                reason=None,
                provider_reference=plug.provider_reference,
            )
        return ended(
            "limit_reached",
            f"the duration limit ({max_duration_seconds}s) tripped",
        )
    finally:
        watchdog.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await watchdog
        await _close_quietly(plug, name)


async def _duration_watchdog(
    max_duration_seconds: float, controls: WalkControls
) -> None:
    await asyncio.sleep(max_duration_seconds)
    controls.trip_duration_limit()


async def _close_quietly(plug: PlatformPlug, name: str) -> None:
    """Tear the exchange down; a failure to close is logged, never raised —
    it would otherwise eat the walk's own answer."""
    try:
        await plug.close()
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("closing the exchange for %s failed", name)
