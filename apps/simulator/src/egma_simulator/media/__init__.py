"""Media backends: the one place that knows how a call's audio travels.

A **media backend** is the component behind a phone call's audio. It alone
knows how to open a session with a bridge, ask that bridge to place a call
over a trunk, learn whether anybody came on the line, carry audio both
ways, and tear the call down. Everything above it is backend-blind: the
phone plug drives this seam, the speech legs and the recorder see only
audio, and the walk and the report never learn which bridge ran.

This docstring is the driver author's whole brief. If writing a new
driver requires reading anything beyond this file, that is a bug in this
file.

## Why the seam exists at all

The bridge is bought, not built — LiveKit today, Daily or another the day
somebody wants it — and the pieces that differ between two bridges are
small and few: how a session is opened, how a call is placed, how an
answer is learned, and how it all ends. Everything else about a phone
simulation is identical, so everything else sits above this line. Adding
a bridge is therefore one new module in this package and one line in the
registry below, and the diff that adds it touches nothing else.

## What a driver implements

Two objects, and no more.

:class:`MediaBackend` is the call: four methods, in this order, once each.

1. ``await create_session()`` — open the way in and answer with the
   :class:`MediaSession` that carries the audio. No call is placed yet.
   Raise :class:`MediaBackendError` when the bridge cannot be reached.
2. ``await dial(number)`` — ask the bridge to place the call. Returns as
   soon as the request is away; it does not wait for an answer, because
   the plug wants the ringing time on the clock rather than inside one
   call it cannot see into.
3. ``await wait_answered(seconds)`` — block until somebody is on the
   line, then answer with **the provider's own identifier for the call**,
   which is what the report carries as its join to the platform's
   telemetry. Raise :class:`MediaBackendError` when the call never
   became a conversation, with the ending it deserves — see below.
4. ``await teardown()`` — end the call and release everything. Called
   exactly once whatever happened: after a natural end, after a limit,
   after a cancel, after a refusal at any step above, and even when
   ``create_session`` never ran. Make it safe in every one of those
   states.

:class:`MediaSession` is the audio, and it is only alive between an
answer and teardown:

- ``sample_rate_hz`` — the band the session carries, which the driver is
  handed rather than choosing: the pipeline above is already assembled at
  it, and a driver that answered with a different one would be handing
  the recorder samples it will mis-time.
- ``await send(pcm)`` — the persona's audio, out to the far end, and
  **back only once it has all been said**. A line carries a voice in real
  time, so a driver over a real line waits out the audio's own length and
  drops whatever arrived while it was playing: that was the far end
  listening, not answering, and counting it would put the persona's own
  speaking time inside every measurement of the answer. A driver with no
  real line to wait on returns at once, which is why CI pays none of it.
- ``await receive(seconds)`` — the next audio that arrived, or ``None``
  when none arrived within ``seconds``. Quiet is audio: a real line
  carries comfort noise between words, and a driver must hand it over
  rather than hide it, because the plug reads the far end's turn
  boundaries out of it.
- ``far_end_left`` — true once the far end is off the line. On LiveKit
  that is the SIP participant leaving the room, and it is exactly what
  "the agent hung up" means.

## Which failed ending a refusal deserves

The contract has three failed endings and this seam uses two of them.
The line is *who* refused, and it is worth stating once because a wrong
answer here is a lie on somebody's record:

- :data:`NOT_ANSWERED` — the call reached the far end and nothing came on
  the line: busy, ringing out, declined. The simulator did its part and
  the phone was not picked up.
- :data:`ERROR` — the call never reached the far end: the trunk refused
  the credentials, the carrier failed, the number is not allocated, the
  bridge could not be reached. Somebody has something to fix.

Neither is ever the agent failing, and the reason carried alongside is
what names which of them happened, in the carrier's own words where
there are any.

## Credentials

A driver's credentials arrive from the environment and nowhere else — a
phone connection's spec carries no secret, because the trunk belongs to
the deployment rather than to one simulation. Use them to reach the
bridge and for nothing else: **never log one, never let one into an
exception message, never let one into a returned value.** A driver that
quotes a bridge's own words back into a refusal scrubs its secrets out
of them first, here, where they are known — see :func:`without_secrets`.
The acceptance suite plants sentinel trunk credentials and scans every
byte the process emits, on the happy path and the failing ones both.

## Registration

The registry is :func:`backend_for` below: one entry per backend name,
the name exactly as a connection's ``backend`` key or the deployment's
default will spell it.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from ..plugs import ERROR, NOT_ANSWERED
from ..redaction import REDACTED

BACKENDS = ("livekit", "scripted")
"""Every media backend this simulator can place a call through, in the
one place the list lives. A phone connection names one of these — or
names none and gets the deployment's default."""


