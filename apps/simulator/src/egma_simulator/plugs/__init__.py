"""Connection adapters selected by connection type and modality.

Constructors validate configuration without I/O. Reject unknown config keys
and unsupported access variants or modalities. Never log, persist, or return
credentials, including in exceptions. Register new adapters in plug_for().

Each simulation supplies config, credentials, simulation_id, agent_version,
dynamic_variables, job_dispatch_metadata, mock_tools, and media. Preserve the
opaque simulation ID, version type, variable values, and test-owned metadata.
named_version() trims version names; rendered_variables() validates strings.
Only adapters that use a value forward it to their agent platform.

Chat uses ConnectionPlug: open() returns a greeting or None, deliver() returns
one AgentReply per persona turn, and close() tears down from any state.
Deliveries are sequential. An ended reply records final words and stops delivery.
Keep platform_notes separate from speech and from the persona's transcript.

Voice uses VoiceConnection: prepare() builds transport processors, open()
connects, and close() tears down. The Pipecat pipeline owns audio processing,
pacing, persona speech, and recording. No PCM exchange crosses this interface.

Expose provider_reference as soon as the platform supplies its identifier.
Report only observed tool calls. Display reads mock coverage from the pinned test
version.

Raise PlugError for known faults. Its default ending is ERROR; NOT_ANSWERED
is an unanswered phone call, and AGENT_NEVER_JOINED means the connection opened
but no agent arrived. These are simulation failures, not failed grades.
Let CancelledError propagate and rely on close() for cleanup.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from ..contract import ERROR
from ..media import VoiceMedia
from ..provider_keys import ProviderKeyUnavailable
from ..redaction import REDACTED

QUOTED_REFUSAL_CHARS = 200
"""How much of a refusal's body is quoted into a reason: enough to carry
the platform's own words about what was wrong, short of pasting a page."""


@dataclass(frozen=True)
class ToolCall:
    """One tool the agent called, as observed from egma's side of the wire.

    The name and the arguments exactly as the platform reported them, and
    nothing else: the simulator observes the call and not the return, so
    there is no result here. A platform that reports the invocation
    without its arguments leaves them ``None``, which is the honest record
    of what was seen.
    """

    name: str
    arguments: str | None = None


@dataclass(frozen=True)
class AgentReply:
    """The agent's answer to one delivered persona turn."""

    text: str | None
    """What the agent said, or ``None`` for an answer without words."""

    ended: bool = False
    """True when this answer ended the exchange — the agent's goodbye,
    a hang-up, or the platform closing it from its side."""

    tool_calls: tuple[ToolCall, ...] = ()
    """The tool calls this answer made, where the platform exposes them.
    Empty is the ordinary case and never a claim that none happened: most
    ways of reaching an agent say nothing about its tools, and a plug that
    cannot see them reports none rather than guessing."""

    platform_notes: tuple[str, ...] = ()
    """Platform events that are not agent speech, such as node transitions.
    Keep them beside the turn, outside its text and the persona's transcript.
    """

    answered_at: float | None = None
    """Agent answer start time on the event loop clock: the finish line for
    turn_response_latency. For live streams, exclude the later turn-completion wait.
    For request/response adapters, None uses deliver() completion time.
    A turn without an answer produces no latency sample.
    """


class PlugError(Exception):
    """A plug refusing config it does not understand, a modality it cannot
    speak, or a platform interaction that failed in a way it can name.

    ``ending`` is which failed ending the record should carry. It is
    :data:`ERROR` unless a plug says otherwise, because a plug that has
    nothing to say about the difference has hit a fault.
    """

    def __init__(self, message: str, *, ending: str = ERROR) -> None:
        super().__init__(message)
        self.ending = ending


def quotable(told: str, *secrets: str) -> str:
    """Remove known credentials from a platform error and bound its length
    before it can enter a failure reason or log.
    """
    for secret in secrets:
        if secret:
            told = told.replace(secret, REDACTED)
    return told[:QUOTED_REFUSAL_CHARS]


