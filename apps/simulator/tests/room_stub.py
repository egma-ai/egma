"""A LiveKit, room-shaped, on this machine — what CI holds a room
simulation against.

The room-shaped twin of the Retell stub one layer down: a whole voice
simulation conducts against it with no LiveKit server, no project, no
worker and no network. What it stands in for is exactly the places the
room driver reaches a LiveKit — the requests it makes of the project,
joining the room, and deleting it — and nothing else.

Not the token request. A connection that asks a customer's own endpoint
for its token really asks, over a socket, of the endpoint in
:mod:`token_endpoint_stub`; nothing here stands in for that.

Everything else is the real driver's own code, and deliberately so. The
requests recorded below are the very protobuf messages that would have
gone on the wire, built by the driver: the room's name and the metadata
the connection configured, the agent's name and the context egma
dispatches with. So are the waits, the endings, the sentences a person
reads and the scrubbing of the key pair. What this suite proves about a
refusal or an ending is therefore proved about the code a customer's
server will run.

It is a subclass rather than a stand-in for exactly that reason: a fake
written beside the driver would drift from it, and the first anybody
would know is a live call.

The room carries two channels and this one carries both. Beside the
audio, a room is where the agent's side asks egma to answer for its
tools — so the room here registers the methods the driver registers,
refuses what the transport refuses, and lets a test say the two things a
session says: hello, and one tool call. What answers them is egma's own
code, unchanged, with no LiveKit and no network anywhere.

The script it is built with:

- ``greeting`` — what the agent says the moment it is in the room.
  Absent: it joins and says nothing, and the persona speaks first.
- ``replies`` — the agent's answers, in order, one per stretch of persona
  speech. A spent script answers with quiet, the way a room with nobody
  talking in it really sounds.
- ``answer_delay_seconds`` — how long the agent is quiet before each
  answer. Rendered into the room's own audio, where a live exchange
  carries it and where time-to-first-word is read from.
- ``hangs_up_after_replies`` — when true, the agent leaves the room once
  its last reply has been carried, which is what an agent ending the
  exchange looks like from the plug's seat.
- ``agent_joins`` — false for the worker that never comes: the room
  opens, the dispatch goes out, and nobody arrives.
- ``agent_publishes_audio`` — false for the worker that joins and
  publishes nothing, which is a worker that crashed rather than an agent
  under test.
- ``refuses_room`` / ``refuses_dispatch`` — the platform's own words when
  it will not make the room, or will not dispatch into it.
- ``refuses_rpc`` — a participant that will not take the mock-tool methods
  at all, which must cost the exchange and never the conversation.

## The same room, carrying typing

A chat simulation is the same room with nobody speaking in it, so it gets
the same treatment: :class:`ChatRoomStubBackend` is the real chat driver
with the three requests it makes of a LiveKit answered here, and
:class:`StubTextRoom` is the real text room with only its join stood in
for. Everything a chat test then exercises is the driver's own — reading
an utterance to its close, skipping egma's own words, deciding where a
turn ends and waiting out the quiet period, and putting the mock-tool
methods on egma's participant. What is scripted is only what the agent
does, and the interesting scripts are the ones a real agent produces:

- ``greeting`` / ``replies`` — as above, except that one entry may be a
  **list** of utterances rather than one. That is a turn arriving in
  pieces, which is what an agent that says a filler and then answers
  really sends.
- ``answer_delay_seconds`` — how long the agent is quiet before it starts
  a turn.
- ``pause_seconds`` — the gap *inside* a turn, between two of its
  utterances. This is the tool-call pause, and it is the whole reason the
  turn does not end at the first close.
- ``agent_publishes_audio_track`` / ``marks_speech`` — the two wire facts
  that say an agent is speaking rather than typing, scriptable separately
  because they reach egma by different routes and either alone is enough.

The record fields are the voice fake's own — ``rooms``, ``dispatches``,
``deleted``, ``standing_ready`` — because they are the same facts about
the same room, and a chat test that reads like a voice one is the point of
having one connection type answer in two modalities.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
from dataclasses import dataclass, field, replace
from typing import Any

from egma_simulator.media import VoiceMedia
from egma_simulator.media.livekit_room import (
    LiveKitChatRoomBackend,
    LiveKitRoomBackend,
    RoomSettings,
    TextRoom,
    Utterance,
    platform_refusal,
)
from egma_simulator.media.room import answering
from egma_simulator.media.scripted_transport import ScriptedTransport
from egma_simulator.mock_tools import (
    HELLO_METHOD,
    LARGEST_PAYLOAD_BYTES,
    PROTOCOL_VERSION,
    TOOL_METHOD,
)

AGENT_IDENTITY = "agent-under-test"
"""Who the agent is in the room, once its worker turns up."""


@dataclass(frozen=True)
class RpcAsk:
    """One incoming call, in the shape a handler is handed by the room.

    Only the payload matters to anything egma registers — room membership
    is the authorisation, so who called and how long they will wait decide
    nothing on this side.
    """

    payload: str


@dataclass(frozen=True)
class CreatedRoom:
    """One room this LiveKit was asked to make, and what it carries."""

    name: str
    metadata: str


@dataclass(frozen=True)
class Dispatch:
    """One agent this LiveKit was asked to put in a room."""

    room: str
    agent_name: str
    metadata: str


class StubRoom:
    """The room itself: who is in it, what can be heard in it, and what
    can be called in it.

    The calling half is the room's second channel, and it is as real as
    the audio one: the methods registered below are the driver's own, the
    refusals are the driver's own conversion of them, and the caller side
    behaves the way the transport behaves — a method nobody registered is
    refused, and a payload too large for one message is refused before it
    is carried. So an agent's side of the mock-tool exchange can be
    written against this room and is written against the real one.
    """

    def __init__(self, backend: RoomStubBackend) -> None:
        self._backend = backend
        self._transport: ScriptedTransport | None = None
        self._activation: asyncio.Task[None] | None = None
        self._joined = False
        self._methods: dict[str, object] = {}
        self.arrivals = asyncio.Event()
        self.carrying_audio = asyncio.Event()
        self.ended = asyncio.Event()
        self.who_arrived: list[str] = []

    @property
    def transport(self) -> ScriptedTransport | None:
        return self._transport

    @property
    def joined(self) -> bool:
        return self._joined

    def create_transport(self) -> VoiceMedia:
        """Build the same Pipecat-native scripted transport CI uses elsewhere."""
        self._joined = True
        stub = self._backend.stub
        self._transport = ScriptedTransport(
            greeting=stub.greeting,
            replies=stub.replies,
            answer_delay_seconds=stub.answer_delay_seconds,
            ends_after_replies=stub.hangs_up_after_replies,
        )
        stub.transports.append(self._transport)
        # Where egma minted its own token, the worker is on its way because
        # egma asked for it. Where it did not, nobody asked and nobody
        # could: the endpoint that minted the token is what dispatches, so
        # from the room's side the agent simply turns up — or does not.
        if self._backend.endpoint_dispatches:
            self._backend.agent_is_coming = stub.agent_joins
        if self._backend.agent_is_coming:
            self.agent_arrives()
        return self._transport.media

    async def wait_connected(self) -> None:
        """The local room is connected as soon as its processors exist."""
        return None

    async def leave(self) -> None:
        if self._transport is not None:
            self._transport.stop()
        if self._activation is not None and not self._activation.done():
            self._activation.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._activation
        self._transport = None
        self._joined = False
        self.ended.set()

    # -- The room's other channel: what can be called in it -------------------

    def register_rpc(self, method: str, handler: object) -> None:
        """Offer one method on egma's participant, the driver's own way.

        The handler is wrapped by :func:`egma_simulator.media.room.answering`
        — the very wrapper the real room registers — so what a refusal
        becomes on the wire is proved here about the code a customer's
        server runs, rather than about a second conversion written beside
        it.
        """
        refusal = self._backend.stub.refuses_rpc
        if refusal is not None:
            raise RuntimeError(refusal)
        self._methods[method] = answering(handler)
        self._backend.stub.standing_ready.set()

    async def perform_rpc(self, method: str, payload: str) -> str:
        """Call a method on egma's participant, the way the transport does."""
        return await performed(self._methods, method, payload)

    def agent_arrives(self) -> None:
        """The worker turns up, and — unless it is broken — is heard."""
        if AGENT_IDENTITY in self.who_arrived:
            return
        self.who_arrived.append(AGENT_IDENTITY)
        self.arrivals.set()
        transport = self._transport
        stub = self._backend.stub
        if transport is None or not stub.agent_publishes_audio:
            return
        self.carrying_audio.set()
        self._activation = asyncio.create_task(
            transport.activate(), name="room-stub-transport"
        )


