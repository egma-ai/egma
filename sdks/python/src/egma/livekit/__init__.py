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
``pip install "egma[livekit]"``.
"""

from __future__ import annotations

import logging
import re
from importlib.metadata import PackageNotFoundError, version

logger = logging.getLogger("egma")

SUPPORTED_LIVEKIT_AGENTS = ">=1.6.6,<1.9"
"""The ``livekit-agents`` range this SDK is tested against.

The same range as the ``[livekit]`` extra. A worker that installs plain
``egma`` beside its own ``livekit-agents`` gets no resolver check, so the
range is also checked here, once, when this module loads.
"""

_FLOOR = (1, 6, 6)
_CEILING = (1, 9, 0)


def _require_livekit() -> None:
    """Import LiveKit Agents, or say which extra installs it."""
    try:
        import livekit.agents  # noqa: F401
    except ModuleNotFoundError as missing:
        if (missing.name or "").split(".")[0] != "livekit":
            raise
        raise ModuleNotFoundError(
            "egma's LiveKit integration needs livekit-agents, and it is not "
            'installed here. Install the LiveKit extra: pip install "egma[livekit]". '
            "A Pipecat bot imports egma.pipecat instead.",
            name=missing.name,
        ) from missing


def _release(text: str) -> tuple[int, int, int] | None:
    """The numeric release of a version string, or None if unreadable."""
    matched = re.match(r"(\d+)\.(\d+)(?:\.(\d+))?", text)
    if matched is None:
        return None
    major, minor, patch = matched.groups()
    return int(major), int(minor), int(patch or 0)


def _warn_outside_supported_range() -> None:
    """Log once when the installed livekit-agents is outside the tested range."""
    try:
        installed = version("livekit-agents")
    except PackageNotFoundError:
        return
    release = _release(installed)
    if release is None or _FLOOR <= release < _CEILING:
        return
    logger.warning(
        "egma supports livekit-agents %s, and this worker runs %s. Mock tools "
        "and trace export may not work. Install a supported version with "
        'pip install "egma[livekit]".',
        SUPPORTED_LIVEKIT_AGENTS,
        installed,
    )


_require_livekit()
_warn_outside_supported_range()

from ..errors import NotReported  # noqa: E402
from ..monitoring import monitor  # noqa: E402
from ..simulation_room import simulation  # noqa: E402

__all__ = ["NotReported", "SUPPORTED_LIVEKIT_AGENTS", "monitor", "simulation"]
