from __future__ import annotations

import asyncio
import base64
import json

import pytest
from pipecat.frames.frames import OutputAudioRawFrame, SpeechOutputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.openai.live import events
from websockets.asyncio.server import serve

from egma_simulator.contract import validate_spec
from egma_simulator.conversation import ConversationControls
from egma_simulator.live import LiveConductor, _TranscriptLedger
from egma_simulator.media import PlayoutStamp, VoiceMedia
from egma_simulator.model import PersonaReply, PersonaToolCall
from egma_simulator.persona import Persona, compose_live_prompt
from egma_simulator.spec import (
    AuthoredPersona,
    LiveSelection,
    PersonaParameters,
    SimulationSpec,
)
from egma_simulator.speech import gained_speech_frame
from egma_simulator.usage import ProviderUsage, live_duration_usage


def authored(**changes) -> AuthoredPersona:
    fields = {
        "language": "English",
        "emotion": "anxious",
        "accent": "irish",
        "interruption_level": "none",
    }
    fields.update(changes)
    return AuthoredPersona(
        name="Mara",
        personality="Careful and direct.",
        language="English",
        parameters=PersonaParameters(**fields),
    )


def test_live_prompt_keeps_conversation_controls_and_delegates_scenario() -> None:
    prompt = compose_live_prompt(authored(), "Ask to move the appointment to Thursday.")

    assert "Mara" in prompt
    assert "Careful and direct" in prompt
    assert "English" in prompt
    assert "anxious" in prompt
    assert "irish accent" in prompt
    assert "Wait quietly" in prompt
    assert "Do not overlap" in prompt
    assert "Ask to move the appointment to Thursday." in prompt
    assert "Delegate decisions about the situation" in prompt

    fast_prompt = compose_live_prompt(
        authored(speech_speed="fast", tts_speed=1.5), "Ask about an appointment."
    )
    assert "about 1.5x" in fast_prompt


async def test_live_transcript_preserves_source_intervals_and_overlap() -> None:
    partials = []
    utterances = []

    async def partial(text, began, ended):
        partials.append((text, began, ended))

    async def utterance(speaker, text, began, ended):
        utterances.append((speaker, text, began, ended))

    ledger = _TranscriptLedger(on_partial=partial)
    ledger.session_started_unix_nano = 1_000_000_000
    await ledger.observe(
        events.TranscriptDeltaEvent(
            type="session.output_transcript.delta",
            delta="Hello",
            start_ms=100,
            end_ms=500,
        )
    )
    await ledger.observe(
        events.TranscriptDeltaEvent(
            type="session.input_transcript.delta",
            delta="Hi",
            start_ms=350,
            end_ms=650,
        )
    )
    await ledger.observe(
        events.TranscriptDeltaEvent(
            type="session.output_transcript.delta",
            delta=" there",
            start_ms=500,
            end_ms=700,
        )
    )
    await ledger.finish("assistant", utterance)
    await ledger.flush(utterance)

    assert partials == []
    assert utterances == [
        ("human", "Hello there", 1_100_000_000, 1_700_000_000),
        ("agent", "Hi", 1_350_000_000, 1_650_000_000),
    ]


async def test_live_transcript_measures_non_overlapping_agent_response() -> None:
    measured = []

    async def measurement(name, began, ended):
        measured.append((name, began, ended))

    ledger = _TranscriptLedger(on_measured=measurement)
    ledger.session_started_unix_nano = 1_000_000_000
    await ledger.observe(
        events.TranscriptDeltaEvent(
            type="session.output_transcript.delta",
            delta="How can I help?",
            start_ms=100,
            end_ms=400,
        )
    )
    await ledger.finish("assistant")
    await ledger.observe(
        events.TranscriptDeltaEvent(
            type="session.input_transcript.delta",
            delta="Check my balance.",
            start_ms=650,
            end_ms=900,
        )
    )
    await ledger.finish("user")

    assert measured == [
        ("first_response_latency", 1_400_000_000, 1_650_000_000),
        ("turn_response_latency", 1_400_000_000, 1_650_000_000),
        ("agent_speech_duration", 1_650_000_000, 1_900_000_000),
    ]


