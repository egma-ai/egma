"""The livekit plug, and the room driver it stands on.

An agent that lives in a LiveKit room is reached by getting into that room
in the customer's own project, holding the exchange there, and being
honest about everything that can go wrong on the way. What is pinned here
is that whole story, against a room-shaped LiveKit on this machine: no
server, no project, no worker and no network — see :mod:`room_stub`, which
stands in for the places the driver reaches a LiveKit and leaves every
other line of it real.

Both shapes of the connection are here, and the second half of the file is
the second one: a connection that names a customer's own token endpoint
rather than carrying their key pair. That endpoint is not stood in for at
all — it is a real HTTP server on loopback serving the contract the public
docs publish (:mod:`token_endpoint_stub`), so what is proved about the
request egma sends and the answers it takes is proved over a socket.

The failure paths get the same treatment, because a room where nothing
turned up is the outcome this plug has to be most honest about: it is
never the agent failing, and the record has to say so — including whose
job the missing half was, which is not the same answer in both shapes.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import socket
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from conftest import (
    A_PERSONALITY,
    A_SCENARIO,
    a_spec,
    assert_one_speaker_to_a_channel,
    speech_in_the_recording,
)
from room_stub import AGENT_IDENTITY, RoomStub
from token_endpoint_stub import serving

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.contract import AGENT_NEVER_JOINED, ERROR, contract_dir
from egma_simulator.media import MediaBackend, MediaBackendError, VoiceMedia
from egma_simulator.media import livekit_room as livekit_room_module
from egma_simulator.media import room as room_media
from egma_simulator.media.livekit_room import (
    TOKEN_RESPONSE_BYTES,
    LiveKitRoomBackend,
    RoomSettings,
)
from egma_simulator.media.room import PERSONA_IDENTITY, ROOM_PREFIX, JoinedRoom
from egma_simulator.media.scripted_transport import FRAME_SECONDS
from egma_simulator.mock_tools import PROTOCOL_VERSION, MockToolSeam
from egma_simulator.model import GOODBYE, ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.pipeline import assemble
from egma_simulator.plugs import PlugError, VoiceConnection, failed_ending, plug_for
from egma_simulator.plugs import livekit as livekit_plug
from egma_simulator.plugs.livekit import LiveKitRoom
from egma_simulator.recording import channels_of
from egma_simulator.redaction import REDACTED
from egma_simulator.spec import MockTool, SimulationSpec
from egma_simulator.speech import SCRIPTED_PAIR
from egma_simulator.walk import Conducted, WalkControls

A_URL = "wss://lakeside-dental.livekit.cloud"
A_KEY = "APIlakeside0000"
A_SECRET = "SENTINEL-livekit-api-secret-7f3b0c19d2a4"
"""The customer's key pair. The secret is a sentinel because every path
below is scanned for it, on the way through and on the way out."""

A_SIMULATION = "sim-room-001"

AN_AGENT = "front-desk"
"""The name the agent's worker registered under.

