"""Configure reporting and mock tools before a LiveKit simulation starts.

    agent = Agent(instructions=..., tools=[...])
    session = AgentSession(...)
    await simulation(agent, ctx, session)
    await session.start(agent=agent, room=ctx.room)

Production rooms are unchanged. Simulation rooms install the exporter,
connect if needed, find Egma, and report the tool list before startup.
Egma's hello reply selects mock tools; all other tools remain real.
Handoffs install wrappers before the selected agent starts and report
the cumulative tool list. Reporting failures raise ``NotReported``.

Each wrapper copies the real tool's signature when available, uses the
explicit RPC limits in ``egma.seam``, and raises mock or transport errors
without falling back to the real tool. See ``simulation`` for setup errors.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from livekit.agents import (
    Agent,
    AgentSession,
    ConversationItemAddedEvent,
    JobContext,
    RunContext,
    ToolContext,
    ToolError,
    mock_tools,
)
from livekit.agents.llm import (
    AgentHandoff,
    FunctionTool,
    RawFunctionTool,
    is_raw_function_tool,
)
from livekit.rtc import RpcError

from . import export, seam
from .room import Simulation, simulation_in

logger = logging.getLogger("egma")

VERB = "egma.simulation"
"""What this verb is called, for every sentence it has to say."""


class NotReported(RuntimeError):
    """Reporting failed in a simulation room; do not start the session.

    Raised by ``simulation`` when the hello exchange cannot complete.
    Never raised for a production room.
    """


EGMA_IDENTITY = "egma-persona"
"""Egma participant identity, bare or suffixed with a simulation ID.

Reject an empty suffix and multiple matches rather than choosing a
participant that could receive the agent's tool list incorrectly.
"""

EGMA_CONNECT_SECONDS = 30.0
"""How long egma allows itself to get into the room.

One of egma's own bounds, restated here rather than imported. This
package is the half a customer installs, so it may not reach back into
egma's services for a constant — the same reason :mod:`egma.seam` gives
for writing the exchange twice. The number it restates is
``CONNECT_SECONDS`` in the simulator's ``media/room.py``, and a
simulation whose room does not open inside it ends saying so.
"""

ARRIVAL_MARGIN_SECONDS = 15.0
"""Extra startup allowance for token acquisition and RPC registration.

Egma can appear in the room before its RPC handlers are registered.
This margin does not cover a token request and connection that both
consume their maximum time. Failure to find or contact Egma raises
``NotReported``; it does not start an unreported simulation.
"""

STARTUP_SECONDS = EGMA_CONNECT_SECONDS + ARRIVAL_MARGIN_SECONDS
"""Deadline for finding Egma and deciding whether to retry hello.

Derived from connect allowance plus arrival margin. Connection and
individual RPC calls use their own timeout behavior, so this is not
a strict bound on the entire simulation() call. Production rooms
never enter this wait.
"""

POLL_SECONDS = 0.25
"""How long to sleep between looks, when nothing has woken this side.

The room's own arrival event is what makes finding egma prompt; this is
the floor under it, so a transport that renames that event degrades to
slow rather than to broken.
"""

RAW_ARGUMENTS = "raw_arguments"
"""The one parameter a raw-schema tool takes: the call's arguments, whole.

