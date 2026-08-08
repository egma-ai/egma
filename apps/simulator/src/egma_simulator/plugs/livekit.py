"""The livekit plug: the simulator joins the agent's own room.

The second plug that reaches an agent the way its customers do, and the
first that reaches one where it lives. A LiveKit agent is a worker
waiting to be given a room; so egma makes a room in the customer's own
LiveKit project, joins it, asks for the worker, and holds the exchange
there. What a spec names is a server, a key pair, and — where the
customer runs more than one agent — which agent to ask for.

The room itself is a media driver's job — see
:mod:`egma_simulator.media.livekit_room`, which owns the room whole:
create it, mint the token, join outbound, dispatch the agent, learn that
it really turned up, and delete the room whatever happened. This module
owns the *lifecycle* above that seam, and it is deliberately thin: open,
carry the persona's speech out and the agent's speech back, notice the
agent leaving, end deliberately, and offer the room's name as the
provider reference — the one join between egma's record and the
platform's own telemetry.

Its config keys, like every plug's, are its own, and they are read by the
driver that uses them:

- ``url`` (string, required) — the customer's LiveKit, ``ws``/``wss`` or
  ``http``/``https``. Cloud and self-hosted are the same URL and the same
  API; nothing here knows the difference.
- ``agentName`` (string, optional) — which agent to dispatch. Absent or
  blank: automatic dispatch, which is what a worker registered without a
  name already gets.
- ``metadata`` (object, list or string of JSON, optional) — carried on
  the room, verbatim, for the agent to read.

Its credentials are the customer's LiveKit ``apiKey`` and ``apiSecret``.
Unlike a phone connection, a room connection carries its own: the room is
the customer's project, not this deployment's, so nothing about reaching
it comes from the environment.

## The band an exchange in a room is carried at

Always :data:`ROOM_BAND_HZ` — wideband, where a phone call is narrowband
— and there is no way to ask for another. WebRTC negotiates its own codec
and the transport resamples what arrives, so what a record stamps is
measured off the audio the recorder really saw.

## Where a turn begins and ends

Out of the audio itself, because a live room carries no end-of-turn
signal any more than a phone line does — see
:mod:`egma_simulator.plugs.audio_turns`.
"""

from __future__ import annotations

from typing import Any

from ..media import MediaBackendError, MediaSession
from ..media.livekit_room import ROOM_BAND_HZ, LiveKitRoomBackend, RoomSettings
from . import AgentSpeech, PlugError, Utterance
from .audio_turns import next_turn

AGENT_JOIN_SECONDS = 30.0
"""How long the room may stand empty before nobody coming is the answer.

Long enough for a worker to be woken, given the room, and to publish its
first audio; short of a simulation's duration limit doing the job
instead, which would put ``limit_reached`` on a record whose real story is
that nothing ever turned up.
"""


class LiveKitRoom:
    """One exchange with an agent in its own room, per instance."""

    def __init__(
        self,
        *,
        modality: str,
        config: dict[str, Any],
        credentials: object,
        simulation_id: str,
        driver: Any = None,
    ) -> None:
        # Which driver holds the room is not the spec's to choose: there
        # is one, and it is the one below. The keyword is for tests, which
        # put a room-shaped fake behind the same seam rather than stand up
        # a LiveKit.
        driver = driver or LiveKitRoomBackend

        if modality != "voice":
            raise PlugError(
                f"the livekit plug speaks voice only; a {modality!r} "
                "simulation in a room is not a thing that exists"
            )

        # Reading the connection here, before any pipeline starts, is what
        # makes a connection the driver cannot use an honest refusal
        # rather than a failure part-way through an exchange.
        self._band_hz = ROOM_BAND_HZ
        self._backend = _built(
            driver,
            settings=_read(config, credentials),
            band_hz=self._band_hz,
            simulation_id=simulation_id,
        )
        self._session: MediaSession | None = None
        self._reference: str | None = None

    @property
    def provider_reference(self) -> str | None:
        """The room this exchange was conducted in, once there is one."""
        return self._reference

    @property
    def sample_rate_hz(self) -> int:
        return self._band_hz

    @property
    def backend(self) -> object:
        """The driver holding the room.

        Here for the tests, honestly: the plug seam takes a spec and
        nothing else, so a test cannot hand in a driver to watch and this
        is the only way to ask what the exchange was really held in.
        """
        return self._backend

    async def open(self) -> AgentSpeech | None:
        """Make the room, ask for the agent, and hear how it opens."""
        try:
            self._session = await self._backend.create_session()
            await self._backend.dial()
            self._reference = await self._backend.wait_answered(AGENT_JOIN_SECONDS)
            return await self._listen()
        except MediaBackendError as refused:
            raise PlugError(str(refused), ending=refused.ending) from refused

    async def deliver(self, speech: Utterance) -> AgentSpeech:
        session = self._session
        if session is None:
            raise PlugError("a turn reached the livekit plug before the room did")
        try:
            await session.send(speech.pcm)
            return await self._listen()
        except MediaBackendError as failed:
            # A room that goes wrong mid-exchange is the driver's to name
            # and the plug's to carry: a fault, never an agent that never
            # joined, because one did join.
            raise PlugError(str(failed), ending=failed.ending) from failed

    async def close(self) -> None:
        """Leave, and delete the room. Safe from every state."""
        self._session = None
        await self._backend.teardown()

    async def _listen(self) -> AgentSpeech:
        """One turn of the agent's speech, read out of the room itself."""
        session = self._session
        if session is None:
            raise PlugError("the livekit plug listened before the room was joined")
        return await next_turn(session, self._band_hz)


def _read(config: dict[str, Any], credentials: object) -> RoomSettings:
    """The connection, read by the driver that uses it, in the plug's words."""
    try:
        return RoomSettings.from_connection(config, credentials)
    except MediaBackendError as refused:
        raise PlugError(str(refused), ending=refused.ending) from refused


def _built(factory, **arguments) -> Any:
    """One room driver, or the plug's own refusal in its words."""
    try:
        return factory(**arguments)
    except MediaBackendError as refused:
        raise PlugError(str(refused), ending=refused.ending) from refused