The default of every builder below, because a livekit connection now
carries one always: egma dispatches explicitly, so a connection naming no
agent is refused before anything is reached, and a test whose subject is
something else would otherwise be testing that refusal instead.
"""


def local_endpoint_socket(addr_info: tuple[object, ...]) -> socket.socket:
    """Connect to the local contract endpoint in tests that need the next hop."""
    family, kind, protocol, _canonical_name, _sockaddr = addr_info
    return socket.socket(family=family, type=kind, proto=protocol)  # type: ignore[arg-type]


class LocalEndpointBackend(LiveKitRoomBackend):
    """A test driver that reaches the local plaintext contract server."""

    def _endpoint_connector(self, aiohttp: Any, resolver: Any) -> tuple[Any, Any]:
        connector = aiohttp.TCPConnector(
            resolver=resolver,
            socket_factory=local_endpoint_socket,
            use_dns_cache=False,
        )
        return resolver, connector


FAILED_ENDINGS = frozenset(
    json.loads(
        (contract_dir() / "schemas" / "simulation-report.v1.schema.json").read_text(
            encoding="utf-8"
        )
    )["$defs"]["failed_facts"]["properties"]["ending"]["enum"]
)
"""The endings a failed simulation may honestly claim, read off the
contract itself rather than spelled again here — a plug that invented a
variant would be refused at the door, and this says so early."""


async def test_room_transport_loss_is_not_remote_participant_departure(
    monkeypatch: pytest.MonkeyPatch,
):
    """Pipecat exposes two events, and Egma keeps their meanings separate."""
    from pipecat.transports.livekit import transport as livekit_transport

    class EventTransport:
        created: EventTransport | None = None

        def __init__(self, **_kwargs: object) -> None:
            self.handlers: dict[str, object] = {}
            self.input_processor = EventInput()
            EventTransport.created = self

        def event_handler(self, name: str):
            def register(handler):
                self.handlers[name] = handler
                return handler

            return register

        def input(self) -> object:
            return self.input_processor

        def output(self) -> object:
            return object()

        async def cleanup(self) -> None:
            disconnected = self.handlers["on_disconnected"]
            await disconnected(self)

    class EventClient:
        def __init__(self) -> None:
            self._audio_queue: asyncio.Queue[object] = asyncio.Queue()
            self._audio_streams: dict[str, object] = {}

        async def get_next_audio_frame(self):
            raise AssertionError("the pinned drain wrapper was not installed")
            yield

        async def _process_audio_stream(
            self, _stream: object, _participant_id: str
        ) -> None:
            raise AssertionError("the pinned drain wrapper was not installed")

        async def _close_audio_stream(self, _participant_id: str) -> None:
            raise AssertionError("the pinned drain wrapper was not installed")

    class EventInput:
        def __init__(self) -> None:
            self._client = EventClient()
            self._audio_in_queue: asyncio.Queue[object] = asyncio.Queue()

        async def push_frame(self, frame: object) -> None:
            frame.completed.set()

    monkeypatch.setattr(livekit_transport, "LiveKitTransport", EventTransport)
    room = JoinedRoom(url=A_URL, token=A_SECRET, room_name=A_SIMULATION)
    media = room.create_transport()
    transport = EventTransport.created
    assert transport is not None
    assert A_SECRET not in media.transport_name

    await transport.handlers["on_disconnected"](transport)
    assert media.failed.is_set()
    assert not media.ended.is_set()
    await transport.handlers["on_connected"](transport)
    with pytest.raises(MediaBackendError, match="closed the room") as lost:
        await room.wait_connected()
    assert lost.value.ending == ERROR

    media.failed.clear()
    await transport.handlers["on_participant_disconnected"](transport, AGENT_IDENTITY)
    assert media.ended.is_set()

    await room.leave()
    assert not media.failed.is_set()


async def test_the_pinned_reader_keeps_livekit_frames_buffered_before_eos():
    """LiveKit 1.1.14's iterator drops these; Egma's reader must not."""
    from livekit import rtc
    from livekit.rtc._utils import RingQueue
    from pipecat.transports.livekit.transport import (
        LiveKitInputTransport,
        LiveKitTransportClient,
    )

    class BufferedAudioStream(rtc.AudioStream):
        def __del__(self) -> None:
            pass

    stream = object.__new__(BufferedAudioStream)
    stream._queue = RingQueue(0)
    finished = asyncio.get_running_loop().create_future()
    finished.set_result(None)
    stream._task = finished
    first = rtc.AudioFrameEvent(
        rtc.AudioFrame(
            data=bytes(320),
            sample_rate=16000,
            num_channels=1,
            samples_per_channel=160,
        )
    )
    second = rtc.AudioFrameEvent(
        rtc.AudioFrame(
            data=bytes(320),
            sample_rate=16000,
            num_channels=1,
            samples_per_channel=160,
        )
    )
    stream._queue.put(first)
    stream._queue.put(second)
    stream._queue.put(None)

    with pytest.raises(StopAsyncIteration):
        await stream.__anext__()

    room = JoinedRoom(url=A_URL, token=A_SECRET, room_name=A_SIMULATION)
    media = room.create_transport()
    input_transport = media.input[0]
    client = input_transport._client

    # This is the exact private Pipecat 1.7.0 seam the production guard pins.
    # The faulty reader and close coordinator are wrapped; conversion,
    # iteration, and pipeline push stay on Pipecat's installed implementations.
    assert (
        input_transport._audio_in_task_handler.__func__
        is LiveKitInputTransport._audio_in_task_handler
    )
    assert (
        client.get_next_audio_frame.__func__
        is LiveKitTransportClient.get_next_audio_frame
    )
    assert client._close_audio_stream.__self__ is room._input_drain
    await client._process_audio_stream(stream, AGENT_IDENTITY)

    assert client._audio_queue.qsize() == 2
    assert client._audio_queue.get_nowait() == (first, AGENT_IDENTITY)
    client._audio_queue.task_done()
    assert client._audio_queue.get_nowait() == (second, AGENT_IDENTITY)
    client._audio_queue.task_done()


async def test_pipecat_17_unsubscribe_drains_before_participant_departure():
    """Unsubscribe preserves buffered audio; only later departure ends."""
    from livekit import rtc
    from livekit.rtc._utils import RingQueue
    from pipecat.frames.frames import AudioRawFrame

    class BufferedAudioStream(rtc.AudioStream):
        def __del__(self) -> None:
            pass

    class Handle:
        def __init__(self) -> None:
            self.disposals = 0

        def dispose(self) -> None:
            self.disposals += 1

    room = JoinedRoom(url=A_URL, token=A_SECRET, room_name=A_SIMULATION)
    media = room.create_transport()
    input_transport = media.input[0]
    client = input_transport._client
    drain = room._input_drain
    input_transport._audio_in_queue = asyncio.Queue()

    conversion_started = asyncio.Event()
    convert = asyncio.Event()

    async def gated_conversion(_event: object) -> AudioRawFrame:
        conversion_started.set()
        await convert.wait()
        return AudioRawFrame(audio=bytes(320), sample_rate=16000, num_channels=1)

    input_transport._convert_livekit_audio_to_pipecat = gated_conversion

    order: list[str] = []
    forwarding_started = asyncio.Event()
    forward = asyncio.Event()

    async def forward_input() -> None:
        for index in range(2):
            frame = await input_transport._audio_in_queue.get()
            if index == 0:
                forwarding_started.set()
            await forward.wait()
            order.append(type(frame).__name__)
            input_transport._audio_in_queue.task_done()

    marker_started = asyncio.Event()
    acknowledge = asyncio.Event()
    markers: list[object] = []

    async def push_marker(frame: object, *_args: object) -> None:
        markers.append(frame)
        order.append("departure")
        marker_started.set()
        await acknowledge.wait()
        frame.completed.set()

    input_transport.push_frame = push_marker

    stream = object.__new__(BufferedAudioStream)
    stream._queue = RingQueue(0)
    stream._track = None
    stream._ffi_handle = Handle()
    stream._processor = None
    source = asyncio.get_running_loop().create_future()
    source.set_result(None)
    stream._task = source
    first_audio = rtc.AudioFrameEvent(
        rtc.AudioFrame(
            data=bytes(320),
            sample_rate=16000,
            num_channels=1,
            samples_per_channel=160,
        )
    )
    second_audio = rtc.AudioFrameEvent(
        rtc.AudioFrame(
            data=bytes(320),
            sample_rate=16000,
            num_channels=1,
            samples_per_channel=160,
        )
    )
    stream._queue.put(first_audio)
    stream._queue.put(second_audio)
    stream._queue.put(None)
    reader = asyncio.create_task(client._process_audio_stream(stream, AGENT_IDENTITY))
    client._audio_streams[AGENT_IDENTITY] = (stream, reader)

    # Track unsubscribe happens first for mute and republish. It must drain the
    # old stream without claiming that the participant left.
    await client._close_audio_stream(AGENT_IDENTITY)
    await client._close_audio_stream(AGENT_IDENTITY)
    await asyncio.sleep(0)

    assert client._audio_queue.qsize() == 2
    assert reader.done() and not reader.cancelled()
    assert stream._ffi_handle.disposals == 1
    assert not markers
    assert not media.ended.is_set()
    assert not media.failed.is_set()

    receiving = asyncio.create_task(input_transport._audio_in_task_handler())
    forwarding = asyncio.create_task(forward_input())
    await conversion_started.wait()

    first = asyncio.create_task(drain.participant_left(AGENT_IDENTITY, media.ended))
    second = asyncio.create_task(drain.participant_left(AGENT_IDENTITY, media.ended))
    await asyncio.sleep(0)
    assert not markers
    assert not media.ended.is_set()

    convert.set()
    await forwarding_started.wait()
    assert not markers
    assert not media.ended.is_set()

    forward.set()
    await marker_started.wait()
    assert len(markers) == 1
    assert not media.ended.is_set()

    acknowledge.set()
    await asyncio.wait_for(asyncio.gather(first, second), timeout=1.0)
    assert media.ended.is_set()
    assert not media.failed.is_set()
    assert len(markers) == 1
    assert order == ["UserAudioRawFrame", "UserAudioRawFrame", "departure"]
    assert stream._ffi_handle.disposals == 1

    await forwarding
    receiving.cancel()
    with pytest.raises(asyncio.CancelledError):
        await receiving


async def test_a_swallowed_reader_error_cannot_become_normal_departure():
    """Pipecat logs reader errors; Egma must still refuse a normal ending."""
    from pipecat.utils.asyncio.task_manager import TaskManager

    class BrokenStream:
        async def aclose(self) -> None:
            pass

    room = JoinedRoom(url=A_URL, token=A_SECRET, room_name=A_SIMULATION)
    media = room.create_transport()
    input_transport = media.input[0]
    input_transport._audio_in_queue = asyncio.Queue()
    client = input_transport._client
    stream = BrokenStream()
    reader = TaskManager().create_task(
        client._process_audio_stream(stream, AGENT_IDENTITY),
        "broken-livekit-reader",
    )
    client._audio_streams[AGENT_IDENTITY] = (stream, reader)
    await reader
    assert reader.result() is None
    assert media.failed.is_set()

    markers: list[object] = []

    async def catch_marker(frame: object, *_args: object) -> None:
        markers.append(frame)
        frame.completed.set()

    input_transport.push_frame = catch_marker
    transport = room._transport
    participant_left = transport._event_handlers[
        "on_participant_disconnected"
    ].handlers[0]
    await participant_left(transport, AGENT_IDENTITY)

    assert media.failed.is_set()
    assert not media.ended.is_set()
    assert not markers


async def test_a_stalled_departure_fails_remotely_but_local_leave_reaps_it():
    """The one drain deadline is bounded; local teardown stays intentional."""
    from livekit import rtc
    from livekit.rtc._utils import RingQueue

    assert room_media.AUDIO_STREAM_CLOSE_SECONDS == 2.0

    class RemoteAudioStream(rtc.AudioStream):
        def __del__(self) -> None:
            pass

    class RemoteHandle:
        def dispose(self) -> None:
            pass

    remote_room = JoinedRoom(url=A_URL, token=A_SECRET, room_name=A_SIMULATION)
    remote_media = remote_room.create_transport()
    remote_input = remote_media.input[0]
    remote_client = remote_input._client
    remote_stream = object.__new__(RemoteAudioStream)
    remote_stream._queue = RingQueue(0)
    remote_stream._track = None
    remote_stream._ffi_handle = RemoteHandle()
    remote_stream._processor = None
    remote_source = asyncio.get_running_loop().create_future()
    remote_stream._task = remote_source
    remote_reader = asyncio.create_task(
        remote_client._process_audio_stream(remote_stream, AGENT_IDENTITY)
    )
    remote_client._audio_streams[AGENT_IDENTITY] = (
        remote_stream,
        remote_reader,
    )
    remote_markers: list[object] = []

    async def catch_remote_marker(frame: object, *_args: object) -> None:
        remote_markers.append(frame)

    remote_input.push_frame = catch_remote_marker
    remote_transport = remote_room._transport
    remote_handler = remote_transport._event_handlers[
        "on_participant_disconnected"
    ].handlers[0]
    remote_started = asyncio.get_running_loop().time()
    await remote_handler(remote_transport, AGENT_IDENTITY)
    remote_elapsed = asyncio.get_running_loop().time() - remote_started

    assert 1.8 <= remote_elapsed < 2.5
    assert remote_media.failed.is_set()
    assert not remote_media.ended.is_set()
    assert not remote_markers
    assert remote_source.cancelled()
    assert remote_reader.cancelled()

    class LocalAudioStream(rtc.AudioStream):
        def __del__(self) -> None:
            pass

    class LocalHandle:
        def __init__(self) -> None:
            self.disposed = asyncio.Event()

        def dispose(self) -> None:
            self.disposed.set()

    local_room = JoinedRoom(url=A_URL, token=A_SECRET, room_name="local-leave")
    local_media = local_room.create_transport()
    local_input = local_media.input[0]
    local_client = local_input._client
    local_drain = local_room._input_drain
    assert local_drain is not None
    local_stream = object.__new__(LocalAudioStream)
    local_stream._queue = RingQueue(0)
    local_stream._track = None
    local_stream._ffi_handle = LocalHandle()
    local_stream._processor = None
    local_source = asyncio.get_running_loop().create_future()
    local_stream._task = local_source
    local_reader = asyncio.create_task(
        local_client._process_audio_stream(local_stream, AGENT_IDENTITY)
    )
    local_client._audio_streams[AGENT_IDENTITY] = (
        local_stream,
        local_reader,
    )
    local_markers: list[object] = []

    async def catch_local_marker(frame: object, *_args: object) -> None:
        local_markers.append(frame)

    local_input.push_frame = catch_local_marker
    local_transport = local_room._transport
    cleaned = asyncio.Event()

    async def clean_after_departure() -> None:
        assert all(task.done() for task in local_drain._departures.values())
        cleaned.set()

    local_transport.cleanup = clean_after_departure
    local_handler = local_transport._event_handlers[
        "on_participant_disconnected"
    ].handlers[0]
    leaving_remotely = asyncio.create_task(
        local_handler(local_transport, AGENT_IDENTITY)
    )
    await local_stream._ffi_handle.disposed.wait()

    before_disconnect = local_transport._event_handlers[
        "on_before_disconnect"
    ].handlers[0]
    local_started = asyncio.get_running_loop().time()
    await asyncio.wait_for(before_disconnect(local_transport), timeout=0.5)
    local_elapsed = asyncio.get_running_loop().time() - local_started
    with pytest.raises(asyncio.CancelledError):
        await leaving_remotely
    await asyncio.wait_for(local_room.leave(), timeout=0.5)

    assert local_elapsed < 0.5
    assert cleaned.is_set()
    assert local_media.ended.is_set()
    assert not local_media.failed.is_set()
    assert not local_markers
    assert local_source.cancelled()
    assert local_reader.cancelled()


def livekit_spec(
    simulation_id: str = A_SIMULATION,
    *,
    url: str = A_URL,
    agent_name: str | None = AN_AGENT,
    metadata: object = None,
    scenario: str = A_SCENARIO,
    max_turns: int = 60,
    max_duration_seconds: int = 600,
) -> dict:
    """One voice spec whose connection names a room, and nothing else.

    Deliberately the same shape as the phone and loopback builders: a room
    simulation differs from every other voice one by its connection block
    and by nothing else.
    """
    config: dict = {"url": url}
    if agent_name is not None:
        config["agentName"] = agent_name
    if metadata is not None:
        config["metadata"] = metadata
    return a_spec(
        simulation_id,
        modality="voice",
        connection={
            "agent_platform": "livekit",
            "connection_type": "livekit_room",
            "access_variant": "livekit_room.project_credentials",
            "config": config,
            "credentials": {"apiKey": A_KEY, "apiSecret": A_SECRET},
        },
        scenario=scenario,
        personality=A_PERSONALITY,
        max_turns=max_turns,
        max_duration_seconds=max_duration_seconds,
    )


A_HEADER_SECRET = "SENTINEL-endpoint-bearer-8c41d7"
"""The auth header the endpoint shape sends. A sentinel for the same
reason the api secret is: whoever holds it can ask the customer's endpoint
for a token, so every path below is scanned for it."""

AN_AUTH_HEADER = f'{{"Authorization":"Bearer {A_HEADER_SECRET}"}}'


def livekit_endpoint_spec(
    simulation_id: str = A_SIMULATION,
    *,
    url: str = A_URL,
    token_endpoint: str = "https://acme.example/egma/livekit-token",
    credentials: object = None,
    scenario: str = A_SCENARIO,
    max_turns: int = 60,
    max_duration_seconds: int = 600,
) -> dict:
    """One voice spec whose connection asks an endpoint for its token.

    The same shape as the builder above and different in one key, which is
    the whole of the difference between the two ways a livekit connection
    is reached.
    """
    return a_spec(
        simulation_id,
        modality="voice",
        connection={
            "agent_platform": "livekit",
            "connection_type": "livekit_room",
            "access_variant": "livekit_room.customer_token_endpoint",
            "config": {"url": url, "tokenEndpoint": token_endpoint},
            "credentials": (
                {"headers": AN_AUTH_HEADER} if credentials is None else credentials
            ),
        },
        scenario=scenario,
        personality=A_PERSONALITY,
        max_turns=max_turns,
        max_duration_seconds=max_duration_seconds,
    )


def room(stub: RoomStub, **config: object) -> LiveKitRoom:
    """One livekit plug against a room-shaped LiveKit."""
    return LiveKitRoom(
        modality="voice",
        access_variant="livekit_room.project_credentials",
        config={"url": A_URL, "agentName": AN_AGENT} | config,
        credentials={"apiKey": A_KEY, "apiSecret": A_SECRET},
        simulation_id=A_SIMULATION,
        driver=stub.driver,
    )


def endpoint_room(
    stub: RoomStub,
    token_endpoint: str,
    *,
    url: str = A_URL,
    credentials: object = None,
) -> LiveKitRoom:
    """One livekit plug that asks an endpoint for its way into the room."""
    return LiveKitRoom(
        modality="voice",
        access_variant="livekit_room.customer_token_endpoint",
        config={"url": url, "tokenEndpoint": token_endpoint},
        credentials=(
            {"headers": AN_AUTH_HEADER} if credentials is None else credentials
        ),
        simulation_id=A_SIMULATION,
        driver=stub.driver,
    )


async def room_walk(
    tmp_path: Path,
    stub: RoomStub,
    monkeypatch: pytest.MonkeyPatch,
    *,
    controls: WalkControls | None = None,
    built_by=livekit_spec,
    spans: list[tuple[str, str, int, int]] | None = None,
    **overrides: object,
) -> tuple[Conducted, list[tuple[str, str]], list[tuple[str, float, int]], object]:
    """One room simulation, conducted the way the service conducts it.

    The spec goes in at the top — through the plug registry and the
    pipeline the service assembles — so what is exercised below the fake
    is every line the service would run, including the Pipecat conductor
    that drives the room. ``built_by`` is which of the two connection
    shapes the spec names; everything else is the same, which is the point.

    Each measurement comes back as its name, the milliseconds its own span
    holds, and the instant it closed — which is where a voice measure's
    number lives now that both ends are read off the audio. A test that
    wants a turn's two instants as well passes ``spans`` to be filled.
    """
    monkeypatch.setattr(livekit_plug, "LiveKitRoomBackend", stub.driver)
    spec = SimulationSpec.from_document(built_by(**overrides))
    turns: list[tuple[str, str]] = []
    measures: list[tuple[str, float, int]] = []

    async def on_utterance(speaker: str, text: str, began: int, ended: int) -> None:
        turns.append((speaker, text))
        if spans is not None:
            spans.append((speaker, text, began, ended))

    async def on_measured(measure: str, began: int, ended: int) -> None:
        measures.append((measure, (ended - began) / 1_000_000, ended))

    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
    )
    assert assembled.conductor is not None
    conducted = await assembled.conductor.conduct(
        persona=Persona(
            authored=spec.persona,
            scenario_instructions=spec.scenario_instructions,
            model=ScriptedModel(spec.scenario_instructions),
        ),
        max_turns=spec.limits.max_turns,
        max_duration_seconds=spec.limits.max_duration_seconds,
        controls=controls if controls is not None else WalkControls(),
        name="sim:room-test",
        on_utterance=on_utterance,
        on_measured=on_measured,
    )
    return conducted, turns, measures, assembled


def test_the_registry_answers_a_room_spec_with_the_plug_for_its_modality():
    """One connection type, two modalities, and the registry is where the
    choice lives — nowhere above it learns which of the two it got."""
    from egma_simulator.plugs.livekit_chat import LiveKitChat

    factory = plug_for("livekit_room")
    assert factory is not None
    built = {
        "access_variant": "livekit_room.project_credentials",
        "config": {"url": A_URL, "agentName": AN_AGENT},
        "credentials": {"apiKey": A_KEY, "apiSecret": A_SECRET},
        "simulation_id": A_SIMULATION,
    }
    assert isinstance(factory(modality="voice", **built), LiveKitRoom)
    assert isinstance(factory(modality="chat", **built), LiveKitChat)


def test_a_room_is_one_pipecat_voice_connection():
    """The seam gives Pipecat the transport instead of exchanging PCM.

    There is no second byte bridge, processing rate, or playout clock for
    the room plug to own.
    """
    connection = room(RoomStub())
    assert isinstance(connection, VoiceConnection)
    assert not hasattr(connection, "exchange")
    assert not hasattr(connection, "sample_rate_hz")


# -- One whole simulation ----------------------------------------------------


async def test_a_livekit_spec_conducts_a_whole_simulation_in_a_room(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Everything a voice simulation owes its record, from a spec alone.

    A spec whose connection names a room becomes a conversation, and what
    comes back is a transcript, a distinct ending, per-turn measurements
    that never run backwards, a dual-channel recording that resolves, and
    the room's own name as the join to the platform's telemetry.
    """
    stub = RoomStub(
        greeting="Lakeside Dental, how can I help?",
        replies=["Of course — could I take your name?", "Booked for Thursday."],
        answer_delay_seconds=0.3,
    )
    conducted, turns, measures, assembled = await room_walk(
        tmp_path,
        stub,
        monkeypatch,
        agent_name="front-desk",
        scenario=(
            "I need to move my Tuesday cleaning to Thursday. My name is Margaret Hale."
        ),
    )

    assert turns == [
        ("agent", "Lakeside Dental, how can I help?"),
        ("human", "I need to move my Tuesday cleaning to Thursday."),
        ("agent", "Of course — could I take your name?"),
        ("human", "My name is Margaret Hale."),
        ("agent", "Booked for Thursday."),
        ("human", GOODBYE),
    ]
    assert conducted.status == "completed"
    assert conducted.ending == "persona_concluded"

    # The room this was held in is the provider reference — one room, one
    # simulation, and the one join between egma's record and LiveKit's.
    assert conducted.provider_reference == stub.rooms[0].name
    assert conducted.provider_reference.startswith(f"{ROOM_PREFIX}-")
    # And bare on purpose: the marked form is the chat lane's, and a voice
    # room wearing it would mute every worker carrying the chat setup.
    assert not conducted.provider_reference.startswith("egma-sim-chat-")

    # Measured, and measured per turn: the agent's quiet and speech on
    # each of its three turns, the persona's on each of its three, and the
    # answer latencies every simulation reports.
    named = [measure for measure, _, _ in measures]
    assert named.count("time_to_first_word") == 3
    assert named.count("agent_speech_duration") == 3
    assert named.count("persona_speech_duration") == 3
    assert named.count("first_response_latency") == 1
    assert named.count("turn_response_latency") == 2
    # The configured quiet is present before every answer. Pipecat also
    # carries turn-boundary media, so this is a lower bound rather than an
    # exact sample count.
    delays = [
        milliseconds
        for measure, milliseconds, _ in measures
        if measure == "time_to_first_word"
    ]
    assert len(delays) == 3
    assert all(delay >= 300.0 for delay in delays)
    # And nothing was stamped before the measurement reported ahead of it.
    stamped = [at for _, _, at in measures]
    assert stamped == sorted(stamped)

    audio = assembled.audio
    assert set(audio) == {"recording"}

    # The reference is a reference: no bytes on the wire, and it resolves
    # to a recording with one speaker to a channel.
    assert "://" not in audio["recording"]
    recording = (tmp_path / audio["recording"]).read_bytes()
    assert_one_speaker_to_a_channel(recording, turns)

    # And the room was not left behind.
    assert stub.deleted == [stub.rooms[0].name]