class MediaBackendError(Exception):
    """A media backend cannot do what was asked, and says what happened.

    ``ending`` is which of the contract's failed endings the refusal
    deserves — :data:`NOT_ANSWERED` when the far end did not come on the
    line, :data:`ERROR` for everything else. The plug carries both up,
    and the record ends up with the honest one of the two.
    """

    def __init__(self, reason: str, *, ending: str = ERROR) -> None:
        super().__init__(reason)
        self.ending = ending


NOT_ANSWERED_STATUSES = frozenset({408, 410, 480, 486, 487, 600, 603, 604})
"""The SIP statuses that mean the far end, not the path to it.

Request Timeout, Gone, Temporarily Unavailable, Busy Here, Request
Terminated, Busy Everywhere, Decline, Does Not Exist Anywhere — a phone
that rang out, was engaged, or was refused by whoever holds it. Every
other status is something between here and there going wrong, and that is
a fault somebody has to fix rather than a call nobody picked up. The
vocabulary is the PSTN's own, so any bridge riding a SIP trunk maps
through this same table.
"""


def sip_refusal(
    status_code: int | None, status: str | None = None, *, told: str = ""
) -> MediaBackendError:
    """One carrier refusal, in the carrier's own words, with its ending.

    ``told`` is whatever else the bridge said about it — already scrubbed
    of this driver's secrets by its caller, because words quoted from
    somebody else are not the quoter's to trust.
    """
    if status_code in NOT_ANSWERED_STATUSES:
        ending, what = NOT_ANSWERED, "the call was not answered"
    else:
        ending, what = ERROR, "the call could not be placed"
    said = " ".join(
        part for part in (str(status_code) if status_code else "", status) if part
    )
    named = f"{what}: the carrier answered {said}" if said else what
    return MediaBackendError(f"{named}{f'; {told}' if told else ''}", ending=ending)


class MediaSession(Protocol):
    """The audio channel one call rides on. See the module docstring."""

    @property
    def sample_rate_hz(self) -> int: ...

    @property
    def far_end_left(self) -> bool: ...

    async def send(self, pcm: bytes) -> None: ...

    async def receive(self, seconds: float) -> bytes | None: ...


class MediaBackend(Protocol):
    """One outbound call, from opening the way in to hanging up."""

    async def create_session(self) -> MediaSession: ...

    async def dial(self, number: str) -> None: ...

    async def wait_answered(self, seconds: float) -> str: ...

    async def teardown(self) -> None: ...


BackendFactory = Callable[..., MediaBackend]
"""What the registry hands back: called with ``config=``, ``band_hz=`` and
``caller_id=`` keywords, it returns one backend for one call — in
practice, the driver class itself."""


def without_secrets(text: str, secrets: tuple[str, ...]) -> str:
    """Somebody else's words with this driver's own secrets taken out.

    A bridge or a carrier that echoes a trunk password back in an error
    body would otherwise put it into a failure reason and into the
    traceback logged beneath one. What a driver quotes is not a driver's
    to trust, so it is scrubbed here, where the secrets are known.
    """
    for secret in secrets:
        if secret and secret in text:
            text = text.replace(secret, REDACTED)
    return text


def backend_for(name: str) -> BackendFactory | None:
    """The driver registered under one backend name, or ``None``.

    The registry is deliberately a literal here, and the imports are
    inside it: a deployment that never dials a phone must not pay for a
    bridge's client library, and a library that is never imported is one
    that cannot reach the network on its own. The quarantine suite holds
    both halves of that.
    """
    if name == "scripted":
        from .scripted import ScriptedBackend

        return ScriptedBackend
    if name == "livekit":
        from .livekit import LiveKitBackend

        return LiveKitBackend
    return None
