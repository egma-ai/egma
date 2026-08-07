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

import math
import os
import socket
from dataclasses import dataclass, field
from pathlib import Path

from .reporting import DELIVERY_DEADLINE_SECONDS

MODEL_PROVIDERS = ("scripted", "openai")
DEFAULT_MODEL_BASE_URL = "https://api.openai.com/v1"
LOG_LEVELS = ("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG")

STT_PROVIDERS = ("scripted", "deepgram")
"""What the persona hears with. ``scripted`` needs no account and no network."""

TTS_PROVIDERS = ("scripted", "elevenlabs")
"""What the persona speaks with. ``scripted`` needs no account and no network."""

SPEECH_PROVIDER_KEYS = {
    "deepgram": "EGMA_SIMULATOR_DEEPGRAM_API_KEY",
    "elevenlabs": "EGMA_SIMULATOR_ELEVENLABS_API_KEY",
}
"""The variable each real speech provider's key arrives in. Naming a
provider is what makes its key required, and the refusal names this."""

MEDIA_BACKENDS = ("scripted", "livekit")
"""How a phone call's audio may travel. Naming one is what makes a
simulator able to dial at all, and what makes that backend's own
variables required."""


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
    if not math.isfinite(value):
        # `float()` reads "nan", "inf" and "-inf", and the range check
        # below cannot catch the first two: every comparison against nan
        # is False, and +inf is greater than zero, so both would be taken
        # as a duration. What they would then buy is silence — an
        # infinite heartbeat interval never beats again, so the control
        # plane sees an orphan while the simulation is conducting fine,
        # and an infinite report deadline retries one report until the
        # process ends, holding a capacity slot nothing will free. Both
        # are worse than not starting.
        raise ValueError(
            f"{name} must be a finite number of seconds, got {raw!r}"
        )
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


def _one_of(name: str, allowed: tuple[str, ...], fallback: str) -> str:
    """A variable naming one of a short list, refused by name when it does not."""
    chosen = _text(name, fallback)
    if chosen not in allowed:
        raise ValueError(
            f"{name} must be one of {', '.join(allowed)}; got {chosen!r}"
        )
    return chosen


def _speech_key(provider: str) -> str:
    """The key a chosen speech provider needs, or a refusal naming its variable.

    Choosing a provider is the whole of what makes its key required. A
    simulator started with a provider it has no key for would conduct
    nothing: every voice simulation it claimed would fail at the first
    turn, one after another, with the provider's refusal rather than with
    the one sentence that says which variable to set. So it says it here,
    before it claims anything.
    """
    variable = SPEECH_PROVIDER_KEYS[provider]
    key = _text(variable)
    if key is None:
        raise ValueError(f"{variable} is required when the {provider} leg is chosen")
    return key


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
class MediaSettings:
    """How this deployment places a phone call, read once at startup.

    A phone call needs a bridge and — for a real one — a SIP trunk, and
    both belong to the deployment rather than to any one simulation. So
    they arrive here, are checked here, and a simulator that cannot place
    calls says so on its first line naming the variable rather than
    failing one claimed simulation after another with the same sentence.

    A deployment that names no backend gets no settings at all and starts
    in silence: dialling is opt-in, and a simulator that never dials
    should not have to explain a trunk it does not want.
    """

    backend: str
    """Which driver places the call — one of :data:`MEDIA_BACKENDS`."""

    livekit_url: str | None = None
    livekit_api_key: str | None = None
    livekit_api_secret: str | None = field(default=None, repr=False)

    trunk_id: str | None = None
    """A SIP trunk already stored in LiveKit. Wins over the inline fields."""

    trunk_address: str | None = None
    trunk_number: str | None = None
    trunk_username: str | None = None
    trunk_password: str | None = field(default=None, repr=False)

    @property
    def secrets(self) -> tuple[str, ...]:
        """Every secret these settings hold, for redaction. One place to
        ask, so a third one arriving cannot fall out of the scrubbing."""
        return tuple(
            secret
            for secret in (self.livekit_api_secret, self.trunk_password)
            if secret is not None
        )

    @classmethod
    def from_env(cls) -> MediaSettings | None:
        """This deployment's bridge, or ``None`` where it names none."""
        named = _text("EGMA_SIMULATOR_MEDIA_BACKEND")
        if named is None:
            return None
        if named not in MEDIA_BACKENDS:
            raise ValueError(
                "EGMA_SIMULATOR_MEDIA_BACKEND must be one of "
                f"{', '.join(MEDIA_BACKENDS)}; got {named!r}"
            )
        if named != "livekit":
            return cls(backend=named)

        settings = cls(
            backend=named,
            livekit_url=_needed("EGMA_SIMULATOR_LIVEKIT_URL", named),
            livekit_api_key=_needed("EGMA_SIMULATOR_LIVEKIT_API_KEY", named),
            livekit_api_secret=_needed("EGMA_SIMULATOR_LIVEKIT_API_SECRET", named),
            trunk_id=_text("EGMA_SIMULATOR_SIP_TRUNK_ID"),
            trunk_address=_text("EGMA_SIMULATOR_SIP_TRUNK_ADDRESS"),
            trunk_number=_text("EGMA_SIMULATOR_SIP_TRUNK_NUMBER"),
            trunk_username=_text("EGMA_SIMULATOR_SIP_TRUNK_USERNAME"),
            trunk_password=_text("EGMA_SIMULATOR_SIP_TRUNK_PASSWORD"),
        )
        if settings.trunk_id is None and settings.trunk_address is None:
            raise ValueError(
                "a phone call needs a trunk: set EGMA_SIMULATOR_SIP_TRUNK_ID "
                "for a trunk already stored in LiveKit, or "
                "EGMA_SIMULATOR_SIP_TRUNK_ADDRESS with "
                "EGMA_SIMULATOR_SIP_TRUNK_USERNAME and "
                "EGMA_SIMULATOR_SIP_TRUNK_PASSWORD for an inline one"
            )
        # Credential auth is a pair. Neither half is a trunk the carrier
        # authenticates some other way — by the address it came from — and
        # that is a real deployment. One half is nobody's deployment: every
        # call it places comes back 403, which reads as *wrong* credentials
        # rather than as half of one, and it reads that way once per
        # simulation until somebody looks here.
        if (settings.trunk_username is None) != (settings.trunk_password is None):
            # Both names written out whole, never assembled from parts: a
            # variable somebody has to search for has to be searchable, in
            # this file as much as in the sentence it prints.
            username = "EGMA_SIMULATOR_SIP_TRUNK_USERNAME"
            password = "EGMA_SIMULATOR_SIP_TRUNK_PASSWORD"
            missing, given = (
                (password, username)
                if settings.trunk_password is None
                else (username, password)
            )
            raise ValueError(
                f"{missing} is required alongside {given}: a trunk "
                "authenticated by credentials needs both halves, and a "
                "carrier refuses half of one exactly the way it refuses a "
                "wrong one"
            )
        return settings


