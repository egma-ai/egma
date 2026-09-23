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
LiveKit.
"""

from __future__ import annotations

import logging
import re
from importlib.metadata import PackageNotFoundError, version

logger = logging.getLogger("egma")

SUPPORTED_PIPECAT = ">=1.9,<1.12"
"""The ``pipecat-ai`` range this SDK is tested against, minor by minor.

The same range as the ``[pipecat]`` extra. Mock tools read a private part
of Pipecat's LLM service, so a new minor joins the range once it passes.
"""

_FLOOR = (1, 9, 0)
_CEILING = (1, 12, 0)


def _require_pipecat() -> None:
    """Import Pipecat, or say which extra installs it."""
    try:
        import pipecat  # noqa: F401
    except ModuleNotFoundError as missing:
        if (missing.name or "").split(".")[0] != "pipecat":
            raise
        raise ModuleNotFoundError(
            "egma's Pipecat integration needs pipecat-ai, and it is not "
            'installed here. Install the Pipecat extra: pip install "egma[pipecat]".',
            name=missing.name,
        ) from missing


def _release(text: str) -> tuple[int, int, int] | None:
    matched = re.match(r"(\d+)\.(\d+)(?:\.(\d+))?", text)
    if matched is None:
        return None
    major, minor, patch = matched.groups()
    return int(major), int(minor), int(patch or 0)


def _warn_outside_supported_range() -> None:
    """Log once when the installed pipecat-ai is outside the tested range."""
    try:
        installed = version("pipecat-ai")
    except PackageNotFoundError:
        return
    release = _release(installed)
    if release is None or _FLOOR <= release < _CEILING:
        return
    logger.warning(
        "egma supports pipecat-ai %s, and this bot runs %s. Mock tools may "
        'not work. Install a supported version with pip install "egma[pipecat]".',
        SUPPORTED_PIPECAT,
        installed,
    )


_require_pipecat()
_warn_outside_supported_range()

from ..errors import NotReported  # noqa: E402
from .verbs import monitor, simulation  # noqa: E402

__all__ = ["NotReported", "SUPPORTED_PIPECAT", "monitor", "simulation"]
