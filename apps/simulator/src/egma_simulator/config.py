"""Environment-driven configuration.

The simulator is one more compose container that only dials out, so
everything it needs to know arrives as ``EGMA_SIMULATOR_*`` environment
variables — no flags, no config files, nothing that would make the hosted
and self-hosted deployments differ.

A container's whole conversation with whoever deployed it is its
environment and its first log lines, which settles how everything below
behaves. One variable is required, because a simulator with no control
plane is nothing; everything else has a default that works. Anything set
to something unusable is refused here, at startup, in a sentence naming
the variable — never discovered halfway through somebody's first
simulation, and never guessed at.
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field
from pathlib import Path

from .reporting import DELIVERY_DEADLINE_SECONDS

MODEL_PROVIDERS = ("scripted", "openai")
DEFAULT_MODEL_BASE_URL = "https://api.openai.com/v1"
LOG_LEVELS = ("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG")


def _text(name: str, fallback: str | None = None) -> str | None:
    """A variable's value, where blank means absent.

    Compose passes an unset optional through as an empty string rather
    than leaving it out, which is what lets a compose entry carry a
    ``${VAR:-}`` default at all. So "" and "never set" have to mean the
    same thing here: otherwise a blank model base URL would become a base
    URL of nothing, and the first request would go nowhere with no idea
    why.
    """
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return fallback
    return raw.strip()


def _whole(name: str, fallback: int) -> int:
    """A count from the environment, refused by name rather than by Python's."""
    raw = _text(name)
    if raw is None:
        return fallback
    try:
        return int(raw)
    except ValueError:
        raise ValueError(f"{name} must be a whole number, got {raw!r}") from None


def _seconds(name: str, fallback: float, *, allow_zero: bool = False) -> float:
    """A duration from the environment, refused rather than guessed at."""
    raw = _text(name)
    if raw is None:
        return fallback
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(
            f"{name} must be a number of seconds, got {raw!r}"
        ) from None
    if value < 0 or (value == 0 and not allow_zero):
        wanted = "zero or more" if allow_zero else "more than zero"
        raise ValueError(f"{name} must be {wanted}, got {raw}")
    return value


def _level(name: str, fallback: str) -> str:
    """A log level, checked here so the refusal can name the variable.

    Handing an unknown level to the logging module raises too, but a
    ``Unknown level: 'CHATTY'`` from inside logging setup tells a
    self-hoster nothing about which of their variables to fix.
    """
    level = _text(name, fallback).upper()
    if level not in LOG_LEVELS:
        raise ValueError(
            f"{name} must be one of {', '.join(LOG_LEVELS)}; got {level!r}"
        )
    return level


def _writable_directory(name: str, path: Path) -> Path:
    """A directory the simulator can really write to, proven at startup.

    In a compose deployment both directories are a mounted volume, and a
    volume that is read-only, or owned by somebody else, or shadowed by a
    file, does not announce itself. It waits — for the recording at the
    end of a voice exchange, or for the first report on its way out — and
    then takes that simulation down with it. A container that cannot keep
    what it is asked to keep should say so before it claims anything.

    Proving it is also making it, which is the other half of the point: a
    fresh volume arrives empty and nothing else would create the two
    directories inside it.
    """
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f".egma-simulator-write-probe-{os.getpid()}"
        probe.write_bytes(b"")
        probe.unlink()
    except OSError as refusal:
        raise ValueError(
            f"{name}={path} is not a directory the simulator can write to: "
            f"{refusal}"
        ) from refusal
    return path


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

    service_token: str | None = field(default=None, repr=False)
    """What the simulator shows the control plane to be allowed to claim.

    It rides every outbound call as a bearer, the same header an egma key
    uses everywhere else. Optional, because the workbench asks for nothing
    and a local run should need nothing; a control plane handing out real
    work asks for it. Kept out of the dataclass repr — it is a credential
    and travels like one."""

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
        url = _text("EGMA_SIMULATOR_CONTROL_PLANE_URL")
        if not url:
            raise ValueError(
                "EGMA_SIMULATOR_CONTROL_PLANE_URL is required: the simulator "
                "is nothing without a control plane to claim from"
            )
        if not url.startswith(("http://", "https://")):
            # `api:3100` is the natural thing to write next to a compose
            # service name, and it reaches nothing. Said now rather than
            # by the first claim failing with an unreadable URL error.
            raise ValueError(
                "EGMA_SIMULATOR_CONTROL_PLANE_URL must start with http:// or "
                f"https://, got {url!r}"
            )

        capacity = _whole("EGMA_SIMULATOR_CAPACITY", 4)
        if capacity < 1:
            raise ValueError(
                f"EGMA_SIMULATOR_CAPACITY must be at least 1, got {capacity}"
            )

        provider = _text("EGMA_SIMULATOR_MODEL_PROVIDER", "scripted")
        if provider not in MODEL_PROVIDERS:
            raise ValueError(
                "EGMA_SIMULATOR_MODEL_PROVIDER must be one of "
                f"{', '.join(MODEL_PROVIDERS)}; got {provider!r}"
            )
        model_name = _text("EGMA_SIMULATOR_MODEL_NAME")
        model_api_key = _text("EGMA_SIMULATOR_MODEL_API_KEY")
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
            claimant=_text(
                "EGMA_SIMULATOR_CLAIMANT",
                f"egma-simulator-{socket.gethostname()}-{os.getpid()}",
            ),
            capacity=capacity,
            heartbeat_seconds=_seconds("EGMA_SIMULATOR_HEARTBEAT_SECONDS", 5.0),
            claim_wait_seconds=_seconds("EGMA_SIMULATOR_CLAIM_WAIT_SECONDS", 30.0),
            report_deadline_seconds=_seconds(
                "EGMA_SIMULATOR_REPORT_DEADLINE_SECONDS", DELIVERY_DEADLINE_SECONDS
            ),
            wal_dir=_writable_directory(
                "EGMA_SIMULATOR_WAL_DIR",
                Path(_text("EGMA_SIMULATOR_WAL_DIR", ".egma-simulator/wal")),
            ),
            blob_dir=_writable_directory(
                "EGMA_SIMULATOR_BLOB_DIR",
                Path(_text("EGMA_SIMULATOR_BLOB_DIR", ".egma-simulator/blobs")),
            ),
            log_level=_level("EGMA_SIMULATOR_LOG_LEVEL", "INFO"),
            service_token=_text("EGMA_SIMULATOR_SERVICE_TOKEN"),
            model_provider=provider,
            model_base_url=_text(
                "EGMA_SIMULATOR_MODEL_BASE_URL", DEFAULT_MODEL_BASE_URL
            ).rstrip("/"),
            model_name=model_name,
            model_api_key=model_api_key,
        )
