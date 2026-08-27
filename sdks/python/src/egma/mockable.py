"""One verb: make this agent's tools mockable, and touch nothing else.

Call it once, after the agent is built and before the session starts::

    from egma import mockable

    async def entrypoint(ctx: agents.JobContext) -> None:
        agent = Agent(instructions=..., tools=[...])
        session = AgentSession(...)
        await mockable(agent, ctx, session)
        await session.start(agent=agent, room=ctx.room)

## What it does, in order

It reads the dispatch metadata **once**. A room with no egma context in
it — every production room — is where this returns having touched
nothing at all: no wrapping, no side table, no call. That inertness is
the whole safety story, and it is a test in this package rather than a
promise in a document.

In a simulation it connects the job to its LiveKit room, if the agent's
normal startup has not already done so. This uses ``JobContext.connect``
before reading the room's local participant; an already-connected job is
left alone.

In a simulation it sends the **census** first: every tool the agent has,
by name and schema, read off the agent object. That is the first message
of the exchange on purpose — an egma that is not there is discovered
here, before a single tool call, rather than half way through a
simulation with somebody waiting on the line.

egma answers with the names it covers, and one **courier** is stood in
front of each. Couriers go in through LiveKit's own ``mock_tools``, which
writes into a side table rather than touching the agent, the class or the
tool registry: never calling it leaves the tools byte for byte as they
were, which is what makes production untouched by construction rather
than by care.

A courier is registered for **every name egma answers for**, not for the
overlap with the census. The side table is consulted per call, by name,
so a tool attached after this call is still intercepted on its first
call, and a courier for a tool that never turns up simply never fires.

## What a courier does with one call

It asks egma, and hands back what egma answers. Around that:

- It carries the **real tool's signature**, copied where the tool exists
  when the courier is made. LiveKit trims a call's arguments to the
  mock's own signature, so a bare closure would be handed nothing and the
  record would show a call with no arguments. A tool attached after this
  runs has no signature to copy, and that call's arguments really are
  thin — which egma flags on the record rather than hiding.
- It sets **both transport knobs explicitly**, every time. The values and
  the arithmetic behind them are in :mod:`egma.seam`; what matters here
  is that neither is ever left to a default, because the transport's own
  default is shorter than a delay a mock tool may legally declare.
- It **runs the real tool** when the transport says egma was never
  reached. A room that lost its egma participant behaves as a room that
  never had one, which is the same fail-open the absent-metadata path
  takes one level up.
- It **raises what egma refuses**, as the tool's own error, so the model
  sees a tool that failed and can say so. egma's refusals are honest
  answers — a call it has no mock for, a payload it could not read — and
  a courier that swallowed one would leave the simulation waiting on
  nothing.

There is no branch on which a courier waits forever. That is the property
this file is written around.

## What it deliberately does not do

It never aborts the agent. Where egma is present but will not talk — a
version neither side shares, a reply in a shape this SDK cannot read —
the couriers are simply not installed, the agent's own tools run, and it
is said out loud in the log. egma's record already tells that truth from
its own side: a hello it refused covers nothing, so the coverage stamp
shows those tools uncovered rather than isolated. Taking the customer's
agent down to make the same point would only lose the simulation as well.
"""

from __future__ import annotations

import inspect
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RunContext,
    ToolContext,
    ToolError,
    mock_tools,
)
from livekit.agents.llm import FunctionTool, RawFunctionTool, is_raw_function_tool
from livekit.rtc import RpcError

from . import seam

logger = logging.getLogger("egma")

RAW_ARGUMENTS = "raw_arguments"
"""The one parameter a raw-schema tool takes: the call's arguments, whole.

Unwrapped before a call is reported, so a raw tool's arguments land on
the record as the arguments the model sent rather than nested one level
inside the framework's own parameter name.
"""


