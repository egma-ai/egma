"""Retell voice connection through create-web-call and the shared LiveKit driver.
Config requires retellAgentId; baseUrl and roomHost are optional overrides.
Forward the supplied agent version and dynamic variables when creating the call.
Check the final call status if the room closes before participant departure.

Credentials contain apiKey. The returned room access token is also a secret;
register both for redaction before reporting platform errors.
The token permits one join: do not retry or create a second transport.

Wait for the agent and its audio; absence is AGENT_NEVER_JOINED, not NOT_ANSWERED.
Teardown leaves the room; Egma has no authority to delete Retell's room.
Mock-tool calls use the configured HTTP endpoint, not RPC on this participant.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from urllib.parse import quote

import aiohttp

from ..client import UNREACHABLE
from ..contract import AGENT_NEVER_JOINED
from ..media import MediaBackendError, VoiceMedia
from ..media.livekit_room import URL_SCHEMES, LiveKitRoomBackend, RoomSettings
from ..platform_logging import log_event
from . import PlugError, named_version, quotable, rendered_variables
from .retell import CREDENTIAL_KEYS, DEFAULT_BASE_URL

logger = logging.getLogger(__name__)

RETELL_ROOM_HOST = "wss://retell-ai-4ihahnq7.livekit.cloud"
"""Default room host copied from retell-client-js-sdk 2.0.8, src/index.ts,
on 2026-08-27. That external SDK is not a dependency, so builds cannot detect
a host change. Verify its room.connect literal when updating this value.
The roomHost config override lets deployments use a changed host.
"""

CREATE_PATH = "/v2/create-web-call"
"""Where a web call is created. Named here so a refusal can say it."""

TIMEOUT_SECONDS = 30.0
"""The most creating one call may take. Retell registers a call and
answers; anything past this is a platform that has stopped answering."""

FINAL_STATUS_SECONDS = 3.0
"""A room can disappear just before Retell publishes its final call status."""

AGENT_JOIN_SECONDS = 30.0
"""How long the room may stand empty before nobody coming is the answer.

