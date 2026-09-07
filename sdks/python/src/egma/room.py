"""Identify simulation rooms by the published ``egma-sim-`` prefix.

Read the job's room name before connecting. The name is available on
every dispatch path; job dispatch metadata belongs to the customer
and must not be used as a second simulation signal.
"""

from __future__ import annotations

from dataclasses import dataclass

SIMULATION_ROOM_PREFIX = "egma-sim-"
"""Prefix used to select simulation discovery and exclude spans from production
ingestion.

The token issuer controls the room name, so this prefix is not authentication.
The SDK also matches the Egma participant by name before sending tool schemas;
it does not confirm that identity with the Egma control plane.
"""


@dataclass(frozen=True)
class Simulation:
    """Simulation room identity, with no test content.

    The lookup returns None for production rooms.
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
