"""Environment-driven configuration.

The simulator is one more compose container that only dials out, so
everything it needs to know arrives as ``EGMA_SIMULATOR_*`` environment
variables — no flags, no config files, nothing that would make the hosted
and self-hosted deployments differ.
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field
from pathlib import Path

from .reporting import DELIVERY_DEADLINE_SECONDS

MODEL_PROVIDERS = ("scripted", "openai")
DEFAULT_MODEL_BASE_URL = "https://api.openai.com/v1"


def _seconds(name: str, fallback: float, *, allow_zero: bool = False) -> float:
    """A duration from the environment, refused rather than guessed at."""
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return fallback
    value = float(raw)
    if value < 0 or (value == 0 and not allow_zero):
        wanted = "zero or more" if allow_zero else "more than zero"
        raise ValueError(f"{name} must be {wanted}, got {raw}")
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

    report_deadline_seconds: float
    """How long one report keeps being resent before the WAL becomes its only record."""

    wal_dir: Path
    """Where report documents are written before they are sent."""

    blob_dir: Path
    """Where recordings land, for the filesystem-backed blob store — the
    default one, so a first voice simulation needs no object storage
    running. A report carries only the reference."""

    log_level: str

    model_provider: str = "scripted"
    """Where the persona's words come from: ``scripted`` (deterministic,
    what CI and the local workbench story run on) or ``openai`` (any
    provider speaking the OpenAI chat-completions shape)."""

    model_base_url: str = DEFAULT_MODEL_BASE_URL
    """The provider's base URL, for the ``openai`` provider."""

    model_name: str | None = None
    """Which model to ask for. Required for the ``openai`` provider."""

    model_api_key: str | None = field(default=None, repr=False)
    """The provider key. Required for the ``openai`` provider; kept out of
    the dataclass repr so no log line can carry it by accident."""

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

        provider = os.environ.get("EGMA_SIMULATOR_MODEL_PROVIDER", "scripted")
        if provider not in MODEL_PROVIDERS:
            raise ValueError(
                "EGMA_SIMULATOR_MODEL_PROVIDER must be one of "
                f"{', '.join(MODEL_PROVIDERS)}; got {provider!r}"
            )
        model_name = os.environ.get("EGMA_SIMULATOR_MODEL_NAME") or None
        model_api_key = os.environ.get("EGMA_SIMULATOR_MODEL_API_KEY") or None
        if provider == "openai":
            if model_name is None:
                raise ValueError(
                    "EGMA_SIMULATOR_MODEL_NAME is required when "
                    "EGMA_SIMULATOR_MODEL_PROVIDER=openai"
                )
            if model_api_key is None:
                raise ValueError(
                    "EGMA_SIMULATOR_MODEL_API_KEY is required when "
                    "EGMA_SIMULATOR_MODEL_PROVIDER=openai"
                )

        return cls(
            control_plane_url=url.rstrip("/"),
            claimant=os.environ.get(
                "EGMA_SIMULATOR_CLAIMANT",
                f"egma-simulator-{socket.gethostname()}-{os.getpid()}",
            ),
            capacity=capacity,
            heartbeat_seconds=_seconds("EGMA_SIMULATOR_HEARTBEAT_SECONDS", 5.0),
            claim_wait_seconds=_seconds("EGMA_SIMULATOR_CLAIM_WAIT_SECONDS", 30.0),
            report_deadline_seconds=_seconds(
                "EGMA_SIMULATOR_REPORT_DEADLINE_SECONDS", DELIVERY_DEADLINE_SECONDS
            ),
            wal_dir=Path(
                os.environ.get("EGMA_SIMULATOR_WAL_DIR", ".egma-simulator/wal")
            ),
            blob_dir=Path(
                os.environ.get("EGMA_SIMULATOR_BLOB_DIR", ".egma-simulator/blobs")
            ),
            log_level=os.environ.get("EGMA_SIMULATOR_LOG_LEVEL", "INFO"),
            model_provider=provider,
            model_base_url=os.environ.get(
                "EGMA_SIMULATOR_MODEL_BASE_URL", DEFAULT_MODEL_BASE_URL
            ).rstrip("/"),
            model_name=model_name,
            model_api_key=model_api_key,
        )
