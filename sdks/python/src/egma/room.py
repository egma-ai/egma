"""Which room this job runs in, which is the whole of what both verbs ask.

One fact decides everything this SDK does: the **name of the room** the
job was given. Every room egma conducts a simulation in is named
``egma-sim-…``, and that prefix is fixed and published. A room named
anything else is a production room, where :func:`egma.simulation` returns
having touched nothing and :func:`egma.monitor` does its work.

The name is read off the job, before anything is connected and without
asking anybody, so a production room pays nothing at all for this SDK
being installed.

The name is read rather than the job's dispatch metadata because dispatch
metadata belongs to the customer. LiveKit teaches it as the channel for a
caller's own identifiers, so anything of egma's written there both
collides with what a customer already reads and, worse, arrives on only
one of the three dispatch paths that can put an agent in an egma room: it
is carried by the dispatch egma makes itself, and on the other two the
customer's own endpoint dispatches and egma writes nothing. A room name
arrives on all three.

It is also the *only* signal, for the same reason. A second way of saying
"simulation" could catch no simulation room the prefix does not already
catch, and could only add rooms that are not simulations at all — whose
tools would then be wrapped and whose spans would be held back from
production Monitoring. A dropped trace is evidence a customer cannot get
back. One signal that is honest about being weak beats two where the
second can only be wrong.
"""

from __future__ import annotations

from dataclasses import dataclass

SIMULATION_ROOM_PREFIX = "egma-sim-"
"""What every room egma conducts a simulation in is named.

Fixed and published, which is the only reason a customer's SDK may key
off it: egma mints ``egma-sim-<run>`` itself where it holds the project's
keys, and asks the customer's own token endpoint for the same name where
it does not, so the prefix is on the room on all three dispatch paths
that can put an agent into one.

It is a weaker anchor than it looks and this side says so rather than
pretending otherwise. A room name is chosen by whoever mints the join
token, and on the token-endpoint access variant that is an internet-facing
endpoint whose whole contract is "the caller names the room". So the
prefix is trusted for the two things a wrong answer merely wastes — the
decision to look for egma at all, and the decision to keep this job's
spans out of production Monitoring — and it is never, by itself, what
this SDK hands a tool inventory to. That is egma's participant, found by
name in the room, and the tension is real: closing it properly needs
egma's own control plane to confirm the room, which is not a thing this
side can do alone today.
"""


@dataclass(frozen=True)
class Simulation:
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
    """What to call this simulation, in a log line so a developer can line
    their own worker's output up with egma's record, and on every span so
    egma can file the agent's POV under the simulation this room ran. The
    room's name, which is the whole of what this side was told and the
    whole of what it needs."""


def simulation_in(ctx: object) -> Simulation | None:
    """Whether this job conducts an egma simulation: the room's name, alone.

    Nothing is the ordinary case, and it is reached without a network, a
    connect or a single message.
    """
    name = room_name(ctx)
    if not name.startswith(SIMULATION_ROOM_PREFIX):
        return None
    return Simulation(named=name)


def room_name(ctx: object) -> str:
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
