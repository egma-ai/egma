"""One verb: make this agent's tools mockable, and touch nothing else.

Call it once, after the agent is built and before the session starts::

    from egma import mockable

    async def entrypoint(ctx: agents.JobContext) -> None:
        agent = Agent(instructions=..., tools=[...])
        session = AgentSession(...)
        await mockable(agent, ctx, session)
        await session.start(agent=agent, room=ctx.room)

## How it knows it is in a simulation

It reads the **room's name** off the job, before it connects anything and
without asking anybody. Every room egma conducts a simulation in is named
``egma-sim-…``, and that prefix is fixed and published. A room named
anything else — which is every production room — is where this returns
having touched nothing at all: no wrapping, no side table, no message, no
connect. That inertness is the whole safety story for production, and it
is a test in this package rather than a promise in a document.

The name is read rather than the job's dispatch metadata because dispatch
metadata belongs to the customer. LiveKit teaches it as the channel for a
caller's own identifiers, so anything of egma's written there both
collides with what a customer already reads and, worse, arrives on only
one of the four dispatch paths that can put an agent in an egma room: it
is carried by an explicit dispatch, and three of the four paths have
none. A room name arrives on all four. Mock tools and the monitoring
guard therefore hold on all four, instead of on the one dispatch path
where egma dispatches the worker itself.

It is also the only signal. Nothing in that metadata is read as a second
way of saying "simulation", because a second way could catch no
simulation room the prefix does not already catch — every one of them
carries it, on all four dispatch paths — and could only add rooms that
are not simulations at all. A production room whose own JSON happened to
use the same key names would have its tools wrapped and its spans held
back from production Monitoring, and a dropped trace is evidence a
customer cannot get back. One signal that is honest about being weak
beats two where the second can only be wrong.

## What it does in a simulation, in order

It connects the job to its LiveKit room, if the agent's normal startup has
not already done so. This is the one connect this SDK forces, it happens
only in a room whose name already said simulation, and it is a stated
consequence rather than an implementation detail: reading a room's
participants needs a connected room, and on three of the four dispatch
paths the agent is in the room **before** egma is.

It then finds egma among the room's remote participants, by name. egma
joins as ``egma-persona`` or as ``egma-persona-<simulation>``, so exactly
those two forms are matched and nothing else is. Because the room's name
has already established that this is a simulation, this side may **wait**
for that participant — bounded, woken by the room's own arrival event,
and never reached in a production room. Where two participants answer to
that name the exchange is refused rather than guessed at: a room with two
claimants is a room where the answer is not knowable, and the loser of
that guess would be handed this agent's whole tool inventory.

It sends the **census** next: every tool the initial agent has, by name
and schema, read off the agent object. That is the first message of the
exchange on purpose — an egma that is not answering is discovered here,
before a single tool call, rather than half way through a simulation with
somebody waiting on the line. A census the far side answers with
``UNSUPPORTED_METHOD`` is asked again until the bound runs out, because
egma registers the exchange after it joins and this side can arrive in
between; every other refusal is taken at its word.

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

LiveKit may later hand the session to another ``Agent`` or ``AgentTask``.
The public handoff event fires after LiveKit selects that exact instance
and before its activity starts. At that boundary this one integration
call installs couriers for the selected class, then reports a cumulative
census containing every tool discovered in the session so far. Returning
to an earlier agent never removes tools from Egma's coverage record.

## Which version of the exchange either side speaks

Nothing here pre-checks it. The version rides the hello in both
directions and :func:`egma.seam.mocked_tools_in` refuses a reply in a
version this SDK does not speak, which is the only reading that stays
true when the two halves are deployed apart. A number carried anywhere
else would be a second answer to the same question, and the second answer
is the one that goes stale.

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
  never had one, which is the same fail-open the production-room path
  takes one level up.
- It **raises what egma refuses**, as the tool's own error, so the model
  sees a tool that failed and can say so. egma's refusals are honest
  answers — a call it has no mock for, a payload it could not read — and
  a courier that swallowed one would leave the simulation waiting on
  nothing.

There is no branch on which a courier waits forever. That is the property
this file is written around.

## What it deliberately does not do

It never aborts the agent. Where egma cannot be reached or will not talk
— a room that would not open, a room where nobody by that name ever
arrived, a version neither side shares, a reply in a shape this SDK
cannot read — the couriers are simply not installed, the agent's own
tools run, and it is said out loud in the log.
egma's record already tells that truth from its own side: a hello it
refused covers nothing, so the coverage stamp shows those tools uncovered
rather than isolated. Taking the customer's agent down to make the same
point would only lose the simulation as well.
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

from . import seam

logger = logging.getLogger("egma")

SIMULATION_ROOM_PREFIX = "egma-sim-"
"""What every room egma conducts a simulation in is named.

