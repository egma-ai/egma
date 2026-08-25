"""The phone connection and the media backend seam it uses.

A phone connection owns the call lifecycle: prepare one Pipecat transport,
dial, wait for an answer, report the carrier's refusal when there is one,
and tear everything down. Pipecat owns audio frames, conversion, pacing,
and recording. No PCM exchange or processing rate crosses the connection
seam.

The scripted backend proves the whole phone path without a carrier or a
network. One full simulation also proves that the existing recording
reference still resolves to a playable, two-channel WAV.
"""

from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass
from pathlib import Path

import pytest
from conftest import assert_one_speaker_to_a_channel, phone_spec

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.config import MediaSettings
from egma_simulator.contract import ERROR, NOT_ANSWERED
from egma_simulator.media import (
    BACKENDS,
    NOT_ANSWERED_STATUSES,
    MediaBackend,
    MediaBackendError,
    VoiceMedia,
    backend_for,
    sip_refusal,
)
from egma_simulator.media.livekit import LiveKitBackend
from egma_simulator.media.scripted import REFUSALS, ScriptedBackend
from egma_simulator.model import GOODBYE, ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.pipeline import Assembled, assemble
from egma_simulator.plugs import PlugError, VoiceConnection, plug_for
from egma_simulator.plugs import phone as phone_module
from egma_simulator.plugs.phone import BACKEND_VARIABLE, PhoneCall
from egma_simulator.recording import channels_of
from egma_simulator.redaction import REDACTED, SecretRegistry
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import SCRIPTED_PAIR
from egma_simulator.walk import Conducted, WalkControls

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


def test_the_registry_knows_the_phone_connection():
    assert plug_for("phone_number") is PhoneCall


def test_a_phone_call_is_one_pipecat_voice_connection():
    """The seam carries transport processors, not PCM or a media clock."""
    connection = phone({"replies": ["Noted."]})
    assert isinstance(connection, VoiceConnection)
    assert not hasattr(connection, "exchange")
    assert not hasattr(connection, "sample_rate_hz")
    assert not hasattr(connection, "measured_band_hz")


class _WatchedBackend:
    """A backend that records lifecycle calls without starting media."""

    def __init__(self) -> None:
        self.ended = asyncio.Event()
        self.steps: list[object] = []

    async def create_transport(self) -> VoiceMedia:
        self.steps.append("prepare")
        return VoiceMedia(input=(), output=(), ended=self.ended)

    async def dial(self, number: str) -> None:
        self.steps.append(("dial", number))

    async def wait_answered(self, seconds: float) -> str:
        self.steps.append(("wait_answered", seconds))
        return "watched-call-1"

    async def teardown(self) -> None:
        self.steps.append("teardown")
        self.ended.set()


async def test_the_connection_drives_the_backend_lifecycle_once(
    monkeypatch: pytest.MonkeyPatch,
):
    backend = _WatchedBackend()
    built_with: dict[str, object] = {}

    def factory(**arguments: object) -> _WatchedBackend:
        built_with.update(arguments)
        return backend

    monkeypatch.setattr(phone_module, "backend_for", lambda _name: factory)
    connection = phone()

    media = await connection.prepare()
    assert isinstance(media, VoiceMedia)
    assert built_with == {
        "settings": SCRIPTED,
        "config": {},
        "caller_id": None,
    }

    await connection.open()
    assert connection.provider_reference == "watched-call-1"
    assert backend.steps[:3] == [
        "prepare",
        ("dial", A_NUMBER),
        ("wait_answered", phone_module.RINGING_SECONDS),
    ]

    backend.ended.set()
    assert connection.far_end_left
    await connection.close()
    assert backend.steps == [
        "prepare",
        ("dial", A_NUMBER),
        ("wait_answered", phone_module.RINGING_SECONDS),
        "teardown",
    ]


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
            traits=spec.persona_traits,
            scenario_instructions=spec.scenario_instructions,
            model=ScriptedModel(spec.scenario_instructions),
        ),
        max_turns=spec.limits.max_turns,
        max_duration_seconds=spec.limits.max_duration_seconds,
        controls=WalkControls(),
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
    assert set(audio) == {"recording"}
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


async def test_closing_a_call_that_was_never_prepared_or_dialled_is_safe():
    connection = phone({"replies": ["Noted."]})
    await connection.close()
    await connection.close()