def named_version(agent_version: object) -> int | str | None:
    """Validate a nonnegative integer or nonempty version name.
    Preserve its type and value, trimming only surrounding whitespace in names.
    """
    if agent_version is None:
        return None
    if isinstance(agent_version, bool) or not isinstance(agent_version, int | str):
        raise PlugError(
            "an agent version is how the platform names its versions — a "
            f"number or a name; got {type(agent_version).__name__}"
        )
    if isinstance(agent_version, int):
        if agent_version < 0:
            raise PlugError(f"an agent version cannot be {agent_version}")
        return agent_version
    if not agent_version.strip():
        raise PlugError("an agent version must say which version, not nothing")
    return agent_version.strip()


def rendered_variables(dynamic_variables: object) -> dict[str, str]:
    """Validate string-valued dynamic variables without changing their values.
    Keep empty strings. Errors name invalid variables without exposing their values.
    """
    if dynamic_variables is None:
        return {}
    if not isinstance(dynamic_variables, dict):
        raise PlugError(
            "dynamic variables are names against strings; got "
            f"{type(dynamic_variables).__name__}"
        )
    unnamed = [name for name in dynamic_variables if not str(name).strip()]
    if unnamed:
        raise PlugError("a dynamic variable with no name is set by nobody")
    unrendered = sorted(
        str(name)
        for name, value in dynamic_variables.items()
        if not isinstance(value, str)
    )
    if unrendered:
        raise PlugError(
            f"dynamic variable(s) {unrendered} carry something that is not a "
            "string, and a rendered variable is a string"
        )
    return {str(name): value for name, value in dynamic_variables.items()}


def failed_ending(fault: BaseException) -> str:
    """Which of the contract's failed endings one fault deserves.

    The one place the question is answered, so that a plug naming an
    honest ending and a fault nobody named go through the same door.
    """
    if isinstance(fault, ProviderKeyUnavailable):
        return "provider_key_unavailable"
    return fault.ending if isinstance(fault, PlugError) else ERROR


class ConnectionPlug(Protocol):
    """Chat connection lifecycle: open, deliver persona text, and close.
    Voice connections use VoiceConnection and the voice conductor.
    """

    @property
    def provider_reference(self) -> str | None: ...

    async def open(self) -> str | AgentReply | None: ...

    async def deliver(self, text: str) -> AgentReply: ...

    async def close(self) -> None: ...


@runtime_checkable
class VoiceConnection(Protocol):
    """The seam a voice conductor gives to its one Pipecat pipeline.

    ``prepare`` constructs the transport processors before the pipeline
    starts. ``open`` waits until that already-running transport reaches the
    far end. No PCM exchange, processing rate, or second media clock crosses
    this seam.
    """

    @property
    def provider_reference(self) -> str | None: ...

    @property
    def far_end_left(self) -> bool: ...

    async def prepare(self) -> VoiceMedia: ...

    async def open(self) -> None: ...

    async def close(self) -> None: ...


PlugFactory = Callable[..., ConnectionPlug | VoiceConnection]
"""What the registry hands back: called with ``modality=``,
``access_variant=``, ``config=``, ``credentials=``, ``simulation_id=``,
``agent_version=``, ``dynamic_variables=``, ``job_dispatch_metadata=``,
``mock_tools=`` and ``media=`` keywords, it returns one plug for one
simulation — in practice, the plug class itself."""


def _livekit_room(*, modality: str, **rest: object) -> ConnectionPlug | VoiceConnection:
    """Select the LiveKit adapter by modality; each constructor validates its
    modality."""
    from .livekit import LiveKitRoom
    from .livekit_chat import LiveKitChat

    speaking = LiveKitChat if modality == "chat" else LiveKitRoom
    return speaking(modality=modality, **rest)


def plug_for(connection_type: str) -> PlugFactory | None:
    """The plug factory registered for one connection type, or ``None``.

    The registry is deliberately a literal here: adding a connection type is one
    import and one line, and the diff that adds it touches nothing else.
    """
    from .loopback import LoopbackCounterpart
    from .phone import PhoneCall
    from .retell import RetellChat
    from .retell_text_mode import RetellTextMode
    from .retell_web_call import RetellWebCall
    from .scripted import ScriptedCounterpart

    return {
        "livekit_room": _livekit_room,
        "loopback": LoopbackCounterpart,
        "phone_number": PhoneCall,
        "retell_chat_api": RetellChat,
        "retell_text_mode": RetellTextMode,
        "retell_web_call": RetellWebCall,
        "scripted": ScriptedCounterpart,
    }.get(connection_type)
