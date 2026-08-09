"""Platform plugs: the one place that knows how to reach a platform.

A **plug** is the component behind a connection type. It alone knows how
to open an exchange with that platform, deliver the persona's turns, hear
the agent's answers, and end the exchange. Everything else in the
simulator is plug-blind: the persona brain, the walk, the claim loop, and
the reporting never learn which platform they are talking through. Adding
a platform therefore touches exactly two things — a new module in this
package, and one line in the registry below.

This docstring is the plug author's whole brief. If writing a new plug
requires reading anything beyond this file, that is a bug in this file.

## What a plug receives

A plug is constructed once per simulation, from the claimed spec's
connection block, with three keyword arguments:

- ``modality`` — ``"chat"`` or ``"voice"``. A plug that cannot speak the
  requested modality must refuse at construction (raise ``PlugError``).
- ``config`` — the connection's non-secret reach configuration, exactly as
  authored. **Its keys belong to the plug**: nothing else reads them, no
  schema constrains them, and each plug documents and validates its own.
  Refuse keys you do not know (raise ``PlugError``) — a silently ignored
  typo would change behavior nobody asked for.
- ``credentials`` — the resolved secret material, or ``None``. Use it to
  reach the platform and for nothing else: **never log it, never persist
  it, never let it into an exception message or a returned value.** The
  report schema structurally rejects credential-shaped fields, and the
  acceptance suite plants sentinel credentials and scans every byte the
  process emits.

Constructors validate and hold; they never do I/O. A constructor that
raises means the simulation fails with an honest reason before the
platform is ever dialled.

## Chat or voice: same job, different currency

A chat plug exchanges text. A **voice plug exchanges audio** — that is the
whole difference, and it is the plug's difference alone. Between a voice
plug and the persona brain sit the speech legs, assembled around it per
simulation: the persona's words are spoken into audio before they reach
the plug, and the audio that comes back is transcribed before anyone else
sees it. So a voice plug never handles text, the persona never handles
audio, and neither of them learns about the other.

The seams are :class:`PlatformPlug` (chat, and what the walk drives
whatever the modality) and :class:`VoicePlug` (voice). A plug implements
the one for the modality it speaks and refuses the other at construction.

## The lifecycle the walk drives

For one simulation, in order, always:

1. ``await open()`` — reach the platform and start the exchange. Returns
   the agent's greeting when the platform opens with one, else ``None``
   (the persona will then speak first).
2. ``await deliver(text)`` — hand the persona's turn to the platform and
   return the agent's answer as an ``AgentReply``:
   - ``text`` — what the agent said, or ``None`` for an answer that
     carried no words.
   - ``ended=True`` — the agent (or the platform) ended the exchange with
     this answer. The walk records any final words and reports the ending
     as the agent's doing. Once returned, ``deliver`` is never called
     again.
   ``deliver`` is called once per persona turn, sequentially — a plug
   never sees two deliveries in flight.
3. ``await close()`` — tear the exchange down. Called exactly once,
   whatever happened: after a natural end, after a limit tripped, after a
   cancel directive, and after a fault. Make it safe to call in every one
   of those states.

A voice plug's lifecycle is the same three steps in audio: ``open``
answers with the agent's spoken greeting, ``deliver`` takes the persona's
speech as an ``Utterance`` and answers with an ``AgentSpeech``, ``close``
tears the exchange down. It also declares ``sample_rate_hz`` — **the band
it actually carries**, after whatever negotiation the platform does, not
the band the config asked for. The legs are assembled at that band and the
simulation's audio facts are measured from what flowed, so a plug that
returns a hopeful number is lying on the record.

``provider_reference`` is the platform's own identifier for the exchange —
a chat id, a telephony leg id — reported with the terminal facts as the
one join between egma's record and the platform's telemetry. Offer it as
soon as it is known; ``None`` when the platform has none.

## Failure

Raise when the platform cannot be reached or stops making sense —
``PlugError`` for the failures you can name, anything for the rest. The
walk turns an exception into a simulation that reports ``failed`` with the
exception's message as the reason, so word messages for the person who
reads the record — and keep credentials out of them.

A ``PlugError`` also carries **which of the contract's failed endings**
the refusal deserves. They are named in :mod:`egma_simulator.contract`,
where the contract's vocabulary lives, and the default is the right
answer nearly always:

- ``ERROR`` (the default) — the simulator hit a fault it could not
  conduct through: config it cannot use, a platform refusing, a way in
  that is not there.
- ``NOT_ANSWERED`` — the simulator reached out and nothing came on the
  line. A phone that rang out or was engaged; never a fault, and never
  the agent's doing.
- ``AGENT_NEVER_JOINED`` — the way in opened and no agent turned up.

None of the three is ever graded as the agent failing: each of them
means the exchange did not happen, so there is nothing to grade.

A cancel directive or a tripped limit cancels the in-flight ``open`` or
``deliver`` (an ``asyncio.CancelledError`` inside the plug): let it
propagate, and rely on ``close()`` for teardown.

## Pacing

A real platform takes real time to answer; that is the plug's time to
take, inside ``deliver``. Fakes that answer instantly make some walks
untestable (nothing can be canceled mid-flight), which is why the scripted
counterpart takes a ``turn_seconds`` knob.

A voice plug has a second, better way to be slow: the quiet before an
agent starts speaking belongs in the audio it returns, because that is
where it is on a real call and where the measurement of it is read from.

## Registration

The registry lives in :func:`plug_for` below: one entry per connection
type, the type string exactly as specs will name it. A simulator holding
no plug for a claimed spec's type refuses the claim out loud and reports
nothing — the row is the control plane's to sweep.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from ..contract import ERROR


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


@dataclass(frozen=True)
class Utterance:
    """One stretch of speech, as it flows: 16-bit signed little-endian mono
    PCM, and the band it is carried at."""

    pcm: bytes
    sample_rate_hz: int


@dataclass(frozen=True)
class AgentSpeech:
    """The agent's spoken answer to one delivered persona utterance."""

    audio: Utterance | None
    """What the agent said, or ``None`` for an answer that carried no audio."""

    ended: bool = False
    """True when this answer ended the exchange — the same meaning as on
    :class:`AgentReply`, one modality over."""

    tool_calls: tuple[ToolCall, ...] = ()
    """The same meaning as on :class:`AgentReply`. A voice platform that
    reports its agent's tool traffic beside the audio names it here."""


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


