"""Send LiveKit Agents production spans to an Egma project.

``monitor`` is one of this SDK's two verbs. It is the production one:
called in a production worker, it exports that conversation's spans to
Monitoring. Its sibling :func:`egma.simulation` does the simulation room,
and the two never both act — each is inert where the other applies.

Both read the same one fact to tell those apart, and only that fact: the
name of the room this job was given. For ``monitor`` that name is also
all there is to read — it is synchronous and runs before the room is
connected, so there is nobody in the room to ask — and it is all there is
to need, because a room Egma named is a simulation whether or not
anybody has joined it yet.
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

    Call this once in the job entrypoint, before ``AgentSession.start``.
    ``endpoint`` defaults to ``EGMA_URL`` and ``api_key`` defaults to
    ``EGMA_API_KEY``. The API key is the existing Egma project API key.

    Repeated calls with the same settings reuse the exporter. Each job gets
    one shutdown callback so its last buffered spans are sent before exit.

    In a simulation room this returns having done nothing:
    :func:`egma.simulation` exports that conversation instead, and under
    the simulation it belongs to.
    """

    # A simulation already has its own trace path, and its own verb.
    # Exporting the agent side of the same room through the production
    # door would make one simulation look like a second production
    # conversation in Monitoring.
    #
    # The room's name is the whole of the question, here and in
    # `simulation`, read straight off the job with no network and nothing
    # connected.
    #
    # Suppression is said out loud. A room name is chosen by whoever mints
    # the join token, so this guard can in principle be tripped by a
    # production room named to look like a simulation — and the cost of
    # that would be a conversation with no record in Monitoring at all. A
    # dropped trace is evidence the customer cannot get back, so the one
    # thing this side can do for it is make it visible in the worker's own
    # log.
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
