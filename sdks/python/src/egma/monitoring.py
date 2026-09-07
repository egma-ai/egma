"""Export production spans from a LiveKit worker.

Select production by room name before connecting. Simulation rooms are
handled by ``egma.simulation`` and are ignored here.
"""

from __future__ import annotations

import logging

from livekit.agents import JobContext

from . import export
from .room import simulation_in

logger = logging.getLogger("egma")

VERB = "egma.monitor"
"""What this verb is called, for every sentence it has to say."""


def monitor(
    ctx: JobContext,
    *,
    endpoint: str | None = None,
    api_key: str | None = None,
) -> None:
    """Export this LiveKit worker's production spans to Egma.

    Call once before ``AgentSession.start``. ``endpoint`` and ``api_key``
    default to ``EGMA_URL`` and ``EGMA_API_KEY``. Repeated calls with the
    same settings reuse the exporter; job shutdown flushes buffered spans.

    Raise ``ValueError`` for invalid settings, unsupported LiveKit/provider
    configuration, or another job requesting different settings in this
    process. Returns without changes in simulation rooms.
    """

    # Simulation rooms export through simulation(), not production monitoring.
    # Log suppression because a production room using the reserved prefix
    # would otherwise lose its monitoring evidence without notice.
    simulation = simulation_in(ctx)
    if simulation is not None:
        logger.warning(
            "this job runs in the Egma simulation room %r, so its spans are "
            "not exported to production Monitoring: egma.simulation exports "
            "them under that simulation instead",
            simulation.named,
        )
        return

    export.install(ctx, verb=VERB, endpoint=endpoint, api_key=api_key)
