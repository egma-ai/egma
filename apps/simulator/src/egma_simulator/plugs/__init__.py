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

A plug is constructed once per simulation, from the claimed spec, with
five keyword arguments:

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
- ``simulation_id`` — which simulation this plug is conducting, opaque as
  everywhere else: never parsed, never minted, never rewritten. Only a
  plug that has to *tell the platform* which simulation it is in has any
  use for it, and most have none — a plug that does not need it takes it
  and drops it.
- ``mock_tools`` — egma's side of the mock-tool exchange for this
  simulation (:class:`egma_simulator.mock_tools.MockToolSeam`), already
  holding the answers the run resolved. Only a plug that can **put egma in
  the agent's tool path** has any use for it, which today is the room: it
  offers the exchange to whoever is in the room with it and says so, and
  that saying-so is what puts a coverage stamp on the record. Every other
  plug takes it and drops it, and its record honestly claims nothing about
  tools, because egma was never in the path to learn anything.

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

There are two seams and no more: :class:`PlatformPlug` (chat, and what the
walk drives) and :class:`DuplexLine` (voice, and what the voice conductor
drives). A plug implements the one for the modality it speaks and refuses
the other at construction.

A voice plug's whole difference from a chat one is that both directions of
the line are open at once. So a duplex line is not asked for a turn: it is
driven one slice of audio at a time, the persona's speech out and the far
end's speech in, and where the turns fall is the conductor's reading of
that audio rather than anything the plug declares. That is true of the
loopback counterpart, of a phone call and of a room alike — a live line
carries no end-of-turn signal in it, and neither does a fake one, which is
what makes CI's voice simulations representative of real ones.

## The lifecycle a conductor drives

A chat plug's is three steps, for one simulation, in order, always:

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

A duplex line's is three steps too, and none of them turn-shaped, because
nothing on a real line is: ``open`` reaches the platform and answers with
nothing at all, ``exchange`` is called once per slice for as long as the
exchange lasts, and ``close`` tears it down. A greeting is not a step
here — it is simply the first thing the far end happens to say, and it
crosses the line like every other sample.

Either way the plug declares ``sample_rate_hz`` — **the band it actually
carries**, after whatever negotiation the platform does, not the band the
config asked for. The legs are assembled at that band and the simulation's
audio facts are measured from what flowed, so a plug that returns a
hopeful number is lying on the record.

``provider_reference`` is the platform's own identifier for the exchange —
a chat id, a telephony leg id — reported with the terminal facts as the
one join between egma's record and the platform's telemetry. Offer it as
soon as it is known; ``None`` when the platform has none.

## Failure

Raise when the platform cannot be reached or stops making sense —
``PlugError`` for the failures you can name, anything for the rest.
Conducting turns an exception into a simulation that reports ``failed``
with the exception's message as the reason, so word messages for the
person who reads the record — and keep credentials out of them.

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

A cancel directive or a tripped limit stops the exchange at whatever call
is in flight — ``open``, ``deliver`` or ``exchange`` — as an
``asyncio.CancelledError`` inside the plug: let it propagate, and rely on
``close()`` for teardown.

## Pacing

A real platform takes real time to answer; that is the plug's time to
take, inside ``deliver``. Fakes that answer instantly make some walks
untestable (nothing can be canceled mid-flight), which is why the scripted
counterpart takes a ``turn_seconds`` knob.

A voice plug has a second, better way to be slow: the quiet before an
agent starts speaking belongs in the audio, because that is where it is on
a real call and where the measurement of it is read from. On a duplex line
that quiet is simply the slices the far end says nothing in, which costs a
deterministic test no time at all and a live call exactly what it costs.

## Registration

The registry lives in :func:`plug_for` below: one entry per connection
type, the type string exactly as specs will name it. A simulator holding
no plug for a claimed spec's type refuses the claim out loud and reports
nothing — the row is the control plane's to sweep.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

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


@runtime_checkable
class DuplexLine(Protocol):
    """The seam a full-duplex voice connection is reached through.

    **Checkable at runtime, and used that way.** Assembly asks a plug
    whether it is one of these before handing it to the voice conductor,
    so the verbs below are what a voice connection has to grow rather
    than a promise made in prose.

    Both directions are open at once, and the line is driven one slice at
    a time: :meth:`exchange` takes the slice the persona is saying right
    now and answers with the slice the far end said in the same moment.
    Neither side is a turn, and neither side announces one — turn-taking
    is the conductor's reading of the audio, which is what makes it
    possible for the two speakers to overlap at all.

    **Every slice is the same number of samples in both directions, and
    quiet is audio.** A speaker saying nothing sends silence rather than
    nothing, because the count of samples that have crossed the line *is*
    the conversation's clock: every utterance in the record is a pair of
    positions on it, so a line that skipped its quiet would leave the two
    speakers on two different clocks.

    ``sample_rate_hz`` is the band the line is *driven* at: the speech
    legs are assembled at it and every slice is cut to it.
    ``measured_band_hz`` is the band the audio really arrived at, read
    back off what flowed, and ``None`` until something has — it is what a
    record stamps, so that a measured band can never be a copy of a
    configured one. ``far_end_left`` is true once the far end is off the
    line, which is what "the agent ended the exchange" means on a voice
    connection.
    """

    @property
    def provider_reference(self) -> str | None: ...

    @property
    def sample_rate_hz(self) -> int: ...

    @property
    def measured_band_hz(self) -> int | None: ...

    @property
    def far_end_left(self) -> bool: ...

    async def open(self) -> None: ...

    async def exchange(self, outgoing: bytes) -> bytes: ...

    async def close(self) -> None: ...


PlugFactory = Callable[..., PlatformPlug | DuplexLine]
"""What the registry hands back: called with ``modality=``, ``config=``,
``credentials=``, ``simulation_id=`` and ``mock_tools=`` keywords, it
returns one plug for one simulation — in practice, the plug class
itself."""


def plug_for(connection_type: str) -> PlugFactory | None:
    """The plug factory registered for one connection type, or ``None``.

    The registry is deliberately a literal here: adding a platform is one
    import and one line, and the diff that adds it touches nothing else.
    """
    from .livekit import LiveKitRoom
    from .loopback import LoopbackCounterpart
    from .phone import PhoneCall
    from .retell import RetellChat
    from .scripted import ScriptedCounterpart

    return {
        "livekit": LiveKitRoom,
        "loopback": LoopbackCounterpart,
        "phone": PhoneCall,
        "retell": RetellChat,
        "scripted": ScriptedCounterpart,
    }.get(connection_type)