Unwrapped before a call is reported, so a raw tool's arguments land on
the record as the arguments the model sent rather than nested one level
inside the framework's own parameter name.
"""


async def simulation(
    agent: Agent,
    ctx: JobContext,
    session: AgentSession,
    *,
    endpoint: str | None = None,
    api_key: str | None = None,
) -> None:
    """Report simulation tools, configure mock tools, and export agent-POV spans.

    Await once before ``AgentSession.start``. Outside simulation rooms this
    returns without connecting, wrapping tools, exporting, or sending RPC.

    Raises:
        NotReported: Room connection, participant discovery, or hello failed.
        ValueError: Export settings or tracer-provider setup are invalid.

    ``endpoint`` and ``api_key`` default to ``EGMA_URL`` and ``EGMA_API_KEY``.
    Use one LiveKit job per process; exporter attribution is fixed by the
    first job, and a job with different settings is refused.
    """
    named = simulation_in(ctx)
    if named is None:
        logger.debug(
            "this job's room is not an Egma simulation room, so nothing is "
            "wrapped, nothing is exported, and every tool runs its own "
            "implementation"
        )
        return

    # First, because this is the part egma cannot do without. The agent's
    # spans are this simulation's record of what the agent did, and they
    # are arranged for before anything that can fail.
    processor = export.install(
        ctx,
        verb=VERB,
        endpoint=endpoint,
        api_key=api_key,
        provider_reference=named.named,
    )
    _flush_when_the_session_closes(session, processor)

    tools = ToolContext(agent.tools).function_tools
    census = seam.hello_request(
        [{"name": name, "schema": _schema_of(tool)} for name, tool in tools.items()]
    )
    try:
        # Measured before it is sent, because the transport's own
        # complaint about a message too big arrives as a census that
        # mysteriously failed, where this one names what outgrew it —
        # which for a census is an agent with a great many tools.
        #
        # Measured before the connect as well, so an agent that can never
        # report its tools does not pay for a room it will not use.
        seam.fits_on_the_wire("this agent's census of tools", census)
    except seam.SeamError as too_much:
        raise _not_reported(
            named, f"this agent's tools do not fit in one message ({too_much})"
        ) from too_much

    # The one deadline. It starts here rather than at the first wait,
    # because what it has to cover is egma's own journey into the room and
    # that began when this job did.
    deadline = asyncio.get_running_loop().time() + STARTUP_SECONDS

    if not ctx.room.isconnected():
        try:
            await ctx.connect()
        except Exception as unopened:
            raise _not_reported(
                named, f"this room could not be connected ({unopened})"
            ) from unopened

    identity = await _egma_in_the_room(ctx.room, deadline, named)

    seat = _Seat(room=ctx.room, identity=identity)
    try:
        answered = await _asked_until_egma_is_listening(seat, census, deadline)
        mocked = seam.mocked_tools_in(answered)
    except RpcError as refused:
        raise _not_reported(
            named, _why_the_hello_was_refused(refused, identity)
        ) from refused
    except seam.SeamError as unreadable:
        raise _not_reported(
            named,
            f"Egma answered {seam.HELLO_METHOD} in a shape this SDK cannot "
            f"read ({unreadable})",
        ) from unreadable
    except Exception as broke:
        # Anything else the transport or the framework can throw. Named
        # last and caught all the same, because the one thing that must
        # not happen is this call ending in an error that does not say the
        # simulation went unreported — a developer reading a bare
        # transport exception has no way to know their simulation isolated
        # nothing.
        raise _not_reported(named, f"{type(broke).__name__}: {broke}") from broke

    couriers = _install_couriers(agent, mocked, seat, session)
    _install_handoff_couriers(agent, mocked, seat, session, named)
    logger.info(
        "simulation %s: the agent reported %d tool(s) and Egma answers for "
        "%d of them (%s); every other tool runs its own implementation",
        named.named,
        len(tools),
        len(couriers),
        ", ".join(couriers) or "none",
    )


def _not_reported(named: Simulation, why: str) -> NotReported:
    """The one sentence every unreported simulation ends on.

    One wording for every branch, with that branch's own finding inside
    it, because what a developer has to do about all of them is the same:
    look at the room, then look at the installation. The two halves are
    named in the order they can be checked.
    """
    return NotReported(
        f"simulation {named.named}: this agent did not report to Egma "
        f"({why}), so its session was not started. A LiveKit simulation "
        f"needs {VERB} to reach Egma's participant in the room: check that "
        "this worker can reach the LiveKit room and that Egma's own side of "
        "this simulation is running, and check that the `egma` package "
        "installed here is the one that shipped with this Egma deployment "
        f"(this is egma {_this_sdk()})."
    )


def _flush_when_the_session_closes(
    session: AgentSession, processor: Any
) -> None:
    """Send the tail of the conversation the moment the session ends.

    The job's own shutdown flush is the backstop and runs later; this one
    is what puts the last turn in front of a grader that is already
    waiting on it. The task is held in a set because a task nobody holds
    may be collected before it has run.
    """
    flushes: set[asyncio.Task[None]] = set()

    def on_close(_: Any) -> None:
        try:
            flushing = export.flush_on(processor, "session close")
        except RuntimeError:
            # No loop left to flush on. The job's shutdown callback is the
            # backstop and still runs.
            return
        flushes.add(flushing)
        flushing.add_done_callback(flushes.discard)

    session.once("close", on_close)


def _install_couriers(
    agent: Agent,
    mocked: Sequence[str],
    seat: _Seat,
    session: AgentSession,
) -> dict[str, Callable[..., Any]]:
    """Put this agent instance's couriers in LiveKit's session side table."""
    tools = ToolContext(agent.tools).function_tools
    couriers: dict[str, Callable[..., Any]] = {
        name: _courier(name, tools.get(name), seat) for name in mocked
    }
    mock_tools(type(agent), couriers, session=session)
    return couriers


def _install_handoff_couriers(
    initial_agent: Agent,
    mocked: Sequence[str],
    seat: _Seat,
    session: AgentSession,
    simulation: Simulation,
) -> None:
    """Cover each agent LiveKit selects before that agent starts running.

    LiveKit looks up mock tools by the exact class of ``current_agent``.
    ``AgentTask`` handoffs therefore need their own entry even though they
    share the same session. LiveKit emits this public event after selecting
    the next agent and before starting its activity, so this synchronous
    callback closes that gap before the task can make its first tool call.
    """
    active_mocked = tuple(mocked)
    last_selected_agent: Agent | None = initial_agent
    installed_types: set[type[Agent]] = {type(initial_agent)}
    initial_tools = ToolContext(initial_agent.tools).function_tools
    discovered = {
        name: {"name": name, "schema": _schema_of(tool)}
        for name, tool in initial_tools.items()
    }
    refresh_tasks: set[asyncio.Task[None]] = set()
    refresh_tail: asyncio.Task[None] | None = None

    def on_conversation_item_added(event: ConversationItemAddedEvent) -> None:
        nonlocal last_selected_agent, refresh_tail
        try:
            if not isinstance(event.item, AgentHandoff):
                return

            current = session.current_agent
            if (
                current is None
                or event.item.new_agent_id != current.id
                or current is last_selected_agent
            ):
                return

            installed_types.add(type(current))
            try:
                couriers = _install_couriers(current, active_mocked, seat, session)
            except Exception:
                # Never leave a courier bound to the previous instance of
                # this exact class. If preparing the new one fails, running
                # its own tools is safer than calling through stale state.
                mock_tools(type(current), {}, session=session)
                logger.exception(
                    "simulation %s: Egma could not prepare LiveKit's selected "
                    "%s; that agent will run its own tools",
                    simulation.named,
                    type(current).__name__,
                )
                return
            last_selected_agent = current
            logger.info(
                "simulation %s: LiveKit handed off to %s; Egma answers for %d "
                "tool name(s) on that agent (%s)",
                simulation.named,
                type(current).__name__,
                len(couriers),
                ", ".join(couriers) or "none",
            )

            try:
                changed = False
                for name, tool in ToolContext(current.tools).function_tools.items():
                    entry = {"name": name, "schema": _schema_of(tool)}
                    if discovered.get(name) != entry:
                        discovered[name] = entry
                        changed = True
                if not changed:
                    return

                cumulative_census = list(discovered.values())
                previous_refresh = refresh_tail

                async def refresh_in_handoff_order() -> None:
                    try:
                        if previous_refresh is not None:
                            await previous_refresh
                        await _refresh_census(
                            cumulative_census, active_mocked, seat, simulation
                        )
                    except (RpcError, seam.SeamError) as refused:
                        logger.warning(
                            "simulation %s: the cumulative tool census could not "
                            "be refreshed (%s); its already-installed couriers remain",
                            simulation.named,
                            refused,
                        )
                    except Exception:
                        logger.exception(
                            "simulation %s: the cumulative tool census could not "
                            "be refreshed; its already-installed couriers remain",
                            simulation.named,
                        )

                refresh_tail = asyncio.create_task(refresh_in_handoff_order())
                refresh_tasks.add(refresh_tail)
                refresh_tail.add_done_callback(refresh_tasks.discard)
            except Exception:
                logger.exception(
                    "simulation %s: Egma installed this handoff's couriers but "
                    "could not add its tools to the cumulative census",
                    simulation.named,
                )
        except Exception:
            # LiveKit's event emitter re-raises TypeError from synchronous
            # callbacks. A mock-tools hook must never stop the agent handoff.
            logger.exception(
                "simulation %s: Egma's LiveKit handoff hook failed; LiveKit "
                "will continue without new courier state from this event",
                simulation.named,
            )

    def on_close(_: Any) -> None:
        session.off("conversation_item_added", on_conversation_item_added)
        for task in tuple(refresh_tasks):
            task.cancel()
        for agent_type in installed_types:
            mock_tools(agent_type, {}, session=session)
        installed_types.clear()
        discovered.clear()

    session.on("conversation_item_added", on_conversation_item_added)
    session.once("close", on_close)


async def _refresh_census(
    reported_tools: Sequence[dict[str, Any]],
    expected_mocked: Sequence[str],
    seat: _Seat,
    simulation: Simulation,
) -> None:
    """Report every tool discovered so far without changing the mock world."""
    census = seam.hello_request(list(reported_tools))
    seam.fits_on_the_wire("the cumulative handoff census", census)
    answered = await seat.ask(
        seam.HELLO_METHOD, census, seam.HELLO_TIMEOUT_SECONDS
    )
    answered_mocked = seam.mocked_tools_in(answered)
    logger.info(
        "simulation %s: the cumulative census now reports %d tool(s) and "
        "Egma answers for %d of them (%s)",
        simulation.named,
        len(reported_tools),
        len(answered_mocked),
        ", ".join(answered_mocked) or "none",
    )
    if tuple(answered_mocked) != tuple(expected_mocked):
        logger.warning(
            "simulation %s: Egma changed the mock-tool names in a later "
            "census; this session keeps the names negotiated at startup",
            simulation.named,
        )


@dataclass(frozen=True)
class _Seat:
    """Send every RPC with explicit response and delivery timeouts.

    Keep the room rather than a participant captured during startup;
    resolve its local participant when sending.
    """

    room: Any
    identity: str

    async def ask(
        self, method: str, payload: str, response_timeout: float | None = None
    ) -> str:
        return await self.room.local_participant.perform_rpc(
            destination_identity=self.identity,
            method=method,
            payload=payload,
            response_timeout=(
                seam.RESPONSE_TIMEOUT_SECONDS
                if response_timeout is None
                else response_timeout
            ),
            max_round_trip_latency=seam.MAX_ROUND_TRIP_SECONDS,
        )


def _answers_to_egmas_name(identity: str) -> bool:
    """Match ``egma-persona`` or ``egma-persona-`` with a nonempty simulation suffix.

    A plain prefix match would accept unrelated participants.
    """
    if identity == EGMA_IDENTITY:
        return True
    return (
        identity.startswith(f"{EGMA_IDENTITY}-")
        and len(identity) > len(EGMA_IDENTITY) + 1
    )


def _egma_candidates(room: Any) -> list[str]:
    """Find matching Egma participants in any mapping-like room table.

    Treat an unreadable table as empty and log it at debug level. The
    startup search raises ``NotReported`` if no participant is found.
    """
    participants = getattr(room, "remote_participants", None)
    items = getattr(participants, "items", None)
    if not callable(items):
        logger.debug(
            "this room does not list who is in it, so Egma's participant "
            "cannot be found in it"
        )
        return []
    found: set[str] = set()
    for key, participant in list(items()):
        identity = getattr(participant, "identity", None)
        if not isinstance(identity, str):
            identity = key
        if isinstance(identity, str) and _answers_to_egmas_name(identity):
            found.add(identity)
    return sorted(found)


def _listen_for_arrivals(room: Any, arrived: asyncio.Event) -> Callable[[], None]:
    """Wake the search when somebody joins, if this room will say so.

    The waiting below polls whatever happens, so this is what makes it
    prompt rather than what makes it work: a transport that renamed this
    event would cost seconds, not correctness.
    """
    listen = getattr(room, "on", None)
    if not callable(listen):
        return lambda: None

    def woken(*_participant: Any) -> None:
        arrived.set()

    try:
        listen("participant_connected", woken)
    except Exception:
        logger.debug(
            "this room does not announce arrivals, so Egma's participant is "
            "waited for by looking rather than by being told",
            exc_info=True,
        )
        return lambda: None

    def stop() -> None:
        forget = getattr(room, "off", None)
        if callable(forget):
            with contextlib.suppress(Exception):
                forget("participant_connected", woken)

    return stop


async def _egma_in_the_room(
    room: Any, deadline: float, simulation: Simulation
) -> str:
    """Wait for one Egma participant in a simulation room or raise ``NotReported``.

    Subscribe before reading participants so an arrival cannot be missed
    between the initial lookup and event registration.
    """
    loop = asyncio.get_running_loop()
    arrived = asyncio.Event()
    stop_listening = _listen_for_arrivals(room, arrived)
    try:
        while True:
            arrived.clear()
            found = _egma_candidates(room)
            if len(found) == 1:
                return found[0]
            if len(found) > 1:
                # Refused rather than resolved. LiveKit makes one identity
                # unique per room, so an impersonator taking egma's exact
                # name is evicted by the server; one taking a variant of it
                # sits quietly beside the real thing, and whichever this
                # side picked would receive every tool name and schema this
                # agent has. There is no reading of two claimants that is
                # safe to act on.
                raise _not_reported(
                    simulation,
                    f"{len(found)} participants in this room answer to Egma's "
                    f"name ({', '.join(found)}), so which one is Egma is not "
                    "knowable and this SDK will hand a tool inventory to "
                    "neither",
                )

            remaining = deadline - loop.time()
            if remaining <= 0:
                raise _not_reported(
                    simulation,
                    f"no Egma participant joined this room within "
                    f"{STARTUP_SECONDS:.0f}s; Egma joins as "
                    f"{EGMA_IDENTITY!r}, or as that name with the simulation "
                    "after it",
                )

            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(
                    arrived.wait(), min(remaining, POLL_SECONDS)
                )
    finally:
        stop_listening()


async def _asked_until_egma_is_listening(
    seat: _Seat, census: str, deadline: float
) -> str:
    """Retry hello while Egma is visible but its RPC handlers are not registered.

    Retry ``UNSUPPORTED_METHOD`` within the startup deadline. Do not retry
    ``RECIPIENT_NOT_FOUND`` after observing the participant; it has left.
    Other failures propagate and become ``NotReported``.
    """
    loop = asyncio.get_running_loop()
    while True:
        try:
            return await seat.ask(
                seam.HELLO_METHOD, census, seam.HELLO_TIMEOUT_SECONDS
            )
        except RpcError as refused:
            if (
                refused.code not in seam.EGMA_NOT_LISTENING_YET
                or loop.time() + POLL_SECONDS >= deadline
            ):
                raise
            logger.debug(
                "Egma is in this room and has not registered %s yet; asking "
                "again",
                seam.HELLO_METHOD,
            )
            await asyncio.sleep(POLL_SECONDS)


def _this_sdk() -> str:
    """This package's own version, for a line that asks somebody to act."""
    try:
        from importlib.metadata import version

        return version("egma")
    except Exception:
        return "unknown"