Long enough for Retell to put its agent in the room it just opened and
for that agent's first audio to flow; short of a simulation's duration
limit doing the job instead, which would put ``limit_reached`` on a record
whose real story is that nothing ever turned up.
"""

_KNOWN_KEYS = {"retellAgentId", "baseUrl", "roomHost"}


class RetellWebCall:
    """One Retell web call, created and joined and left, per instance."""

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
        job_dispatch_metadata: object = None,
        mock_tools: object = None,
        media: object = None,
        driver: Any = None,
    ) -> None:
        # Retell carries this call's audio itself, so the deployment's
        # carrier is nothing to it. And egma is not in this agent's tool
        # path: a mocked Retell world answers from egma's own endpoint,
        # which the agent reaches over the internet and not across the
        # room, so the seam is taken and dropped and the record claims
        # nothing about tools. It dispatches no worker either, so the half
        # of the test's env that rides a job dispatch has nowhere to go.
        del media, mock_tools, job_dispatch_metadata

        if access_variant != "retell_web_call.api_key":
            raise PlugError(
                "the retell web-call adapter does not support access variant "
                f"{access_variant!r}"
            )

        if modality != "voice":
            raise PlugError(
                f"the retell web-call plug speaks voice only; a {modality!r} "
                "simulation over retell is the chat plug's job"
            )

        unknown = set(config) - _KNOWN_KEYS
        if unknown:
            raise PlugError(
                f"the retell web-call plug does not know config key(s) "
                f"{sorted(unknown)}; it knows {sorted(_KNOWN_KEYS)}"
            )

        agent_id = config.get("retellAgentId")
        if not isinstance(agent_id, str) or not agent_id.strip():
            raise PlugError(
                "retell web-call config: retellAgentId must be a non-empty string"
            )

        base_url = config.get("baseUrl", DEFAULT_BASE_URL)
        if not isinstance(base_url, str) or not base_url.strip():
            raise PlugError(
                "retell web-call config: baseUrl must be a non-empty string"
            )

        room_host = config.get("roomHost", RETELL_ROOM_HOST)
        if not isinstance(room_host, str) or not room_host.strip():
            raise PlugError(
                "retell web-call config: roomHost must be a non-empty string — "
                "where the room a web call opens is"
            )
        room_host = room_host.strip()
        if not room_host.startswith(URL_SCHEMES):
            raise PlugError(
                f"retell web-call config: roomHost must start with one of "
                f"{', '.join(URL_SCHEMES)}; got {room_host!r}"
            )

        if not isinstance(credentials, dict):
            raise PlugError(
                "a retell web-call connection needs credentials shaped {apiKey}"
            )
        stray = set(credentials) - CREDENTIAL_KEYS
        if stray:
            raise PlugError(
                f"retell web-call credentials hold no key(s) {sorted(stray)}; "
                "they are shaped {apiKey}"
            )
        api_key = credentials.get("apiKey")
        if not isinstance(api_key, str) or not api_key.strip():
            raise PlugError(
                "retell web-call credentials: apiKey must be a non-empty string"
            )

        self._agent_id = agent_id.strip()
        self._base_url = base_url.strip().rstrip("/")
        self._room_host = room_host
        self._api_key = api_key.strip()
        self._agent_version = named_version(agent_version)
        self._dynamic_variables = rendered_variables(dynamic_variables)
        self._simulation_id = simulation_id
        # Which driver holds the room is not the spec's to choose: there is
        # one, and it is the room driver. The keyword is for tests, which
        # put a room-shaped fake behind the same seam rather than stand up
        # a LiveKit.
        self._driver_factory = driver or LiveKitRoomBackend
        self._timeout = aiohttp.ClientTimeout(total=TIMEOUT_SECONDS)
        self._call_id: str | None = None
        self._conducted = False
        self._room: Any = None
        self._media: VoiceMedia | None = None

    @property
    def base_url(self) -> str:
        """Where this call is created — the URL every refusal names."""
        return self._base_url

    @property
    def room_host(self) -> str:
        """Where the room this call opens is."""
        return self._room_host

    @property
    def provider_reference(self) -> str | None:
        """Retell's own id for this call, once there is one to hold it by.

        The join between egma's record and Retell's telemetry, and it is
        the call rather than the room: the room is Retell's, named by
        Retell, and never told to egma — the call id is what both sides
        can look the same exchange up by.
        """
        return self._call_id

    @property
    def far_end_left(self) -> bool:
        """Whether Retell's agent has left the room. Its participant
        leaving *is* the agent ending the exchange, here as in any room."""
        return self._media is not None and self._media.ended.is_set()

    async def prepare(self) -> VoiceMedia:
        """Create the call, then build the transport for the room it opens."""
        if self._conducted:
            # Refused before it is tried, not tried and refused. Retell
            # mints an access token for one entry into one room, so a
            # second attempt on this call is a request whose answer is
            # already known, and asking would only make the reason worse.
            raise PlugError(
                "a retell web call is joined once — its access token is "
                "spent on that join — so conducting again needs a new call"
            )

        # Marked once there is something to spend, and not before: a
        # creation that failed minted no token and left no call at Retell,
        # so it is a thing that did not happen rather than a thing already
        # used up, and saying otherwise would send whoever reads the reason
        # looking for a call that never existed.
        token = await self._create_call()
        self._conducted = True
        self._room = self._built(
            settings=RoomSettings(url=self._room_host, given_token=token),
            simulation_id=self._simulation_id,
            # Deliberately none: egma does not stand in this agent's tool
            # path, so nothing is offered in the room and the record makes
            # no claim about tools it never saw.
            mock_tools=None,
            confirm_remote_end=self._confirm_remote_end,
        )
        try:
            self._media = await self._room.create_transport()
            return self._media
        except MediaBackendError as refused:
            raise PlugError(
                self._about_the_room(refused), ending=refused.ending
            ) from refused

    async def open(self) -> None:
        """Wait for Retell's agent to be in the room and to be heard.

        Nothing is heard here. The line is open the moment the agent's
        audio flows; the running Pipecat transport then carries both
        sides, including the agent's opening.
        """
        if self._room is None:
            raise PlugError("a retell web call was opened before it was created")
        try:
            await self._room.dial()
            await self._room.wait_answered(AGENT_JOIN_SECONDS)
        except MediaBackendError as refused:
            raise PlugError(
                self._about_the_room(refused), ending=refused.ending
            ) from refused

    async def close(self) -> None:
        """Leave the room. Safe from every state.

        There is nothing else to do and nothing else egma may do: the room
        belongs to Retell, which closes it once egma is gone, and the
        access token that opened it was only ever a way in.
        """
        self._media = None
        room, self._room = self._room, None
        if room is not None:
            await room.teardown()

    async def _confirm_remote_end(self) -> bool:
        """Only this call's final status can confirm a Retell room ending.

        The disconnect reason explains the ending; it does not replace the
        provider's status. A network failure or an unfinished call remains
        unconfirmed, and no media failure is cleared by this check.
        """
        call_id = self._call_id
        if call_id is None:
            return False
        url = f"{self._base_url}/v2/get-call/{quote(call_id, safe='')}"
        try:
            async with (
                asyncio.timeout(FINAL_STATUS_SECONDS),
                aiohttp.ClientSession(
                    headers={"Authorization": f"Bearer {self._api_key}"},
                    timeout=aiohttp.ClientTimeout(total=1.0),
                ) as session,
            ):
                while True:
                    try:
                        async with session.get(url) as response:
                            if response.status == 200:
                                document = await response.json()
                                if not isinstance(document, dict):
                                    return False
                                if document.get("call_id") != call_id:
                                    return False
                                status = document.get("call_status")
                                if status in {"ended", "error"}:
                                    reason = document.get("disconnection_reason")
                                    log_event(
                                        logger,
                                        logging.INFO,
                                        "egma.retell.call_final_status",
                                        "retell reported its final call status",
                                        attributes={
                                            "retell.call_id": call_id,
                                            "retell.call_status": status,
                                            "retell.disconnection_reason": (
                                                quotable(reason, self._api_key)[:80]
                                                if isinstance(reason, str)
                                                else "unknown"
                                            ),
                                        },
                                    )
                                    return status == "ended"
                            elif (
                                response.status not in {404, 408, 429}
                                and response.status < 500
                            ):
                                return False
                    except UNREACHABLE:
                        pass
                    except ValueError:
                        return False
                    await asyncio.sleep(0.25)
        except TimeoutError:
            return False

    # -- Creating the Retell call -------------------------------------------

    async def _create_call(self) -> str:
        """Create the call and come back with the way into its room.

        Or refuse in a sentence that carries no secret: what a person needs
        is the status Retell answered with, the URL it answered from, and
        Retell's own words about what was wrong. None of the three is one.
        """
        url = f"{self._base_url}{CREATE_PATH}"
        try:
            async with (
                aiohttp.ClientSession() as session,
                session.post(
                    url,
                    json=self._creation(),
                    headers={"Authorization": f"Bearer {self._api_key}"},
                    timeout=self._timeout,
                ) as response,
            ):
                status = response.status
                body = await response.text()
        except UNREACHABLE as unreachable:
            raise PlugError(
                f"retell was unreachable at {url}: "
                f"{quotable(repr(unreachable), self._api_key)}"
            ) from unreachable

        if status // 100 != 2:
            raise PlugError(
                f"retell answered {status} to {CREATE_PATH} at {self._base_url} "
                f"and created no web call: {quotable(body, self._api_key)}"
            )
        try:
            document = json.loads(body)
        except ValueError as unreadable:
            raise PlugError(
                f"retell answered {CREATE_PATH} with something that is not JSON"
            ) from unreadable
        if not isinstance(document, dict):
            raise PlugError(
                f"retell answered {CREATE_PATH} with "
                f"{type(document).__name__}, not an object"
            )

        call_id = document.get("call_id")
        if not isinstance(call_id, str) or not call_id:
            raise PlugError("retell created a web call with no call_id to hold it by")
        token = document.get("access_token")
        if not isinstance(token, str) or not token:
            raise PlugError(
                f"retell created web call {call_id} with no access_token, so "
                "there is no way into the room it opened"
            )
        # The token is held from here as the credential it is: whoever has
        # it can join this call's room. It goes straight into the room
        # settings, which register it with the driver's own scrubbing
        # before anything downstream can quote it.
        self._call_id = call_id
        return token

    def _creation(self) -> dict[str, Any]:
        """What one web call is created with.

        Which agent, and — only where the spec said so — which version of
        it and what this simulation is conducted with. The version is named
        explicitly whenever there is one: Retell's own default is the
        newest version, which is a moving target and, on a mocked run, the
        very draft the run must not be at the mercy of.
        """
        creation: dict = {"agent_id": self._agent_id}
        if self._agent_version is not None:
            creation["agent_version"] = self._agent_version
        if self._dynamic_variables:
            creation["retell_llm_dynamic_variables"] = self._dynamic_variables
        return creation

    # -- Saying what went wrong, in this plug's own terms --------------------

    def _built(self, **arguments: Any) -> Any:
        """One room driver, or this plug's refusal in its words."""
        try:
            return self._driver_factory(**arguments)
        except MediaBackendError as refused:
            raise PlugError(str(refused), ending=refused.ending) from refused

    def _about_the_room(self, refused: MediaBackendError) -> str:
        """One room refusal, worded for whoever has to go and look.

        Two things go wrong in a room Retell opened, and they are not the
        same thing to a person reading a record. Nobody turning up is about
        the agent — the call was made, the room was joined, and Retell put
        nothing in it. Not getting in at all is about the way in, and this
        plug knows the one fact that explains most of those: the token is
        spent on the join and does not wait around.
        """
        told = str(refused)
        where = f"retell web call {self._call_id}" if self._call_id else "the web call"
        if refused.ending == AGENT_NEVER_JOINED:
            return f"{where}: {told}"
        return (
            f"{where} was created, but Egma could not get into the room it "
            f"opened: {told}. A web call's access token opens one room once, "
            f"so a token already used, or created and left, is refused and a "
            f"new call has to be created"
        )