async def performed(methods: dict[str, Any], method: str, payload: str) -> str:
    """One call on egma's participant, the way the transport makes it.

    Written once for both rooms, because it is one behaviour: everything
    the transport would refuse before egma ever sees it is refused here
    for the same reasons and with the same codes — a method nobody
    registered, a request too large to carry, and a reply too large to
    carry back. What is left is the handler's own answer, or the handler's
    own refusal.
    """
    from livekit import rtc

    if len(payload.encode()) > LARGEST_PAYLOAD_BYTES:
        raise rtc.RpcError._built_in(rtc.RpcError.ErrorCode.REQUEST_PAYLOAD_TOO_LARGE)
    handler = methods.get(method)
    if handler is None:
        raise rtc.RpcError._built_in(rtc.RpcError.ErrorCode.UNSUPPORTED_METHOD)
    answered = await handler(RpcAsk(payload=payload))
    if len(answered.encode()) > LARGEST_PAYLOAD_BYTES:
        raise rtc.RpcError._built_in(rtc.RpcError.ErrorCode.RESPONSE_PAYLOAD_TOO_LARGE)
    return answered


def _test_endpoint_socket(addr_info: tuple[object, ...]) -> socket.socket:
    """Let the local contract server stand in for a public endpoint in tests."""
    family, kind, protocol, _canonical_name, _sockaddr = addr_info
    return socket.socket(family=family, type=kind, proto=protocol)  # type: ignore[arg-type]


