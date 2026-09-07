"""Egma inside a LiveKit agent: two verbs, one room each.

This package is the piece of egma that lives in *your* process. It has
two verbs, and which one acts is decided by the name of the room the job
was given — never by configuration, and never by both at once.

**A simulation room.** One call, after the agent is built and before the
session starts::

    from egma import simulation

    await simulation(agent, ctx, session)

It reports the agent's tools to egma, puts egma in front of exactly the
tools this simulation mocks — so a test never books the real appointment,
sends the real SMS or charges the real card — and exports the agent's own
spans to egma as this simulation's agent POV.

It is **required** for a LiveKit simulation, and it fails closed: an
agent that cannot report to egma raises :class:`egma.NotReported`, the
session does not start, and egma ends the simulation saying the same
thing from its own side. A simulation that ran without reporting would
have called real backends where a mock tool was meant to answer, and its
record would claim nothing about it.

**A production room.** One call, before the session starts::

    from egma import monitor

    monitor(ctx)

It exports that conversation's spans to Monitoring.

Each verb is inert where the other applies. In a production room
``simulation`` returns having touched nothing: the same tool objects, no
side table, no exporter, not one message on the wire. That is a test in
this package, not a promise in this docstring.

Both read ``EGMA_URL`` and ``EGMA_API_KEY``, or the matching arguments.
See ``README.md`` for both integrations.
"""

from .monitoring import monitor
from .simulation_room import NotReported, simulation

__all__ = ["NotReported", "monitor", "simulation"]