async def test_a_room_turn_span_is_anchored_to_the_audio_timeline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The same claim the loopback and the phone make, over a room.

    A turn's span follows Pipecat's recording timeline. The two clocks can
    differ by one media frame, but that difference must not grow during
    the simulation.
    """
    stub = RoomStub(
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
        answer_delay_seconds=0.3,
    )
    spans: list[tuple[str, str, int, int]] = []
    _conducted, _turns, _measures, assembled = await room_walk(
        tmp_path,
        stub,
        monkeypatch,
        spans=spans,
        scenario="First point. Second point.",
    )

    recording = (tmp_path / assembled.audio["recording"]).read_bytes()
    heard = speech_in_the_recording(recording)
    _human, _agent, recording_rate = channels_of(recording)
    # Every transcript turn is spoken into the room and has recorded time.
    spoken = [span for span in spans if span[2] != span[3]]
    assert [speaker for speaker, _began, _ended in heard] == [
        speaker for speaker, _text, _began, _ended in spoken
    ]

    def audio_offsets(positions: list[int]) -> list[float]:
        return [(position - positions[0]) / recording_rate for position in positions]

    def span_offsets(instants: list[int]) -> list[float]:
        return [(instant - instants[0]) / 1_000_000_000 for instant in instants]

    recorded_begins = audio_offsets([began for _speaker, began, _ended in heard])
    recorded_ends = audio_offsets([ended for _speaker, _began, ended in heard])
    spanned_begins = span_offsets([began for _speaker, _text, began, _ended in spoken])
    spanned_ends = span_offsets([ended for _speaker, _text, _began, ended in spoken])
    assert recorded_begins == pytest.approx(spanned_begins, abs=FRAME_SECONDS)
    assert recorded_ends == pytest.approx(spanned_ends, abs=FRAME_SECONDS)


# -- The plug's own lifecycle -------------------------------------------------


async def test_the_plug_prepares_joins_and_leaves_one_voice_transport():
    """The lifecycle the conductor drives, against a room-shaped LiveKit."""
    stub = RoomStub(
        greeting="Lakeside Dental, how can I help?",
        replies=["Of course — could I take your name?", "Booked for Thursday."],
    )
    plug = room(stub, agentName="front-desk")
    assert plug.provider_reference is None, "no room exists before one is made"

    media = await plug.prepare()
    assert isinstance(media, VoiceMedia)
    assert media.input and media.output
    await plug.open()
    assert plug.provider_reference == stub.rooms[0].name
    assert not plug.far_end_left
    assert stub.room.joined
    await plug.close()

    assert not stub.room.joined
    assert stub.deleted == [stub.rooms[0].name]


# -- Getting the agent into the room -----------------------------------------


async def test_a_named_agent_is_dispatched_by_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The explicit path: the connection names an agent, so egma asks the
    project for that agent by name."""
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    await room_walk(
        tmp_path, stub, monkeypatch, agent_name="front-desk", scenario="One point."
    )

    assert len(stub.dispatches) == 1
    dispatch = stub.dispatches[0]
    assert dispatch.agent_name == "front-desk"
    assert dispatch.room == stub.rooms[0].name


@pytest.mark.parametrize("agent_name", [None, "", "   "])
async def test_a_connection_that_names_no_agent_is_refused_before_any_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, agent_name: str | None
):
    """There is no automatic path any more, and there cannot be one.

    LiveKit would hand a new room to a worker registered without a name,
    but such a room carries no dispatch metadata — so the agent would
    never learn the modality it is in and never learn where egma is
    standing for its tools, and every mocked tool would quietly run for
    real. So a nameless connection is refused at the settings read, by
    name, and nothing is asked of the customer's project at all.
    """
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])

    with pytest.raises(PlugError) as refused:
        await room_walk(
            tmp_path,
            stub,
            monkeypatch,
            agent_name=agent_name,
            scenario="One point.",
        )

    told = str(refused.value)
    assert "agentName" in told, "the key nobody filled in has to be on the record"
    assert failed_ending(refused.value) == ERROR
    assert stub.rooms == [], "nothing was made"
    assert stub.dispatches == [], "nothing was asked for"