class RoomStubBackend(LiveKitRoomBackend):
    """The real room driver, with the calls it makes of a LiveKit answered
    here: making the room, dispatching into it, joining it, deleting it.

    The token request is deliberately not among them: a connection that
    asks an endpoint for one really asks, over a socket, of the fake
    endpoint in :mod:`token_endpoint_stub`. So what CI proves about the
    request egma sends and the answers it will take is proved about the
    driver's own HTTP code rather than about a stand-in for it.
    """

    def __init__(self, stub: RoomStub, **built: object) -> None:
        settings = built.get("settings")
        if isinstance(settings, RoomSettings) and settings.token_endpoint.startswith(
            "https://127.0.0.1:"
        ):
            built["settings"] = replace(
                settings,
                token_endpoint=settings.token_endpoint.replace(
                    "https://", "http://", 1
                ),
            )
        super().__init__(**built)
        self.stub = stub
        self.agent_is_coming = False

    def _endpoint_connector(self, aiohttp: Any, resolver: Any) -> tuple[Any, Any]:
        """Reach this test's loopback HTTP server after production parsing.

        This override is the explicit test-only exception to the production
        connector's public-address and TLS policy. The request and response
        still cross a real socket; the fake supplies only the network edge.
        """
        connector = aiohttp.TCPConnector(
            resolver=resolver,
            socket_factory=_test_endpoint_socket,
            use_dns_cache=False,
        )
        return resolver, connector

    @property
    def endpoint_dispatches(self) -> bool:
        """Whether getting the agent in was somebody else's job."""
        return not self._settings.mints_its_own

    # -- Where the driver reaches a LiveKit, and this stands in for one -------

    async def _asked(self, request: object, what_failed: str) -> None:
        """The requests the driver really built, answered here instead."""
        await answered_from_the_script(self, request, what_failed)

    def _joined_room(self, way_in: object) -> StubRoom:
        # Recorded rather than used: what a real join would have been
        # handed is the only way to see that a token fetched from an
        # endpoint, and the server URL that answer named, are what egma
        # really went to the room with.
        self.stub.joined_with.append(way_in)
        room = StubRoom(self)
        self.stub.joined_rooms.append(room)
        return room

    async def _delete_room(self) -> None:
        self.stub.deleted.append(self.room_name)


# -- What a scripted LiveKit does with each request --------------------------
#
# Written once and used by both fakes, because it is one behaviour: the
# room and the dispatch are the same two requests whether the exchange in
# the room will be spoken or typed, and a second copy of the refusals and
# the record-keeping would be a second thing to keep true.


async def answered_from_the_script(
    driver: Any, request: object, what_failed: str
) -> None:
    """The requests the driver really built, answered from a script."""
    from livekit import api

    if isinstance(request, api.CreateRoomRequest):
        _room_asked_for(driver, request, what_failed)
    else:
        _agent_asked_for(driver, request, what_failed)


