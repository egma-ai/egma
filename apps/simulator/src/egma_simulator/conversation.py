"""One simulation holds one conversation: persona and plug, turn by turn.

The conversation loop is the plug-blind, model-blind middle: it opens the exchange
through the plug, lets the persona and the agent alternate, records every
turn as it flows, measures each answer, and names how it all ended. Four
deliberate endings — the persona concluding, the agent ending, the turn
limit, the duration limit — plus the cancel directive; each is reported
distinctly, and a limit ending is never the agent failing.

Two hands may stop a running conversation from outside its own loop: a cancel
directive honored at a heartbeat, and the duration watchdog. Both act
through :class:`ConversationControls`, and the first cause to land is the one the
record shows — a cause arriving after the conversation already ended changes
nothing, because what happened is the record.

An agent that stays silent is an observed outcome of the conversation.
The voice persona follows up at most twice, then concludes normally. The
record is available to graders; silence alone is not an execution fault.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from typing import Any

from .persona import Persona, Turn
from .plugs import AgentReply, ConnectionPlug

logger = logging.getLogger(__name__)

OnTurn = Callable[[str, str, tuple[str, ...]], Awaitable[None]]
"""One transcript turn: who took it, what was said, and whatever the
platform said *about* it that nobody said. The third is empty for almost
every turn there has ever been, and it is a separate argument rather than
part of the words for the reason the words are the transcript: the persona
is handed those words back, and a transition read as speech is a
conversation the agent never had."""
OnTiming = Callable[[str, float], Awaitable[None]]
OnToolCall = Callable[[str, str | None], Awaitable[None]]

OnAnswered = Callable[[], Awaitable[None]]
"""Everything one agent answer produced is on the record — the words it
carried, the tool calls it made, the time it took.

It carries nothing, because it is not an observation: it is the boundary
between one answer and the next, and turn-taking is the only thing that
knows where that falls. An answer that produced no words is still an
answer that ended, which is exactly the case a reader of the turns alone
would miss. An agent that speaks first has finished saying its piece the
same way, so the opening counts as one.

The last answer of a conversation is deliberately not announced: the
conversation is over, and whatever it produced belongs with the record of the whole
thing rather than in a boundary of its own."""

# The two causes a ConversationControls can carry. Writer and reader both name
# these constants, so a stop can never be misread as the other cause.
CANCEL_DIRECTIVE = "cancel directive"
DURATION_LIMIT = "duration limit"


class _ConversationStopped(Exception):
    """Internal: a stop cause landed while the loop awaited something."""


class ConversationControls:
    """The two hands that may stop a conversation, and the record of which did."""

    def __init__(self) -> None:
        self._stopped = asyncio.Event()
        self.cause: str | None = None

    def request_cancel(self) -> None:
        """A cancel directive, honored at the loop's next opportunity."""
        self._stop_for(CANCEL_DIRECTIVE)

    def trip_duration_limit(self) -> None:
        self._stop_for(DURATION_LIMIT)

    def _stop_for(self, cause: str) -> None:
        if self.cause is None:
            self.cause = cause
            self._stopped.set()

    async def guard(self, coroutine: Coroutine[Any, Any, Any]) -> Any:
        """Await one step of the conversation, unless a stop cause lands first.

        The step runs as its own task, raced against the stop signal; when
        the stop wins, the step is cancelled and ``_ConversationStopped`` raised so
        the loop can name the cause. Cancellation of the loop itself — the
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
        raise _ConversationStopped()


@dataclass(frozen=True)
class Conducted:
    """How one simulation ended, whichever conductor ran it."""

    status: str
    """``completed`` or ``canceled`` — conducting never fails by conversing;
    a fault raises instead, and the service reports the failure."""

    ending: str
    """The contract's ending for that status."""

    reason: str | None
    """The prose the report carries — which limit tripped, whose act the
    ending was — or ``None`` where the ending speaks for itself."""

    provider_reference: str | None
    """The platform's own identifier for the exchange, from the plug."""


