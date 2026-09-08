"""Offline LiveKit room fixtures using the real drivers above their network methods.
Record room, dispatch, deletion, and RPC requests. Token requests still use
the local HTTP server in token_endpoint_stub.

Voice scripts control greetings, replies, audio delays, arrival order, hang-up,
and room/dispatch/join/RPC refusals. They exercise real setup and ending logic.
Chat scripts feed streams through registered handlers, including multi-utterance
turns, ClosesLate readers, pauses, state changes, and accidental audio output.
This preserves production stream ownership and turn-completion code in tests.
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
    AGENT_STATE_ATTRIBUTE,
    SPOKEN_TRACK_ATTRIBUTE,
    TRANSCRIPTION_TOPIC,
    LiveKitChatRoomBackend,
    LiveKitRoomBackend,
    RoomSettings,
    TextRoom,
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
    caller_identity: str = AGENT_IDENTITY


@dataclass(frozen=True)
class CreatedRoom:
    """One room this LiveKit was asked to make, and what it carries.

    ``metadata`` is here to be read as empty: egma writes on the dispatch
    and never on the room, and a field nobody records is a field no test
    can hold that to.
    """

    name: str
    metadata: str


@dataclass(frozen=True)
class Dispatch:
    """One agent this LiveKit was asked to put in a room.

    ``metadata`` is the test's own ``job_dispatch_metadata``, serialised
    by the driver — the exact string a worker would read out of
    ``ctx.job.metadata``.
    """

    room: str
    agent_name: str
    metadata: str


class StubRoom:
    """Stub participants, audio, and RPC transport while using the driver's handlers.
    Refuse unregistered methods and oversized messages at the transport boundary.
    """

    def __init__(self, backend: RoomStubBackend) -> None:
        self._backend = backend
        self._transport: ScriptedTransport | None = None
        self._activation: asyncio.Task[None] | None = None
        self._state_task: asyncio.Task[None] | None = None
        self._joined = False
        self._methods: dict[str, object] = {}
        self._offer: object = None
        self._offering_at_the_join = False
        self.arrivals = asyncio.Event()
        self.carrying_audio = asyncio.Event()
        self.ended = asyncio.Event()
        self.failed = asyncio.Event()
        self.who_arrived: list[str] = []
        self._startup: Any = None

    def answer_when_joined(self, offer: object) -> None:
        """Take the driver's offer to answer for the agent's tools."""
        self._offer = offer

    def watch_startup(self, startup: Any) -> None:
        self._startup = startup

    def note_anybody_already_here(self) -> None:
        """Answer the driver's one question: is somebody in here already?

        The real room asks its transport; this one knows. Both answer the
        same question for the same reason — a participant that was in the
        room before egma got into it is never announced as an arrival, so
        an agent that was quicker would otherwise be waited out and
        reported as a worker that never came.
        """
        if self.who_arrived:
            self.arrivals.set()

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
        self.failed = self._transport.media.failed
        stub.transports.append(self._transport)
        # Entering the room is the moment the driver offers to answer for
        # the agent's tools, and it is offered here rather than later for
        # one reason: the agent can already be in the room. Modelled in
        # that order so nothing below can pass against an ordering the
        # real room does not have.
        self._offering_at_the_join = True
        try:
            if self._offer is not None:
                self._offer()
        finally:
            self._offering_at_the_join = False
        # Where egma minted its own token, the worker is on its way because
        # egma asked for it. Where it did not, nobody asked and nobody
        # could: the endpoint that minted the token is what dispatches, so
        # from the room's side the agent simply turns up — or does not.
        if self._backend.endpoint_dispatches:
            self._backend.agent_is_coming = stub.agent_joins
        if self._backend.agent_is_coming:
            self.agent_arrives(announced=not stub.agent_was_already_in_the_room)
        return self._transport.media

    async def wait_connected(self) -> None:
        """The local room is connected as soon as its processors exist —
        unless this LiveKit will not take the way in it was offered.

        A token that opens one room once is refused the second time and
        after it has waited too long, and what egma sees then is a room it
        cannot get into. The refusal is built by the driver's own
        :func:`platform_refusal`, so the sentence a person reads is
        production's rather than this file's.
        """
        refusal = self._backend.stub.refuses_join
        if refusal is not None:
            raise platform_refusal(
                "the room could not be joined",
                "permission_denied",
                self._backend.quotable(refusal),
            )
        return None

    async def leave(self) -> None:
        if self._transport is not None:
            self._transport.stop()
        reporting = self._backend.stub.reporting
        if reporting is not None and not reporting.done():
            reporting.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reporting
        if self._state_task is not None and not self._state_task.done():
            self._state_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._state_task
        if self._activation is not None and not self._activation.done():
            self._activation.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._activation
        self._transport = None
        self._joined = False
        self.ended.set()

    # -- The room's other channel: what can be called in it -------------------

    def register_rpc(
        self,
        method: str,
        handler: object,
        *,
        on_attempt: Any = None,
        on_accepted: Any = None,
        on_refused: Any = None,
    ) -> None:
        """Offer one method on egma's participant, the driver's own way.

        The handler is wrapped by :func:`egma_simulator.media.room.answering`
        — the very wrapper the real room registers — so what a refusal
        becomes on the wire is proved here about the code a customer's
        server runs, rather than about a second conversion written beside
        it.
        """
        refusal = self._backend.stub.refuses_rpc
        if method == self._backend.stub.refuses_rpc_method:
            refusal = f"{method} registration failed"
        if refusal is None and self._offering_at_the_join:
            refusal = self._backend.stub.refuses_the_offer_at_the_join
        if refusal is not None:
            raise RuntimeError(refusal)
        self._methods[method] = answering(
            handler,
            on_attempt=on_attempt,
            on_accepted=on_accepted,
            on_refused=on_refused,
        )
        self._backend.stub.standing_ready.set()

    async def perform_rpc(self, method: str, payload: str) -> str:
        """Call a method on egma's participant, the way the transport does."""
        return await performed(self._methods, method, payload)

    async def _reports(self) -> None:
        """Wait for RPC registration, then send an empty hello for startup.
        Tests of tool discovery send their own census, which replaces this one.
        """
        await self._backend.stub.standing_ready.wait()
        if self._backend.stub.report_delay_seconds:
            await asyncio.sleep(self._backend.stub.report_delay_seconds)
        with contextlib.suppress(Exception):
            await self.perform_rpc(
                HELLO_METHOD,
                json.dumps({"protocol_version": PROTOCOL_VERSION, "tools": []}),
            )
            self._backend.stub.report_complete.set()

    def agent_arrives(self, *, announced: bool = True) -> None:
        """Add the worker and optional audio. With announced=False, omit the arrival
        event to test discovery of a participant present before Egma joined.
        """
        if AGENT_IDENTITY in self.who_arrived:
            return
        self.who_arrived.append(AGENT_IDENTITY)
        if announced:
            self.arrivals.set()
        transport = self._transport
        stub = self._backend.stub
        if self._startup is not None:
            self._startup.participant_seen(AGENT_IDENTITY)
            if stub.agent_state_at_start is not None:
                if stub.release_initial_state is None:
                    self._startup.participant_state(
                        AGENT_IDENTITY, stub.agent_state_at_start
                    )
                else:
                    self._state_task = asyncio.create_task(
                        self._publishes_initial_state(),
                        name="room-stub-initial-state",
                    )
        if stub.agent_reports:
            # The Egma SDK sends its hello as the session starts, which is
            # before the first word anybody hears. A worker in the room
            # that never says it is a worker with no SDK in it, and that
            # is now a failed simulation rather than a quiet one — so the
            # ordinary stub says hello and the test that wants the failure
            # turns it off.
            stub.reporting = asyncio.create_task(
                self._reports(), name="room-stub-hello"
            )
        if transport is None or not stub.agent_publishes_audio:
            return
        self.carrying_audio.set()
        if self._startup is not None:
            self._startup.participant_audio(AGENT_IDENTITY)
        self._activation = asyncio.create_task(
            transport.activate(), name="room-stub-transport"
        )

    async def _publishes_initial_state(self) -> None:
        release = self._backend.stub.release_initial_state
        if release is not None:
            await release.wait()
        state = self._backend.stub.agent_state_at_start
        if self._startup is not None and state is not None:
            self._startup.participant_state(AGENT_IDENTITY, state)


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