async def test_an_agent_that_got_into_the_room_first_is_still_somebody_who_came():
    """A worker already in the room is not a worker that never came.

    On three of the four ways into a room, nothing egma does decides when
    the worker is given the room: automatic dispatch hands it over the
    moment the room exists, and a customer's own dispatcher hands it over
    whenever it likes. So the ordinary case is an agent sitting in the
    room, publishing, before egma's transport connects — and a room
    announces an arrival only to somebody who was already watching.
    Waiting for an event that will never fire would end a live simulation
    as ``agent_never_joined`` while the agent was in the room the whole
    time, and blame the customer's worker for it.
    """
    stub = RoomStub(
        greeting="Front desk.",
        replies=["Noted."],
        agent_was_already_in_the_room=True,
    )
    plug = room(stub)

    await plug.prepare()
    assert not stub.room.arrivals.is_set(), (
        "the room announced an arrival for somebody who was there first, "
        "which is not what a room does"
    )
    await plug.open()
    try:
        assert stub.room.arrivals.is_set()
        assert stub.room.who_arrived == [AGENT_IDENTITY]
    finally:
        await plug.close()


async def test_the_mock_tool_methods_are_offered_at_the_join():
    """Live before anybody can ask, because somebody may already be asking.

    The agent's side says hello as its session starts, and where egma is
    not the one dispatching that session can be under way while egma is
    still connecting. A method registered a step after the join is a race
    with the first thing the agent says; losing it reads on the far side
    as "no egma here", and every tool the simulation meant to answer for
    runs its own implementation instead — inside a live simulation, with
    nothing on the record to say so.
    """
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    plug = LiveKitRoom(
        modality="voice",
        access_variant="livekit_room.project_credentials",
        config={"url": A_URL, "agentName": AN_AGENT},
        credentials={"apiKey": A_KEY, "apiSecret": A_SECRET},
        simulation_id=A_SIMULATION,
        mock_tools=MockToolSeam((MockTool("check_calendar", {"answer": {}}, 0),)),
        driver=stub.driver,
    )

    await plug.prepare()
    try:
        assert stub.standing_ready.is_set(), (
            "the exchange was not offered until after the join, which is a "
            "race with the first thing the agent's session says"
        )
        assert await stub.says_hello("check_calendar") == {
            "protocol_version": PROTOCOL_VERSION,
            "mocked_tools": ["check_calendar"],
        }
    finally:
        await plug.close()


async def test_a_refusal_at_the_join_leaves_the_second_offer_its_chance():
    """The fallback offer is spent on the room that needs it, not on air.

    The driver offers twice: at the join, which is the only moment early
    enough for an agent that was already in the room, and again from
    ``dial`` for a room that had no such moment. A room can refuse the
    first and take the second, and then the second is the only offer the
    simulation has left. Counting the exchange as offered before the
    participant has taken the methods throws that one away, and every
    mocked tool in the run then reaches its own implementation while the
    record says nothing about it.
    """
    stub = RoomStub(
        greeting="Front desk.",
        replies=["Noted."],
        refuses_the_offer_at_the_join="the participant is not ready yet",
    )
    plug = LiveKitRoom(
        modality="voice",
        access_variant="livekit_room.project_credentials",
        config={"url": A_URL, "agentName": AN_AGENT},
        credentials={"apiKey": A_KEY, "apiSecret": A_SECRET},
        simulation_id=A_SIMULATION,
        mock_tools=MockToolSeam((MockTool("check_calendar", {"answer": {}}, 0),)),
        driver=stub.driver,
    )

    await plug.prepare()
    try:
        assert not stub.standing_ready.is_set(), (
            "the room took the methods at the join, so this is not the room "
            "the second offer exists for"
        )
        await plug.open()
        assert stub.standing_ready.is_set(), (
            "the join was refused and the second offer was skipped, so every "
            "mocked tool in this simulation runs for real"
        )
        assert await stub.says_hello("check_calendar") == {
            "protocol_version": PROTOCOL_VERSION,
            "mocked_tools": ["check_calendar"],
        }
    finally:
        await plug.close()


async def test_the_dispatch_carries_the_customers_own_keys_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The whole point of the channel: an agent reading its per-session
    context out of the dispatch finds its own object there.

    LiveKit's own documentation sends agents to this channel for exactly
    that, so an agent doing ``json.loads(ctx.job.metadata)["clinic"]``
    reads what its own deployment configured rather than breaking the
    moment somebody puts it under test.
    """
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    await room_walk(
        tmp_path,
        stub,
        monkeypatch,
        agent_name="front-desk",
        metadata='{"clinic":"lakeside","locale":"en-GB"}',
        scenario="One point.",
    )

    # Read the way an agent reads it, because that is the claim: the
    # bytes are pinned next door, and what is pinned here is that parsing
    # them gets the agent to its own keys.
    carried = json.loads(stub.dispatches[0].metadata)
    assert carried == {"clinic": "lakeside", "locale": "en-GB"}


@pytest.mark.parametrize(
    "configured",
    [
        '{"clinic":"lakeside","locale":"en-GB"}',
        '{"tenant":"caf\u00e9","city":"\u6771\u4eac"}',
        '{"label":"\\ud800"}',
    ],
)
async def test_the_two_channels_carry_the_same_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, configured: str
):
    """One value, two channels, and the same bytes on both.

    egma writes the configured string out on neither channel, so there is
    no second spelling of it to go wrong. That is worth pinning against
    three shapes a re-serialising driver would have handled differently:
    plain ASCII, characters outside it, and ``\\ud800`` — a lone surrogate,
    which is legal JSON the door admits and a character with no UTF-8 form
    at all. Written out again, the third one is a string that cannot go on
    the wire, and the simulation would be dead at the dispatch over a value
    the other channel carried without complaint.
    """
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    await room_walk(
        tmp_path,
        stub,
        monkeypatch,
        agent_name="front-desk",
        metadata=configured,
        scenario="One point.",
    )

    assert stub.dispatches[0].metadata == configured
    assert stub.rooms[0].metadata == configured


async def test_the_dispatch_carries_none_of_the_test(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Nothing whatever about what the agent is going to be asked,
    because an agent that reads its script stops being under test."""
    scenario = "Ask to move the Tuesday cleaning to Thursday. Say you are Margaret."
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    await room_walk(
        tmp_path,
        stub,
        monkeypatch,
        agent_name="front-desk",
        metadata='{"clinic":"lakeside"}',
        scenario=scenario,
    )

    for word in ("Tuesday", "Thursday", "Margaret", "cleaning", A_PERSONALITY):
        assert word not in stub.dispatches[0].metadata


async def test_a_connection_that_configured_nothing_dispatches_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """No metadata configured, so no metadata sent — on either channel.

    There is nothing of egma's to put in an empty message. An agent that
    reads ``ctx.job.metadata`` on a connection that configured none finds
    exactly what it finds in its own production rooms.
    """
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    await room_walk(
        tmp_path, stub, monkeypatch, agent_name="front-desk", scenario="One point."
    )

    assert stub.dispatches[0].metadata == ""
    assert stub.rooms[0].metadata == ""


@pytest.mark.parametrize(
    ("configured", "carried"),
    [
        (
            '{"clinic":"lakeside","locale":"en-GB"}',
            '{"clinic":"lakeside","locale":"en-GB"}',
        ),
        ('{"already":"json"}', '{"already":"json"}'),
        (None, ""),
    ],
)
async def test_the_room_carries_the_connections_own_json(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    configured: object,
    carried: str,
):
    """The customer's metadata channel: theirs to write, egma's to pass
    through untouched, and it never carries anything of egma's.

    The door only ever stores metadata as a JSON object in a string, so a
    string is the whole product shape: it rides byte for byte."""
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    await room_walk(
        tmp_path, stub, monkeypatch, metadata=configured, scenario="One point."
    )

    assert stub.rooms[0].metadata == carried
    assert A_SIMULATION not in stub.rooms[0].metadata


@pytest.mark.parametrize("configured", [{"clinic": "lakeside"}, [1, 2], 7])
def test_metadata_that_is_not_the_doors_own_string_is_refused(configured: object):
    """A spec is the door's word, and the door stores metadata as a JSON
    object in a string. Anything else never came through it, and the
    driver names the mistake rather than papering over it."""
    from egma_simulator.media.livekit_room import _configured_json

    with pytest.raises(MediaBackendError) as refused:
        _configured_json(configured)

    assert "a JSON object in a string" in str(refused.value)


# -- Every way a room fails to become a simulation ---------------------------


async def test_a_worker_that_never_comes_is_never_the_agent_failing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The room opens, the dispatch goes out, and nobody arrives.

    Nothing was tested, so nothing is graded: the ending says the agent
    never joined, and the reason is worded for whoever has to go and look
    at their worker.
    """
    monkeypatch.setattr(livekit_plug, "AGENT_JOIN_SECONDS", 0.05)
    stub = RoomStub(agent_joins=False)

    with pytest.raises(PlugError) as never_came:
        await room_walk(
            tmp_path, stub, monkeypatch, agent_name="front-desk", scenario="One point."
        )

    # What the record would carry, asked the way the service asks it: a
    # failed simulation whose ending says nothing was tested, so there is
    # nothing for a grader to judge the agent on.
    assert failed_ending(never_came.value) == AGENT_NEVER_JOINED
    assert AGENT_NEVER_JOINED in FAILED_ENDINGS
    told = str(never_came.value)
    assert "front-desk" in told, "the name nobody registered has to be on the record"
    assert "worker" in told
    # It was asked for before it was given up on, and the room went away.
    assert len(stub.dispatches) == 1
    assert stub.deleted == [stub.rooms[0].name]


async def test_a_worker_that_joins_and_publishes_nothing_never_joined_either(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A participant with no audio is a worker that crashed on its first
    frame. Conducting against it would grade an agent that never spoke."""
    monkeypatch.setattr(livekit_plug, "AGENT_JOIN_SECONDS", 0.05)
    stub = RoomStub(agent_publishes_audio=False)

    with pytest.raises(PlugError) as silent:
        await room_walk(tmp_path, stub, monkeypatch, scenario="One point.")

    assert failed_ending(silent.value) == AGENT_NEVER_JOINED
    assert "audio" in str(silent.value)
    assert stub.deleted == [stub.rooms[0].name]


def test_the_wait_for_a_worker_is_bounded_and_shorter_than_a_simulation():
    """The budget itself, pinned where the tests above shorten it: a wait
    that outran a simulation's duration limit would put ``limit_reached``
    on a record whose real story is that nothing turned up."""
    assert 0 < livekit_plug.AGENT_JOIN_SECONDS <= 60