# -- The endings vocabulary, written once for both conductors ----------------
#
# Chat is looped here, turn by turn, and voice is conducted by a Pipecat
# pipeline; the two
# agree on nothing about how a conversation runs. They do agree on how one
# *ends*: the same four endings, in the same words, because a reader
# comparing the same scenario over both modalities is comparing exactly
# that. The sentences are asserted verbatim by the acceptance suite, so a
# second copy of one is a way for the two to drift apart silently.

Ending = tuple[str, str]
"""One ending: the contract's word for it, and the prose a report carries."""

PERSONA_CONCLUDED: Ending = (
    "persona_concluded",
    "the persona concluded the scenario",
)
AGENT_ENDED: Ending = ("agent_ended", "the agent ended the exchange")


def turn_limit_reached(max_turns: int) -> Ending:
    """The turn limit tripped, named with the budget that ran out."""
    return "limit_reached", f"the turn limit ({max_turns} turns) tripped"


def duration_limit_reached(max_duration_seconds: float) -> Ending:
    """The duration limit tripped, named with the budget that ran out."""
    return (
        "limit_reached",
        f"the duration limit ({max_duration_seconds}s) tripped",
    )


async def conduct(
    *,
    persona: Persona,
    plug: ConnectionPlug,
    max_turns: int,
    max_duration_seconds: float,
    on_turn: OnTurn,
    on_timing: OnTiming | None,
    controls: ConversationControls,
    name: str,
    on_tool_call: OnToolCall | None = None,
    on_answered: OnAnswered | None = None,
) -> Conducted:
    """Hold one simulation's conversation, turn by turn, and say how it went."""
    loop = asyncio.get_running_loop()
    history: list[Turn] = []

    async def record(
        speaker: str, text: str, notes: tuple[str, ...] = ()
    ) -> None:
        # The history is what the persona is handed, so it carries the
        # words and nothing else. The notes go to the record only.
        history.append(Turn(speaker, text))
        await on_turn(speaker, text, notes)

    async def record_answer(answer: AgentReply) -> None:
        """One agent answer on the record, where there is anything to put.

        An answer that carried no words is not a turn — except when the
        platform said something about it, which is still the agent's side
        of the conversation and still has to land somewhere. Then it is a
        turn with no words, which is exactly what happened.
        """
        if answer.text is None and not answer.platform_notes:
            return
        await record("agent", answer.text or "", answer.platform_notes)

    async def answered() -> None:
        if on_answered is not None:
            await on_answered()

    def budget_spent() -> bool:
        return len(history) >= max_turns

    def ended(named: Ending) -> Conducted:
        ending, reason = named
        return Conducted(
            status="completed",
            ending=ending,
            reason=reason,
            provider_reference=plug.provider_reference,
        )

    def limit_by_turns() -> Conducted:
        return ended(turn_limit_reached(max_turns))

    watchdog = asyncio.create_task(
        _duration_watchdog(max_duration_seconds, controls),
        name=f"{name}:watchdog",
    )
    try:
        opened = await controls.guard(plug.open())
        # Two shapes, because most platforms open with words and nothing
        # else, and one that says more about its opening should not have to
        # hold it back until the second turn to say it.
        if isinstance(opened, AgentReply):
            await record_answer(opened)
            if opened.ended:
                # An agent that ends the exchange with its own greeting:
                # "we are closed today" and a goodbye. Rare, and real. The
                # exchange is over before the persona has said anything,
                # so the walk stops here — asking the persona for a turn
                # would put a line on the record that nobody heard, and
                # whatever ended the walk afterwards would be reported as
                # the ending instead of the agent's own doing.
                return ended(AGENT_ENDED)
        elif opened is not None:
            await record("agent", opened)
        await answered()

        while True:
            # The persona's move — unless the budget is already spent.
            if budget_spent():
                return limit_by_turns()
            reply = await controls.guard(persona.next_turn(history))
            await record("human", reply.text)
            if reply.concluded or reply.requests_end_call:
                return ended(PERSONA_CONCLUDED)

            # The agent's move — not asked for when its answer could not
            # be recorded anyway: the limit ends the conversation before a phantom
            # exchange happens off the record.
            if budget_spent():
                return limit_by_turns()
            asked_at = loop.time()
            answer = await controls.guard(plug.deliver(reply.text))
            returned_at = loop.time()
            finish_line = _answer_started_at(
                answer, asked_at=asked_at, returned_at=returned_at
            )
            if finish_line is not None:
                answered_in = (finish_line - asked_at) * 1000
                if on_timing is not None:
                    await on_timing("turn_response_latency", answered_in)
                # What egma spent after the finish line deciding the agent
                # had no more to say. Logged rather than measured: it is
                # egma's own turn-taking cost, and the catalog names what
                # the agent did. Worth seeing, because a turn that spent
                # seconds of it is a turn whose platform never published a
                # finished state.
                logger.debug(
                    "turn answered in %.0f ms; egma then waited %.0f ms to "
                    "establish the turn was over",
                    answered_in,
                    (returned_at - finish_line) * 1000,
                )
            # What the agent did while answering, before what it said: a
            # tool call happened during the turn, and only a platform that
            # exposes one reports any at all.
            if on_tool_call is not None:
                for call in answer.tool_calls:
                    await on_tool_call(call.name, call.arguments)
            await record_answer(answer)
            if answer.ended:
                return ended(AGENT_ENDED)
            # The answer is whole, whatever it turned out to carry. Said
            # here rather than beside the turn above, because an answer
            # with no words is still an answer, and a boundary read off
            # the transcript alone would miss exactly that one.
            await answered()
    except _ConversationStopped:
        if controls.cause == CANCEL_DIRECTIVE:
            return Conducted(
                status="canceled",
                ending="canceled",
                reason=None,
                provider_reference=plug.provider_reference,
            )
        return ended(duration_limit_reached(max_duration_seconds))
    finally:
        watchdog.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await watchdog
        await _close_quietly(plug, name)


