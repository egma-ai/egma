"""Environment-driven configuration.

The simulator is one more compose container that only dials out, so
everything it needs to know arrives as ``EGMA_SIMULATOR_*`` environment
variables — no flags, no config files, nothing that would make the hosted
and self-hosted deployments differ.
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from pathlib import Path


def _positive_seconds(name: str, fallback: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return fallback
    value = float(raw)
    if value <= 0:
        raise ValueError(f"{name} must be positive, got {raw}")
    return value


def _nonnegative_seconds(name: str, fallback: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return fallback
    value = float(raw)
    if value < 0:
        raise ValueError(f"{name} must not be negative, got {raw}")
    return value


@dataclass(frozen=True)
class SimulatorConfig:
    """Everything the simulator reads from its environment."""

    control_plane_url: str
    """Base URL of the control plane (in dev and test: the workbench)."""

    claimant: str
    """How this simulator names itself when claiming — stamped on the row."""

    capacity: int
    """The most simulations conducted at once; claims never exceed the free part."""

    heartbeat_seconds: float
    """How often each running simulation heartbeats. Directives ride the answers."""

    claim_wait_seconds: float
    """How long one claim request is willing to hang before asking again."""

    echo_turn_seconds: float
    """Pacing between echo turns. Zero conducts as fast as the pipe carries."""

    wal_dir: Path
    """Where report documents are written before they are sent."""

    log_level: str

    @classmethod
    def from_env(cls) -> SimulatorConfig:
        url = os.environ.get("EGMA_SIMULATOR_CONTROL_PLANE_URL")
        if not url:
            raise ValueError(
                "EGMA_SIMULATOR_CONTROL_PLANE_URL is required: the simulator "
                "is nothing without a control plane to claim from"
            )

        capacity = int(os.environ.get("EGMA_SIMULATOR_CAPACITY", "4"))
        if capacity < 1:
            raise ValueError(
                f"EGMA_SIMULATOR_CAPACITY must be at least 1, got {capacity}"
            )

        return cls(
            control_plane_url=url.rstrip("/"),
            claimant=os.environ.get(
                "EGMA_SIMULATOR_CLAIMANT",
                f"egma-simulator-{socket.gethostname()}-{os.getpid()}",
            ),
            capacity=capacity,
            heartbeat_seconds=_positive_seconds(
                "EGMA_SIMULATOR_HEARTBEAT_SECONDS", 5.0
            ),
            claim_wait_seconds=_positive_seconds(
                "EGMA_SIMULATOR_CLAIM_WAIT_SECONDS", 30.0
            ),
            echo_turn_seconds=_nonnegative_seconds(
                "EGMA_SIMULATOR_ECHO_TURN_SECONDS", 0.0
            ),
            wal_dir=Path(
                os.environ.get("EGMA_SIMULATOR_WAL_DIR", ".egma-simulator/wal")
            ),
            log_level=os.environ.get("EGMA_SIMULATOR_LOG_LEVEL", "INFO"),
        )
