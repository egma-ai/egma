"""Egma for LiveKit Agents workers.

    from egma.livekit import monitor, simulation

Await ``simulation(agent, ctx, session)`` before ``AgentSession.start``
in simulation rooms. It reports tools, installs the test's mock tools,
and exports agent-POV spans. Failure to report raises ``NotReported``.

Call ``monitor(ctx)`` before startup to export production spans. Both
helpers select their role from the room name and do nothing in the other
room type. Both read ``EGMA_URL`` and ``EGMA_API_KEY`` or explicit
arguments.

This module needs ``livekit-agents``. Install it with the LiveKit extra:
``pip install "egma[livekit]"``. A LiveKit version outside the extra's
tested range is logged once, when this module loads.
"""

from __future__ import annotations

from .._frameworks import require, warn_outside_range

require(
    "livekit.agents", label="LiveKit", distribution="livekit-agents", extra="livekit"
)
warn_outside_range("livekit-agents", "livekit")

from ..errors import NotReported  # noqa: E402
from ..monitoring import monitor  # noqa: E402
from ..simulation_room import simulation  # noqa: E402

__all__ = ["NotReported", "monitor", "simulation"]