async def test_the_agent_leaving_mid_exchange_is_the_agent_ending_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The agent's participant leaving is the agent ending the exchange,
    and everything said up to that moment stays on the record."""
    stub = RoomStub(
        greeting="Front desk.",
        replies=["I am afraid I have to go. Goodbye."],
        hangs_up_after_replies=True,
    )
    conducted, turns, _measures, assembled = await room_walk(
        tmp_path,
        stub,
        monkeypatch,
        scenario=" ".join(f"Sentence number {n}." for n in range(1, 41)),
    )

    assert conducted.status == "completed"
    assert conducted.ending == "agent_ended"
    assert turns == [
        ("agent", "Front desk."),
        ("human", "Sentence number 1."),
        ("agent", "I am afraid I have to go. Goodbye."),
    ]
    # A simulation cut short still leaves the audio it had.
    recording = (tmp_path / assembled.audio["recording"]).read_bytes()
    assert_one_speaker_to_a_channel(recording, turns)


async def test_a_dispatch_the_platform_refuses_is_a_fault_in_its_words(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A project that will not dispatch is somebody's to fix, and what it
    said is the whole diagnosis."""
    stub = RoomStub(refuses_dispatch="no worker registered as 'front-desk'")

    with pytest.raises(PlugError) as refused:
        await room_walk(
            tmp_path, stub, monkeypatch, agent_name="front-desk", scenario="One point."
        )

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert "no worker registered" in told
    assert stub.deleted == [stub.rooms[0].name]


async def test_a_room_the_platform_refuses_is_a_fault_in_its_words(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    stub = RoomStub(refuses_room="room name already taken")

    with pytest.raises(PlugError) as refused:
        await room_walk(tmp_path, stub, monkeypatch, scenario="One point.")

    assert failed_ending(refused.value) == ERROR
    assert "room name already taken" in str(refused.value)
    # Nothing was joined, and the room is still asked about: a delete that
    # finds nothing is cheaper than a room left running.
    assert stub.deleted


async def test_a_livekit_that_answers_nowhere_fails_without_a_credential(
    caplog: pytest.LogCaptureFixture,
):
    """The failure a wrong URL really hits, hermetically and through the
    real driver: a closed port on loopback, a real key pair in hand, and a
    refusal that names what could not be reached and no secret at all.

    Tearing down then asks the same unreachable server to delete a room it
    never made, which is the one path in this driver that logs the
    platform's words rather than raising them — so the log line it writes
    is scanned here too.
    """
    caplog.set_level(logging.INFO)
    settings = RoomSettings.from_connection(
        "livekit_room.project_credentials",
        {"url": "http://127.0.0.1:1", "agentName": AN_AGENT},
        {"apiKey": A_KEY, "apiSecret": A_SECRET},
    )
    driver = LiveKitRoomBackend(settings=settings, simulation_id=A_SIMULATION)

    with pytest.raises(MediaBackendError) as refusal:
        await driver.create_transport()
    await driver.teardown()

    told = str(refusal.value)
    assert "127.0.0.1:1" in told, "the reason has to name what could not be reached"
    assert failed_ending(refusal.value) == ERROR
    assert A_SECRET not in told
    assert A_SECRET not in repr(refusal.value.__cause__)

    logged = [record.getMessage() for record in caplog.records]
    assert any("was not deleted" in line for line in logged), logged
    for line in logged:
        assert A_SECRET not in line


async def test_a_real_transport_join_refusal_reaches_the_running_pipeline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    """A stock LiveKit transport connects only after Pipecat starts it."""
    with serving(
        token="a.token.the.server.will.not.take",
        server_url="ws://127.0.0.1:1",
    ) as endpoint:

        def local_driver(**built: Any) -> LocalEndpointBackend:
            settings = built.get("settings")
            assert isinstance(settings, RoomSettings)
            built["settings"] = replace(
                settings,
                token_endpoint=endpoint.wire_url,
            )
            return LocalEndpointBackend(**built)

        monkeypatch.setattr(livekit_plug, "LiveKitRoomBackend", local_driver)
        spec = SimulationSpec.from_document(
            livekit_endpoint_spec(
                url="ws://127.0.0.1:1",
                token_endpoint=endpoint.url,
                scenario="One point.",
                max_duration_seconds=30,
            )
        )
        assembled = assemble(
            spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
        )
        conductor = assembled.conductor
        assert conductor is not None

        async def ignore(*_facts: object) -> None:
            return None

        with pytest.raises(PlugError) as refused:
            await conductor.conduct(
                persona=Persona(
                    authored=spec.persona,
                    scenario_instructions=spec.scenario_instructions,
                    model=ScriptedModel(spec.scenario_instructions),
                ),
                max_turns=spec.limits.max_turns,
                max_duration_seconds=spec.limits.max_duration_seconds,
                controls=WalkControls(),
                name="sim:real-room-join-refusal",
                on_utterance=ignore,
                on_measured=ignore,
            )

    told = str(refused.value)
    assert "voice connection could not open" in told
    assert "127.0.0.1:1" in told, "the reason names the server that said no"
    assert A_HEADER_SECRET not in told
    assert A_HEADER_SECRET not in repr(refused.value.__cause__)


async def test_a_platform_that_says_the_secret_back_still_leaks_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A careless platform's own words can include the key pair it was
    just given. The driver is what has to survive that: nothing downstream
    may repeat a secret because somebody else did first."""
    stub = RoomStub(refuses_dispatch=f"auth failed for key {A_KEY} secret {A_SECRET}")

    with pytest.raises(PlugError) as refused:
        await room_walk(
            tmp_path, stub, monkeypatch, agent_name="front-desk", scenario="One point."
        )

    told = str(refused.value)
    assert A_SECRET not in told
    assert REDACTED in told


@pytest.mark.parametrize("agent_joins", [True, False])
async def test_nothing_a_simulation_produces_carries_the_api_secret(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    agent_joins: bool,
):
    """The sentinel scan, on the path that works and the path that does not.

    A whole simulation runs with the customer's secret really in the
    process, and then everything it produced is read for it: every log
    line, both metadata channels, the driver printed out, the refusal and
    the exception under it, and — where there was one — every byte of the
    recording.
    """
    monkeypatch.setattr(livekit_plug, "AGENT_JOIN_SECONDS", 0.05)
    caplog.set_level(logging.DEBUG)
    stub = RoomStub(greeting="Front desk.", replies=["Noted."], agent_joins=agent_joins)

    produced: list[str] = []
    try:
        _conducted, _turns, _measures, assembled = await room_walk(
            tmp_path, stub, monkeypatch, agent_name="front-desk", scenario="One point."
        )
        recording = (tmp_path / assembled.audio["recording"]).read_bytes()
        produced.append(recording.decode("latin-1"))
    except PlugError as refused:
        produced += [str(refused), repr(refused.__cause__)]

    produced += [record.getMessage() for record in caplog.records]
    produced += [created.metadata for created in stub.rooms]
    produced += [dispatch.metadata for dispatch in stub.dispatches]
    produced.append(repr(stub.backends[0]))

    assert any(produced), "there was nothing to scan, which always passes"
    for piece in produced:
        assert A_SECRET not in piece


# -- The room is always cleaned up -------------------------------------------


async def test_the_room_is_deleted_however_the_simulation_ends(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A room that outlived its simulation would go on costing the
    customer, so it is deleted on every way out: the natural end, a limit,
    a cancel directive, and a fault."""
    natural = RoomStub(greeting="Front desk.", replies=["Noted."])
    await room_walk(tmp_path, natural, monkeypatch, scenario="One point.")
    assert natural.deleted == [natural.rooms[0].name]

    limited = RoomStub(greeting="Front desk.", replies=["One.", "Two.", "Three."])
    conducted, _turns, _measures, _assembled = await room_walk(
        tmp_path,
        limited,
        monkeypatch,
        scenario="First. Second. Third. Fourth.",
        max_turns=3,
    )
    assert conducted.ending == "limit_reached"
    assert limited.deleted == [limited.rooms[0].name]

    canceled = RoomStub(greeting="Front desk.", replies=["Noted."])
    conducted, _turns, _measures, _assembled = await room_walk(
        tmp_path,
        canceled,
        monkeypatch,
        controls=CancelsOnceUnderWay(),
        scenario="One point.",
    )
    assert conducted.status == "canceled"
    assert canceled.deleted == [canceled.rooms[0].name]

    faulted = RoomStub(refuses_dispatch="the project is over its agent quota")
    with pytest.raises(PlugError):
        await room_walk(
            tmp_path, faulted, monkeypatch, agent_name="front-desk", scenario="One."
        )
    assert faulted.deleted == [faulted.rooms[0].name]


class CancelsOnceUnderWay(WalkControls):
    """A cancel directive that lands after the exchange has opened.

    A directive really arrives on a heartbeat answer, mid-exchange; a walk
    canceled before it opened would never have made a room, and would
    prove nothing about deleting one.
    """

    def __init__(self) -> None:
        super().__init__()
        self._steps = 0

    async def guard(self, coroutine):
        self._steps += 1
        if self._steps > 1:
            self.request_cancel()
        return await super().guard(coroutine)


async def test_closing_a_simulation_that_never_opened_asks_for_nothing():
    """``close`` is called whatever happened, including before ``open`` —
    and a simulation that never made a room must not spend a call
    deleting one, because that call could only fail."""
    stub = RoomStub()
    plug = room(stub)
    await plug.close()
    await plug.close()
    assert stub.rooms == [], "nothing was ever made"
    assert stub.deleted == [], "nothing was ever there to delete"


# -- Connections the plug does not understand --------------------------------


@pytest.mark.parametrize(
    "connection",
    [
        ({}, {"apiKey": A_KEY, "apiSecret": A_SECRET}),
        ({"url": ""}, {"apiKey": A_KEY, "apiSecret": A_SECRET}),
        ({"url": 7}, {"apiKey": A_KEY, "apiSecret": A_SECRET}),
        ({"url": "livekit.cloud"}, {"apiKey": A_KEY, "apiSecret": A_SECRET}),
        ({"url": A_URL, "agentName": 7}, {"apiKey": A_KEY, "apiSecret": A_SECRET}),
        (
            {"url": A_URL, "agentName": AN_AGENT, "metadata": 7},
            {"apiKey": A_KEY, "apiSecret": A_SECRET},
        ),
        (
            {"url": A_URL, "agentName": AN_AGENT, "urls": A_URL},
            {"apiKey": A_KEY, "apiSecret": A_SECRET},
        ),
        ({"url": A_URL, "agentName": AN_AGENT}, None),
        ({"url": A_URL, "agentName": AN_AGENT}, {}),
        ({"url": A_URL, "agentName": AN_AGENT}, {"apiKey": A_KEY}),
        (
            {"url": A_URL, "agentName": AN_AGENT},
            {"apiKey": A_KEY, "apiSecret": ""},
        ),
        (
            {"url": A_URL, "agentName": AN_AGENT},
            {"apiKey": A_KEY, "apiSecret": A_SECRET, "token": "x"},
        ),
    ],
)
def test_a_connection_the_plug_cannot_use_is_refused(connection: tuple):
    config, credentials = connection
    with pytest.raises(PlugError):
        LiveKitRoom(
            modality="voice",
            access_variant=(
                "livekit_room.customer_token_endpoint"
                if "tokenEndpoint" in config
                else "livekit_room.project_credentials"
            ),
            config=config,
            credentials=credentials,
            simulation_id=A_SIMULATION,
        )


def test_a_config_typo_is_named_in_the_refusal():
    with pytest.raises(PlugError) as refusal:
        room(RoomStub(), agentNmae="a typo")
    assert "agentNmae" in str(refusal.value)


def test_a_refusal_about_a_credential_never_quotes_one():
    """The refusal a blank secret gets says which field, never what was in
    it — a sentence about a secret must not carry one.

    The connection names its agent, deliberately: the config block is read
    before the credentials, so a nameless one here would be refused for
    the name and prove nothing about a secret.
    """
    with pytest.raises(PlugError) as refusal:
        LiveKitRoom(
            modality="voice",
            access_variant="livekit_room.project_credentials",
            config={"url": A_URL, "agentName": AN_AGENT},
            credentials={"apiKey": A_KEY, "apiSecret": "   "},
            simulation_id=A_SIMULATION,
        )
    told = str(refusal.value)
    assert "apiSecret" in told
    assert A_SECRET not in told


def test_the_plug_speaks_voice_only():
    with pytest.raises(PlugError) as refusal:
        LiveKitRoom(
            modality="chat",
            access_variant="livekit_room.project_credentials",
            config={"url": A_URL},
            credentials={"apiKey": A_KEY, "apiSecret": A_SECRET},
            simulation_id=A_SIMULATION,
        )
    assert "chat" in str(refusal.value)


def test_the_room_is_made_fresh_and_never_reused():
    """One room per simulation: a room that outlived its own would put two
    simulations on one line."""
    settings = RoomSettings.from_connection(
        "livekit_room.project_credentials",
        {"url": A_URL, "agentName": AN_AGENT},
        {"apiKey": A_KEY, "apiSecret": A_SECRET},
    )
    built = [
        LiveKitRoomBackend(settings=settings, simulation_id=A_SIMULATION).room_name
        for _ in range(2)
    ]
    assert all(name.startswith(f"{ROOM_PREFIX}-") for name in built)
    assert built[0] != built[1]


def test_the_settings_never_show_the_secret_when_they_are_printed():
    """A dataclass printed into a log line is the easiest way to leak
    one, so this one does not carry it."""
    settings = RoomSettings.from_connection(
        "livekit_room.project_credentials",
        {"url": A_URL, "agentName": AN_AGENT},
        {"apiKey": A_KEY, "apiSecret": A_SECRET},
    )
    assert A_SECRET not in repr(settings)
    assert settings.secrets == (A_SECRET,)


# -- The driver seam ---------------------------------------------------------


def taken_by(method) -> list[tuple[str, object]]:
    return [
        (name, parameter.annotation)
        for name, parameter in inspect.signature(method).parameters.items()
    ]


def test_the_room_driver_is_behind_the_four_verb_seam():
    """The same four verbs every media driver has, in the same order and
    with the same shapes — except ``dial``, which reaches for nothing here
    because who to reach is the room's own configuration."""
    for name in ("create_transport", "dial", "wait_answered", "teardown"):
        method = getattr(LiveKitRoomBackend, name, None)
        assert method is not None, f"the room driver has no {name}"
        assert inspect.iscoroutinefunction(method), name
        if name == "dial":
            assert taken_by(method) == [("self", inspect.Parameter.empty)]
            continue
        assert taken_by(method) == taken_by(getattr(MediaBackend, name)), name


def test_the_fake_is_the_real_driver_with_its_network_answered():
    """The claim the fake's fidelity rests on: everything CI exercises
    above the three LiveKit calls it stands in for is the driver a customer's
    server will run. Its fourth override is the explicit test-only route to
    the loopback token endpoint."""
    stub = RoomStub()
    driver = stub.driver(
        settings=RoomSettings.from_connection(
            "livekit_room.project_credentials",
            {"url": A_URL, "agentName": AN_AGENT},
            {"apiKey": A_KEY, "apiSecret": A_SECRET},
        ),
        simulation_id=A_SIMULATION,
    )
    assert isinstance(driver, LiveKitRoomBackend)
    overridden = {
        name
        for name in vars(type(driver))
        if not name.startswith("__") and hasattr(LiveKitRoomBackend, name)
    }
    assert overridden == {
        "_asked",
        "_joined_room",
        "_delete_room",
        "_endpoint_connector",
    }


# -- The golden fixture ------------------------------------------------------


async def test_the_golden_livekit_fixture_is_a_connection_the_plug_accepts(
    tmp_path: Path,
):
    """The fixture the contract package carries is not decoration.

    The plug the simulator would really build for it builds, and the
    pipeline assembles around it — neither of which reaches anywhere, so
    nothing here needs the customer's LiveKit to exist.
    """
    from conftest import load_fixture_spec

    spec = SimulationSpec.from_document(load_fixture_spec("voice-livekit.json"))
    assert spec.agent_platform == "livekit"
    assert spec.connection_type == "livekit_room"
    assert spec.access_variant == "livekit_room.project_credentials"

    plug = plug_for(spec.connection_type)(
        modality=spec.modality,
        access_variant=spec.access_variant,
        config=spec.connection_config,
        credentials=spec.credentials,
        simulation_id=spec.simulation_id,
    )
    assert isinstance(plug, LiveKitRoom)
    assert plug.provider_reference is None, "no room exists before one is made"
    assert plug.backend.room_name.startswith(f"{ROOM_PREFIX}-")

    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
    )
    assert assembled.conductor is not None
    assert assembled.audio is None, "nothing was conducted, so nothing was recorded"


