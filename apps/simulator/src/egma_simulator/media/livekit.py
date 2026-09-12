"""Place phone calls through LiveKit SIP and a shared Pipecat room transport.
The simulator joins outbound; the answering phone appears as a room participant.

MediaSettings combines the deployment bridge with the validated work order's
carrier route. This driver reads no environment settings or connection credentials.
Carrier authentication failures are reported from the dial response.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from ..config import MediaSettings
from ..redaction import REDACTED, SecretRegistry
from . import ERROR, NOT_ANSWERED, MediaBackendError, VoiceMedia, sip_refusal
from .room import (
    QUOTED_REFUSAL_CHARS,
    JoinedRoom,
    delete_room,
    fresh_room_name,
    room_token,
)

logger = logging.getLogger(__name__)


def _private_phone_reference(reference: str, number: str) -> str:
    """Keep LiveKit's call identity while removing the private destination."""
    return reference.replace(number, REDACTED)


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
                "carrier route arrives on the phone work order, so "
                f"{sorted(config)} was handed over by mistake"
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
        self._room_name = settings.livekit_room_name or fresh_room_name()
        self._room: JoinedRoom | None = None
        self._dialling: asyncio.Task | None = None

    @property
    def room_name(self) -> str:
        """The room this call is conducted in — one room, one call."""
        return self._room_name

    async def create_transport(self, *, audio_out_mixer: object = None) -> VoiceMedia:
        """Build the room transport for the conductor's Pipecat pipeline."""
        self._room = JoinedRoom(
            url=self._settings.livekit_url,
            token=self._settings.livekit_room_token
            or room_token(
                self._settings.livekit_api_key,
                self._settings.livekit_api_secret,
                self._room_name,
            ),
            room_name=self._room_name,
            quotable=self._quotable,
        )
        if audio_out_mixer is None:
            return self._room.create_transport()
        return self._room.create_transport(audio_out_mixer=audio_out_mixer)

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
                    token=self._settings.livekit_api_token,
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
            hide_phone_number=True,
            wait_until_answered=True,
            play_dialtone=False,
        )
        request.trunk.hostname = self._settings.trunk_address
        if self._settings.trunk_username is not None:
            request.trunk.auth_username = self._settings.trunk_username
        if self._settings.trunk_password is not None:
            request.trunk.auth_password = self._settings.trunk_password
        if self._caller_id is not None:
            request.sip_number = self._caller_id

        lkapi = (
            api.LiveKitAPI(
                self._settings.livekit_url, token=self._settings.livekit_api_token
            )
            if self._settings.livekit_api_token is not None
            else api.LiveKitAPI(
                self._settings.livekit_url,
                self._settings.livekit_api_key,
                self._settings.livekit_api_secret,
            )
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
        return _private_phone_reference(participant.participant_identity, number)

    def _quotable(self, told: str) -> str:
        """Somebody else's words, minus this driver's secrets, short enough
        to read. A bridge or a carrier that echoed a trunk password back
        must not get it repeated into a reason or into the traceback
        logged beneath one."""
        return self._secrets.redact(told)[:QUOTED_REFUSAL_CHARS]