def _why_the_hello_was_refused(refused: RpcError, identity: str) -> str:
    """What a refused census means, in the terms it means it in.

    Three readings, because they send a developer to three different
    places: a version neither side shares, a participant that was not
    there to answer, and an Egma that answered by refusing.
    """
    if refused.code == seam.UNSUPPORTED_PROTOCOL_VERSION:
        # The one refusal a customer can act on alone. Egma's own sentence
        # carries the two version numbers; the sentence around this one
        # carries the package they belong to, because "Egma speaks 1 and
        # this one declared 2" reads as an SDK that is too new when the
        # fix is usually the other half.
        return (
            "Egma here speaks a version of the mock-tool exchange this SDK "
            f"does not: {refused.message}"
        )
    if refused.code in seam.EGMA_NOT_REACHED:
        return (
            f"no Egma participant answered at {identity!r} in this room "
            f"({refused.message})"
        )
    return (
        f"Egma refused this agent's census with code {refused.code}: "
        f"{refused.message}"
    )


def _schema_of(tool: FunctionTool | RawFunctionTool) -> dict[str, Any]:
    """Read a tool schema directly or through the framework's schema builder.

    If extraction fails, still report the tool name so mock-tool matching
    works without the optional schema hint.
    """
    if is_raw_function_tool(tool):
        return dict(tool.info.raw_schema)
    try:
        from livekit.agents.llm.utils import build_legacy_openai_schema

        return build_legacy_openai_schema(tool, internally_tagged=True)
    except Exception:
        info = tool.info
        logger.warning(
            "could not read the schema of tool %r, so its census entry carries "
            "the name and description alone; mock authoring for it starts from "
            "less",
            info.name,
            exc_info=True,
        )
        return {
            "name": info.name,
            "description": getattr(info, "description", None) or "",
        }