async def mockable(agent: Agent, ctx: JobContext, session: AgentSession) -> None:
    """Let egma answer for this agent's tools, for this session only.

    Returns having touched nothing outside a simulation. Never raises on
    egma's account: what it cannot arrange, it says in the log and leaves
    alone.
    """
    context = _egma_context(ctx)
    if context is None:
        logger.debug(
            "no Egma context in this job's dispatch metadata, so nothing is "
            "wrapped and every tool runs its own implementation"
        )
        return

    if not _speaks_this_version(context.protocol_version):
        logger.error(
            "Egma speaks protocol version %r here and this SDK speaks %d, so "
            "no mock tool can be served: every tool ran its own "
            "implementation. Upgrade the Egma SDK",
            context.protocol_version,
            seam.PROTOCOL_VERSION,
        )
        return

    tools = ToolContext(agent.tools).function_tools
    census = seam.hello_request(
        [{"name": name, "schema": _schema_of(tool)} for name, tool in tools.items()]
    )
    try:
        # Measured before it is sent, because the transport's own
        # complaint about a message too big arrives as a census that
        # mysteriously failed, where this one names what outgrew it —
        # which for a census is an agent with a great many tools.
        seam.fits_on_the_wire("this agent's census of tools", census)
    except seam.SeamError as too_much:
        logger.error(
            "this agent's tools do not fit in one message, so nothing is "
            "wrapped and every tool ran its own implementation: %s",
            too_much,
        )
        return

    if not ctx.room.isconnected():
        await ctx.connect()

    seat = _Seat(room=ctx.room, identity=context.identity)
    try:
        answered = await seat.ask(seam.HELLO_METHOD, census)
        mocked = seam.mocked_tools_in(answered)
    except RpcError as refused:
        _hello_refused(refused, context)
        return
    except seam.SeamError as unreadable:
        logger.error(
            "Egma answered %s in a shape this SDK cannot read, so nothing is "
            "wrapped and every tool ran its own implementation: %s",
            seam.HELLO_METHOD,
            unreadable,
        )
        return

    couriers: dict[str, Callable[..., Any]] = {
        name: _courier(name, tools.get(name), agent, seat) for name in mocked
    }
    mock_tools(type(agent), couriers, session=session)
    logger.info(
        "simulation %s: the agent reported %d tool(s) and Egma answers for "
        "%d of them (%s); every other tool runs its own implementation",
        context.simulation_id,
        len(tools),
        len(couriers),
        ", ".join(couriers) or "none",
    )


@dataclass(frozen=True)
class _Seat:
    """Where a message goes, and the terms it goes on.

    Every ask in this file goes through here, and that is the point
    rather than tidiness: the two transport knobs are the one thing this
    SDK must never leave to a default, and a second place that built a
    call would be a second place to forget them. One method means the
    arithmetic in :mod:`egma.seam` is honoured by construction.

    The room is held rather than the participant, because a participant
    is something a room has once it is connected and this SDK would
    rather read it when it is used than pin whatever was there when the
    session was being set up.
    """

    room: Any
    identity: str

    async def ask(self, method: str, payload: str) -> str:
        return await self.room.local_participant.perform_rpc(
            destination_identity=self.identity,
            method=method,
            payload=payload,
            response_timeout=seam.RESPONSE_TIMEOUT_SECONDS,
            max_round_trip_latency=seam.MAX_ROUND_TRIP_SECONDS,
        )


@dataclass(frozen=True)
class _EgmaContext:
    """Where egma is, read off the dispatch metadata and nowhere else.

    Three facts, and every one of them is about *where egma is* rather
    than what the test asks. There is no test content in dispatch
    metadata by design — an agent that could read its own script would
    stop being under test — so nothing here could leak one if it tried.
    """

    identity: str
    """Who egma is in this room: the address every call is sent to, and
    the whole of the authorisation. A room with nobody by this name has
    nobody to ask, which is every production room."""

    simulation_id: str
    """Which simulation this room conducts. Logged, so a developer can
    line their own worker's logs up with egma's record."""

    protocol_version: object
    """Which version of the exchange egma speaks here. Kept as it arrived
    rather than coerced, so a mismatch can be named in the words it came
    in."""


def _speaks_this_version(declared: object) -> bool:
    """Whether that is the version of the exchange this SDK speaks.

    A boolean is refused explicitly. Python counts ``True`` as equal to
    ``1``, so a metadata field carrying ``true`` would otherwise be read
    as version 1 and this SDK would go on to speak an exchange nobody
    declared.
    """
    if isinstance(declared, bool) or not isinstance(declared, int):
        return False
    return declared == seam.PROTOCOL_VERSION


def _egma_context(ctx: JobContext) -> _EgmaContext | None:
    """egma's context for this job, or nothing where there is none.

    Nothing is the ordinary case: production dispatch metadata is the
    customer's own, or empty, and either way it names no egma participant.
    Every way of not finding one ends here the same way, because the
    difference between "no metadata", "somebody else's metadata" and
    "metadata that is not JSON" is a difference about *them*, and about
    egma they all say the same thing.
    """
    metadata = getattr(getattr(ctx, "job", None), "metadata", None)
    if not isinstance(metadata, str) or not metadata.strip():
        return None
    try:
        context = json.loads(metadata)
    except ValueError:
        return None
    if not isinstance(context, dict):
        return None
    identity = context.get("egmaIdentity")
    if not isinstance(identity, str) or not identity.strip():
        return None
    simulation = context.get("simulationId")
    return _EgmaContext(
        identity=identity.strip(),
        simulation_id=simulation if isinstance(simulation, str) else "unnamed",
        protocol_version=context.get("protocolVersion"),
    )