Fixed and published, which is the only reason a customer's SDK may key
off it: egma mints ``egma-sim-<run>`` itself where it holds the project's
keys, and asks the customer's own token endpoint for the same name where
it does not, so the prefix is on the room on all four dispatch paths that
can put an agent into one.

It is a weaker anchor than it looks and this side says so rather than
pretending otherwise. A room name is chosen by whoever mints the join
token, and on the token-endpoint access variant that is an internet-facing
endpoint whose whole contract is "the caller names the room". So the
prefix is trusted for the two things a wrong answer merely wastes — the
decision to look for egma at all, and the decision to keep this job's
spans out of production Monitoring — and it is never, by itself, what
this SDK hands a tool inventory to. That is the participant below, and
the tension is real: closing it properly needs egma's own control plane
to confirm the room, which is not a thing this side can do alone today.
"""

EGMA_IDENTITY = "egma-persona"
"""Who egma is in the room: the address every message is sent to.

Two forms, because egma joins under two: exactly this where egma mints
its own token, and this with the simulation appended where a customer's
token endpoint mints it. Both are matched, and nothing that merely begins
with these letters is — an identity is either the name or the name with a
``-`` and a simulation after it.

Matching two forms rather than one exact string is the concession this
side makes to egma joining under two, and it costs the guarantee LiveKit
would otherwise give for free: one identity is unique per room, so an
impersonator taking the exact name would be evicted by the server, while
one taking a name merely *like* it sits quietly beside the real thing.
That is why more than one match is refused outright below rather than
resolved by picking the first.
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
"""What this side allows on top, for the part of the journey with no bound.

**Chosen, not derived, and said to be so.** The two things it covers have
no constant on egma's side to restate, and a derivation from a number
nobody wrote down is a number nobody can check.

What it covers is the time before the bound above even starts running,
plus the sliver at the far end of it:

- On the token-endpoint access variant egma does not hold the project's
  keys, so before it can begin connecting it must ask the customer's own
  endpoint for a token. egma allows that request 20 seconds of its own
  (``TOKEN_SECONDS`` in the simulator's ``media/livekit_room.py``), and
  none of it is part of the connect above.
- egma's participant becomes visible in the room a moment before its two
  methods answer, because the room announces an arrival to everybody in
  it before the joining side's own connect handler has run. egma
  registers the methods in that handler, which is the earliest it can, so
  the window is small — but it is not nothing, and it is the window
  :data:`egma.seam.EGMA_NOT_LISTENING_YET` exists to sit out.

It does not cover the worst case of the first bullet, and that is a trade
rather than an oversight: a token endpoint that takes all 20, followed by
a connect that takes all 30, is 50 seconds against the 45 below. What
runs out here is not a failure this side has to survive intact — it is a
fail-open, said out loud in the log — and holding a customer's agent
silent in front of a caller for longer than the sum below is the worse of
the two outcomes. Both numbers are here to be revised together if a real
simulation is ever found to have run out of them.
"""

