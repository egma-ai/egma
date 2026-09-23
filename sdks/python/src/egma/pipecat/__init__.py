"""Egma for Pipecat bots.

    from egma.pipecat import monitor, simulation

    worker = PipelineWorker(pipeline, ...)
    await simulation(worker, runner_args)   # simulation testing
    await monitor(worker, runner_args)      # production monitoring
    await runner.add_workers(worker)

``simulation`` does nothing unless the start request that started this bot
carried Egma's ``egma`` body key. For a simulation Egma confirms live, it
answers the test's mock tools from Egma, runs every other tool for real,
and exports the bot's own record of the conversation. If the bot cannot
report to Egma it raises ``NotReported`` and the bot must not start.

``monitor`` exports production conversations to Egma Monitoring and does
nothing in a simulation Egma has confirmed.

Both read ``EGMA_URL`` and ``EGMA_API_KEY``, or explicit arguments. This
module needs ``pipecat-ai``: install ``egma[pipecat]``. It never imports
LiveKit. Mock tools read a private part of Pipecat's LLM service, so the
extra holds a range of tested minors; a Pipecat outside it is logged once,
when this module loads.
"""

from __future__ import annotations

from .._frameworks import require, warn_outside_range

require("pipecat", label="Pipecat", distribution="pipecat-ai", extra="pipecat")
warn_outside_range("pipecat-ai", "pipecat")

from ..errors import NotReported  # noqa: E402
from .verbs import monitor, simulation  # noqa: E402

__all__ = ["NotReported", "monitor", "simulation"]