def _needed(variable: str, backend: str) -> str:
    """A variable one chosen media backend cannot do without."""
    value = _text(variable)
    if value is None:
        raise ValueError(
            f"{variable} is required when "
            f"EGMA_SIMULATOR_MEDIA_BACKEND={backend}"
        )
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

    stt_provider: str = "scripted"
    """The persona's ears, for a voice simulation: ``scripted`` (the exactly
    invertible test codec, what CI and the free local demo run on) or
    ``deepgram``. Read at pipeline assembly and nowhere else."""

    tts_provider: str = "scripted"
    """The persona's mouth, for a voice simulation: ``scripted`` or
    ``elevenlabs``. Chosen apart from the ears on purpose — a real mouth
    with scripted ears is a configuration somebody will want."""

    deepgram_api_key: str | None = field(default=None, repr=False)
    """The Deepgram key. Required when the ``deepgram`` ears are chosen;
    kept out of the dataclass repr, and registered for redaction."""

    elevenlabs_api_key: str | None = field(default=None, repr=False)
    """The ElevenLabs key. Required when the ``elevenlabs`` mouth is chosen;
    kept out of the dataclass repr, and registered for redaction."""

    media: MediaSettings | None = None
    """How a phone call's audio travels, for a deployment that dials at
    all. ``None`` where none was named, and a simulation that then names a
    phone number is refused with a sentence naming the variable."""

    @property
    def speech_secrets(self) -> tuple[str, ...]:
        """Every speech-provider key this configuration holds.

        One place to ask, so registering them for redaction cannot fall
        behind the day a third provider arrives.
        """
        return tuple(
            key
            for key in (self.deepgram_api_key, self.elevenlabs_api_key)
            if key is not None
        )

    @property
    def media_secrets(self) -> tuple[str, ...]:
        """Every secret the media configuration holds, for the same reason."""
        return () if self.media is None else self.media.secrets

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

        provider = _one_of(
            "EGMA_SIMULATOR_MODEL_PROVIDER", MODEL_PROVIDERS, "scripted"
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

        stt_provider = _one_of(
            "EGMA_SIMULATOR_STT_PROVIDER", STT_PROVIDERS, "scripted"
        )
        tts_provider = _one_of(
            "EGMA_SIMULATOR_TTS_PROVIDER", TTS_PROVIDERS, "scripted"
        )
        speech_keys = {
            provider: _speech_key(provider)
            for provider in (stt_provider, tts_provider)
            if provider != "scripted"
        }

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
            stt_provider=stt_provider,
            tts_provider=tts_provider,
            deepgram_api_key=speech_keys.get("deepgram"),
            elevenlabs_api_key=speech_keys.get("elevenlabs"),
            media=MediaSettings.from_env(),
        )