def _courier(
    name: str,
    original: FunctionTool | RawFunctionTool | None,
    seat: _Seat,
) -> Callable[..., Any]:
    """One tool's stand-in: ask egma, hand back what egma answers.

    ``original`` is the real tool where the agent had one when this was
    made, and it is read for one thing only — its signature, so a call's
    arguments reach the record. It is never called: in a simulation room
    a wrapped tool's own implementation does not run, whatever happens to
    the message.
    """
    signature = _signature_of(original)
    raw = original is not None and is_raw_function_tool(original)

    async def courier(*args: Any, **kwargs: Any) -> Any:
        arguments = _arguments_of(signature, raw, args, kwargs)
        asking = seam.tool_request(name, arguments)
        try:
            # Measured before it is sent, on the same terms egma measures
            # its own answers: a message the transport cannot carry is a
            # fault to name, and the transport's own complaint about one
            # arrives at this end as a call that failed for no stated
            # reason.
            seam.fits_on_the_wire(f"the call to {name!r}", asking)
        except seam.SeamError as too_much:
            logger.warning("the call to %r could not be sent: %s", name, too_much)
            raise ToolError(f"Egma could not answer {name}: {too_much}") from too_much

        try:
            answered = await seat.ask(seam.TOOL_METHOD, asking)
        except RpcError as refused:
            # Never run a real tool when its mock-tool RPC fails. Raise a tool error
            # so the model receives the refusal. Distinguish authored mock-tool
            # errors from transport failures in the diagnostic.
            logger.warning(
                "%s the call to %r with code %s: %s",
                "Egma refused"
                if refused.code in seam.EGMA_REFUSALS
                else "the room could not carry",
                name,
                refused.code,
                refused.message,
            )
            raise ToolError(
                f"Egma could not answer {name}: {refused.message}"
            ) from refused
        except Exception as broke:
            # Everything else, on the same terms. A courier that let an
            # unexpected exception through would hand the framework a tool
            # that failed in a way the model cannot hear, and in the worst
            # reading a simulation that waits on nothing.
            logger.warning(
                "the call to %r could not be made: %s: %s",
                name,
                type(broke).__name__,
                broke,
            )
            raise ToolError(f"Egma could not answer {name}: {broke}") from broke

        try:
            served = seam.served_in(answered)
        except seam.SeamError as unreadable:
            logger.error(
                "Egma answered the call to %r unreadably: %s", name, unreadable
            )
            raise ToolError(
                f"Egma could not answer {name}: {unreadable}"
            ) from unreadable

        if served.failed:
            # The branch a test forces on purpose. It is the mock tool
            # author's own sentence that reaches the model, never this
            # side's words about it.
            raise ToolError(served.message)
        return served.value

    if signature is not None:
        # The whole reason a courier can report arguments at all. LiveKit
        # trims a call to the mock's declared parameters, so a courier
        # without this is handed nothing — not an error, just an empty
        # call, which is the quietest way to lose a record.
        courier.__signature__ = signature  # type: ignore[attr-defined]
    courier.__name__ = name
    return courier


