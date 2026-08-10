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
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field

from egma_simulator.media.livekit_room import LiveKitRoomBackend, platform_refusal
from egma_simulator.media.room import answering
from egma_simulator.media.scripted import ScriptedSession
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


class StubSession(ScriptedSession):
    """The room's audio, with the latch a room driver waits on.

    The frames, the greeting, the scripted replies and the leaving are
    the scripted media session's, unchanged — a room and a phone line
    carry a turn the same way, and writing it twice would only let the
    two drift.
    """

    def __init__(self, **built: object) -> None:
        super().__init__(**built)
        self.carrying_audio = asyncio.Event()


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

    def __init__(self, backend: RoomStubBackend, *, band_hz: int) -> None:
        self._backend = backend
        self._band_hz = band_hz
        self._session: StubSession | None = None
        self._joined = False
        self._methods: dict[str, object] = {}
        self.arrivals = asyncio.Event()
        self.who_arrived: list[str] = []

    @property
    def session(self) -> StubSession | None:
        return self._session

    @property
    def joined(self) -> bool:
        return self._joined

    async def join(self) -> StubSession:
        self._joined = True
        self._session = StubSession(
            band_hz=self._band_hz,
            delay_seconds=self._backend.stub.answer_delay_seconds,
            answered_by=self._backend.answer_to,
        )
        self._backend.stub.sessions.append(self._session)
        # Where egma minted its own token, the worker is on its way because
        # egma asked for it. Where it did not, nobody asked and nobody
        # could: the endpoint that minted the token is what dispatches, so
        # from the room's side the agent simply turns up — or does not.
        if self._backend.endpoint_dispatches:
            self._backend.agent_is_coming = self._backend.stub.agent_joins
        if self._backend.agent_is_coming:
            self.agent_arrives()
        return self._session

    async def leave(self) -> None:
        if self._session is not None:
            self._session.hang_up()
        self._session = None

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
        """Call a method on egma's participant, the way the transport does.

        Everything the transport would refuse before egma ever sees it is
        refused here for the same reasons and with the same codes: a
        method nobody registered, a request too large to carry, and a
        reply too large to carry back. What is left is the handler's own
        answer, or the handler's own refusal.
        """
        from livekit import rtc

        if len(payload.encode()) > LARGEST_PAYLOAD_BYTES:
            raise rtc.RpcError._built_in(
                rtc.RpcError.ErrorCode.REQUEST_PAYLOAD_TOO_LARGE
            )
        handler = self._methods.get(method)
        if handler is None:
            raise rtc.RpcError._built_in(rtc.RpcError.ErrorCode.UNSUPPORTED_METHOD)
        answered = await handler(RpcAsk(payload=payload))
        if len(answered.encode()) > LARGEST_PAYLOAD_BYTES:
            raise rtc.RpcError._built_in(
                rtc.RpcError.ErrorCode.RESPONSE_PAYLOAD_TOO_LARGE
            )
        return answered

    def agent_arrives(self) -> None:
        """The worker turns up, and — unless it is broken — is heard."""
        if AGENT_IDENTITY in self.who_arrived:
            return
        self.who_arrived.append(AGENT_IDENTITY)
        self.arrivals.set()
        session = self._session
        stub = self._backend.stub
        if session is None or not stub.agent_publishes_audio:
            return
        session.carrying_audio.set()
        if stub.greeting is not None:
            session.greet(
                stub.greeting,
                then_hang_up=stub.hangs_up_after_replies and not stub.replies,
            )


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
        super().__init__(**built)
        self.stub = stub
        self.agent_is_coming = False
        self._delivered = 0

    @property
    def endpoint_dispatches(self) -> bool:
        """Whether getting the agent in was somebody else's job."""
        return not self._settings.mints_its_own

    # -- Where the driver reaches a LiveKit, and this stands in for one -------

    async def _asked(self, request: object, what_failed: str) -> None:
        """The requests the driver really built, answered here instead."""
        from livekit import api

        if isinstance(request, api.CreateRoomRequest):
            self._room_asked_for(request, what_failed)
        else:
            self._agent_asked_for(request, what_failed)

    def _joined_room(self, way_in: object) -> StubRoom:
        # Recorded rather than used: what a real join would have been
        # handed is the only way to see that a token fetched from an
        # endpoint, and the server URL that answer named, are what egma
        # really went to the room with.
        self.stub.joined_with.append(way_in)
        room = StubRoom(self, band_hz=self._band_hz)
        self.stub.joined_rooms.append(room)
        return room

    async def _delete_room(self) -> None:
        self.stub.deleted.append(self.room_name)

    # -- What a scripted LiveKit does with each ------------------------------

    def _room_asked_for(self, request: object, what_failed: str) -> None:
        if self.stub.refuses_room is not None:
            raise platform_refusal(
                what_failed, "invalid_argument", self._quotable(self.stub.refuses_room)
            )
        self.stub.rooms.append(
            CreatedRoom(name=request.name, metadata=request.metadata)
        )
        if not self._settings.agent_name:
            # Automatic dispatch: a worker registered without a name is
            # given every new room in the project, so making the room
            # *was* the request and nothing more will be asked for.
            self.agent_is_coming = self.stub.agent_joins

    def _agent_asked_for(self, request: object, what_failed: str) -> None:
        if self.stub.refuses_dispatch is not None:
            raise platform_refusal(
                what_failed, "not_found", self._quotable(self.stub.refuses_dispatch)
            )
        self.stub.dispatches.append(
            Dispatch(
                room=request.room,
                agent_name=request.agent_name,
                metadata=request.metadata,
            )
        )
        if not self.stub.agent_joins:
            return
        self.agent_is_coming = True
        room = self._room
        if isinstance(room, StubRoom):
            room.agent_arrives()

    # -- The script ----------------------------------------------------------

    def answer_to(self) -> None:
        """Queue the answer to one stretch of persona speech.

        A spent script answers with quiet rather than a holding line: a
        room where nobody has anything left to say is a room where nobody
        is talking, and the conductor reads exactly that.
        """
        room = self._room
        session = room.session if isinstance(room, StubRoom) else None
        if session is None:
            return
        position = self._delivered
        self._delivered += 1
        replies = self.stub.replies
        if position >= len(replies):
            return
        session.say(
            replies[position],
            then_hang_up=(
                self.stub.hangs_up_after_replies and position == len(replies) - 1
            ),
        )


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
    """Every agent it was asked to put in one, in order. Empty is what
    automatic dispatch looks like from the server's side: nothing asked
    for, because the room itself was the request."""

    deleted: list[str] = field(default_factory=list)
    """Every room it was asked to delete, in order. Empty is what a
    connection with no power to delete looks like from the server's side:
    egma left, and the room's own empty timeout closes it."""

    joined_with: list[object] = field(default_factory=list)
    """The token and server URL egma really went into each room with."""

    sessions: list[StubSession] = field(default_factory=list)
    """The audio of every room that was joined — what a test asks when it
    wants the agent's side of the story, including every stretch of
    persona speech the room really carried."""

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