# -- The second way in: the customer mints the token -------------------------
#
# A connection that names a token endpoint keeps the secret that signs
# tokens for the customer's whole LiveKit project on the customer's side.
# egma invents a room and an identity, asks for a token scoped to exactly
# those, joins, and waits — and dispatching is the endpoint's job, because
# egma holds no power to do it.
#
# The endpoint below is not a fake in the sense the room is: it is a real
# HTTP server on loopback, and the driver really posts to it. What is
# proved here about the request and about every answer is therefore proved
# about the code, over a socket.


@pytest.mark.parametrize(
    "token_endpoint",
    [
        "https://127.0.0.1/egma/livekit-token",
        "https://10.0.0.4/egma/livekit-token",
        "https://169.254.169.254/latest/meta-data",
        "https://0.0.0.0/egma/livekit-token",
        "https://224.0.0.1/egma/livekit-token",
        "https://[::1]/egma/livekit-token",
        "https://[::ffff:127.0.0.1]/egma/livekit-token",
        "https://localhost/egma/livekit-token",
    ],
)
async def test_an_unsafe_token_endpoint_is_refused_before_a_request_leaves_egma(
    token_endpoint: str,
):
    """No stored connection can turn into an internal request."""
    plug = LiveKitRoom(
        modality="voice",
        access_variant="livekit_room.customer_token_endpoint",
        config={"url": A_URL, "tokenEndpoint": token_endpoint},
        credentials={"headers": AN_AUTH_HEADER},
        simulation_id=A_SIMULATION,
    )

    with pytest.raises(PlugError) as refused:
        await plug.prepare()
    await plug.close()

    assert "non-public network address" in str(refused.value)


def test_a_saved_http_token_endpoint_is_refused_before_auth_headers_leave_egma():
    """A malformed record cannot send a secret or token over cleartext."""
    with pytest.raises(MediaBackendError) as refused:
        RoomSettings.from_connection(
            "livekit_room.customer_token_endpoint",
            {
                "url": A_URL,
                "tokenEndpoint": "http://tokens.example/egma/livekit-token",
            },
            {"headers": AN_AUTH_HEADER},
        )

    assert "https" in str(refused.value)


@pytest.mark.parametrize(
    ("addresses", "opens_socket"),
    [
        (["127.0.0.1"], False),
        (["::1"], False),
        (["::ffff:127.0.0.1"], False),
        (["169.254.169.254"], False),
        (["224.0.0.1"], False),
        (["93.184.216.34", "10.0.0.4"], False),
        (["93.184.216.34"], True),
    ],
)
async def test_a_token_endpoint_name_must_resolve_only_to_public_addresses(
    addresses: list[str], opens_socket: bool, monkeypatch: pytest.MonkeyPatch
):
    """The checked address is the address the socket would connect to."""

    class Resolver:
        async def resolve(
            self, host: str, port: int = 0, family: int = socket.AF_UNSPEC
        ) -> list[dict[str, object]]:
            del family
            return [
                {
                    "hostname": host,
                    "host": address,
                    "port": port,
                    "family": socket.AF_INET6 if ":" in address else socket.AF_INET,
                    "proto": socket.IPPROTO_TCP,
                    "flags": socket.AI_NUMERICHOST,
                }
                for address in addresses
            ]

        async def close(self) -> None:
            return None

    settings = RoomSettings.from_connection(
        "livekit_room.customer_token_endpoint",
        {"url": A_URL, "tokenEndpoint": "https://tokens.example/token"},
        {"headers": AN_AUTH_HEADER},
    )
    driver = LiveKitRoomBackend(
        settings=settings,
        simulation_id=A_SIMULATION,
        endpoint_resolver=Resolver(),
    )
    opened: list[tuple[object, ...]] = []

    def record_socket(*arguments: object, **keywords: object) -> socket.socket:
        del keywords
        opened.append(arguments)
        raise OSError("test stopped after the address policy")

    monkeypatch.setattr(livekit_room_module.socket, "socket", record_socket)

    with pytest.raises(MediaBackendError) as refused:
        await driver.create_transport()

    diagnosis = str(refused.value)
    if opens_socket:
        assert "could not be reached over HTTPS" in diagnosis
    else:
        assert "non-public network address" in diagnosis
    assert bool(opened) is opens_socket


async def test_an_unexpected_endpoint_client_bug_is_not_hidden_as_customer_fault():
    """Only known network failures become safe customer-facing messages."""

    class BrokenResolver:
        async def resolve(self, *_arguments: object) -> list[dict[str, object]]:
            raise RuntimeError("SENTINEL programming failure")

        async def close(self) -> None:
            return None

    settings = RoomSettings.from_connection(
        "livekit_room.customer_token_endpoint",
        {"url": A_URL, "tokenEndpoint": "https://tokens.example/token"},
        {"headers": AN_AUTH_HEADER},
    )
    driver = LiveKitRoomBackend(
        settings=settings,
        simulation_id=A_SIMULATION,
        endpoint_resolver=BrokenResolver(),
    )

    with pytest.raises(RuntimeError, match="SENTINEL programming failure"):
        await driver.create_transport()