@pytest.mark.parametrize(
    ("outcome", "ending", "quoted"),
    [
        ("busy", NOT_ANSWERED, "486"),
        ("no_answer", NOT_ANSWERED, "480"),
        ("declined", NOT_ANSWERED, "603"),
        ("carrier_failure", ERROR, "503"),
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


async def test_a_trunk_the_carrier_rejects_is_a_dial_time_fault():
    connection = phone({"outcome": "trunk_rejected"})
    await connection.prepare()
    try:
        with pytest.raises(PlugError) as refused:
            await connection.open()
    finally:
        await connection.close()

    assert refused.value.ending == ERROR
    assert "403" in str(refused.value)


def test_a_simulator_that_places_no_calls_refuses_a_number_by_name():
    with pytest.raises(PlugError) as refusal:
        phone({"replies": ["Noted."]}, media=None)
    assert BACKEND_VARIABLE in str(refusal.value)


def test_the_busy_and_declined_statuses_are_the_far_end_and_not_the_path():
    for status_code, _phrase in REFUSALS.values():
        refusal = sip_refusal(status_code)
        answered_by_the_phone = status_code in NOT_ANSWERED_STATUSES
        assert refusal.ending == (NOT_ANSWERED if answered_by_the_phone else ERROR)
    assert 486 in NOT_ANSWERED_STATUSES
    assert 503 not in NOT_ANSWERED_STATUSES


def test_a_carrier_refusal_carries_its_words_and_not_a_secret():
    secrets = SecretRegistry()
    secrets.register(["SENTINEL-trunk-abc"])
    refusal = sip_refusal(
        401,
        "Unauthorized",
        told=secrets.redact("auth failed for egma with password SENTINEL-trunk-abc"),
    )
    assert "401" in str(refusal)
    assert "SENTINEL-trunk-abc" not in str(refusal)
    assert REDACTED in str(refusal)


@pytest.mark.parametrize(
    "config",
    [
        {},
        {"phoneNumber": ""},
        {"phoneNumber": 15551234567},
        {"phoneNumber": A_NUMBER, "phoneNumbre": "a typo"},
        {"phoneNumber": A_NUMBER, "callerId": 7},
        {"phoneNumber": A_NUMBER, "backend": "a-backend-nobody-wrote"},
        {"phoneNumber": A_NUMBER, "scripted": "not a script"},
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


def test_a_script_the_backend_does_not_understand_is_refused():
    with pytest.raises(PlugError) as refusal:
        phone({"repliez": ["a typo, not a script"]})
    assert "repliez" in str(refusal.value)


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


def test_the_connection_speaks_voice_only():
    with pytest.raises(PlugError) as refusal:
        PhoneCall(
            modality="chat",
            access_variant="phone_number.public_e164",
            config={"phoneNumber": A_NUMBER},
            credentials=None,
            media=SCRIPTED,
        )
    assert "chat" in str(refusal.value)


def test_the_deployment_is_what_places_the_call():
    connection = PhoneCall(
        modality="voice",
        access_variant="phone_number.public_e164",
        config={"phoneNumber": A_NUMBER},
        credentials=None,
        media=SCRIPTED,
    )
    assert isinstance(connection.backend, ScriptedBackend)


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


def taken_by(method) -> list[tuple[str, object]]:
    """One method's parameter names and annotations."""
    return [
        (name, parameter.annotation)
        for name, parameter in inspect.signature(method).parameters.items()
    ]


def test_every_registered_backend_is_behind_the_transport_seam():
    for backend_name in BACKENDS:
        driver = backend_for(backend_name)
        assert driver is not None, backend_name
        constructed = inspect.signature(driver.__init__).parameters
        assert {"settings", "config", "caller_id"} <= set(constructed), backend_name
        assert "band_hz" not in constructed, backend_name
        for name in ("create_transport", "dial", "wait_answered", "teardown"):
            method = getattr(driver, name, None)
            assert method is not None, f"{backend_name} has no {name}"
            assert inspect.iscoroutinefunction(method), f"{backend_name}.{name}"
            assert taken_by(method) == taken_by(getattr(MediaBackend, name)), (
                f"{backend_name}.{name}"
            )


async def test_the_scripted_backend_prepares_voice_media():
    backend = ScriptedBackend(settings=SCRIPTED, config={}, caller_id=None)
    media = await backend.create_transport()
    assert isinstance(media, VoiceMedia)
    assert media.input
    assert media.output
    assert not hasattr(media, "send")
    assert not hasattr(media, "receive")
    await backend.teardown()
    assert media.ended.is_set()


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


def test_the_livekit_driver_is_built_without_reaching_anything():
    backend = LiveKitBackend(
        settings=livekit_settings(),
        config={},
        caller_id=None,
    )
    assert backend.room_name.startswith("egma-sim-")
    other = LiveKitBackend(
        settings=livekit_settings(),
        config={},
        caller_id=None,
    )
    assert other.room_name != backend.room_name


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


def test_the_livekit_driver_reads_no_connection_config():
    with pytest.raises(MediaBackendError) as refusal:
        LiveKitBackend(
            settings=livekit_settings(),
            config={"replies": ["Noted."]},
            caller_id=None,
        )
    told = str(refusal.value)
    assert "connection config" in told
    assert "work order" in told
