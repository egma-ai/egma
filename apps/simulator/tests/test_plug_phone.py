"""Exercise phone lifecycle through the scripted backend without a carrier.
Check answer/refusal handling, config refusals, LiveKit cleanup, and
a full simulation with a resolvable stereo WAV recording.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest
from conftest import assert_one_speaker_to_a_channel, phone_spec

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.config import MediaSettings
from egma_simulator.contract import ERROR, NOT_ANSWERED
from egma_simulator.conversation import Conducted, ConversationControls
from egma_simulator.media import VoiceMedia, backend_for
from egma_simulator.media.livekit import LiveKitBackend, _private_phone_reference
from egma_simulator.media.scripted import ScriptedBackend
from egma_simulator.model import GOODBYE, ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.pipeline import Assembled, assemble
from egma_simulator.plugs import PlugError
from egma_simulator.plugs.phone import PhoneCall
from egma_simulator.recording import channels_of
from egma_simulator.redaction import REDACTED
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import SCRIPTED_PAIR

A_NUMBER = "+15551234567"

SCRIPTED = MediaSettings(backend="scripted")
"""A deployment that places calls through the scripted backend."""

PLATFORM = {
    "carrier": {
        "trunk_address": "scripted-carrier.example.com",
        "trunk_number": "+15550100100",
        "trunk_username": "scripted-trunk-user",
        "trunk_password": "SENTINEL-scripted-trunk-password",
    }
}
"""A complete credential-authenticated route for contract-valid phone work."""


def phone(script: dict | None = None, *, media=SCRIPTED, **config) -> PhoneCall:
    """One phone connection against the scripted backend."""
    whole = {"phoneNumber": A_NUMBER} | config
    if script is not None:
        whole["scripted"] = script
    return PhoneCall(
        modality="voice",
        access_variant="phone_number.public_e164",
        config=whole,
        credentials=None,
        media=media,
    )


@dataclass(frozen=True)
class _PhoneRun:
    conducted: Conducted
    assembled: Assembled
    turns: list[tuple[str, str]]
    connection: PhoneCall


async def _conduct_phone(tmp_path: Path, **overrides: object) -> _PhoneRun:
    """Conduct one phone spec through the production Pipecat path."""
    spec = SimulationSpec.from_document(
        phone_spec(
            "sim-phone-plug",
            number=A_NUMBER,
            platform=PLATFORM,
            **overrides,
        )
    )
    assembled = assemble(
        spec,
        blobs=FilesystemBlobStore(tmp_path),
        media=SCRIPTED,
        speech=SCRIPTED_PAIR,
    )
    conductor = assembled.conductor
    assert conductor is not None
    connection = conductor._connection
    assert isinstance(connection, PhoneCall)
    turns: list[tuple[str, str]] = []

    async def on_utterance(
        speaker: str,
        text: str,
        _began: int,
        _ended: int,
    ) -> None:
        turns.append((speaker, text))

    async def on_measured(_measure: str, _began: int, _ended: int) -> None:
        return None

    conducted = await conductor.conduct(
        persona=Persona(
            authored=spec.persona,
            scenario_instructions=spec.scenario_instructions,
            model=ScriptedModel(spec.scenario_instructions),
        ),
        max_turns=spec.limits.max_turns,
        max_duration_seconds=spec.limits.max_duration_seconds,
        controls=ConversationControls(),
        name="sim:phone-plug-test",
        on_utterance=on_utterance,
        on_measured=on_measured,
    )
    return _PhoneRun(
        conducted=conducted,
        assembled=assembled,
        turns=turns,
        connection=connection,
    )


async def test_a_phone_spec_dials_converses_records_and_tears_down(tmp_path: Path):
    run = await _conduct_phone(
        tmp_path,
        scenario=(
            "I need to move my Tuesday cleaning to Thursday. My name is Margaret Hale."
        ),
        greeting="Lakeside Dental, how can I help?",
        replies=["Of course — could I take your name?", "Booked for Thursday."],
    )

    assert run.conducted.status == "completed"
    assert run.conducted.ending == "persona_concluded"
    assert run.conducted.provider_reference == "scripted-sip-participant-1"
    assert run.turns == [
        ("agent", "Lakeside Dental, how can I help?"),
        ("human", "I need to move my Tuesday cleaning to Thursday."),
        ("agent", "Of course — could I take your name?"),
        ("human", "My name is Margaret Hale."),
        ("agent", "Booked for Thursday."),
        ("human", GOODBYE),
    ]

    backend = run.connection.backend
    assert isinstance(backend, ScriptedBackend)
    assert backend.dialled == [A_NUMBER]
    assert backend.transport.ended.is_set(), "teardown left the transport running"

    audio = run.assembled.audio
    assert audio is not None
    assert set(audio) == {"recording", "waveform"}
    assert "://" not in audio["recording"]
    recording = (tmp_path / audio["recording"]).read_bytes()
    assert channels_of(recording)[2] > 0
    assert_one_speaker_to_a_channel(recording, run.turns)


async def test_the_far_end_hanging_up_keeps_its_last_words_and_recording(
    tmp_path: Path,
):
    run = await _conduct_phone(
        tmp_path,
        scenario="I have another question. I also need to confirm my name.",
        greeting="Front desk.",
        replies=["All sorted, goodbye now."],
        hangs_up_after_replies=True,
    )

    assert run.conducted.ending == "agent_ended"
    assert ("agent", "All sorted, goodbye now.") in run.turns
    audio = run.assembled.audio
    assert audio is not None
    assert (tmp_path / audio["recording"]).exists()


@pytest.mark.parametrize(
    ("outcome", "ending", "quoted"),
    [
        ("busy", NOT_ANSWERED, "486"),
        ("trunk_rejected", ERROR, "403"),
    ],
)
async def test_a_call_nobody_took_fails_honestly_and_names_what_happened(
    outcome: str,
    ending: str,
    quoted: str,
):
    connection = phone({"outcome": outcome})
    await connection.prepare()
    try:
        with pytest.raises(PlugError) as refused:
            await connection.open()
    finally:
        await connection.close()

    told = str(refused.value)
    assert quoted in told, "the carrier's own status has to be on the record"
    assert refused.value.ending == ending
    assert "agent" not in told.lower()


@pytest.mark.parametrize(
    "config",
    [
        {},
    ],
)
def test_config_the_connection_does_not_understand_is_refused(config: dict):
    with pytest.raises(PlugError):
        PhoneCall(
            modality="voice",
            access_variant="phone_number.public_e164",
            config=config,
            credentials=None,
            media=SCRIPTED,
        )


def test_a_config_typo_is_named_in_the_refusal():
    with pytest.raises(PlugError) as refusal:
        phone(phoneNumbre="a typo")
    assert "phoneNumbre" in str(refusal.value)


def test_a_script_for_a_backend_this_deployment_does_not_use_is_refused():
    livekit = MediaSettings(
        backend="livekit",
        livekit_url="ws://127.0.0.1:1",
        livekit_api_key="key",
        livekit_api_secret="secret",
        trunk_address="test.pstn.twilio.com",
        trunk_number="+15550100100",
        trunk_username="test-trunk-user",
        trunk_password="SENTINEL-test-trunk-password",
    )
    with pytest.raises(PlugError) as refusal:
        PhoneCall(
            modality="voice",
            access_variant="phone_number.public_e164",
            config={
                "phoneNumber": A_NUMBER,
                "scripted": {"replies": ["Noted."]},
            },
            credentials=None,
            media=livekit,
        )
    assert "scripted" in str(refusal.value)


def test_credentials_on_a_phone_connection_are_refused():
    with pytest.raises(PlugError) as refusal:
        PhoneCall(
            modality="voice",
            access_variant="phone_number.public_e164",
            config={"phoneNumber": A_NUMBER},
            credentials={"apiKey": "SENTINEL-not-read-here"},
            media=SCRIPTED,
        )
    told = str(refusal.value)
    assert "work order" in told
    assert "SENTINEL-not-read-here" not in told


def test_a_deployment_handed_no_backend_does_not_read_the_environment(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("EGMA_SIMULATOR_MEDIA_BACKEND", "scripted")
    with pytest.raises(PlugError) as refusal:
        PhoneCall(
            modality="voice",
            access_variant="phone_number.public_e164",
            config={"phoneNumber": A_NUMBER},
            credentials=None,
            media=None,
        )
    told = str(refusal.value)
    assert "places no phone calls" in told
    assert "EGMA_SIMULATOR_MEDIA_BACKEND" in told
    assert "platform" not in told


def test_an_unknown_backend_name_is_nobody():
    assert backend_for("daily") is None
    assert backend_for("scripted") is ScriptedBackend
    assert backend_for("livekit") is LiveKitBackend


def livekit_settings(**overrides) -> MediaSettings:
    return MediaSettings(
        **{
            "backend": "livekit",
            "livekit_url": "ws://127.0.0.1:1",
            "livekit_api_key": "key",
            "livekit_api_secret": "test-livekit-secret-at-least-32-bytes",
            "trunk_address": "test.pstn.twilio.com",
        }
        | overrides
    )


def test_the_livekit_provider_reference_keeps_the_private_destination_out():
    number = "+15551234567"
    assert _private_phone_reference(f"sip_{number}_call", number) == (
        f"sip_{REDACTED}_call"
    )


async def test_the_livekit_driver_builds_voice_media_without_a_fixed_rate(
    monkeypatch: pytest.MonkeyPatch,
):
    deleted: list[str] = []

    async def delete_room(*, room_name: str, **_kwargs) -> None:
        deleted.append(room_name)

    monkeypatch.setattr("egma_simulator.media.livekit.delete_room", delete_room)
    backend = LiveKitBackend(
        settings=livekit_settings(),
        config={},
        caller_id=None,
    )
    media = await backend.create_transport()
    assert isinstance(media, VoiceMedia)
    assert media.input
    assert media.output
    await backend.teardown()
    assert deleted == [backend.room_name]
