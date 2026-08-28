"""Retell web call: the agent under test, reached by voice over WebRTC.

The third plug that reaches an agent where it lives, and the first that
reaches a *voice* agent on somebody else's platform. Egma creates the call
itself — ``create-web-call``, against the agent and, where the spec named
one, against a **named version** of it, with this simulation's variables
attached — and Retell answers with a way into a room. That room is a
LiveKit one: the way in is a server URL and an access token, which is
exactly what :mod:`egma_simulator.media.livekit_room` already joins, so
this module is thin. Creating the call is the only place it touches
Retell's API; everything after it is the room media the simulator already
has.

Its config keys, like every plug's, are its own:

- ``retellAgentId`` (string, required) — the agent the call is placed
  against, exactly as the control plane stores it.
- ``baseUrl`` (string, optional) — where Retell's API answers, defaulting
  to Retell itself. What lets a test create a call against a
  Retell-shaped server on loopback, and a proxy stand in front of the
  platform for a deployment that needs one.
- ``roomHost`` (string, optional) — where the room a web call opens is,
  defaulting to :data:`RETELL_ROOM_HOST` below. See that constant for why
  it is a value and not a line of code.

Credentials are shaped ``{"apiKey": ...}`` — the shape the control plane
seals — and are read for the ``Authorization`` header and nothing else.
Retell's answer carries a second secret, the room's access token, and it
is treated as one from the moment it arrives: registered for scrubbing
before anything can quote it, and named in no message, log or report.

**What "the agent answered" means here.** Retell's own participant is in
the room and its audio is flowing. A call that was created and whose room
nobody joined never tested anything, so it fails as ``AGENT_NEVER_JOINED``
and is never graded as the agent failing. ``NOT_ANSWERED`` belongs to a
line that rang out, and nothing rings here: egma creates the call and
joins the room it opens, so this lane never claims it.

**One call, one join.** A web call's access token is spent on the join —
Retell mints it for that one entry — so there is no rejoining and no
second attempt. Asking this plug for a second transport is refused rather
than tried, because trying would be a request Retell has already answered.

**Egma leaves; Retell closes.** The room is Retell's own, opened for its
own call, and a token that opens one room carries no power to delete it.
So teardown is a departure, which is also what ends the call from egma's
side.

**Egma is not in this agent's tool path.** A mocked world on Retell is
built out of the agent's own configuration, and the tool calls in it
travel from Retell to egma's endpoint rather than through the room. So the
mock-tool seam is taken and dropped here, deliberately: this plug never
offers the exchange in the room, and the record therefore claims nothing
about tools, which is the truth.
"""

from __future__ import annotations

import json
from typing import Any

import aiohttp

from ..client import UNREACHABLE
from ..contract import AGENT_NEVER_JOINED
from ..media import MediaBackendError, VoiceMedia
from ..media.livekit_room import URL_SCHEMES, LiveKitRoomBackend, RoomSettings
from ..redaction import REDACTED
from . import PlugError, named_version, rendered_variables
from .retell import DEFAULT_BASE_URL

RETELL_ROOM_HOST = "wss://retell-ai-4ihahnq7.livekit.cloud"
"""Where every Retell web call's room is.

Retell's own infrastructure, and the same host for every account: its
browser SDK connects to this one URL with the token the API hands back.
It is a value here, and overridable by the connection's ``roomHost``, for
the two reasons a constant of somebody else's is: a deployment can follow
Retell moving its infrastructure without waiting for a release of egma,
and there is exactly one place to change when a new SDK release moves it.
Track it against ``retell-client-js-sdk`` when that package is bumped.
"""

CREATE_PATH = "/v2/create-web-call"
"""Where a web call is created. Named here so a refusal can say it."""

TIMEOUT_SECONDS = 30.0
"""The most creating one call may take. Retell registers a call and
answers; anything past this is a platform that has stopped answering."""

AGENT_JOIN_SECONDS = 30.0
"""How long the room may stand empty before nobody coming is the answer.

Long enough for Retell to put its agent in the room it just opened and
for that agent's first audio to flow; short of a simulation's duration
limit doing the job instead, which would put ``limit_reached`` on a record
whose real story is that nothing ever turned up.
"""

QUOTED_REFUSAL_CHARS = 200
"""How much of a refusal's body is quoted into the reason: enough to carry
the platform's own words about what was wrong, short of pasting a page."""

_KNOWN_KEYS = {"retellAgentId", "baseUrl", "roomHost"}

_CREDENTIAL_KEYS = {"apiKey"}
"""Exactly what the control plane seals for a retell connection. Refused
strictly, and for the same reason it is refused there: a secret handed over
that nothing reads was handed over by mistake."""


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
        mock_tools: object = None,
        media: object = None,
        driver: Any = None,
    ) -> None:
        # Retell carries this call's audio itself, so the deployment's
        # carrier is nothing to it. And egma is not in this agent's tool
        # path: a mocked Retell world answers from egma's own endpoint,
        # which the agent reaches over the internet and not across the
        # room, so the seam is taken and dropped and the record claims
        # nothing about tools.
        del media, mock_tools

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
        stray = set(credentials) - _CREDENTIAL_KEYS
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
        self._spent = False
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
        if self._spent:
            # Not tried and refused: refused before it is tried. Retell
            # mints an access token for one entry into one room, so a
            # second attempt on this call is a request whose answer is
            # already known, and asking would only make the reason worse.
            raise PlugError(
                "a retell web call is joined once and its access token is "
                "spent on that join; conducting again needs a new call"
            )
        self._spent = True

        created = await self._create_call()
        self._room = self._built(
            settings=RoomSettings(url=self._room_host, given_token=created["token"]),
            simulation_id=self._simulation_id,
            # Deliberately none: egma does not stand in this agent's tool
            # path, so nothing is offered in the room and the record makes
            # no claim about tools it never saw.
            mock_tools=None,
        )
        try:
            self._media = await self._room.create_transport()
            return self._media
        except MediaBackendError as refused:
            raise PlugError(self._about_the_room(refused), ending=refused.ending) from (
                refused
            )

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
            raise PlugError(self._about_the_room(refused), ending=refused.ending) from (
                refused
            )

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

    # -- The one place this plug reaches Retell ------------------------------

    async def _create_call(self) -> dict[str, str]:
        """Create the call, or refuse in a sentence that carries no secret."""
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
                f"{self._quotable(repr(unreachable))}"
            ) from unreachable

        if status // 100 != 2:
            raise PlugError(
                f"retell answered {status} to {CREATE_PATH} at {self._base_url} "
                f"and created no web call: {self._quotable(body)}"
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
        # Held from here as the credential it is: whoever has it can join
        # this call's room. It is registered with the room driver's own
        # scrubbing below, before anything can quote it.
        self._call_id = call_id
        return {"call_id": call_id, "token": token}

    def _creation(self) -> dict:
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

    def _quotable(self, told: str) -> str:
        """The platform's own words, minus the key, short enough to read."""
        return told.replace(self._api_key, REDACTED)[:QUOTED_REFUSAL_CHARS]
