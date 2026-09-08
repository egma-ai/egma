"""Deployment settings for control plane, capacity, media bridge, storage, and
telemetry.
Work orders supply persona models, provider credentials, and carrier routes;
these do not fall back to deployment settings. Validate each at its boundary.
"""

from __future__ import annotations

import math
import os
import re
import socket
from dataclasses import dataclass, field
from pathlib import Path

from .reporting import DELIVERY_DEADLINE_SECONDS
from .spec import PlatformCarrier

LOG_LEVELS = ("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG")

DEFAULT_CAPACITY = 2
"""The one default for how many simulations this process conducts at once.

Compose passes an unset value through instead of restating this number, so a
bare simulator and a container use the same limit unless an operator supplies
``EGMA_SIMULATOR_CAPACITY`` explicitly.
"""

SIMULATOR_MODES = ("persistent", "one-shot", "standby")
SIMULATION_MODALITIES = ("voice", "chat")

STT_PROVIDERS = ("scripted", "deepgram", "openai_realtime", "cartesia_manual")
"""What the persona hears with. ``scripted`` needs no account and no network.

``openai_realtime`` holds a socket open and transcribes while the agent is
still talking. The segmented OpenAI adapter was removed: an OpenAI STT
selection has one meaning and cannot reach ``/audio/transcriptions``.
``cartesia_manual`` streams audio to Cartesia and uses Egma's own VAD frames
to finalize each turn."""

TTS_PROVIDERS = ("scripted", "openai", "cartesia")
"""What the persona speaks with. ``scripted`` needs no account and no network."""

VAD_PROVIDERS = ("scripted", "silero")
"""How the persona hears the agent start and stop speaking. Neither needs
an account or a network: ``silero`` ships inside the pinned pipecat wheel
and downloads nothing, and ``scripted`` reads the test codec exactly."""

MEDIA_BACKENDS = ("scripted", "livekit")
"""How a phone call's audio may travel. Naming one is what makes a
simulator able to dial at all, and what makes that backend's own
variables required."""

DEFAULT_S3_BUCKET = "egma-recordings"
"""The bucket the deployment creates on its first start. A self-hoster
running the compose file this repository ships never names it."""

DEFAULT_S3_REGION = "us-east-1"
"""What to sign for when nobody said. MinIO ignores the region entirely
and every request must still carry one, so this is the value that lets a
deployment with no region at all work — and the one a deployment on real
S3 will nearly always be replacing."""

NAMED_A_STORE = (
    "EGMA_SIMULATOR_S3_ENDPOINT names an object store to write recordings to"
)
"""What makes the object store's other variables required, said the way a
refusal says it. A simulator holding half a credential conducts every
voice simulation it claims to the end and then loses the recording, one
after another, with the store's own refusal in the log rather than the one
sentence naming the variable to set."""

S3_BUCKET_NAME = re.compile(r"\A[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\Z")
"""What every object store agrees a bucket may be called: lower case,
three to sixty-three characters, and no separator.

Checked here rather than left to the client, because the failure is worse
than a refused request. A name carrying a ``/`` would put a prefix nobody
configured in front of every key, which is the one thing the key
confinement in ``blob.py`` exists to make impossible."""