def _answer_started_at(
    answer: AgentReply, *, asked_at: float, returned_at: float
) -> float | None:
    """The finish line of ``turn_response_latency``, for one answer.

    The measure runs between two events. Its **starting line** is the
    moment the persona's turn went out, which the loop above holds. Its
    **finish line** is the moment the agent began answering, which is this
    — and everything egma spends past it is egma's own cost, never the
    agent's speed.

    Three cases, in order:

    - **The plug saw the answer start.** It reports the instant, and that
      is the finish line. Only a plug reading a live room can see it, and
      it is exactly the plug whose ``deliver`` returns much later than the
      answer began: it must also establish the agent has no more to say
      before the persona may speak, and that wait can be seconds.
    - **The plug's ``deliver`` is a request and its response.** Then the
      call returns when the answer does, the two instants are the same,
      and the return is the finish line. Nothing is lost by using it.
    - **The turn never began an answer.** A turn that only called a tool,
      or produced nothing at all. There is no moment the agent started
      replying, so no sample is taken. A wait that never happened is not
      a wait of zero, and the voice lane answers the same way, out of the
      audio, for the same reason.

    A reported instant before the starting line is refused rather than
    measured. Nothing egma ships can produce one — a stream is stamped
    with the turn that was outstanding when it opened, and this turn's
    streams open after its question went out — so this guards a future
    plug rather than a present one. A measure that ran backwards would be
    worse than a missing one: it can never fail a bound, so it would sit
    in the series holding one trivially and drag every mean below it.
    """
    answered_at = answer.answered_at
    if answered_at is not None:
        return answered_at if answered_at >= asked_at else None
    return returned_at if answer.text is not None else None


async def _duration_watchdog(
    max_duration_seconds: float, controls: ConversationControls
) -> None:
    await asyncio.sleep(max_duration_seconds)
    controls.trip_duration_limit()


async def _close_quietly(plug: ConnectionPlug, name: str) -> None:
    """Tear the exchange down; a failure to close is logged, never raised —
    it would otherwise eat the conversation's own answer."""
    try:
        await plug.close()
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("closing the exchange for %s failed", name)
