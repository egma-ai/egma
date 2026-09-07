"""LiveKit voice connection. The room driver owns room setup and cleanup;
the Pipecat transport owns audio and turn processing.

access_variant explicitly selects token authority:
- Project credentials: url and agentName are required; credentials contain
  apiKey and apiSecret. Egma creates, dispatches into, and deletes the room.
- Token endpoint: tokenEndpoint and agentName are required; credentials contain
  auth headers. The HTTPS endpoint must include the requested worker and
  test-owned job_dispatch_metadata in the token's room_config.

Both variants offer MockToolSeam RPC on the Egma participant before agent
startup completes. The room name is the provider reference for agent POV spans.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from ..contract import AGENT_NEVER_JOINED
from ..media import MediaBackendError, VoiceMedia
from ..media.livekit_room import LiveKitRoomBackend, RoomSettings
from ..mock_tools import MockToolSeam
from . import PlugError

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
        access_variant: str,
        config: dict[str, Any],
        credentials: object,
        simulation_id: str,
        agent_version: object = None,
        dynamic_variables: object = None,
        job_dispatch_metadata: dict[str, Any] | None = None,
        mock_tools: MockToolSeam | None = None,
        media: object = None,
        driver: Any = None,
        on_provider_reference: Callable[[str], Awaitable[None]] | None = None,
    ) -> None:
        # A room is reached with this connection's URL and authority. It does
        # not use the deployment's phone media bridge or the platform carrier
        # resolved for a phone simulation. A worker is whatever the customer
        # is running: LiveKit keeps no versions of it, and it renders no
        # variables — what egma tells it is the test's dispatch metadata,
        # passed to the driver below.
        del media, agent_version, dynamic_variables

        if modality != "voice":
            raise PlugError(
                f"the livekit plug speaks voice only; a {modality!r} "
                "simulation in a room is not a thing that exists"
            )

        # Reading the connection here, before any pipeline starts, is what
        # makes a connection the driver cannot use an honest refusal
        # rather than a failure part-way through an exchange.
        #
        # Which driver holds the room is not the spec's to choose: there is
        # one, and it is the one below. The keyword is for tests, which put
        # a room-shaped fake behind the same seam rather than stand up a
        # LiveKit.
        self._backend = build_driver(
            driver or LiveKitRoomBackend,
            settings=read_connection(access_variant, config, credentials),
            simulation_id=simulation_id,
            mock_tools=mock_tools,
            job_dispatch_metadata=job_dispatch_metadata,
            on_provider_reference=on_provider_reference,
        )
        self._media: VoiceMedia | None = None
        self._reference: str | None = None
        # Kept as well as handed over, because this plug has to ask one
        # question of it after the agent is in the room: did the agent's
        # own side ever say hello.
        self._mock_tools = mock_tools

    @property
    def provider_reference(self) -> str | None:
        """The room this exchange was conducted in, once there is one."""
        return self._reference

    @property
    def far_end_left(self) -> bool:
        """Whether the agent has left the room. There is no other signal
        and no better one: its participant leaving *is* the agent ending
        the exchange."""
        return self._media is not None and self._media.ended.is_set()

    @property
    def backend(self) -> object:
        """The driver holding the room.

        Here for the tests, honestly: a plug built from a spec alone
        builds its own driver, and this is the only way to ask which room
        the exchange was really held in before there is a reference.
        """
        return self._backend

    async def prepare(self) -> VoiceMedia:
        """Build the transport before the conductor starts its pipeline."""
        try:
            self._media = await self._backend.create_transport()
            return self._media
        except MediaBackendError as refused:
            raise PlugError(str(refused), ending=refused.ending) from refused

    async def open(self) -> None:
        """Open the room and wait for the agent's audio and Egma hello.
        The running transport carries the greeting. Missing hello fails setup
        before the simulation proceeds without its required mock configuration.
        """
        try:
            await self._backend.dial()
            self._reference = await self._backend.wait_answered(AGENT_JOIN_SECONDS)
        except MediaBackendError as refused:
            raise PlugError(str(refused), ending=refused.ending) from refused
        if self._mock_tools is not None and not self._mock_tools.agent_reported:
            raise PlugError(
                self._mock_tools.why_unreported, ending=AGENT_NEVER_JOINED
            )

    async def close(self) -> None:
        """Leave, and delete the room. Safe from every state."""
        self._media = None
        await self._backend.teardown()


def read_connection(
    access_variant: str, config: dict[str, Any], credentials: object
) -> RoomSettings:
    """The connection, read by the driver that uses it, in the plug's words.

    Public because the chat plug next door reads the *same* connection
    block with the *same* driver and owes a refusal in the same words. A
    second copy of this would be a second set of sentences to keep true.
    """
    try:
        return RoomSettings.from_connection(access_variant, config, credentials)
    except MediaBackendError as refused:
        raise PlugError(str(refused), ending=refused.ending) from refused


def build_driver(factory, **arguments) -> Any:
    """One room driver, or the plug's own refusal in its words.

    Public for the reason above: both plugs build a driver, and both owe
    the same refusal when a connection turns out to be unusable.
    """
    try:
        return factory(**arguments)
    except MediaBackendError as refused:
        raise PlugError(str(refused), ending=refused.ending) from refused