class PublicNameResolver:
    """Resolve test hostnames to a public address so server validation runs normally.
    The literal loopback token endpoint bypasses DNS. Refusal tests inject a resolver.
    """

    async def resolve(
        self, host: str, port: int = 0, family: int = socket.AF_UNSPEC
    ) -> list[dict[str, object]]:
        del family
        return [
            {
                "hostname": host,
                "host": "93.184.216.34",
                "port": port,
                "family": socket.AF_INET,
                "proto": socket.IPPROTO_TCP,
                "flags": socket.AI_NUMERICHOST,
            }
        ]

    async def close(self) -> None:
        return None


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
        if built.get("endpoint_resolver") is None:
            built["endpoint_resolver"] = PublicNameResolver()
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
        """Whether getting the agent in was somebody else's job.

        True for both shapes that were handed a token: egma holds no key
        pair, so the agent arrives because whoever minted the token put it
        there, or does not arrive at all.
        """
        return not self._settings.mints_its_own

    def quotable(self, told: str) -> str:
        """The driver's own scrubbing, reachable from the room beside it."""
        return self._quotable(told)

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
    agent_reports: bool = True
    """Whether the worker in this room has the Egma SDK in it.

    False for the worker that joins, talks and never says ``egma.hello``:
    a simulation that isolated nothing and would otherwise look like one
    that did. The ordinary worker reports, so the ordinary stub does."""
    report_delay_seconds: float = 0.0
    """How long SDK setup takes before its configuration exchange reaches Egma."""
    agent_state_at_start: str | None = "listening"
    """Native LiveKit session state published once session startup completes."""
    release_initial_state: asyncio.Event | None = None
    """Optional gate that holds native session readiness after hello."""
    reporting: asyncio.Task | None = None
    """The hello in flight, held so a test can wait for it."""
    report_complete: asyncio.Event = field(default_factory=asyncio.Event)
    """Set after the ordinary SDK hello is accepted."""
    agent_was_already_in_the_room: bool = False
    """True for the worker that got in before egma did.

    The ordinary case wherever egma is not the one dispatching: nothing
    egma does decides when that worker is given the room, so it can be
    sitting in it, publishing, before egma's transport connects. The room
    then announces nobody — being there first is not an arrival — and a
    driver that only waits for arrivals waits the whole budget out and
    calls a present agent a worker that never came."""
    refuses_room: str | None = None
    refuses_dispatch: str | None = None
    refuses_join: str | None = None
    """A LiveKit that will not take the way in it was offered — a token
    already spent, or one that waited too long to be used."""
    refuses_rpc: str | None = None
    """A participant that will not take the mock-tool methods at all — the
    one refusal that must cost the exchange and nothing else."""

    refuses_the_offer_at_the_join: str | None = None
    """A participant that will not take them at the join, and will after.

    The driver offers at the join because the agent may already be in the
    room, and again from ``dial`` for a room that has no such moment. This
    is the room where the first of those two does not take: the second is
    the only offer left, so what it costs to spend it on nothing is every
    mocked tool in the simulation running its own implementation."""
    refuses_rpc_method: str | None = None
    """One method that the participant refuses while accepting the other."""

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

    What a session waits for before it says hello. On a live room the
    agent's side has no such event: it finds egma by the persona identity
    in a room whose name says a simulation is running, and a room with no
    such participant answers nothing. Which is why the driver offers the
    methods at the join and not a step later — the far side may already
    be knocking."""

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
        if method == self._room.stub.refuses_rpc_method:
            refusal = f"{method} registration failed"
        if refusal is not None:
            raise RuntimeError(refusal)
        self.methods[method] = handler
        self._room.stub.standing_ready.set()

    async def send_text(self, text: str, *, topic: str) -> None:
        self._room.persona_typed(topic, text)


class StubLocalRoom:
    """What ``rtc.Room`` is to the text room: a participant, a way out, and
    every handler the driver registered on it.

    The handlers are kept rather than ignored because they are the wire:
    what LiveKit hands each event, and in what order, is the one thing a
    fake cannot derive from the driver, and a script that reached past
    them would prove nothing about the unpacking each one does.
    """

    def __init__(self, participant: StubLocalParticipant) -> None:
        self.local_participant = participant
        self.left = False
        self.handlers: dict[str, Any] = {}
        """Every ``room.on`` handler, under the event name it answers."""
        self.text_streams: dict[str, Any] = {}
        """Every text-stream handler, under the topic it reads."""

    def on(self, event: str) -> Any:
        """``rtc.Room.on``, which is a decorator that keeps the handler."""

        def keep(handler: Any) -> Any:
            self.handlers[event] = handler
            return handler

        return keep

    def register_text_stream_handler(self, topic: str, handler: Any) -> None:
        self.text_streams[topic] = handler

    def unregister_text_stream_handler(self, topic: str) -> None:
        self.text_streams.pop(topic, None)

    def off(self, event: str, handler: Any) -> None:
        if self.handlers.get(event) is handler:
            self.handlers.pop(event)

    async def disconnect(self) -> None:
        self.left = True


class StubParticipant:
    """What the attributes event carries beside the attributes.

    A participant object and never an identity string, because the driver
    reads the identity off it: a fake that handed over the string already
    would be doing the driver's work and proving its own.
    """

    def __init__(
        self, identity: str, attributes: dict[str, str] | None = None
    ) -> None:
        self.identity = identity
        self.sid = f"PA_{identity}"
        self.attributes = attributes or {}
        self.track_publications: dict[str, object] = {}


@dataclass(frozen=True)
class ClosesLate:
    """One utterance whose stream opens with its turn and closes after it.

    The shape a queue of finished utterances cannot express and the one a
    real agent produces all the time: the header is on the wire and
    stamped, and the words are still being written. Scripted with a delay
    rather than an event so a test can place the close on either side of
    the wait it is testing — inside it, where the words are still the
    turn's, or beyond every bound, where they are lost and said to be.
    """

    text: str
    closes_after_seconds: float


Scripted = str | ClosesLate | list[str | ClosesLate]
"""One scripted agent turn: one utterance, or several in order."""


class ScriptedStreamInfo:
    """What a text stream's header carries, as much as egma reads of it."""

    def __init__(self, attributes: dict[str, str]) -> None:
        self.attributes = attributes
        self.topic = TRANSCRIPTION_TOPIC


