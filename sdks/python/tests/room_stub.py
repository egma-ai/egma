"""A room with Egma in it, on this machine — what CI holds the SDK against.

The customer's side of the exchange is proved with no LiveKit server, no
project, no worker and no network. What this stands in for is exactly the
one place the SDK reaches a LiveKit — the call it makes to Egma's
participant — and nothing else. Everything above that is the SDK's own
code: reading the metadata, building the census, standing the couriers,
reading a reply, falling open.

Two things it can be, and a test picks by what it builds:

- **Egma answering** — a script of replies, keyed by method. The calls it
  received are on the record, in order, so a test can say the census went
  first.
- **Egma absent** — every call refused with the transport's own
  ``RECIPIENT_NOT_FOUND``, which is the whole of what a production room
  looks like from in here.

The refusals are real :class:`~livekit.rtc.RpcError` instances, because
the SDK's fail-open branch reads a code off one and a stand-in with its
own error type would prove the stand-in's conversion rather than the
SDK's reading.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from livekit.rtc import RpcError

from egma import seam

EGMA_IDENTITY = "egma-persona"
"""Who Egma is in the room. The name is the address and the whole of the
authorisation: a room with nobody by it has nobody to ask."""

A_SIMULATION = "sim-sdk-0001"


@dataclass(frozen=True)
class Asked:
    """One call the SDK made, as Egma received it."""

    method: str
    identity: str
    payload: str
    response_timeout: float | None
    max_round_trip_latency: float | None

    @property
    def body(self) -> dict[str, Any]:
        return json.loads(self.payload)


class StubParticipant:
    """The one method of a room the SDK ever calls."""

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


@dataclass
class StubRoom:
    """A room, from the seat the SDK sits in.

    ``mocked_tools`` is what Egma answers a census with. ``answers`` is
    what it answers each tool call with, by name, already in the tagged
    shape the wire carries — ``{"answer": …}`` or ``{"error": …}`` — so a
    test writes the same bytes Egma would send.

    ``refuses_with`` puts a code in front of everything instead, which is
    how an absent Egma and every honest refusal are both said.
    """

    mocked_tools: tuple[str, ...] = ()
    answers: dict[str, dict[str, Any]] = field(default_factory=dict)
    refuses_with: RpcError | None = None
    refuses_tool_with: RpcError | None = None
    hello_reply: str | None = None
    asked: list[Asked] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.local_participant = StubParticipant(self)

    async def answer(self, asked: Asked) -> str:
        self.asked.append(asked)
        if self.refuses_with is not None:
            raise self.refuses_with
        if asked.method == seam.HELLO_METHOD:
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
class StubJob:
    """The job's dispatch metadata, which is all the SDK reads of a job."""

    metadata: str


class StubContext:
    """A job context, down to the two things the SDK touches."""

    def __init__(self, room: StubRoom, metadata: str) -> None:
        self.room = room
        self.job = StubJob(metadata=metadata)


def egma_metadata(
    *,
    identity: str = EGMA_IDENTITY,
    simulation_id: str = A_SIMULATION,
    protocol_version: object = seam.PROTOCOL_VERSION,
) -> str:
    """The dispatch metadata Egma really sends, byte for byte in shape.

    Written here rather than imported so this suite holds the SDK to the
    *contract*, not to a constant the two halves could move together.
    """
    return json.dumps(
        {
            "simulationId": simulation_id,
            "modality": "voice",
            "egmaIdentity": identity,
            "protocolVersion": protocol_version,
        },
        separators=(",", ":"),
    )


def not_reached() -> RpcError:
    """What the transport says about a room with no Egma in it."""
    return RpcError(
        RpcError.ErrorCode.RECIPIENT_NOT_FOUND,
        RpcError.ErrorMessage[RpcError.ErrorCode.RECIPIENT_NOT_FOUND],
    )