def _signature_of(
    tool: FunctionTool | RawFunctionTool | None,
) -> inspect.Signature | None:
    """The real tool's parameters, or nothing where there is no tool yet."""
    if tool is None:
        return None
    try:
        return inspect.signature(tool)
    except (TypeError, ValueError):
        logger.warning(
            "could not read the parameters of tool %r, so calls to it will be "
            "answered by Egma with their arguments unreported",
            getattr(tool.info, "name", tool),
            exc_info=True,
        )
        return None


def _arguments_of(
    signature: inspect.Signature | None,
    raw: bool,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> dict[str, Any] | None:
    """Bind model arguments to the real tool's signature for reporting.

    Return None when no signature is available, rather than claim the
    tool received no arguments. Omit framework context arguments.
    """
    if signature is None:
        return None
    try:
        bound = signature.bind(*args, **kwargs)
    except TypeError:
        # Bound by LiveKit against this very signature moments ago, so
        # reaching here means the framework's trimming changed shape.
        # Reported as unseen arguments rather than a failed call: the
        # answer is still egma's to give.
        logger.warning(
            "a call arrived in a shape its own signature does not accept, so "
            "its arguments are unreported",
            exc_info=True,
        )
        return None
    bound.apply_defaults()
    arguments = {
        parameter: value
        for parameter, value in bound.arguments.items()
        if not isinstance(value, RunContext)
    }
    if raw:
        # A raw-schema tool takes the call whole, under one parameter
        # name of the framework's choosing. What the model sent is the
        # value, so that is what travels — and where it is not there to
        # unwrap, nothing does, for the same reason a courier with no
        # signature reports nothing: an empty object would say this call
        # was made without arguments, which is a different and untrue
        # thing.
        inner = arguments.get(RAW_ARGUMENTS)
        return dict(inner) if isinstance(inner, dict) else None
    return arguments