STARTUP_SECONDS = EGMA_CONNECT_SECONDS + ARRIVAL_MARGIN_SECONDS
"""How long this SDK may spend finding egma before it gives up. 30 + 15 = 45.

Added up rather than picked, because the worst case this has to cover is
an agent whose job starts at the very moment egma begins connecting —
which is the ordinary case on three of the four dispatch paths. Written
as the sum rather than as its answer so the two halves stay separately
checkable: the 30 against egma's own constant, the 15 against the
sentence above that says what it is for and what it deliberately leaves
uncovered.

One deadline covers both halves of the search, the wait for egma's
participant and the retries against a participant that has not registered
the exchange yet, so the whole of this call is bounded by this number
however the time inside it is spent.

It is a long time to hold an agent before it greets anybody, and that is
the trade taken deliberately: the alternative to waiting is a simulation
in which every mocked tool ran its real implementation, which is a real
appointment booked and a real card charged. Nothing waits here unless the
room's name says simulation, so a production room pays none of it.
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


async def mockable(agent: Agent, ctx: JobContext, session: AgentSession) -> None:
    """Let egma answer for this agent's tools, for this session only.

    Returns having touched nothing outside a simulation. Never raises on
    egma's account: what it cannot arrange, it says in the log and leaves
    alone.
    """
    simulation = _simulation_in(ctx)
    if simulation is None:
        logger.debug(
            "this job's room is not an Egma simulation room, so nothing is "
            "wrapped and every tool runs its own implementation"
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
        #
        # Measured before the connect as well, so an agent that can never
        # report its tools does not pay for a room it will not use.
        seam.fits_on_the_wire("this agent's census of tools", census)
    except seam.SeamError as too_much:
        logger.error(
            "this agent's tools do not fit in one message, so nothing is "
            "wrapped and every tool ran its own implementation: %s",
            too_much,
        )
        return

    # The one deadline. It starts here rather than at the first wait,
    # because what it has to cover is egma's own journey into the room and
    # that began when this job did.
    deadline = asyncio.get_running_loop().time() + STARTUP_SECONDS

    if not ctx.room.isconnected():
        try:
            await ctx.connect()
        except Exception:
            # The one connect this SDK forces is also the one place it
            # could take an agent down that was going to connect for
            # itself a moment later. It does not: a room this side could
            # not open is a room it cannot find egma in, which is the
            # fail-open every other unreachable-egma branch takes.
            logger.exception(
                "simulation %s: this room could not be connected, so nothing "
                "is wrapped and every tool runs its own implementation",
                simulation.named,
            )
            return

    identity = await _egma_in_the_room(ctx.room, deadline, simulation)
    if identity is None:
        return

    seat = _Seat(room=ctx.room, identity=identity)
    try:
        answered = await _asked_until_egma_is_listening(seat, census, deadline)
        mocked = seam.mocked_tools_in(answered)
    except RpcError as refused:
        _hello_refused(refused, identity)
        return
    except seam.SeamError as unreadable:
        logger.error(
            "Egma answered %s in a shape this SDK cannot read, so nothing is "
            "wrapped and every tool ran its own implementation: %s",
            seam.HELLO_METHOD,
            unreadable,
        )
        return

    couriers = _install_couriers(agent, mocked, seat, session)
    _install_handoff_couriers(agent, mocked, seat, session, simulation)
    logger.info(
        "simulation %s: the agent reported %d tool(s) and Egma answers for "
        "%d of them (%s); every other tool runs its own implementation",
        simulation.named,
        len(tools),
        len(couriers),
        ", ".join(couriers) or "none",
    )


def _install_couriers(
    agent: Agent,
    mocked: Sequence[str],
    seat: _Seat,
    session: AgentSession,
) -> dict[str, Callable[..., Any]]:
    """Put this agent instance's couriers in LiveKit's session side table."""
    tools = ToolContext(agent.tools).function_tools
    couriers: dict[str, Callable[..., Any]] = {
        name: _courier(name, tools.get(name), agent, seat) for name in mocked
    }
    mock_tools(type(agent), couriers, session=session)
    return couriers


def _install_handoff_couriers(
    initial_agent: Agent,
    mocked: Sequence[str],
    seat: _Seat,
    session: AgentSession,
    simulation: _Simulation,
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
    simulation: _Simulation,
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


@dataclass(frozen=True)
class _Simulation:
    """That this room is one, and what this side may call it.

    One fact, and it is about the *room* rather than about what the test
    asks. A room's name could carry no test content by design — an agent
    able to read its own script would stop being under test — so nothing
    here could leak one if it tried.

    It is a type rather than a bare string because the question this
    answers is "is this a simulation", and ``None`` for a production room
    says that in one reading at every call site.
    """

    named: str
    """What to call this simulation in a log line, so a developer can line
    their own worker's output up with egma's record. The room's name,
    which is the whole of what this side was told and the whole of what it
    needs."""


def _simulation_in(ctx: JobContext) -> _Simulation | None:
    """Whether this job conducts an egma simulation: the room's name, alone.

    Nothing is the ordinary case, and it is reached without a network, a
    connect or a single message: a production room is a room whose name is
    the customer's own, and every way of not being an egma room ends here
    the same way.

    One signal on purpose. The other thing this side could read is the
    job's dispatch metadata, and that channel is the customer's own — so a
    second reading could add no simulation room the prefix does not
    already cover, and could only take a room that is *not* a simulation
    and treat it as one. This decision suppresses a job's production
    telemetry as well as wrapping its tools, and a trace dropped on a
    false positive is evidence nobody can get back.
    """
    room_name = _room_name(ctx)
    if not room_name.startswith(SIMULATION_ROOM_PREFIX):
        return None
    return _Simulation(named=room_name)


def _room_name(ctx: JobContext) -> str:
    """This job's room name, or nothing where there is not one to read.

    Read defensively, through the job rather than through the room this
    process connected: the job's copy is the one the server handed the
    worker. Anything that is not a job with a room in it answers the same
    way an ordinary production room does, which is also what keeps a
    caller who passed the wrong object reaching the worded complaint
    further down instead of an attribute error here.
    """
    name = getattr(getattr(getattr(ctx, "job", None), "room", None), "name", None)
    return name if isinstance(name, str) else ""


def _answers_to_egmas_name(identity: str) -> bool:
    """Whether a participant in this room is egma, by the name it joined as.

    Two forms and no others: the bare name, which is what egma joins as
    where it mints its own token, and the name with the simulation after
    it, which is what a customer's token endpoint is asked to mint. A
    plain prefix test would also match a name that merely starts with
    these letters, and the whole of the addressing rests on this.
    """
    return identity == EGMA_IDENTITY or identity.startswith(f"{EGMA_IDENTITY}-")


def _egma_candidates(room: Any) -> list[str]:
    """Every remote participant in this room answering to egma's name.

    The room's table is asked whether it can be walked rather than checked
    against a concrete type: LiveKit declares it as a mapping, and a room
    that hands back some other mapping is a room this side can still read.

    A table that cannot be walked at all is read as a room nobody is
    visible in, which is the fail-open every other defensive read here
    takes. It is said at debug level because this runs on every look, and
    the outcome a developer has to act on — a simulation room egma was
    never found in — is already said once, at error, when the search gives
    up.
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
    room: Any, deadline: float, simulation: _Simulation
) -> str | None:
    """egma's identity in this room, waited for, or nothing at the deadline.

    Only ever reached in a room whose name already said simulation, which
    is what makes waiting legitimate at all: a production room never gets
    here, so nothing about a production start is slower than it was.

    The listener is attached before the first look, not after it, because
    a participant who joins between a look and a subscription is a
    participant this side would then wait the whole bound for.
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
                logger.error(
                    "simulation %s: %d participants in this room answer to "
                    "Egma's name (%s), so which one is Egma is not knowable: "
                    "nothing is wrapped and every tool runs its own "
                    "implementation",
                    simulation.named,
                    len(found),
                    ", ".join(found),
                )
                return None

            remaining = deadline - loop.time()
            if remaining <= 0:
                logger.error(
                    "simulation %s: this room is an Egma simulation room and no "
                    "Egma participant joined it within %.0fs, so nothing is "
                    "wrapped and every tool runs its own implementation. Egma "
                    "joins as %r, or as that name with the simulation after "
                    "it: check that Egma's own side of this simulation "
                    "started, and that the token it was minted carries that "
                    "identity (this is egma %s). This job's spans stay out of "
                    "production Monitoring either way, because the room's name "
                    "already said this is a simulation",
                    simulation.named,
                    STARTUP_SECONDS,
                    EGMA_IDENTITY,
                    _this_sdk(),
                )
                return None

            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(
                    arrived.wait(), min(remaining, POLL_SECONDS)
                )
    finally:
        stop_listening()


async def _asked_until_egma_is_listening(
    seat: _Seat, census: str, deadline: float
) -> str:
    """Send the census, allowing for an egma that is in but not yet listening.

    egma's participant enters the room before it registers the two methods
    of the exchange, and on three of the four dispatch paths this agent
    can be asking in exactly that window. The transport answers an
    unregistered method with ``UNSUPPORTED_METHOD``, which this side would
    otherwise read as "there is no egma here" and fall open on for the
    whole simulation — a mocked tool running its real implementation,
    which is the one outcome this file exists to prevent.

    Only that one code is asked again. ``RECIPIENT_NOT_FOUND`` is not,
    even though it is the same kind of race in principle. Nothing reaches
    this function without having seen egma in the room's own participant
    table, so a destination that cannot be found a moment later is one
    that left — and a participant that left is the fail-open every other
    lost participant gets, not a participant to keep calling. Retrying it
    would hold the agent silent for the rest of the bound, in the one
    simulation it was waiting to serve, and end in the same place.
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


def _hello_refused(refused: RpcError, identity: str) -> None:
    """Say what a refused census means, in the terms it means it in."""
    if refused.code == seam.UNSUPPORTED_PROTOCOL_VERSION:
        # The one refusal a customer can act on alone, so it is the one
        # refusal that names the action. Egma's own sentence carries the
        # two version numbers; this side carries the package they belong
        # to, because "Egma speaks 1 and this one declared 2" reads as an
        # SDK that is too new when the fix is usually the other half.
        logger.error(
            "Egma here speaks a version of the mock-tool exchange this SDK "
            "does not, so nothing is wrapped and every tool ran its own "
            "implementation: %s. Upgrade that Egma deployment, or install "
            "the `egma` package that shipped with it (this is egma %s)",
            refused.message,
            _this_sdk(),
        )
        return
    if refused.code in seam.EGMA_NOT_REACHED:
        logger.warning(
            "no Egma participant answered at %r in this room, so nothing is "
            "wrapped and every tool runs its own implementation (%s)",
            identity,
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
    no SDK installed — which is the same answer the production-room path
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
