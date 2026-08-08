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

The script it is built with:

- ``greeting`` — what the agent says the moment it is in the room.
  Absent: it joins and says nothing, and the persona speaks first.
- ``replies`` — the agent's answers, in order, one per persona turn. A
  spent script answers with quiet, the way a room with nobody talking in
  it really sounds.
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
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from egma_simulator.media.livekit_room import LiveKitRoomBackend, platform_refusal
from egma_simulator.media.scripted import ScriptedSession

AGENT_IDENTITY = "agent-under-test"
"""Who the agent is in the room, once its worker turns up."""


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
    """The room itself: who is in it, and what can be heard in it."""

    def __init__(self, backend: RoomStubBackend, *, band_hz: int) -> None:
        self._backend = backend
        self._band_hz = band_hz
        self._session: StubSession | None = None
        self._joined = False
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
            session.say(
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
        return StubRoom(self, band_hz=self._band_hz)

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
        """Queue the answer to one delivered persona turn.

        A spent script answers with quiet rather than a holding line: a
        room where nobody has anything left to say is a room where nobody
        is talking, and the plug reads exactly that.
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

    def driver(self, **built: object) -> RoomStubBackend:
        """The factory a plug is handed, in place of the real driver."""
        backend = RoomStubBackend(self, **built)
        self.backends.append(backend)
        return backend