def test_live_duration_uses_one_cumulative_snapshot() -> None:
    measured = live_duration_usage(
        events.Usage(seconds=12.25),
        selection_model="gpt-live-1",
        session_id="live_123",
    )

    assert measured is not None
    assert measured.operation == "openai_live"
    assert measured.quantities == {"audio_seconds": 12.25}
    assert measured.provider_ref == "live_123"
    assert measured.raw == {"seconds": 12.25}


def test_speech_gain_applies_to_live_audio() -> None:
    frame = SpeechOutputAudioRawFrame(
        audio=(1000).to_bytes(2, "little", signed=True),
        sample_rate=24_000,
        num_channels=1,
    )

    gained_speech_frame(frame, 0.5)

    assert int.from_bytes(frame.audio, "little", signed=True) == 500


def test_v7_live_work_order_needs_no_stt_or_tts() -> None:
    document = {
        "contract_version": 7,
        "simulation_id": "sim-live",
        "modality": "voice",
        "connection": {
            "agent_platform": "livekit_agents",
            "connection_type": "livekit_room",
            "access_variant": "livekit.token_endpoint",
            "config": {},
            "credentials": None,
        },
        "persona": {
            "name": "Mara",
            "personality": "Careful",
            "parameters": {
                "language": "English",
                "emotion": "neutral",
                "accent": "voice_default",
                "speech_speed": "normal",
                "tts_speed": 1,
                "speech_volume": 1,
                "interruption_level": "none",
                "execution_policy_version": 2,
            },
        },
        "scenario": {"instructions": "Ask for help."},
        "limits": {"max_duration_seconds": 30, "max_turns": 8},
        "models": {
            "mode": "live",
            "llm": {
                "provider": "openai",
                "model": "gpt-5.6-luna",
                "adapter": "openai_chat_completions",
                "key": "backend-key",
            },
            "live": {
                "provider": "openai",
                "model": "gpt-live-1",
                "adapter": "openai_live",
                "voice_id": "marin",
                "key": "live-key",
            },
        },
    }

    validate_spec(document)
    spec = SimulationSpec.from_document(document)
    assert "live-key" in spec.secrets
    assert "backend-key" in spec.secrets
    assert "live-key" not in repr(spec)


class _BackendModel:
    model_name = "gpt-5.6-luna"

    def __init__(self, *, concluded: bool = False) -> None:
        self.requests = []
        self.concluded = concluded

    async def reply(self, context):
        self.requests.append(context.get_messages())
        return PersonaReply(
            text="The caller should ask for the account balance.",
            concluded=False,
            tool_calls=(
                PersonaToolCall(
                    tool_call_id="call_end", name="end_call", arguments={}
                ),
            )
            if self.concluded
            else (),
            usage=ProviderUsage(
                provider="openai",
                model=self.model_name,
                operation="openai_chat_completions",
                measurement="provider_reported",
                quantities={"input_tokens": 4, "output_tokens": 6},
            ),
        )

    async def close(self) -> None:
        return None


class _OutputObserved(FrameProcessor):
    def __init__(self, observed: asyncio.Event, stopped: asyncio.Event) -> None:
        super().__init__()
        self.observed = observed
        self.stopped = stopped

    async def process_frame(self, frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, OutputAudioRawFrame):
            self.observed.set()
        if frame.__class__.__name__ == "TTSStoppedFrame":
            self.stopped.set()
        await self.push_frame(frame, direction)


class _Connection:
    provider_reference = "call-controlled"
    far_end_left = False

    def __init__(self, ended: asyncio.Event) -> None:
        self.ended = ended
        self.closed = False
        self.output_observed = asyncio.Event()
        self.output_stopped = asyncio.Event()

    async def prepare(self) -> VoiceMedia:
        return VoiceMedia(
            input=(),
            output=(
                PlayoutStamp(),
                _OutputObserved(self.output_observed, self.output_stopped),
            ),
            ended=self.ended,
        )

    async def open(self) -> None:
        return None

    async def close(self) -> None:
        self.closed = True


class _Blobs:
    def __init__(self) -> None:
        self.writes = []

    async def write(self, key: str, value: bytes) -> str:
        self.writes.append((key, value))
        return "recording://controlled"