class ScriptedStream:
    """One transcription stream, opened by the scripted agent.

    Read by the driver's own reader task, so the stamping at the header,
    the strip at the close, the drop of egma's own words and the line in
    the log about a stream that never closed are all real code under test.
    """

    def __init__(
        self, said: str, *, spoken: bool, closes_after_seconds: float = 0.0
    ) -> None:
        self.info = ScriptedStreamInfo(
            {SPOKEN_TRACK_ATTRIBUTE: "TR_0001"} if spoken else {}
        )
        self._said = said
        self._closes_after_seconds = closes_after_seconds
        self.closed = asyncio.Event()
        """Set where the wire would send the trailer. What a script waits
        on to place the agent's state after its words, the way a session
        produces them."""

    async def read_all(self) -> str:
        if self._closes_after_seconds:
            await asyncio.sleep(self._closes_after_seconds)
        self.closed.set()
        return self._said


class StubTextRoom(TextRoom):
    """Real chat-room handlers with a stubbed LiveKit connection.
    Script agent events through those handlers to exercise stream ownership,
    reading, state changes, and RPC registration.
    """

    def __init__(self, backend: ChatRoomStubBackend, **built: Any) -> None:
        super().__init__(**built)
        self._backend = backend
        self._replies: list[Scripted] = list(backend.stub.replies)
        self._speaking: asyncio.Task[None] | None = None
        self._stating: set[asyncio.Task[None]] = set()
        self._published_state: str | None = None
        """The last state this agent really published. Only a change
        travels the wire, so only a change goes out from here."""
        self.who_arrived: list[str] = []

    @property
    def stub(self) -> ChatStub:
        return self._backend.stub

    async def join(self) -> None:
        """Enter the room, with nothing under it but this script."""
        room = StubLocalRoom(StubLocalParticipant(self))
        # The driver's own registration, run here rather than stood in
        # for: what a script fires below is the handler a real room fires,
        # taking what a real room hands it.
        self._watch(room)
        self._room = room
        # Where egma minted its own token, the worker is on its way because
        # egma asked for it. Where a customer's endpoint minted it, the
        # endpoint dispatches the worker egma named, so from the room's side
        # the agent simply turns up — or does not — exactly as in the voice
        # fake.
        if self._backend.endpoint_dispatches:
            self._backend.agent_is_coming = self.stub.agent_joins
        if self._backend.agent_is_coming:
            self.agent_arrives()

    async def leave(self) -> None:
        """Stop the agent mid-sentence, then leave the driver's own way."""
        speaking, self._speaking = self._speaking, None
        stating, self._stating = self._stating, set()
        for running in (speaking, *stating, self.stub.reporting):
            if running is not None and not running.done():
                running.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await running
        await super().leave()

    async def perform_rpc(self, method: str, payload: str) -> str:
        """Call a method on egma's participant, the way the transport does."""
        return await performed(self._room.local_participant.methods, method, payload)

    async def _reports(self) -> None:
        """The hello an ordinary worker's SDK sends, once egma is listening.

        An empty census, for the voice stub's reason: what the plug reads
        is that a hello arrived at all, and a test that cares which tools
        were reported sends its own.
        """
        await self.stub.standing_ready.wait()
        if self.stub.report_delay_seconds:
            await asyncio.sleep(self.stub.report_delay_seconds)
        with contextlib.suppress(Exception):
            await self.perform_rpc(
                HELLO_METHOD,
                json.dumps({"protocol_version": PROTOCOL_VERSION, "tools": []}),
            )
            self.stub.report_complete.set()

    # -- The agent's side of the exchange -------------------------------------

    def agent_arrives(self) -> None:
        """The worker turns up, and says its piece if it has one."""
        if AGENT_IDENTITY in self.who_arrived:
            return
        self.who_arrived.append(AGENT_IDENTITY)
        self.arrivals.set()
        if self._startup is not None:
            self._startup.participant_seen(AGENT_IDENTITY)
        if self.stub.agent_reports:
            # The same hello an ordinary worker's SDK sends in a voice
            # room. A chat room is a LiveKit simulation too — same verb,
            # same exchange — so a worker with no SDK in it fails a chat
            # simulation exactly as it fails a spoken one.
            self.stub.reporting = asyncio.create_task(
                self._reports(), name="chat-room-stub-hello"
            )
        if self.stub.agent_publishes_audio_track:
            self.audio_published.set()
        # A session announces itself the moment it starts, which is before
        # it has greeted anybody. Scripted here rather than with the
        # greeting's own states for exactly that reason: the state that
        # arrives here means ready, and a rule that read it as finished
        # would end the greeting before the agent said a word.
        if self.stub.agent_state_at_start is not None:
            if self.stub.release_initial_state is None:
                if self._startup is not None:
                    self._startup.participant_state(
                        AGENT_IDENTITY, self.stub.agent_state_at_start
                    )
            else:
                stating = asyncio.create_task(
                    self._publishes_initial_state(),
                    name="chat-room-stub-initial-state",
                )
                self._stating.add(stating)
                stating.add_done_callback(self._stating.discard)
        if self.stub.greeting is not None:
            self._agent_says(self.stub.greeting)

    async def _publishes_initial_state(self) -> None:
        release = self.stub.release_initial_state
        if release is not None:
            await release.wait()
        state = self.stub.agent_state_at_start
        if self._startup is not None and state is not None:
            self._startup.participant_state(AGENT_IDENTITY, state)

    def agent_publishes_state(self, state: str) -> None:
        """Emit only changed state through participant_attributes_changed.
        Pass attributes first and participant second, matching the real event signature.
        """
        if state == self._published_state:
            return
        self._published_state = state
        self._room.handlers["participant_attributes_changed"](
            {AGENT_STATE_ATTRIBUTE: state}, StubParticipant(AGENT_IDENTITY)
        )

    def persona_typed(self, topic: str, text: str) -> None:
        """Egma's turn arrives, and the agent takes its next one."""
        first = not self.stub.typed
        self.stub.typed.append(TypedTurn(topic=topic, text=text))
        late_greeting = self.stub.greeting_during_first_send
        if first and late_greeting is not None:
            # The stream's header lands while the send is still resolving,
            # so the stamp is whatever the counter says mid-send — which
            # is the greeting era, because the turn has not begun yet.
            self._agent_said(
                ScriptedStream(late_greeting, spoken=self.stub.marks_speech),
                AGENT_IDENTITY,
            )
        if self._replies:
            self._agent_says(self._replies.pop(0))
        elif self.stub.hangs_up_after_replies:
            self.ended.set()

    def _agent_says(self, turn: Scripted) -> None:
        said = [turn] if isinstance(turn, (str, ClosesLate)) else list(turn)
        self._speaking = asyncio.create_task(
            self._speaks(said), name="chat-room-stub-turn"
        )

    async def _speaks(self, turn: list[str | ClosesLate]) -> None:
        """Send each scripted utterance through the stream-header handler, with real
        waits
        for pauses. This exercises open-reader tracking and turn ownership, not just a
        queue.
        """
        # Which turn the streams are stamped with is the driver's to
        # decide, at each header, exactly as on a real wire. A reply that
        # then takes longer than egma waited for it still belongs to the
        # question it started answering — which is the whole point of
        # stamping.
        if self.stub.answer_delay_seconds:
            await asyncio.sleep(self.stub.answer_delay_seconds)
        opened = self._turn
        streams: list[ScriptedStream] = []
        for spoken, said in enumerate(turn):
            if spoken and self.stub.pause_seconds:
                await asyncio.sleep(self.stub.pause_seconds)
            stream = ScriptedStream(
                said.text if isinstance(said, ClosesLate) else said,
                spoken=self.stub.marks_speech,
                closes_after_seconds=(
                    said.closes_after_seconds if isinstance(said, ClosesLate) else 0.0
                ),
            )
            streams.append(stream)
            self._agent_said(stream, AGENT_IDENTITY)
        # Scheduled rather than awaited: the state still follows this
        # turn's last close, and the departure below still does not wait
        # for it. Awaiting it here made a scripted state a barrier the
        # streams had to clear first, which quietly took the race out of
        # every test that scripted both.
        stating = asyncio.create_task(
            self._then_states(opened, streams), name="chat-room-stub-states"
        )
        self._stating.add(stating)
        stating.add_done_callback(self._stating.discard)
        # The departure does not wait for the streams to be read, because
        # on a real wire it does not: a participant's last words and its
        # leaving reach egma through one queue and the words are read in a
        # task the departure runs ahead of. That race is the whole reason
        # the driver lets a departing stream settle, and a fake that
        # queued the words first would never run it.
        if not self._replies and self.stub.hangs_up_after_replies:
            self.ended.set()

    async def _then_states(
        self, turn: int, streams: list[ScriptedStream]
    ) -> None:
        """Publish this turn's states, once its last stream has closed.

        In that order because that is the order a real session produces
        them: the words are forwarded and only then does the state go back
        to listening. A script that published the state first would be
        scripting an agent that finishes before it speaks, and would let a
        broken rule pass.
        """
        scripted = self.stub.agent_states
        if scripted is None or turn >= len(scripted):
            return
        for stream in streams:
            await stream.closed.wait()
        for state in scripted[turn]:
            self.agent_publishes_state(state)


