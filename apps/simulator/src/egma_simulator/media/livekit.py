"""The LiveKit driver: a room joined outbound, and a call placed into it.

Two halves, both LiveKit's own:

- **The room.** The simulator joins it through Pipecat's stock LiveKit
  transport, purely outbound — signalling over a websocket it opens,
  media over ICE it negotiates — so the simulator needs no inbound
  network surface to conduct a phone call. Nothing dials the simulator;
  the simulator dials. That half is :mod:`egma_simulator.media.room`,
  shared with every other driver that reaches an agent through a room.
- **The call.** LiveKit's SIP service places it, over a SIP trunk the
  deployment brings, and the answering phone appears in the room as an
  ordinary participant. Pipecat ships no example of this half, so the
  ``create_sip_participant`` call below is written here — it is about
  twenty lines, and it is what turns a room into a phone call.

The same driver serves a self-hosted LiveKit and LiveKit Cloud, which
are the same API behind the same URL: a deployment moves between them by
changing one variable, and nothing in this file knows the difference.

The trunk is the deployment's, not the spec's: a customer brings one from
any carrier, either as a reference to a trunk already stored in LiveKit
or as the inline fields LiveKit documents for outbound credential auth.
Both are checked at startup (see
:class:`egma_simulator.config.MediaSettings`) and arrive here already
good, so nothing in this file reads an environment variable and nothing
in it can be the first to discover a deployment cannot dial.

What can only be known at dial time stays at dial time: a trunk whose
credentials the *carrier* rejects is a SIP refusal like any other, and it
is reported as one.

(This module is named for the product it drives. ``from livekit import
api`` inside it reaches the installed LiveKit package, not this file:
Python resolves imports absolutely.)
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from ..config import MediaSettings
from ..redaction import SecretRegistry
from . import ERROR, NOT_ANSWERED, MediaBackendError, VoiceMedia, sip_refusal
from .room import (
    QUOTED_REFUSAL_CHARS,
    JoinedRoom,
    delete_room,
    fresh_room_name,
    room_token,
)

logger = logging.getLogger(__name__)


class LiveKitBackend:
    """One outbound call over LiveKit, per instance."""

    def __init__(
        self,
        *,
        settings: MediaSettings,
        config: dict,
        caller_id: str | None,
    ) -> None:
        if config:
            raise MediaBackendError(
                "the livekit media backend reads no connection config: its "
                f"trunk belongs to the deployment, so {sorted(config)} was "
                "handed over by mistake"
            )
        if settings.livekit_url is None:
            # Unreachable through a started simulator, which checks this at
            # startup and names the variable. Kept because a driver that
            # trusted its settings silently would fail somewhere far away
            # from the thing that was wrong.
            raise MediaBackendError(
                "the livekit media backend was built without a livekit to "
                "place calls through"
            )
        self._settings = settings
        self._caller_id = caller_id or settings.trunk_number
        # One registry, built from the same secrets the process-wide log
        # filter was given at startup, so what a driver quotes goes through
        # the same scrubbing every log line does rather than through a
        # second implementation of it.
        self._secrets = SecretRegistry()
        self._secrets.register(list(settings.secrets))
        self._room_name = fresh_room_name()
        self._room: JoinedRoom | None = None
        self._dialling: asyncio.Task | None = None

    @property
    def room_name(self) -> str:
        """The room this call is conducted in — one room, one call."""
        return self._room_name

    async def create_transport(self) -> VoiceMedia:
        """Build the room transport for the conductor's Pipecat pipeline."""
        self._room = JoinedRoom(
            url=self._settings.livekit_url,
            token=room_token(
                self._settings.livekit_api_key,
                self._settings.livekit_api_secret,
                self._room_name,
            ),
            room_name=self._room_name,
            quotable=self._quotable,
        )
        return self._room.create_transport()

    async def dial(self, number: str) -> None:
        """Ask LiveKit to place the call. Returns as soon as it is away."""
        if self._room is None:
            raise MediaBackendError("a call was dialled before its room transport")
        await self._room.wait_connected()
        self._dialling = asyncio.create_task(
            self._place(number), name=f"dial:{self._room_name}"
        )

    async def wait_answered(self, seconds: float) -> str:
        """Block until somebody is on the line, or say why nobody is."""
        if self._dialling is None:
            raise MediaBackendError("an answer was waited for before a dial")
        try:
            return await asyncio.wait_for(self._dialling, timeout=seconds)
        except TimeoutError as rang_out:
            raise MediaBackendError(
                f"the call was not answered: it rang for {seconds:.0f}s and "
                "nothing picked up",
                ending=NOT_ANSWERED,
            ) from rang_out

    async def teardown(self) -> None:
        """End the call and let go of everything, from any state.

        Deleting the room is what ends the call: LiveKit tears the SIP leg
        down with the room it was in, which is safe whether the call was
        answered, refused, or never placed.
        """
        dialling, self._dialling = self._dialling, None
        if dialling is not None:
            # Awaited whether it finished or not: a dial that failed with
            # nobody waiting on it would otherwise be an unretrieved
            # exception logged from the event loop, out of context and out
            # of order with the record.
            if not dialling.done():
                dialling.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await dialling
        room, self._room = self._room, None
        if room is None:
            return
        joined = room.joined
        try:
            await room.leave()
        finally:
            if joined:
                # No room was ever joined, so there is no room to delete
                # and nobody to ask — a trunk refused at construction must
                # not cost a call to LiveKit that could only fail.
                await delete_room(
                    url=self._settings.livekit_url,
                    api_key=self._settings.livekit_api_key,
                    api_secret=self._settings.livekit_api_secret,
                    room_name=self._room_name,
                    quotable=self._quotable,
                )

    # -- The parts that speak to LiveKit -------------------------------------

    async def _place(self, number: str) -> str:
        """One `CreateSIPParticipant`, waited out, or the carrier's refusal.

        ``wait_until_answered`` is what makes this one call rather than a
        request and a poll: LiveKit holds it open until the phone is
        picked up, and raises with the carrier's own SIP status when it
        is not. That status is the whole diagnosis, so it is carried up
        rather than summarised away.
        """
        from livekit import api

        request = api.CreateSIPParticipantRequest(
            room_name=self._room_name,
            sip_call_to=number,
            # No participant identity of our own: LiveKit mints one for the
            # SIP leg, and that identity is what the report carries as its
            # join to the platform's own telemetry.
            participant_name="agent-under-test",
            wait_until_answered=True,
            play_dialtone=False,
        )
        if self._settings.trunk_id is not None:
            request.sip_trunk_id = self._settings.trunk_id
        else:
            request.trunk.hostname = self._settings.trunk_address
            if self._settings.trunk_username is not None:
                request.trunk.auth_username = self._settings.trunk_username
            if self._settings.trunk_password is not None:
                request.trunk.auth_password = self._settings.trunk_password
        if self._caller_id is not None:
            request.sip_number = self._caller_id

        lkapi = api.LiveKitAPI(
            self._settings.livekit_url,
            self._settings.livekit_api_key,
            self._settings.livekit_api_secret,
        )
        try:
            participant = await lkapi.sip.create_sip_participant(request)
        except api.SipCallError as refused:
            raise sip_refusal(
                refused.sip_status_code,
                refused.sip_status,
                told=self._quotable(refused.message),
            ) from refused
        except api.ServerError as refused:
            raise MediaBackendError(
                "the call could not be placed: livekit answered "
                f"{refused.code} — {self._quotable(refused.message)}",
                ending=ERROR,
            ) from refused
        except asyncio.CancelledError:
            raise
        except Exception as unreachable:
            raise MediaBackendError(
                "the call could not be placed: the livekit server at "
                f"{self._settings.livekit_url} could not be reached — "
                f"{self._quotable(repr(unreachable))}",
                ending=ERROR,
            ) from unreachable
        finally:
            with contextlib.suppress(Exception):
                await lkapi.aclose()
        return participant.participant_identity

    def _quotable(self, told: str) -> str:
        """Somebody else's words, minus this driver's secrets, short enough
        to read. A bridge or a carrier that echoed a trunk password back
        must not get it repeated into a reason or into the traceback
        logged beneath one."""
        return self._secrets.redact(told)[:QUOTED_REFUSAL_CHARS]
