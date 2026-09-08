"""Egma reporting and mock tools inside a LiveKit agent.

Await ``simulation(agent, ctx, session)`` before ``AgentSession.start``
in simulation rooms. It reports tools, installs the test's mock tools,
and exports agent-POV spans. Failure to report raises ``NotReported``.

Call ``monitor(ctx)`` before startup to export production spans. Both
helpers select their role from the room name and do nothing in the other
room type. Both read ``EGMA_URL`` and ``EGMA_API_KEY`` or explicit arguments.
See README.md for integration examples.
"""

from .monitoring import monitor
from .simulation_room import NotReported, simulation

__all__ = ["NotReported", "monitor", "simulation"]