async def test_a_token_endpoint_spec_conducts_a_whole_simulation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The whole story, end to end, with no LiveKit and no network.

    A spec whose connection names an endpoint becomes a conversation: the
    endpoint is asked, the token comes back, egma joins with it, the agent
    somebody else dispatched turns up, and the record carries the room.
    """
    stub = RoomStub(
        greeting="Lakeside Dental, how can I help?",
        replies=["Of course — could I take your name?", "Booked for Thursday."],
    )
    with serving(token="minted.by.the.customer") as endpoint:
        conducted, turns, _measures, assembled = await room_walk(
            tmp_path,
            stub,
            monkeypatch,
            built_by=livekit_endpoint_spec,
            token_endpoint=endpoint.url,
            scenario=(
                "I need to move my Tuesday cleaning to Thursday. "
                "My name is Margaret Hale."
            ),
        )

    assert turns == [
        ("agent", "Lakeside Dental, how can I help?"),
        ("human", "I need to move my Tuesday cleaning to Thursday."),
        ("agent", "Of course — could I take your name?"),
        ("human", "My name is Margaret Hale."),
        ("agent", "Booked for Thursday."),
        ("human", GOODBYE),
    ]
    assert conducted.status == "completed"
    assert conducted.ending == "persona_concluded"

    # One request, and the token it answered is what egma joined with.
    assert len(endpoint.asked) == 1
    assert stub.joined_with[0].token == "minted.by.the.customer"

    # Nothing was created and nothing was dispatched: egma has no power to
    # do either, and the room it joined is the one it asked for a token
    # into.
    assert stub.rooms == []
    assert stub.dispatches == []
    assert conducted.provider_reference == f"{ROOM_PREFIX}-{A_SIMULATION}"

    # And a recording that resolves, exactly as the other shape produces.
    recording = (tmp_path / assembled.audio["recording"]).read_bytes()
    assert_one_speaker_to_a_channel(recording, turns)


async def test_the_endpoint_is_asked_for_the_room_and_identity_egma_will_use(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The request, exactly as the published contract spells it.

    Both names are egma's own invention and both carry the simulation's
    id, so the endpoint can mint a token for exactly the identity egma
    will join as and exactly the room it will join — and refuse anything
    else. The room's prefix is fixed and recognisable on purpose: it is
    what an endpoint allowlists so that nobody can ask it for a token into
    a production room.
    """
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    with serving() as endpoint:
        await room_walk(
            tmp_path,
            stub,
            monkeypatch,
            built_by=livekit_endpoint_spec,
            token_endpoint=endpoint.url,
            scenario="One point.",
        )

    asked = endpoint.asked[0]
    assert asked.body == {
        "room_name": f"{ROOM_PREFIX}-{A_SIMULATION}",
        "participant_name": f"{PERSONA_IDENTITY}-{A_SIMULATION}",
    }
    assert asked.body["room_name"].startswith(f"{ROOM_PREFIX}-")
    assert asked.header("content-type") == "application/json"

    # The identity egma joins with is the one it asked a token for, and it
    # is never the agent's.
    assert asked.body["participant_name"] != AGENT_IDENTITY