def _text(name: str, fallback: str | None = None) -> str | None:
    """A variable's value, where blank means absent.

    Compose passes an unset optional through as an empty string rather
    than leaving it out, which is what lets a compose entry carry a
    ``${VAR:-}`` default at all. So "" and "never set" have to mean the
    same thing here. For example, a blank optional S3 endpoint means use
    the provider's normal endpoint rather than try to send a request to
    an empty address.
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
        raise ValueError(f"{name} must be a number of seconds, got {raw!r}") from None
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
        raise ValueError(f"{name} must be a finite number of seconds, got {raw!r}")
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
        raise ValueError(f"{name} must be one of {', '.join(allowed)}; got {chosen!r}")
    return chosen


def _writable_directory(name: str, path: Path) -> Path:
    """Create the directory and verify write access before claiming work.
    A bad volume must fail startup rather than a later recording or report.
    """
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f".egma-simulator-write-probe-{os.getpid()}"
        probe.write_bytes(b"")
        probe.unlink()
    except OSError as refusal:
        raise ValueError(
            f"{name}={path} is not a directory the simulator can write to: {refusal}"
        ) from refusal
    return path


@dataclass(frozen=True)
class MediaSettings:
    """Phone media settings: from_env() reads the deployment bridge;
    for_simulation() adds the work order's carrier. There is no deployment trunk
    fallback.
    """

    backend: str
    """Which driver places the call — one of :data:`MEDIA_BACKENDS`."""

    livekit_url: str | None = None
    livekit_api_key: str | None = None
    livekit_api_secret: str | None = field(default=None, repr=False)

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
        """This deployment's bridge, or ``None`` where it names none.

        A trunk is not deployment configuration. It arrives with each
        claimed simulation and is checked only when the phone plug dials.
        """
        named = _text("EGMA_SIMULATOR_MEDIA_BACKEND")
        if named is None:
            return None
        return cls.for_backend(named, because=f"EGMA_SIMULATOR_MEDIA_BACKEND={named}")

    @classmethod
    def for_backend(cls, named: str, *, because: str) -> MediaSettings:
        """One backend's settings out of this container's environment.

        ``because`` is the deployment variable that made the backend
        required, repeated in any refusal so an operator knows what to fix.
        """
        if named not in MEDIA_BACKENDS:
            raise ValueError(
                f"{because} names a media backend this simulator does not "
                f"have; it places calls through {', '.join(MEDIA_BACKENDS)}"
            )
        if named != "livekit":
            return cls(backend=named)

        return cls(
            backend=named,
            livekit_url=_needed("EGMA_SIMULATOR_LIVEKIT_URL", because=because),
            livekit_api_key=_needed("EGMA_SIMULATOR_LIVEKIT_API_KEY", because=because),
            livekit_api_secret=_needed(
                "EGMA_SIMULATOR_LIVEKIT_API_SECRET", because=because
            ),
        )

    @classmethod
    def for_simulation(
        cls, standing: MediaSettings | None, carrier: PlatformCarrier
    ) -> MediaSettings | None:
        """Combine the deployment bridge with the work order's complete carrier route.
        Return None without a media backend; only the phone adapter rejects that case.
        Non-phone simulations need no carrier, and no carrier field falls back to
        deployment configuration.
        """
        if standing is None:
            return None
        backend = standing.backend
        bridge = standing
        if backend != "livekit":
            return cls(backend=backend)

        return cls(
            backend=backend,
            livekit_url=bridge.livekit_url,
            livekit_api_key=bridge.livekit_api_key,
            livekit_api_secret=bridge.livekit_api_secret,
            trunk_address=carrier.trunk_address,
            trunk_number=carrier.trunk_number,
            trunk_username=carrier.trunk_username,
            trunk_password=carrier.trunk_password,
        )

    def checked(self) -> MediaSettings:
        """These settings, or the refusal a deployment that cannot dial earns.

        **Every carrier refusal is here, and here is the moment a call is
        about to be placed.** That is the whole of why it is a step of its
        own: the same facts are assembled for every simulation, and only a
        simulation that dials has any business failing over them.
        """
        if self.backend not in MEDIA_BACKENDS:
            raise ValueError(
                f"this deployment's media backend is {self.backend!r}, which "
                "is not a bridge this simulator has; it places calls through "
                f"{', '.join(MEDIA_BACKENDS)}"
            )
        if self.backend != "livekit":
            return self
        absent = [
            variable
            for variable, value in (
                ("EGMA_SIMULATOR_LIVEKIT_URL", self.livekit_url),
                ("EGMA_SIMULATOR_LIVEKIT_API_KEY", self.livekit_api_key),
                ("EGMA_SIMULATOR_LIVEKIT_API_SECRET", self.livekit_api_secret),
            )
            if value is None
        ]
        if absent:
            # Named as variables rather than as settings, because that is
            # what they are: the media server is a container of its own that
            # reads its key and secret when it is created, so these can never
            # come from the platform's store and this container is where they
            # are missing from.
            raise ValueError(
                f"this deployment dials through livekit and this container is "
                f"missing {' and '.join(absent)}"
            )
        carrier_absent = [
            f"platform.carrier.{name}"
            for name, value in (
                ("trunk_address", self.trunk_address),
                ("trunk_number", self.trunk_number),
                ("trunk_username", self.trunk_username),
                ("trunk_password", self.trunk_password),
            )
            if value is None
        ]
        if carrier_absent:
            raise ValueError(
                "a phone call needs a complete credential-authenticated carrier "
                f"route; this work order is missing {' and '.join(carrier_absent)}"
            )
        return self


def _needed(variable: str, *, because: str) -> str:
    """A variable one thing this deployment chose cannot do without.

    The refusal names both: the variable to set, and what made it
    required. A simulator started without one of these conducts every
    simulation it claims to a failure with the provider's own words —
    which say nothing about which of somebody's variables to fix — so it
    says it here, before it claims anything.
    """
    value = _text(variable)
    if value is None:
        raise ValueError(f"{variable} is required when {because}")
    return value


@dataclass(frozen=True)
class ObjectStoreSettings:
    """Shared recording-store settings, selected by an endpoint.
    Without an endpoint, use filesystem storage. Validate settings locally;
    deployment startup ordering is responsible for store and bucket readiness.
    """

    endpoint: str
    """Where the store answers, on the deployment's own network. Not the
    address a browser uses — that belongs to whoever signs links for one,
    and the two differ on nearly every real deployment."""

    bucket: str
    region: str

    access_key_id: str = field(repr=False)
    secret_access_key: str = field(repr=False)
    """The simulator's write credential, both halves kept out of the
    dataclass repr, and neither of them optional: a store cannot be
    reached without both, so settings that exist at all hold both. The key
    id is treated as secret beside the secret it signs with because the
    two are one credential in two halves — they arrive together, they are
    rotated together, and a log line carrying either is a log line that
    should not have."""

    @property
    def secrets(self) -> tuple[str, ...]:
        """Every secret these settings hold, for redaction. One place to
        ask, so a read credential arriving beside the write one cannot
        fall out of the scrubbing."""
        return (self.access_key_id, self.secret_access_key)

    @classmethod
    def from_env(cls) -> ObjectStoreSettings | None:
        """This deployment's object store, or ``None`` where it names none."""
        endpoint = _text("EGMA_SIMULATOR_S3_ENDPOINT")
        if endpoint is None:
            return None
        if not endpoint.startswith(("http://", "https://")):
            # `minio:9000` is the natural thing to write next to a compose
            # service name, and it reaches nothing. Said now rather than
            # by every recording failing against an unreadable URL.
            raise ValueError(
                "EGMA_SIMULATOR_S3_ENDPOINT must start with http:// or "
                f"https://, got {endpoint!r}"
            )

        bucket = _text("EGMA_SIMULATOR_S3_BUCKET", DEFAULT_S3_BUCKET)
        if not S3_BUCKET_NAME.match(bucket):
            raise ValueError(
                "EGMA_SIMULATOR_S3_BUCKET must be a bucket name — lower "
                "case, 3 to 63 characters, letters, digits, dots and "
                f"hyphens, and no separator; got {bucket!r}"
            )

        return cls(
            endpoint=endpoint.rstrip("/"),
            bucket=bucket,
            region=_text("EGMA_SIMULATOR_S3_REGION", DEFAULT_S3_REGION),
            access_key_id=_needed(
                "EGMA_SIMULATOR_S3_ACCESS_KEY_ID", because=NAMED_A_STORE
            ),
            secret_access_key=_needed(
                "EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY", because=NAMED_A_STORE
            ),
        )


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

    blob_dir: Path | None
    """Filesystem recording directory, set only when object_store is absent.
    Do not create or probe a directory when recordings use object storage.
    """

    log_level: str

    mode: str = "persistent"
    """Process lifetime: standing loop, one claim, or bounded standby."""

    modalities: tuple[str, ...] | None = None
    """Claim filter. None preserves the mixed self-hosted queue."""

    execution_deadline_seconds: float = 900.0
    """Whole claim-to-report allowance for one-shot and standby modes."""

    standby_seconds: float = 1800.0
    """How long a standby waits without a claim before it exits."""

    thread_pool_workers: int | None = None
    """Optional size for the process default executor."""

    service_token: str | None = field(default=None, repr=False)
    """What the simulator shows the control plane to be allowed to claim.

    It rides every outbound call as a bearer, the same header an egma key
    uses everywhere else. Optional, because the workbench asks for nothing
    and a local run should need nothing; a control plane handing out real
    work asks for it. Kept out of the dataclass repr — it is a credential
    and travels like one."""

    vad_provider: str = "scripted"
    """What tells the persona the agent has started or stopped speaking:
    ``scripted`` (the test codec read exactly, so every boundary is a
    sample position) or ``silero``. Chosen apart from the other two for
    the same reason, and needing no key either way."""

    media: MediaSettings | None = None
    """How a phone call's audio travels, for a deployment that dials at
    all. ``None`` where none was named, and a simulation that then names a
    phone number is refused with a sentence naming the variable."""

    object_store: ObjectStoreSettings | None = None
    """Where recordings go for a deployment that runs object storage.
    ``None`` where it names no endpoint, and then :attr:`blob_dir` is
    where they go instead."""

    def __post_init__(self) -> None:
        """Require exactly one recording store: blob_dir or object_store."""
        if (self.blob_dir is None) == (self.object_store is None):
            raise ValueError(
                "a simulator needs exactly one place to put recordings: "
                "either an object store, named by "
                "EGMA_SIMULATOR_S3_ENDPOINT, or a directory in "
                "EGMA_SIMULATOR_BLOB_DIR — never both and never neither"
            )
        if self.mode not in SIMULATOR_MODES:
            raise ValueError(
                "EGMA_SIMULATOR_MODE must be one of "
                f"{', '.join(SIMULATOR_MODES)}, got {self.mode!r}"
            )
        if self.modalities is not None and (
            not self.modalities
            or any(item not in SIMULATION_MODALITIES for item in self.modalities)
        ):
            raise ValueError("EGMA_SIMULATOR_MODALITIES must name voice, chat, or both")
        if self.mode in ("one-shot", "standby"):
            if self.capacity != 1:
                raise ValueError(
                    f"EGMA_SIMULATOR_CAPACITY must be 1 in {self.mode} mode"
                )
            if self.modalities != ("voice",):
                raise ValueError(
                    f"EGMA_SIMULATOR_MODALITIES must be voice in {self.mode} mode"
                )

    @property
    def media_secrets(self) -> tuple[str, ...]:
        """Every secret the media configuration holds, for the same reason."""
        return () if self.media is None else self.media.secrets

    @property
    def object_store_secrets(self) -> tuple[str, ...]:
        """Every secret the object store's configuration holds, for the same
        reason again — botocore logs a refused request at DEBUG, headers
        and all, and DEBUG is exactly the level somebody turns on when a
        recording is not arriving."""
        return () if self.object_store is None else self.object_store.secrets

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

        mode = _one_of("EGMA_SIMULATOR_MODE", SIMULATOR_MODES, "persistent")
        capacity = _whole(
            "EGMA_SIMULATOR_CAPACITY",
            1 if mode in ("one-shot", "standby") else DEFAULT_CAPACITY,
        )
        if capacity < 1:
            raise ValueError(
                f"EGMA_SIMULATOR_CAPACITY must be at least 1, got {capacity}"
            )

        vad_provider = _one_of("EGMA_SIMULATOR_VAD_PROVIDER", VAD_PROVIDERS, "scripted")
        offered_modalities = _text("EGMA_SIMULATOR_MODALITIES")
        modalities = (
            ("voice",)
            if offered_modalities is None and mode in ("one-shot", "standby")
            else (
                None
                if offered_modalities is None
                else tuple(
                    dict.fromkeys(
                        part.strip().lower()
                        for part in offered_modalities.split(",")
                        if part.strip()
                    )
                )
            )
        )
        thread_pool_workers = (
            None
            if _text("EGMA_SIMULATOR_THREAD_POOL_WORKERS") is None
            else _whole("EGMA_SIMULATOR_THREAD_POOL_WORKERS", 1)
        )
        if thread_pool_workers is not None and thread_pool_workers < 1:
            raise ValueError(
                "EGMA_SIMULATOR_THREAD_POOL_WORKERS must be at least 1, "
                f"got {thread_pool_workers}"
            )

        # Read before the directories below, because it decides whether one
        # of them is a directory at all.
        object_store = ObjectStoreSettings.from_env()

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
            blob_dir=(
                None
                if object_store is not None
                else _writable_directory(
                    "EGMA_SIMULATOR_BLOB_DIR",
                    Path(_text("EGMA_SIMULATOR_BLOB_DIR", ".egma-simulator/blobs")),
                )
            ),
            log_level=_level("EGMA_SIMULATOR_LOG_LEVEL", "INFO"),
            mode=mode,
            modalities=modalities,
            execution_deadline_seconds=_seconds(
                "EGMA_SIMULATOR_EXECUTION_DEADLINE_SECONDS", 900.0
            ),
            standby_seconds=_seconds("EGMA_SIMULATOR_STANDBY_SECONDS", 1800.0),
            thread_pool_workers=thread_pool_workers,
            service_token=_text("EGMA_SIMULATOR_SERVICE_TOKEN"),
            vad_provider=vad_provider,
            media=MediaSettings.from_env(),
            object_store=object_store,
        )