async def test_live_conductor_uses_backend_and_final_cumulative_usage() -> None:
    ended = asyncio.Event()
    server_closed = asyncio.Event()
    output_observed: asyncio.Event | None = None

    async def provider(socket) -> None:
        started = json.loads(await socket.recv())
        assert started["type"] == "session.start"
        assert started["session"]["model"] == "gpt-live-1"
        assert started["session"]["audio"]["output"]["voice"] == "marin"
        await socket.send(
            json.dumps(
                {
                    "type": "session.started",
                    "session": {"id": "live_controlled", "status": "active"},
                }
            )
        )
        await socket.send(
            json.dumps(
                {
                    "type": "session.input_transcript.delta",
                    "delta": "I need help",
                    "start_ms": 100,
                    "end_ms": 400,
                }
            )
        )
        await socket.send(
            json.dumps(
                {
                    "type": "session.delegation.created",
                    "delegation": {
                        "id": "delegation_1",
                        "type": "delegation",
                        "target": "client",
                    },
                }
            )
        )
        while True:
            message = json.loads(await socket.recv())
            if (
                message["type"] == "session.commentary.append"
                and message.get("delegation_id") == "delegation_1"
            ):
                break
        await socket.send(
            json.dumps(
                {
                    "type": "session.output_transcript.delta",
                    "delta": "I can help.",
                    "start_ms": 300,
                    "end_ms": 700,
                }
            )
        )
        await socket.send(
            json.dumps(
                {
                    "type": "session.output_audio.delta",
                    "delta": base64.b64encode(b"\xe8\x03" * 240).decode(),
                }
            )
        )
        await socket.send(
            json.dumps({"type": "session.usage.updated", "usage": {"seconds": 3}})
        )
        await socket.send(
            json.dumps({"type": "session.usage.updated", "usage": {"seconds": 2}})
        )
        assert output_observed is not None
        await output_observed.wait()
        ended.set()
        async for raw in socket:
            message = json.loads(raw)
            if message["type"] == "session.close":
                await socket.send(
                    json.dumps(
                        {
                            "type": "session.closed",
                            "reason": "client_close",
                            "usage": {"seconds": 4},
                        }
                    )
                )
                server_closed.set()
                return

    async with serve(provider, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        model = _BackendModel()
        connection = _Connection(ended)
        output_observed = connection.output_observed
        blobs = _Blobs()
        conductor = LiveConductor(
            connection=connection,
            selection=LiveSelection(
                provider="openai",
                model="gpt-live-1",
                adapter="openai_live",
                voice_id="marin",
                key="controlled-key",
            ),
            backend_model=model,
            blobs=blobs,
            recording_key="sim/dual-channel.wav",
            speech_volume=0.5,
            _base_url=f"ws://127.0.0.1:{port}",
        )
        turns = []
        partials = []
        usages = []

        async def collect_turn(*turn) -> None:
            turns.append(turn)

        async def collect_partial(*fragment) -> None:
            partials.append(fragment)

        async def collect_usage(usage) -> None:
            usages.append(usage)

        result = await conductor.conduct(
            persona=Persona(
                authored=authored(),
                scenario_instructions="Ask for the account balance.",
                model=model,
            ),
            max_turns=8,
            max_duration_seconds=10,
            controls=ConversationControls(),
            name="controlled-live",
            on_utterance=collect_turn,
            on_partial_utterance=collect_partial,
            on_measured=lambda *_: asyncio.sleep(0),
            on_provider_usage=collect_usage,
        )

    assert result.ending == "agent_ended"
    assert connection.closed
    assert server_closed.is_set()
    assert model.requests
    assert len(model.requests) == 1
    assert "account balance" in json.dumps(model.requests)
    assert {usage.model for usage in usages} == {"gpt-5.6-luna", "gpt-live-1"}
    assert sum(usage.model == "gpt-live-1" for usage in usages) == 1
    assert sum(usage.model == "gpt-5.6-luna" for usage in usages) == 1
    live_usage = next(usage for usage in usages if usage.model == "gpt-live-1")
    assert live_usage.quantities == {"audio_seconds": 4}
    assert live_usage.provider_ref == "live_controlled"
    assert partials == []
    assert turns[0][2] < turns[1][3]
    assert conductor.audio is not None
    assert blobs.writes


async def test_live_conductor_cancels_both_workers_without_false_transcript() -> None:
    ready = asyncio.Event()
    ended = asyncio.Event()

    async def provider(socket) -> None:
        assert json.loads(await socket.recv())["type"] == "session.start"
        await socket.send(
            json.dumps(
                {
                    "type": "session.started",
                    "session": {"id": "live_cancel", "status": "active"},
                }
            )
        )
        await socket.send(
            json.dumps(
                {
                    "type": "session.output_transcript.delta",
                    "delta": "This was generated but never played.",
                    "start_ms": 0,
                    "end_ms": 900,
                }
            )
        )
        ready.set()
        await socket.wait_closed()

    async with serve(provider, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        controls = ConversationControls()
        connection = _Connection(ended)
        turns = []
        conductor = LiveConductor(
            connection=connection,
            selection=LiveSelection(
                provider="openai",
                model="gpt-live-1",
                adapter="openai_live",
                voice_id="marin",
                key="controlled-key",
            ),
            backend_model=_BackendModel(),
            blobs=_Blobs(),
            recording_key="sim/canceled.wav",
            speech_volume=1,
            _base_url=f"ws://127.0.0.1:{port}",
        )
        task = asyncio.create_task(
            conductor.conduct(
                persona=Persona(
                    authored=authored(),
                    scenario_instructions="Ask one question.",
                    model=_BackendModel(),
                ),
                max_turns=8,
                max_duration_seconds=30,
                controls=controls,
                name="controlled-cancel",
                on_utterance=lambda *turn: turns.append(turn) or asyncio.sleep(0),
                on_measured=lambda *_: asyncio.sleep(0),
            )
        )
        await ready.wait()
        controls.request_cancel()
        result = await task

    assert result.status == "canceled"
    assert connection.closed
    assert turns == []
    assert conductor.audio is None


@pytest.mark.parametrize(
    ("max_turns", "cancel_goodbye", "filler", "expected_ending"),
    [
        (8, False, False, "persona_concluded"),
        (1, False, False, "limit_reached"),
        (8, True, False, "canceled"),
        (8, False, True, "persona_concluded"),
    ],
)
async def test_live_conductor_waits_for_concluding_goodbye_playout(
    max_turns: int, cancel_goodbye: bool, filler: bool, expected_ending: str
) -> None:
    ended = asyncio.Event()
    output_observed: asyncio.Event | None = None
    close_seen = asyncio.Event()
    controls = ConversationControls()

    async def provider(socket) -> None:
        await socket.recv()
        await socket.send(
            json.dumps(
                {
                    "type": "session.started",
                    "session": {"id": "live_goodbye", "status": "active"},
                }
            )
        )
        if filler:
            await socket.send(
                json.dumps(
                    {
                        "type": "session.output_transcript.delta",
                        "delta": "Let me think.",
                        "start_ms": 0,
                        "end_ms": 250,
                    }
                )
            )
            await socket.send(
                json.dumps(
                    {
                        "type": "session.output_audio.delta",
                        "delta": base64.b64encode(b"\xe8\x03" * 6_000).decode(),
                    }
                )
            )
        await socket.send(
            json.dumps(
                {
                    "type": "session.delegation.created",
                    "delegation": {
                        "id": "goodbye_delegation",
                        "type": "delegation",
                        "target": "client",
                    },
                }
            )
        )
        while True:
            message = json.loads(await socket.recv())
            if message.get("delegation_id") == "goodbye_delegation":
                break
        if filler:
            await connection.output_stopped.wait()
            connection.output_observed.clear()
        await socket.send(
            json.dumps(
                {
                    "type": "session.output_transcript.delta",
                    "delta": "Thanks, goodbye.",
                    "start_ms": 0,
                    "end_ms": 500,
                }
            )
        )
        await socket.send(
            json.dumps(
                {
                    "type": "session.output_audio.delta",
                    "delta": base64.b64encode(b"\xe8\x03" * 12_000).decode(),
                }
            )
        )
        assert output_observed is not None
        await output_observed.wait()
        if cancel_goodbye:
            controls.request_cancel()
        while True:
            message = json.loads(await socket.recv())
            if message["type"] == "session.close":
                close_seen.set()
                await socket.send(
                    json.dumps(
                        {"type": "session.closed", "reason": "client_close"}
                    )
                )
                return

    async with serve(provider, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        connection = _Connection(ended)
        output_observed = connection.output_observed
        model = _BackendModel(concluded=True)
        turns = []
        conductor = LiveConductor(
            connection=connection,
            selection=LiveSelection(
                provider="openai",
                model="gpt-live-1",
                adapter="openai_live",
                voice_id="marin",
                key="controlled-key",
            ),
            backend_model=model,
            blobs=_Blobs(),
            recording_key="sim/goodbye.wav",
            speech_volume=1,
            _base_url=f"ws://127.0.0.1:{port}",
        )
        result = await conductor.conduct(
            persona=Persona(
                authored=authored(),
                scenario_instructions="Conclude after one answer.",
                model=model,
            ),
            max_turns=max_turns,
            max_duration_seconds=10,
            controls=controls,
            name="controlled-goodbye",
            on_utterance=lambda *turn: turns.append(turn) or asyncio.sleep(0),
            on_measured=lambda *_: asyncio.sleep(0),
        )

    assert result.ending == expected_ending
    if not cancel_goodbye:
        assert close_seen.is_set()
    if cancel_goodbye:
        assert turns == []
    else:
        expected_texts = (
            ["Let me think.", "Thanks, goodbye."]
            if filler
            else ["Thanks, goodbye."]
        )
        assert [turn[1] for turn in turns] == expected_texts


async def test_live_conductor_cleans_up_after_provider_failure() -> None:
    ended = asyncio.Event()

    async def provider(socket) -> None:
        await socket.recv()
        await socket.send(
            json.dumps(
                {
                    "type": "session.started",
                    "session": {"id": "live_failed", "status": "active"},
                }
            )
        )
        await socket.close(code=1011, reason="controlled provider failure")

    async with serve(provider, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        connection = _Connection(ended)
        model = _BackendModel()
        conductor = LiveConductor(
            connection=connection,
            selection=LiveSelection(
                provider="openai",
                model="gpt-live-1",
                adapter="openai_live",
                voice_id="marin",
                key="controlled-key",
            ),
            backend_model=model,
            blobs=_Blobs(),
            recording_key="sim/failed.wav",
            speech_volume=1,
            _base_url=f"ws://127.0.0.1:{port}",
        )
        usages = []
        with pytest.raises(Exception, match="controlled provider failure"):
            await conductor.conduct(
                persona=Persona(
                    authored=authored(),
                    scenario_instructions="Ask one question.",
                    model=model,
                ),
                max_turns=8,
                max_duration_seconds=30,
                controls=ConversationControls(),
                name="controlled-failure",
                on_utterance=lambda *_: asyncio.sleep(0),
                on_measured=lambda *_: asyncio.sleep(0),
                on_provider_usage=lambda usage: usages.append(usage)
                or asyncio.sleep(0),
            )

    assert connection.closed
    assert usages == []
    assert not [
        task
        for task in asyncio.all_tasks()
        if task is not asyncio.current_task()
        and not task.done()
        and (
            task.get_name().startswith("live-pipeline:")
            or task.get_name().startswith("turn-gap:")
        )
    ]


async def test_live_conductor_enforces_duration_limit_and_closes_session() -> None:
    ended = asyncio.Event()

    async def provider(socket) -> None:
        await socket.recv()
        await socket.wait_closed()

    async with serve(provider, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        connection = _Connection(ended)
        model = _BackendModel()
        conductor = LiveConductor(
            connection=connection,
            selection=LiveSelection(
                provider="openai",
                model="gpt-live-1",
                adapter="openai_live",
                voice_id="marin",
                key="controlled-key",
            ),
            backend_model=model,
            blobs=_Blobs(),
            recording_key="sim/duration.wav",
            speech_volume=1,
            _base_url=f"ws://127.0.0.1:{port}",
        )
        result = await conductor.conduct(
            persona=Persona(
                authored=authored(), scenario_instructions="Wait.", model=model
            ),
            max_turns=8,
            max_duration_seconds=0,
            controls=ConversationControls(),
            name="controlled-duration",
            on_utterance=lambda *_: asyncio.sleep(0),
            on_measured=lambda *_: asyncio.sleep(0),
        )

    assert result.ending == "limit_reached"
    assert connection.closed