async def test_the_endpoints_auth_headers_are_sent_and_go_nowhere_else(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The credential is used for the one thing it is for."""
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    with serving() as endpoint:
        await room_walk(
            tmp_path,
            stub,
            monkeypatch,
            built_by=livekit_endpoint_spec,
            token_endpoint=endpoint.url,
            scenario="One point.",
        )

    assert endpoint.asked[0].header("authorization") == f"Bearer {A_HEADER_SECRET}"


@pytest.mark.parametrize("credentials", [None, {}])
def test_a_token_endpoint_without_auth_headers_is_refused_before_a_request(
    credentials: object,
):
    """Every token endpoint is authenticated; there is no legacy shape."""
    with serving() as endpoint:
        with pytest.raises(PlugError) as refused:
            LiveKitRoom(
                modality="voice",
                access_variant="livekit_room.customer_token_endpoint",
                config={"url": A_URL, "tokenEndpoint": endpoint.url},
                credentials=credentials,
                simulation_id=A_SIMULATION,
                driver=RoomStub().driver,
            )

        assert endpoint.asked == []
    assert "headers" in str(refused.value)


@pytest.mark.parametrize("alias", ["token", "participantToken", "accessToken"])
async def test_a_token_under_any_of_the_three_names_is_taken(alias: str):
    """Accepting the spread is what makes the endpoints already out there
    reusable as they are, rather than each team writing a second handler
    for egma."""
    stub = RoomStub(greeting="Front desk.")
    with serving(token="under.this.name", alias=alias) as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        await plug.prepare()
        await plug.open()
        await plug.close()

    assert stub.joined_with[0].token == "under.this.name"


async def test_the_endpoints_own_server_url_is_where_egma_joins():
    """The override: an endpoint that knows which of several LiveKit
    projects this agent lives in says so, and egma goes there."""
    stub = RoomStub(greeting="Front desk.")
    with serving(server_url="wss://elsewhere.livekit.cloud") as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        await plug.prepare()
        await plug.open()
        await plug.close()

    assert stub.joined_with[0].url == "wss://elsewhere.livekit.cloud"


async def test_the_connections_own_url_is_where_egma_joins_without_one():
    """And where the answer names none, the connection's url stands."""
    stub = RoomStub(greeting="Front desk.")
    with serving() as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        await plug.prepare()
        await plug.open()
        await plug.close()

    assert stub.joined_with[0].url == A_URL


# -- Every way an endpoint answers badly -------------------------------------


async def test_a_token_endpoint_response_body_never_reaches_the_simulation_error():
    """An internal HTTP response is not customer-visible diagnostic text."""
    internal_body = "SENTINEL internal service response must stay private"
    with serving(status=500, raw=internal_body) as endpoint:
        plug = endpoint_room(RoomStub(), endpoint.url)
        with pytest.raises(PlugError) as refused:
            await plug.prepare()
        await plug.close()

    told = str(refused.value)
    assert "answered 500" in told
    assert internal_body not in told


async def test_a_token_endpoint_response_is_bounded_before_json_parsing():
    """A customer endpoint cannot make one simulation hold an unbounded body."""
    with serving(raw="x" * (TOKEN_RESPONSE_BYTES + 1)) as endpoint:
        plug = endpoint_room(RoomStub(), endpoint.url)
        with pytest.raises(PlugError) as refused:
            await plug.prepare()
        await plug.close()

    told = str(refused.value)
    assert f"more than {TOKEN_RESPONSE_BYTES} bytes" in told
    assert "x" * 100 not in told


@pytest.mark.parametrize(
    ("named", "scripted", "diagnosis", "private_text"),
    [
        (
            "a refusal",
            {"status": 401, "raw": '{"error":"that key is not ours"}'},
            "answered 401",
            "that key is not ours",
        ),
        (
            "a server that broke",
            {"status": 500, "raw": "<html><title>Internal Server Error</title>"},
            "answered 500",
            "Internal Server Error",
        ),
        (
            "something that is not JSON at all",
            {"raw": "<html><body>proxy: no upstream</body></html>"},
            "not a JSON object",
            "no upstream",
        ),
        (
            "JSON that is not an object",
            {"raw": '["a token would go here"]'},
            "not a JSON object",
            "a token would go here",
        ),
        (
            "an object with no token under any of the names it could be",
            {"body": {"jwt": "wrong-key-entirely"}},
            "answered no token",
            "wrong-key-entirely",
        ),
        (
            "a token that is there and blank",
            {"body": {"token": "   ", "detail": "SENTINEL blank token"}},
            "answered no token",
            "SENTINEL blank token",
        ),
        (
            "a serverUrl that is not a string",
            {"body": {"token": "fine.token.here", "serverUrl": 7}},
            "serverUrl that is not a string",
            "fine.token.here",
        ),
        (
            "a serverUrl egma cannot join",
            {"body": {"token": "fine.token.here", "serverUrl": "sip:acme.example"}},
            "serverUrl Egma cannot join",
            "sip:acme.example",
        ),
    ],
)
async def test_an_endpoint_that_answers_badly_names_the_contract_not_its_body(
    named: str, scripted: dict, diagnosis: str, private_text: str
):
    """The error stays useful without turning an HTTP body into output."""
    stub = RoomStub()
    with serving(**scripted) as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        with pytest.raises(PlugError) as refused:
            await plug.prepare()
        await plug.close()
        served = endpoint.wire_url

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert served in told, "the reason has to name what was asked"
    assert diagnosis in told, f"{named}: the broken contract part is the diagnosis"
    assert private_text not in told, f"{named}: response text reached the error"
    assert A_HEADER_SECRET not in told


async def test_a_token_the_endpoint_minted_is_never_quoted_back():
    """A good token inside a bad answer never becomes diagnostic text.

    The refusal names the broken ``serverUrl`` contract and hides the whole
    endpoint body. Registering the token as a secret also protects later error
    paths that may handle it.
    """
    minted = "a.working.token.nobody.should.read"
    stub = RoomStub()
    with serving(body={"token": minted, "serverUrl": 17}) as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        with pytest.raises(PlugError) as refused:
            await plug.prepare()
        await plug.close()

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert "serverUrl" in told, "the handler still has to see what to fix"
    assert minted not in told, "the endpoint's token was quoted back"
    assert A_HEADER_SECRET not in told


@pytest.mark.parametrize(
    ("named", "status"),
    [("a server error", 500), ("a refusal", 403), ("a redirect", 302)],
)
async def test_a_token_in_a_failing_answer_is_never_quoted_back(
    named: str, status: int
):
    """An endpoint can fail and still have minted a working credential.

    A 500 whose body carries a token, a 403 that echoes one back, and a
    redirect that answers with one all report only the status. The response
    body is never copied into the simulation error.
    """
    minted = "a.token.the.failure.still.carried"
    stub = RoomStub()
    with serving(status=status, body={"token": minted}) as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        with pytest.raises(PlugError) as refused:
            await plug.prepare()
        await plug.close()

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert str(status) in told, f"{named}: the status is the diagnosis"
    assert minted not in told, f"{named}: a minted token was quoted back"
    assert A_HEADER_SECRET not in told


async def test_an_endpoint_that_redirects_is_answered_rather_than_followed():
    """A redirect is an answer, not an instruction.

    Following one would carry the customer's own auth headers to a host
    they never configured, chosen by whoever answered — so egma reads the
    status and stops, and says so in the same words it uses for any other
    status it cannot work with.
    """
    stub = RoomStub()
    with serving(status=302, body={"token": "never.minted.here"}) as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        with pytest.raises(PlugError) as refused:
            await plug.prepare()
        await plug.close()

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert "302" in told, "the status it stopped on is the diagnosis"
    assert A_HEADER_SECRET not in told


async def test_an_endpoint_that_answers_nowhere_is_a_fault_naming_it(
    monkeypatch: pytest.MonkeyPatch,
):
    """A public HTTPS name can fail without exposing a network exception."""

    class PublicResolver:
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

    def closed_socket(*_arguments: object, **_keywords: object) -> socket.socket:
        raise OSError("SENTINEL private network exception")

    monkeypatch.setattr(livekit_room_module.socket, "socket", closed_socket)
    endpoint = "https://tokens.example:443/egma/livekit-token"
    settings = RoomSettings.from_connection(
        "livekit_room.customer_token_endpoint",
        {"url": A_URL, "tokenEndpoint": endpoint},
        {"headers": AN_AUTH_HEADER},
    )
    driver = LiveKitRoomBackend(
        settings=settings,
        simulation_id=A_SIMULATION,
        endpoint_resolver=PublicResolver(),
    )

    with pytest.raises(MediaBackendError) as refused:
        await driver.create_transport()

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert endpoint in told
    assert "could not be reached" in told
    assert "SENTINEL" not in told
    assert A_HEADER_SECRET not in told


async def test_the_agent_nobody_dispatched_is_the_endpoints_duty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The room opened, the token was minted, and nobody came.

    Nothing was tested, so nothing is graded — and the reason says whose
    job the missing half was, because on this shape it was never egma's.
    """
    monkeypatch.setattr(livekit_plug, "AGENT_JOIN_SECONDS", 0.05)
    stub = RoomStub(agent_joins=False)

    with serving() as endpoint:
        with pytest.raises(PlugError) as never_came:
            await room_walk(
                tmp_path,
                stub,
                monkeypatch,
                built_by=livekit_endpoint_spec,
                token_endpoint=endpoint.url,
                scenario="One point.",
            )

    assert failed_ending(never_came.value) == AGENT_NEVER_JOINED
    assert AGENT_NEVER_JOINED in FAILED_ENDINGS
    told = str(never_came.value)
    assert "token endpoint minted a token" in told
    assert "nothing dispatched the agent" in told
    assert "the endpoint's own job" in told
    # And never the advice from the other shape, which nobody here can act
    # on: there is no key pair to dispatch with.
    assert "automatic dispatch" not in told


# -- A room egma cannot delete is left, not deleted --------------------------


async def test_a_room_egma_cannot_delete_is_left_however_the_simulation_ends(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A token minted to join one room carries no power to delete it.

    So egma leaves and the room stands empty for a moment, and the
    customer's own empty timeout on ``egma-sim-`` rooms closes it. Trying
    the delete anyway would spend a request to be refused and write a log
    line about a failure that was never one — on every path out, which is
    what this walks.
    """
    for named, overrides, expected in [
        ("a natural end", {}, "persona_concluded"),
        ("a limit", {"max_turns": 3}, "limit_reached"),
    ]:
        stub = RoomStub(greeting="Front desk.", replies=["One.", "Two.", "Three."])
        with serving() as endpoint:
            conducted, _turns, _measures, _assembled = await room_walk(
                tmp_path,
                stub,
                monkeypatch,
                built_by=livekit_endpoint_spec,
                token_endpoint=endpoint.url,
                scenario="First. Second. Third.",
                **overrides,
            )
        assert conducted.ending == expected, named
        assert stub.deleted == [], named

    canceled = RoomStub(greeting="Front desk.", replies=["Noted."])
    with serving() as endpoint:
        conducted, _turns, _measures, _assembled = await room_walk(
            tmp_path,
            canceled,
            monkeypatch,
            built_by=livekit_endpoint_spec,
            token_endpoint=endpoint.url,
            controls=CancelsOnceUnderWay(),
            scenario="One point.",
        )
    assert conducted.status == "canceled"
    assert canceled.deleted == []

    # And the fault path, where the endpoint itself said no: nothing was
    # ever joined, so there is nothing to leave and nothing to delete.
    faulted = RoomStub()
    with serving(status=503, raw="upstream is down") as endpoint:
        with pytest.raises(PlugError):
            await room_walk(
                tmp_path,
                faulted,
                monkeypatch,
                built_by=livekit_endpoint_spec,
                token_endpoint=endpoint.url,
                scenario="One point.",
            )
    assert faulted.deleted == []


# -- The endpoint's credential, followed everywhere it could surface ---------


@pytest.mark.parametrize("agent_joins", [True, False])
async def test_nothing_a_token_endpoint_simulation_produces_carries_the_header(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    agent_joins: bool,
):
    """The sentinel scan, on the path that works and the path that does not.

    An ``Authorization: Bearer …`` header is a reusable credential:
    whoever holds it can ask the customer's endpoint for a token. So a
    whole simulation runs with it really in the process, and then
    everything it produced is read for it — every log line, the settings
    and the driver printed out, the refusal and the exception under it,
    and, where there was one, every byte of the recording.
    """
    monkeypatch.setattr(livekit_plug, "AGENT_JOIN_SECONDS", 0.05)
    caplog.set_level(logging.DEBUG)
    stub = RoomStub(greeting="Front desk.", replies=["Noted."], agent_joins=agent_joins)

    produced: list[str] = []
    with serving() as endpoint:
        try:
            _conducted, _turns, _measures, assembled = await room_walk(
                tmp_path,
                stub,
                monkeypatch,
                built_by=livekit_endpoint_spec,
                token_endpoint=endpoint.url,
                scenario="One point.",
            )
            recording = (tmp_path / assembled.audio["recording"]).read_bytes()
            produced.append(recording.decode("latin-1"))
        except PlugError as refused:
            produced += [str(refused), repr(refused.__cause__)]

    produced += [record.getMessage() for record in caplog.records]
    produced.append(repr(stub.backends[0]))
    produced.append(repr(stub.backends[0]._settings))

    assert any(produced), "there was nothing to scan, which always passes"
    for piece in produced:
        assert A_HEADER_SECRET not in piece


async def test_an_endpoint_that_says_the_header_back_still_leaks_nothing():
    """A careless endpoint can echo the header it was just sent straight
    into its own error body. The driver is what has to survive that."""
    stub = RoomStub()
    with serving(status=403, raw=f"forbidden for Bearer {A_HEADER_SECRET}") as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        with pytest.raises(PlugError) as refused:
            await plug.prepare()
        await plug.close()

    told = str(refused.value)
    assert A_HEADER_SECRET not in told
    assert "answered 403" in told
    assert "forbidden" not in told


def test_the_settings_never_show_the_endpoints_headers_when_printed():
    """A dataclass printed into a log line is the easiest way to leak a
    credential, so this one does not carry one either."""
    settings = RoomSettings.from_connection(
        "livekit_room.customer_token_endpoint",
        {"url": A_URL, "tokenEndpoint": "https://acme.example/token"},
        {"headers": AN_AUTH_HEADER},
    )
    assert A_HEADER_SECRET not in repr(settings)
    # The whole header value, not the part after the scheme: that is how
    # it goes on the wire and how an endpoint would echo it back.
    assert settings.secrets == (f"Bearer {A_HEADER_SECRET}",)


# -- Connections of the second shape that the plug cannot use ----------------


@pytest.mark.parametrize(
    "connection",
    [
        # An endpoint egma cannot post to: the two url keys the wrong way
        # round, which is the mistake this shape invites.
        ({"url": A_URL, "tokenEndpoint": "wss://acme.livekit.cloud"}, None),
        ({"url": A_URL, "tokenEndpoint": "acme.example/token"}, None),
        ({"url": A_URL, "tokenEndpoint": "   "}, None),
        # No server to join, whatever the endpoint mints.
        ({"tokenEndpoint": "https://acme.example/token"}, None),
        # Powers this shape does not have, refused rather than ignored.
        (
            {
                "url": A_URL,
                "tokenEndpoint": "https://acme.example/token",
                "agentName": "front-desk",
            },
            None,
        ),
        (
            {
                "url": A_URL,
                "tokenEndpoint": "https://acme.example/token",
                "metadata": '{"tenant":"acme"}',
            },
            None,
        ),
        # A key pair has no place on it, and headers that egma cannot send
        # are a connection nobody can use.
        (
            {"url": A_URL, "tokenEndpoint": "https://acme.example/token"},
            {"apiKey": A_KEY, "apiSecret": A_SECRET},
        ),
        (
            {"url": A_URL, "tokenEndpoint": "https://acme.example/token"},
            {"headers": "Authorization: Bearer x"},
        ),
        (
            {"url": A_URL, "tokenEndpoint": "https://acme.example/token"},
            {"headers": '{"Authorization":""}'},
        ),
        (
            {"url": A_URL, "tokenEndpoint": "https://acme.example/token"},
            {"headers": "{}"},
        ),
    ],
)
def test_a_token_endpoint_connection_the_plug_cannot_use_is_refused(
    connection: tuple,
):
    config, credentials = connection
    with pytest.raises(PlugError):
        LiveKitRoom(
            modality="voice",
            access_variant=(
                "livekit_room.customer_token_endpoint"
                if "tokenEndpoint" in config
                else "livekit_room.project_credentials"
            ),
            config=config,
            credentials=credentials,
            simulation_id=A_SIMULATION,
        )


def test_a_refusal_about_the_endpoints_headers_never_quotes_one():
    with pytest.raises(PlugError) as refusal:
        LiveKitRoom(
            modality="voice",
            access_variant="livekit_room.customer_token_endpoint",
            config={"url": A_URL, "tokenEndpoint": "https://acme.example/token"},
            credentials={"headers": f"Bearer {A_HEADER_SECRET}"},
            simulation_id=A_SIMULATION,
        )
    told = str(refusal.value)
    assert "headers" in told
    assert A_HEADER_SECRET not in told


async def test_the_golden_token_endpoint_fixture_is_a_connection_the_plug_accepts(
    tmp_path: Path,
):
    """The second shape's fixture in the contract package, built for real."""
    from conftest import load_fixture_spec

    spec = SimulationSpec.from_document(
        load_fixture_spec("voice-livekit-token-endpoint.json")
    )
    assert spec.agent_platform == "livekit"
    assert spec.connection_type == "livekit_room"
    assert spec.access_variant == "livekit_room.customer_token_endpoint"

    plug = plug_for(spec.connection_type)(
        modality=spec.modality,
        access_variant=spec.access_variant,
        config=spec.connection_config,
        credentials=spec.credentials,
        simulation_id=spec.simulation_id,
    )
    assert isinstance(plug, LiveKitRoom)
    # Named after the simulation, because the endpoint being asked has to
    # be able to check the name against its own rules.
    assert plug.backend.room_name == f"{ROOM_PREFIX}-{spec.simulation_id}"

    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
    )
    assert assembled.conductor is not None
