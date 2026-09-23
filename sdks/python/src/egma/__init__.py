"""Egma simulation testing and production monitoring for voice agents.

LiveKit Agents workers::

    from egma.livekit import monitor, simulation

``from egma import monitor, simulation`` names the same LiveKit functions.

Pipecat bots::

    from egma.pipecat import monitor, simulation

Each integration loads only its own framework. Importing ``egma`` or
``egma.pipecat`` never imports LiveKit; the top-level LiveKit names load
LiveKit code on first use. See README.md for integration examples.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .errors import NotReported

__all__ = ["NotReported", "monitor", "simulation"]

_LIVEKIT_NAMES = frozenset({"monitor", "simulation"})
"""Top-level names that belong to the LiveKit integration."""

if TYPE_CHECKING:
    from .monitoring import monitor
    from .simulation_room import simulation


def __getattr__(name: str) -> Any:
    """Load a LiveKit name from ``egma.livekit`` when it is first used."""
    if name in _LIVEKIT_NAMES:
        from . import livekit

        value = getattr(livekit, name)
        globals()[name] = value
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted({*globals(), *_LIVEKIT_NAMES})