def _room_asked_for(driver: Any, request: Any, what_failed: str) -> None:
    if driver.stub.refuses_room is not None:
        raise platform_refusal(
            what_failed, "invalid_argument", driver._quotable(driver.stub.refuses_room)
        )
    driver.stub.rooms.append(CreatedRoom(name=request.name, metadata=request.metadata))


def _agent_asked_for(driver: Any, request: Any, what_failed: str) -> None:
    if driver.stub.refuses_dispatch is not None:
        raise platform_refusal(
            what_failed, "not_found", driver._quotable(driver.stub.refuses_dispatch)
        )
    driver.stub.dispatches.append(
        Dispatch(
            room=request.room,
            agent_name=request.agent_name,
            metadata=request.metadata,
        )
    )
    if not driver.stub.agent_joins:
        return
    driver.agent_is_coming = True
    room = driver._room
    if room is not None:
        room.agent_arrives()


@dataclass
class RoomStub:
    """One scripted LiveKit, and the record of what it was asked for."""

    greeting: str | None = None
    replies: list[str] = field(default_factory=list)
    answer_delay_seconds: float = 0.0
    hangs_up_after_replies: bool = False
    agent_joins: bool = True
    agent_publishes_audio: bool = True
    refuses_room: str | None = None
    refuses_dispatch: str | None = None
    refuses_rpc: str | None = None
    """A participant that will not take the mock-tool methods at all — the
    one refusal that must cost the exchange and nothing else."""

    rooms: list[CreatedRoom] = field(default_factory=list)
    """Every room this LiveKit was asked to make, in order."""

    dispatches: list[Dispatch] = field(default_factory=list)
    """Every agent it was asked to put in one, in order. One per room that
    was made, because egma dispatches explicitly and always."""

    deleted: list[str] = field(default_factory=list)
    """Every room it was asked to delete, in order. Empty is what a
    connection with no power to delete looks like from the server's side:
    egma left, and the room's own empty timeout closes it."""

    joined_with: list[object] = field(default_factory=list)
    """The token and server URL egma really went into each room with."""

    transports: list[ScriptedTransport] = field(default_factory=list)
    """The Pipecat transport built for every room that was joined."""

    backends: list[RoomStubBackend] = field(default_factory=list)

    joined_rooms: list[StubRoom] = field(default_factory=list)
    """Every room egma joined, in order — where the exchange's other side
    knocks."""

    standing_ready: asyncio.Event = field(default_factory=asyncio.Event)
    """Set once egma has offered the exchange in the room.

    What a session waits for before it says hello — the same thing that
    really decides it on a live room, where an agent's side finds egma by
    the identity in its dispatch metadata or finds nobody at all."""

    def driver(self, **built: object) -> RoomStubBackend:
        """The factory a plug is handed, in place of the real driver."""
        backend = RoomStubBackend(self, **built)
        self.backends.append(backend)
        return backend

    # -- The agent's side of the mock-tool exchange ---------------------------
    #
    # What a session in this room would say to egma, said in a line. It is
    # deliberately thin: everything below builds the payload the exchange
    # documents and hands it to the room, so what a test proves is proved
    # about egma's answers rather than about a helper's cleverness.

    @property
    def room(self) -> StubRoom:
        """The room egma joined. One simulation joins exactly one."""
        return self.joined_rooms[-1]

    async def says_hello(
        self,
        *tools: str,
        schemas: dict[str, object] | None = None,
        protocol_version: int = PROTOCOL_VERSION,
    ) -> dict:
        """The census: every tool the agent has, and what egma answers for."""
        return json.loads(
            await self.room.perform_rpc(
                HELLO_METHOD,
                json.dumps(
                    {
                        "protocol_version": protocol_version,
                        "tools": [
                            {"name": name, "schema": (schemas or {}).get(name, {})}
                            for name in tools
                        ],
                    }
                ),
            )
        )

    async def calls(self, name: str, arguments: dict | None = None) -> dict:
        """One tool call, asked of egma and answered by it."""
        asked: dict = {"name": name}
        if arguments is not None:
            asked["arguments"] = arguments
        return json.loads(await self.room.perform_rpc(TOOL_METHOD, json.dumps(asked)))


# -- The same room, carrying typing ------------------------------------------


@dataclass(frozen=True)
class TypedTurn:
    """One persona turn egma really typed into the room, and where."""

    topic: str
    text: str


