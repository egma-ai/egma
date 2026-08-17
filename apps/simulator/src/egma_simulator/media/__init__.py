"""Media backends give Pipecat one transport for an outbound phone call.

A backend creates the transport processors, dials, waits for an answer,
and tears the call down. The transport owns frames, conversion, buffering,
and pacing. It never exposes a PCM exchange or a processing rate to Egma.

Backends receive checked deployment settings. They must keep credentials
out of logs, exceptions, and returned values. A refusal is ``not_answered``
only when the far end declined or did not pick up; path and carrier faults
are ``error``.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from importlib import import_module
from typing import Protocol

from ..contract import ERROR, NOT_ANSWERED

BACKENDS = {
    "livekit": ("livekit", "LiveKitBackend"),
    "scripted": ("scripted", "ScriptedBackend"),
}
"""Every media backend, by name: the module in this package that holds
it, and the class inside it. One entry per driver and nothing else — the
registry below reads this, so adding a bridge really is one line.

The entries are names rather than classes because a deployment that never
dials a phone must not pay for a bridge's client library, and a library
that is never imported is one that cannot reach the network on its own.
The quarantine suite holds both halves of that.
"""


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


@dataclass(frozen=True)
class VoiceMedia:
    """The Pipecat processors and lifecycle signals for one voice connection.

    The transport owns frames, conversion, buffering, and pacing.  A plug
    gives these processors to the voice conductor once; it never exchanges
    PCM bytes with the conductor itself. ``ended`` means the remote agent
    left normally. ``failed`` means the media path itself was lost.
    """

    input: tuple[object, ...]
    output: tuple[object, ...]
    ended: asyncio.Event
    failed: asyncio.Event = field(default_factory=asyncio.Event)
    transport_name: str = "voice transport"
    input_recorded: Callable[[object], None] = lambda _frame: None


class MediaBackend(Protocol):
    """One outbound call, from opening the way in to hanging up."""

    async def create_transport(self) -> VoiceMedia: ...

    async def dial(self, number: str) -> None: ...

    async def wait_answered(self, seconds: float) -> str: ...

    async def teardown(self) -> None: ...


BackendFactory = Callable[..., MediaBackend]
"""A backend class called with settings, config, and caller id."""


def backend_for(name: str) -> BackendFactory | None:
    """The driver registered under one backend name, or ``None``.

    Only the named driver's module is imported, which is what keeps a
    simulator that dials no phone from loading a bridge's library at all.
    """
    entry = BACKENDS.get(name)
    if entry is None:
        return None
    module, driver = entry
    return getattr(import_module(f".{module}", __package__), driver)