def _hello_refused(refused: RpcError, context: _EgmaContext) -> None:
    """Say what a refused census means, in the terms it means it in."""
    if refused.code in seam.EGMA_NOT_REACHED:
        logger.warning(
            "no Egma participant answered at %r in this room, so nothing is "
            "wrapped and every tool runs its own implementation (%s)",
            context.identity,
            refused.message,
        )
        return
    logger.error(
        "Egma refused this agent's census with code %s, so nothing is wrapped "
        "and every tool ran its own implementation: %s",
        refused.code,
        refused.message,
    )


def _schema_of(tool: FunctionTool | RawFunctionTool) -> dict[str, Any]:
    """One tool's schema, for the census that seeds mock authoring.

    A raw-schema tool already carries the shape an LLM API is given, so it
    travels as it is. Anything else is asked of the framework, which is
    the only thing that knows how a decorated function becomes a schema —
    and asked inside a guard, because the schema is what makes authoring
    *convenient* while the name is what makes matching *correct*. A tool
    whose schema cannot be read still gets its name into the census, and
    egma can still answer for it; only the authoring hint is thinner.
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
    agent: Agent,
    seat: _Seat,
) -> Callable[..., Any]:
    """One tool's stand-in: ask egma, hand back what egma answers.

    ``original`` is the real tool where the agent had one when this was
    made. It is captured rather than looked up so the fail-open path
    reaches the very callable the census reported, even if the agent's
    tools are replaced later; a courier for a name the agent had no tool
    for falls back to whatever the agent has by that name at call time,
    which is the only handle a late-attached tool can offer.
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
            if refused.code in seam.EGMA_NOT_REACHED:
                return await _really(name, original, agent, args, kwargs, refused)
            # Everything else ends the call, and none of it runs the real
            # tool: falling open belongs to *not reaching* egma, never to
            # being refused by it. Raised as the tool's own error so the
            # model hears a tool that failed and can say so, rather than a
            # simulation that waits on nothing.
            #
            # Whose complaint it was is said out loud, because the two
            # send a developer to opposite halves of the system: a mock
            # tool to author, or a room that could not carry a message.
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
    """One call's arguments, by name, as egma should write them down.

    ``None`` where this courier has no signature to read them through: a
    tool attached after the census really does arrive with nothing, and
    reporting an empty object would put "this call had no arguments" on
    the record instead.

    The session's own context is dropped where a tool declares one. It is
    the framework handing a tool its way back into the session, not
    something the model asked for, and it belongs on no record.
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


async def _really(
    name: str,
    original: FunctionTool | RawFunctionTool | None,
    agent: Agent,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    refused: RpcError,
) -> Any:
    """Run the agent's own tool, because egma was never reached.

    The room lost its egma participant, or never had one by the time this
    call was made. Either way the agent behaves exactly as it would with
    no SDK installed — which is the same answer the absent-metadata path
    gives one level up, arrived at from the other direction.
    """
    tool = original or ToolContext(agent.tools).function_tools.get(name)
    if tool is None:
        logger.error(
            "Egma was not reached for the call to %r (%s) and this agent has "
            "no tool by that name to run instead",
            name,
            refused.message,
        )
        raise ToolError(f"{name} could not be run") from refused
    logger.warning(
        "Egma was not reached for the call to %r (%s), so its own "
        "implementation ran",
        name,
        refused.message,
    )
    try:
        ran = tool(*args, **kwargs)
    except TypeError as unmatched:
        # Only reachable for a tool attached after the census: it was
        # handed no arguments, because there was no signature to read
        # them through, and its own implementation wants some. Said
        # plainly rather than as a bare type error from somebody else's
        # function, which is what a developer would otherwise have to
        # work backwards from.
        logger.error(
            "Egma was not reached for the call to %r, and its own "
            "implementation could not be run without the arguments this "
            "call arrived without: %s",
            name,
            unmatched,
        )
        raise ToolError(f"{name} could not be run") from unmatched
    return await ran if inspect.isawaitable(ran) else ran
