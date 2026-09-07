"""Offline room stub for participant discovery and mock-tool RPC.

Replies are scripted by method; refusals use real LiveKit RpcError instances.
Calls are recorded in order. arrive() adds an identity and emits the arrival
event so tests can cover an agent that joins before the Egma participant.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from livekit.rtc import RpcError

from egma import seam

EGMA_IDENTITY = "egma-persona"
"""Who egma is in the room when it mints its own token. The name is the
address and the whole of the authorisation: a room with nobody by it has
nobody to ask."""

A_SIMULATION = "sim-sdk-0001"

SIMULATION_ROOM = f"egma-sim-{A_SIMULATION}"
"""What egma names a room it conducts a simulation in.

Written here rather than imported so this suite holds the SDK to the
*contract*, not to a constant the two halves could move together.
"""

PRODUCTION_ROOM = "acme-support-4711"
"""What a room nobody named for a simulation looks like."""


def persona_in(simulation_id: str = A_SIMULATION) -> str:
    """Who egma is when a customer's own token endpoint mints for it."""
    return f"{EGMA_IDENTITY}-{simulation_id}"


@dataclass(frozen=True)
class Asked:
    """One call the SDK made, as egma received it."""

    method: str
    identity: str
    payload: str
    response_timeout: float | None
    max_round_trip_latency: float | None

    @property
    def body(self) -> dict[str, Any]:
        return json.loads(self.payload)


class StubParticipant:
    """The one method of a room's local participant the SDK ever calls."""

    def __init__(self, room: StubRoom) -> None:
        self._room = room

    async def perform_rpc(
        self,
        *,
        destination_identity: str,
        method: str,
        payload: str,
        response_timeout: float | None = None,
        max_round_trip_latency: float | None = None,
    ) -> str:
        return await self._room.answer(
            Asked(
                method=method,
                identity=destination_identity,
                payload=payload,
                response_timeout=response_timeout,
                max_round_trip_latency=max_round_trip_latency,
            )
        )


@dataclass(frozen=True)
class StubRemoteParticipant:
    """Somebody else in the room, down to the one thing that addresses them."""

    identity: str


@dataclass
class StubRoom:
    """Room stub with configurable participants and RPC replies.

    mocked_tools lists hello results; answers maps tools to tagged answer/error replies.
    refuses_with overrides RPC replies with an error code. present sets initial
    identities; arrive() can add the Egma participant later.
    """

    mocked_tools: tuple[str, ...] = ()
    answers: dict[str, dict[str, Any]] = field(default_factory=dict)
    refuses_with: RpcError | None = None
    refuses_tool_with: RpcError | None = None
    refuses_hello_until: int = 0
    hello_reply: str | None = None
    asked: list[Asked] = field(default_factory=list)
    connected: bool = True
    present: tuple[str, ...] = (EGMA_IDENTITY,)

    def __post_init__(self) -> None:
        self._local_participant = StubParticipant(self)
        self.remote_participants = {
            identity: StubRemoteParticipant(identity) for identity in self.present
        }
        self._listeners: dict[str, list[Any]] = {}
        self._helloes = 0

    # -- who is in it ---------------------------------------------------------

    def on(self, event: str, callback: Any) -> Any:
        self._listeners.setdefault(event, []).append(callback)
        return callback

    def off(self, event: str, callback: Any) -> None:
        listeners = self._listeners.get(event, [])
        if callback in listeners:
            listeners.remove(callback)

    def arrive(self, identity: str) -> None:
        """Put somebody in the room the way LiveKit announces one."""
        participant = StubRemoteParticipant(identity)
        self.remote_participants[identity] = participant
        for callback in list(self._listeners.get("participant_connected", [])):
            callback(participant)

    @property
    def listeners(self) -> dict[str, list[Any]]:
        """What is still subscribed, so a test can say nothing was left on."""
        return {event: list(each) for event, each in self._listeners.items() if each}

    # -- what it carries ------------------------------------------------------

    @property
    def local_participant(self) -> StubParticipant:
        if not self.connected:
            raise Exception("cannot access local participant before connecting")
        return self._local_participant

    def isconnected(self) -> bool:
        return self.connected

    async def answer(self, asked: Asked) -> str:
        self.asked.append(asked)
        if self.refuses_with is not None:
            raise self.refuses_with
        if asked.method == seam.HELLO_METHOD:
            self._helloes += 1
            if self._helloes <= self.refuses_hello_until:
                # What the transport says while egma is in the room and has
                # not registered the exchange yet.
                raise RpcError(
                    RpcError.ErrorCode.UNSUPPORTED_METHOD, asked.method
                )
            if self.hello_reply is not None:
                return self.hello_reply
            return json.dumps(
                {
                    "protocol_version": seam.PROTOCOL_VERSION,
                    "mocked_tools": list(self.mocked_tools),
                }
            )
        if asked.method == seam.TOOL_METHOD:
            if self.refuses_tool_with is not None:
                raise self.refuses_tool_with
            name = asked.body["name"]
            answer = self.answers.get(name)
            if answer is None:
                raise RpcError(
                    seam.UNKNOWN_TOOL,
                    f"this simulation has no mock tool for {name!r}",
                )
            return json.dumps(answer)
        raise RpcError(RpcError.ErrorCode.UNSUPPORTED_METHOD, asked.method)

    @property
    def methods_asked(self) -> list[str]:
        return [asked.method for asked in self.asked]

    @property
    def tool_calls(self) -> list[dict[str, Any]]:
        return [
            asked.body for asked in self.asked if asked.method == seam.TOOL_METHOD
        ]


@dataclass
class StubJobRoom:
    """The room as the server described it to the worker.

    Separate from the room the process connected on purpose: the name the
    SDK reads is the one that arrived with the job, not one this side
    could have chosen for itself.
    """

    name: str


@dataclass
class StubJob:
    """A job, down to the two things the SDK reads of one."""

    room: StubJobRoom
    metadata: str = ""


class StubContext:
    """A job context, down to the three things the SDK touches.

    The third is the shutdown callback. Every export this SDK installs
    registers one, because the last spans of a conversation are buffered
    when the job is told to stop, and a job that exits without flushing
    loses the end of its own record.
    """

    def __init__(
        self, room: StubRoom, room_name: str, metadata: str = ""
    ) -> None:
        self.room = room
        self.job = StubJob(room=StubJobRoom(name=room_name), metadata=metadata)
        self.connect_calls = 0
        self.shutdown_callbacks: list[Any] = []

    async def connect(self) -> None:
        self.connect_calls += 1
        self.room.connected = True

    def add_shutdown_callback(self, callback: Any) -> None:
        self.shutdown_callbacks.append(callback)


def egma_metadata(*, identity: str = EGMA_IDENTITY) -> str:
    """Legacy-shaped dispatch metadata for negative tests.
    The SDK must ignore every field, including identity: only the room name
    selects simulation behavior.
    """
    return json.dumps(
        {
            "simulationId": A_SIMULATION,
            "modality": "voice",
            "egmaIdentity": identity,
            "protocolVersion": seam.PROTOCOL_VERSION,
        },
        separators=(",", ":"),
    )


def not_reached() -> RpcError:
    """What the transport says about a room with no egma in it."""
    return RpcError(
        RpcError.ErrorCode.RECIPIENT_NOT_FOUND,
        RpcError.ErrorMessage[RpcError.ErrorCode.RECIPIENT_NOT_FOUND],
    )
