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

STT_PROVIDERS = ("scripted", "deepgram", "openai_realtime")
"""What the persona hears with. ``scripted`` needs no account and no network.

``openai_realtime`` holds a socket open and transcribes while the agent is
still talking. The segmented OpenAI adapter was removed: an OpenAI STT
selection has one meaning and cannot reach ``/audio/transcriptions``."""

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
            f"{name}={path} is not a directory the simulator can write to: {refusal}"
        ) from refusal
    return path


@dataclass(frozen=True)
class MediaSettings:
    """How one claimed phone simulation places its call.

    The bridge is deployment configuration. The SIP trunk belongs to the
    platform and arrives on the work order. :meth:`from_env` reads only the
    bridge. :meth:`for_simulation` joins it to that work order's carrier.
    There is no container-level trunk to fall back to.

    A deployment that names no backend and is handed none gets no settings
    at all and places no calls: dialling is opt-in, and a simulator that
    never dials should not have to explain a trunk it does not want.
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
        """The bridge and trunk one simulation is dialled over.

        This container's backend with the platform's carrier laid over it,
        and it is the one place the two meet. ``None`` means this deployment
        has no media backend. A work order cannot create one.

        **It never refuses.** This runs for every simulation, and most
        simulations never dial: a platform whose carrier is half configured
        still runs chat and text work perfectly well, and failing that work
        over a trunk it was never going to use would be a broken phone
        breaking the telephone-free half of the product. So what is
        assembled here is whatever the two sides between them have, and
        every refusal lives in :meth:`checked`, which the phone plug calls
        when a call is really about to be placed.

        Address, number, username and password always move together from
        the work order. No field can come from an older container setting.
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
        if self.trunk_address is None:
            raise ValueError(
                "a phone call needs platform.carrier.trunk_address, but this "
                "work order has none"
            )
        # Credential auth is a pair. Neither half is a trunk the carrier
        # authenticates some other way — by the address it came from — and
        # that is a real deployment. One half is nobody's deployment: every
        # call it places comes back 403, which reads as *wrong* credentials
        # rather than as half of one, and it reads that way once per
        # simulation until somebody looks here.
        if (self.trunk_username is None) != (self.trunk_password is None):
            missing, given = (
                ("password", "username")
                if self.trunk_password is None
                else ("username", "password")
            )
            raise ValueError(
                f"platform.carrier has a trunk_{given} and no trunk_{missing}: "
                "a trunk authenticated by credentials needs both halves"
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
    """Where this deployment's recordings land, read once at startup.

    A recording written inside the simulator is a recording only that
    container can read, and a deployment is invited to run more than one
    simulator — so the second one's audio becomes unreadable with nothing
    said. Object storage is what the whole deployment shares, and these
    are the five facts needed to reach it.

    They arrive the way everything else does, and a deployment that names
    no endpoint gets no settings at all: the filesystem store stands, and
    a contributor's checkout costs them no container. This is the same
    shape as :class:`MediaSettings` on purpose — naming the thing is what
    selects it, and what makes the rest of its variables required.

    What is checked here is what can be checked without a network. That
    the store is up, that the bucket is there, and that the credential is
    the right one are answers only the store has, and a simulator that
    refused to start until it could ask would be a simulator that dies
    because its object store was five seconds behind it. The deployment
    orders that instead: the bucket job runs to completion before the
    simulator starts.
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
    """Where recordings land, for the filesystem-backed blob store — the
    one that stands when this deployment names no object-storage endpoint,
    so a first voice simulation needs no container running. A report
    carries only the reference.

    ``None`` exactly when :attr:`object_store` is set, and that pairing is
    checked in ``__post_init__`` rather than trusted: it is what lets the
    store be chosen by asking which of them is there. It is ``None``
    rather than an unused path because proving this directory is *writing*
    to it, and a deployment whose recordings go to a bucket must not be
    refused over a filesystem it was never going to touch — a read-only
    root is an ordinary way to harden a container."""

    log_level: str

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
        """One place for recordings to go, and exactly one.

        :attr:`blob_dir` and :attr:`object_store` are one decision written
        as two fields, and the whole reason a store can be chosen by
        asking which of them is there. Held here rather than promised in
        a docstring, because the two ways of breaking it both fail a long
        way from the cause: neither set is a ``TypeError`` from inside a
        write that the conductor then swallows, leaving a simulation that
        reports no audio and no reason; both set is a deployment writing
        to a bucket while a directory nobody reads fills up beside it.
        """
        if (self.blob_dir is None) == (self.object_store is None):
            raise ValueError(
                "a simulator needs exactly one place to put recordings: "
                "either an object store, named by "
                "EGMA_SIMULATOR_S3_ENDPOINT, or a directory in "
                "EGMA_SIMULATOR_BLOB_DIR — never both and never neither"
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

        capacity = _whole("EGMA_SIMULATOR_CAPACITY", DEFAULT_CAPACITY)
        if capacity < 1:
            raise ValueError(
                f"EGMA_SIMULATOR_CAPACITY must be at least 1, got {capacity}"
            )

        vad_provider = _one_of("EGMA_SIMULATOR_VAD_PROVIDER", VAD_PROVIDERS, "scripted")

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
            service_token=_text("EGMA_SIMULATOR_SERVICE_TOKEN"),
            vad_provider=vad_provider,
            media=MediaSettings.from_env(),
            object_store=object_store,
        )