def failed_ending(fault: BaseException) -> str:
    """Which of the contract's failed endings one fault deserves.

    The one place the question is answered, so that a plug naming an
    honest ending and a fault nobody named go through the same door.
    """
    return fault.ending if isinstance(fault, PlugError) else ERROR


class PlatformPlug(Protocol):
    """The seam the walk drives: text in, text out, whatever the modality.

    A chat plug implements it directly; a voice plug is reached through it,
    with the speech legs assembled in between. See the module docstring for
    the full brief.
    """

    @property
    def provider_reference(self) -> str | None: ...

    async def open(self) -> str | None: ...

    async def deliver(self, text: str) -> AgentReply: ...

    async def close(self) -> None: ...


class VoicePlug(Protocol):
    """The seam a voice connection is reached through: audio in, audio out.

    ``sample_rate_hz`` is the band actually carried, which the speech legs
    are assembled at and the simulation's measured audio band is read from.
    """

    @property
    def provider_reference(self) -> str | None: ...

    @property
    def sample_rate_hz(self) -> int: ...

    async def open(self) -> AgentSpeech | None: ...

    async def deliver(self, speech: Utterance) -> AgentSpeech: ...

    async def close(self) -> None: ...


PlugFactory = Callable[..., PlatformPlug | VoicePlug]
"""What the registry hands back: called with ``modality=``, ``config=``
and ``credentials=`` keywords, it returns one plug for one simulation —
in practice, the plug class itself."""


def plug_for(connection_type: str) -> PlugFactory | None:
    """The plug factory registered for one connection type, or ``None``.

    The registry is deliberately a literal here: adding a platform is one
    import and one line, and the diff that adds it touches nothing else.
    """
    from .loopback import LoopbackCounterpart
    from .phone import PhoneCall
    from .retell import RetellChat
    from .scripted import ScriptedCounterpart

    return {
        "loopback": LoopbackCounterpart,
        "phone": PhoneCall,
        "retell": RetellChat,
        "scripted": ScriptedCounterpart,
    }.get(connection_type)