class ChatRoomStubBackend(LiveKitChatRoomBackend):
    """The real chat driver, with the calls it makes of a LiveKit answered
    here: making the room, dispatching into it, joining it, deleting it.

    The token request is not among them, exactly as in the voice fake: a
    chat connection that asks a customer's endpoint for a token really
    asks, over a socket, of the fake endpoint in
    :mod:`token_endpoint_stub`, so the marked room name the chat driver
    asks for is proved on the driver's own HTTP code.
    """

    def __init__(self, stub: ChatStub, **built: object) -> None:
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
        if built.get("endpoint_resolver") is None:
            built["endpoint_resolver"] = PublicNameResolver()
        super().__init__(**built)
        self.stub = stub
        self.agent_is_coming = False

    def _endpoint_connector(self, aiohttp: Any, resolver: Any) -> tuple[Any, Any]:
        """Reach this test's loopback HTTP server after production parsing.

        The same explicit test-only exception the voice fake makes to the
        production connector's public-address and TLS policy.
        """
        connector = aiohttp.TCPConnector(
            resolver=resolver,
            socket_factory=_test_endpoint_socket,
            use_dns_cache=False,
        )
        return resolver, connector

    @property
    def endpoint_dispatches(self) -> bool:
        """Whether getting the agent in was somebody else's job: true where
        egma holds no key pair, so the worker it named arrives because the
        endpoint that minted the token dispatched it, or not at all."""
        return not self._settings.mints_its_own

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

    greeting: Scripted | None = None
    """What the agent types the moment it is in the room. Absent: it joins
    and says nothing, and the persona opens."""

    replies: list[Scripted] = field(default_factory=list)
    """The agent's turns, in order, one per persona turn. A string is a
    turn that arrived whole; a list is a turn that arrived in pieces, which
    is what an agent that says a filler and then answers really sends. A
    :class:`ClosesLate` in either place is an utterance whose stream opens
    with the rest of its turn and closes after them."""

    answer_delay_seconds: float = 0.0
    """How long the agent is quiet before it starts a turn."""

    greeting_during_first_send: str | None = None
    """A greeting that outran its wait and opens its stream while the
    persona's first turn is still leaving egma. On a real wire that is a
    header arriving during the send, before ``begin_turn`` has run — so
    the fake plays it synchronously inside the send, stamped with the
    turn counter exactly as it stands at that moment."""

    pause_seconds: float = 0.0
    """The gap inside a turn, between two of its utterances — the tool-call
    pause, and the whole reason a turn does not end at the first close."""

    hangs_up_after_replies: bool = False
    """When true, the agent's participant leaves once its last reply has
    been typed, which is what an agent ending the exchange looks like."""

    agent_joins: bool = True
    """False for the worker that never comes."""

    agent_reports: bool = True
    """Whether the worker in this room has the Egma SDK in it.

    False for the worker that joins, types and never says ``egma.hello``:
    a chat simulation that isolated nothing and would otherwise look like
    one that did."""

    report_delay_seconds: float = 0.0
    """How long SDK setup takes before its configuration exchange reaches Egma."""

    reporting: asyncio.Task | None = None
    """The hello in flight, held so a test can wait for it."""
    report_complete: asyncio.Event = field(default_factory=asyncio.Event)
    """Set after the ordinary SDK hello is accepted."""

    agent_publishes_audio_track: bool = False
    """True for the agent that never took the chat setup and is speaking.
    Reaches egma as a track appearing in the room, before a word is said."""

    marks_speech: bool = False
    """True for the same agent reaching egma the other way: its words
    carrying LiveKit's transcribed-track mark. Either one alone is enough,
    so they are scripted apart."""

    agent_states: list[list[str]] | None = None
    """State changes per turn, starting with the greeting, sent after its last stream
    closes.
    None publishes no states. Repeated states emit no change; ["listening"] alone
    covers coalesced transitions without thinking or speaking events.
    """

    agent_state_at_start: str | None = "listening"
    """A state published the moment the worker arrives, before any
    greeting. ``listening`` here is what a real session announces when it
    starts, and it means ready rather than finished — the one state a
    turn-end rule must not act on."""

    release_initial_state: asyncio.Event | None = None
    """Optional gate that holds native session readiness after hello."""

    refuses_room: str | None = None
    refuses_dispatch: str | None = None
    refuses_rpc: str | None = None
    refuses_rpc_method: str | None = None

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