class StubLocalParticipant:
    """Egma's own participant, as much of one as a typed room needs.

    Two things go through it and both are the driver's own calls: the
    mock-tool methods, already wrapped by the driver in
    :func:`egma_simulator.media.room.answering`, and the persona's turn on
    the chat topic. So what a test proves about either is proved about the
    code, and the topic recorded below is the topic that would have gone
    on the wire.
    """

    def __init__(self, room: StubTextRoom) -> None:
        self._room = room
        self.methods: dict[str, Any] = {}

    def register_rpc_method(self, method: str, handler: Any) -> None:
        refusal = self._room.stub.refuses_rpc
        if refusal is not None:
            raise RuntimeError(refusal)
        self.methods[method] = handler
        self._room.stub.standing_ready.set()

    async def send_text(self, text: str, *, topic: str) -> None:
        self._room.persona_typed(topic, text)


class StubLocalRoom:
    """What ``rtc.Room`` is to the text room: a participant, and a way out."""

    def __init__(self, participant: StubLocalParticipant) -> None:
        self.local_participant = participant
        self.left = False

    async def disconnect(self) -> None:
        self.left = True


class StubTextRoom(TextRoom):
    """The real text room, with the LiveKit under it answered here.

    Only the join is stood in for, and everything a chat test then walks
    is the driver's own code: reading each utterance to its close,
    dropping egma's own words, waiting out the quiet period, deciding
    where a turn ends, and offering the mock-tool methods on egma's
    participant. What is scripted is only what the agent does.
    """

    def __init__(self, backend: ChatRoomStubBackend, **built: Any) -> None:
        super().__init__(**built)
        self._backend = backend
        self._replies: list[str | list[str]] = list(backend.stub.replies)
        self._speaking: asyncio.Task[None] | None = None
        self.who_arrived: list[str] = []

    @property
    def stub(self) -> ChatStub:
        return self._backend.stub

    async def join(self) -> None:
        """Enter the room, with nothing under it but this script."""
        self._room = StubLocalRoom(StubLocalParticipant(self))
        if self._backend.agent_is_coming:
            self.agent_arrives()

    async def leave(self) -> None:
        """Stop the agent mid-sentence, then leave the driver's own way."""
        speaking, self._speaking = self._speaking, None
        if speaking is not None and not speaking.done():
            speaking.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await speaking
        await super().leave()

    async def perform_rpc(self, method: str, payload: str) -> str:
        """Call a method on egma's participant, the way the transport does."""
        return await performed(self._room.local_participant.methods, method, payload)

    # -- The agent's side of the exchange -------------------------------------

    def agent_arrives(self) -> None:
        """The worker turns up, and says its piece if it has one."""
        if AGENT_IDENTITY in self.who_arrived:
            return
        self.who_arrived.append(AGENT_IDENTITY)
        self.arrivals.set()
        if self.stub.agent_publishes_audio_track:
            self.audio_published.set()
        if self.stub.greeting is not None:
            self._agent_says(self.stub.greeting)

    def persona_typed(self, topic: str, text: str) -> None:
        """Egma's turn arrives, and the agent takes its next one."""
        self.stub.typed.append(TypedTurn(topic=topic, text=text))
        if self._replies:
            self._agent_says(self._replies.pop(0))
        elif self.stub.hangs_up_after_replies:
            self.ended.set()

    def _agent_says(self, turn: str | list[str]) -> None:
        said = [turn] if isinstance(turn, str) else list(turn)
        self._speaking = asyncio.create_task(
            self._speaks(said), name="chat-room-stub-turn"
        )

    async def _speaks(self, turn: list[str]) -> None:
        """One turn, in however many utterances the script gives it.

        The gaps are really waited out rather than declared, because the
        thing under test is a rule about time: a pause inside a turn that
        the driver did not wait through would end the turn early, and a
        script that only claimed to pause could never catch that.
        """
        if self.stub.answer_delay_seconds:
            await asyncio.sleep(self.stub.answer_delay_seconds)
        for spoken, said in enumerate(turn):
            if spoken and self.stub.pause_seconds:
                await asyncio.sleep(self.stub.pause_seconds)
            self.utterances.put_nowait(
                Utterance(text=said, spoken=self.stub.marks_speech)
            )
        if not self._replies and self.stub.hangs_up_after_replies:
            self.ended.set()


