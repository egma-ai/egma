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

A cancel directive or a tripped limit cancels the in-flight ``open`` or
``deliver`` (an ``asyncio.CancelledError`` inside the plug): let it
propagate, and rely on ``close()`` for teardown.

## Pacing

A real platform takes real time to answer; that is the plug's time to
take, inside ``deliver``. Fakes that answer instantly make some walks
untestable (nothing can be canceled mid-flight), which is why the scripted
counterpart takes a ``turn_seconds`` knob.

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


@dataclass(frozen=True)
class AgentReply:
    """The agent's answer to one delivered persona turn."""

    text: str | None
    """What the agent said, or ``None`` for an answer without words."""

    ended: bool = False
    """True when this answer ended the exchange — the agent's goodbye,
    a hang-up, or the platform closing it from its side."""


class PlugError(Exception):
    """A plug refusing config it does not understand, a modality it cannot
    speak, or a platform interaction that failed in a way it can name."""


class PlatformPlug(Protocol):
    """The seam. One implementation per connection type; see the module
    docstring for the full brief."""

    @property
    def provider_reference(self) -> str | None: ...

    async def open(self) -> str | None: ...

    async def deliver(self, text: str) -> AgentReply: ...

    async def close(self) -> None: ...


PlugFactory = Callable[..., PlatformPlug]
"""What the registry hands back: called with ``modality=``, ``config=``
and ``credentials=`` keywords, it returns one plug for one simulation —
in practice, the plug class itself."""


def plug_for(connection_type: str) -> PlugFactory | None:
    """The plug factory registered for one connection type, or ``None``.

    The registry is deliberately a literal here: adding a platform is one
    import and one line, and the diff that adds it touches nothing else.
    """
    from .retell import RetellChat
    from .scripted import ScriptedCounterpart

    return {
        "retell": RetellChat,
        "scripted": ScriptedCounterpart,
    }.get(connection_type)