class ChatRoomStubBackend(LiveKitChatRoomBackend):
    """The real chat driver, with the calls it makes of a LiveKit answered
    here: making the room, dispatching into it, and deleting it.

    Three where the voice fake stands in for four. A chat connection never
    asks a customer's endpoint for a token, because chat is refused on
    that access variant — egma holds no key pair there, so it could
    neither dispatch the worker nor tell it to go text-only.
    """

    def __init__(self, stub: ChatStub, **built: object) -> None:
        super().__init__(**built)
        self.stub = stub
        self.agent_is_coming = False

    async def _asked(self, request: object, what_failed: str) -> None:
        """The requests the driver really built, answered here instead."""
        await answered_from_the_script(self, request, what_failed)

    def _joined_room(self, way_in: object) -> StubTextRoom:
        # Recorded rather than used, exactly as the voice fake records it:
        # what a real join would have been handed is the only way to see
        # what egma really went into the room with.
        self.stub.joined_with.append(way_in)
        room = StubTextRoom(
            self,
            url=way_in.url,
            token=way_in.token,
            room_name=self.room_name,
            quotable=self._quotable,
        )
        self.stub.joined_rooms.append(room)
        return room

    async def _delete_room(self) -> None:
        self.stub.deleted.append(self.room_name)


@dataclass
class ChatStub:
    """One scripted LiveKit carrying typing, and the record of what it was
    asked for.

    The script and the record are the voice fake's wherever they are the
    same fact about the same room, and its own only where chat really
    differs — which is what the agent does, never what egma does.
    """

    greeting: str | None = None
    """What the agent types the moment it is in the room. Absent: it joins
    and says nothing, and the persona opens."""

    replies: list[str | list[str]] = field(default_factory=list)
    """The agent's turns, in order, one per persona turn. A string is a
    turn that arrived whole; a list is a turn that arrived in pieces, which
    is what an agent that says a filler and then answers really sends."""

    answer_delay_seconds: float = 0.0
    """How long the agent is quiet before it starts a turn."""

    pause_seconds: float = 0.0
    """The gap inside a turn, between two of its utterances — the tool-call
    pause, and the whole reason a turn does not end at the first close."""

    hangs_up_after_replies: bool = False
    """When true, the agent's participant leaves once its last reply has
    been typed, which is what an agent ending the exchange looks like."""

    agent_joins: bool = True
    """False for the worker that never comes."""

    agent_publishes_audio_track: bool = False
    """True for the agent that never took the chat setup and is speaking.
    Reaches egma as a track appearing in the room, before a word is said."""

    marks_speech: bool = False
    """True for the same agent reaching egma the other way: its words
    carrying LiveKit's transcribed-track mark. Either one alone is enough,
    so they are scripted apart."""

    refuses_room: str | None = None
    refuses_dispatch: str | None = None
    refuses_rpc: str | None = None

    rooms: list[CreatedRoom] = field(default_factory=list)
    dispatches: list[Dispatch] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    joined_with: list[object] = field(default_factory=list)
    backends: list[ChatRoomStubBackend] = field(default_factory=list)
    joined_rooms: list[StubTextRoom] = field(default_factory=list)

    typed: list[TypedTurn] = field(default_factory=list)
    """Every persona turn egma really typed, with the topic it went on."""

    standing_ready: asyncio.Event = field(default_factory=asyncio.Event)
    """Set once egma has offered the mock-tool exchange in the room."""

    def driver(self, **built: object) -> ChatRoomStubBackend:
        """The factory a plug is handed, in place of the real driver."""
        backend = ChatRoomStubBackend(self, **built)
        self.backends.append(backend)
        return backend

    # -- The agent's side of the mock-tool exchange ---------------------------

    @property
    def room(self) -> StubTextRoom:
        """The room egma joined. One simulation joins exactly one."""
        return self.joined_rooms[-1]

    async def says_hello(
        self,
        *tools: str,
        schemas: dict[str, object] | None = None,
        protocol_version: int = PROTOCOL_VERSION,
    ) -> dict:
        """The census: every tool the agent has, and what egma answers for."""
        return json.loads(
            await self.room.perform_rpc(
                HELLO_METHOD,
                json.dumps(
                    {
                        "protocol_version": protocol_version,
                        "tools": [
                            {"name": name, "schema": (schemas or {}).get(name, {})}
                            for name in tools
                        ],
                    }
                ),
            )
        )

    async def calls(self, name: str, arguments: dict | None = None) -> dict:
        """One tool call, asked of egma and answered by it."""
        asked: dict = {"name": name}
        if arguments is not None:
            asked["arguments"] = arguments
        return json.loads(await self.room.perform_rpc(TOOL_METHOD, json.dumps(asked)))
