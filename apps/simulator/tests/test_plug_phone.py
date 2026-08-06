"""The phone plug, and the driver seam it stands on.

The plug's whole job is a call's lifecycle — dial, hear the answer, carry
speech both ways, notice the far end hanging up, end deliberately — so
what is pinned here is exactly that, against the scripted media backend:
no LiveKit server, no trunk, no carrier, no network.

The failure paths get the same treatment, because a call that never
became a conversation is the outcome a phone plug has to be honest about:
each one ends the simulation ``failed`` with a reason naming what the
carrier said, and none of them ever reads as the agent failing.

The seam itself is proved here too. Two drivers sit behind it — the
LiveKit one and the scripted one — and a test that reads their surfaces
against the protocol is what makes "a Daily driver is one new module"
true by construction rather than by hope.
"""

from __future__ import annotations

import inspect

import pytest
from conftest import SENTINEL_TRUNK_ENV

from egma_simulator.media import (
    BACKENDS,
    NOT_ANSWERED_STATUSES,
    MediaBackend,
    MediaBackendError,
    MediaSession,
    backend_for,
    sip_refusal,
    without_secrets,
)
from egma_simulator.media.livekit import LiveKitBackend, LiveKitSettings
from egma_simulator.media.scripted import REFUSALS, ScriptedBackend
from egma_simulator.plugs import ERROR, NOT_ANSWERED, PlugError, plug_for
from egma_simulator.plugs.phone import (
    DEFAULT_BAND_HZ,
    SPEECH_LEVEL,
    PhoneCall,
    carries_speech,
    negotiated_band,
)
from egma_simulator.redaction import REDACTED
from egma_simulator.speech import decode_speech, encode_speech, silence

A_NUMBER = "+15551234567"


def phone(script: dict | None = None, **config) -> PhoneCall:
    """One phone plug against the scripted backend, dialling a number."""
    whole = {"phoneNumber": A_NUMBER, "backend": "scripted"} | config
    if script is not None:
        whole["scripted"] = script
    return PhoneCall(modality="voice", config=whole, credentials=None)


def said(speech) -> str:
    """What one answered turn actually carried, read out of its samples."""
    return decode_speech(speech.audio.pcm, speech.audio.sample_rate_hz)


def test_the_registry_knows_the_phone_plug():
    assert plug_for("phone") is PhoneCall


# -- One whole call ----------------------------------------------------------


async def test_the_plug_dials_converses_and_hangs_up():
    plug = phone(
        {
            "greeting": "Lakeside Dental, how can I help?",
            "replies": ["Of course — could I take your name?", "Booked for Thursday."],
        }
    )
    assert plug.provider_reference is None, "no call exists before it is placed"

    answered = await plug.open()
    assert said(answered) == "Lakeside Dental, how can I help?"
    assert answered.ended is False
    # The join to the bridge's own telemetry, the way the chat plug offers
    # Retell's chat id.
    assert plug.provider_reference == "scripted-sip-participant-1"
    assert plug.backend.dialled == [A_NUMBER]

    first = await plug.deliver(_utterance("I need to move my cleaning."))
    assert said(first) == "Of course — could I take your name?"
    second = await plug.deliver(_utterance("Margaret Hale."))
    assert said(second) == "Booked for Thursday."
    await plug.close()

    # And the far end's side of the same story: both persona turns really
    # went down the line, in order.
    heard = [decode_speech(pcm, DEFAULT_BAND_HZ) for pcm in plug.backend.session.heard]
    assert heard == ["I need to move my cleaning.", "Margaret Hale."]


async def test_a_line_that_answers_and_says_nothing_lets_the_persona_speak_first():
    """A phone answered in silence is ordinary, and it is not a fault."""
    plug = phone({"replies": ["Go on."]})
    answered = await plug.open()
    assert answered.audio is None
    assert answered.ended is False
    await plug.close()


async def test_a_turn_the_far_end_answers_with_nothing_is_a_turn_without_words():
    """The budget for quiet is spent in audio, so this costs CI nothing.

    Without it the turn would wait on a far end that never speaks until
    the simulation's duration limit, and the record would say "limit
    reached" about a line nobody was talking on.
    """
    plug = phone({"replies": ["Only one thing to say."]})
    await plug.open()
    assert said(await plug.deliver(_utterance("First point."))) == (
        "Only one thing to say."
    )

    spent = await plug.deliver(_utterance("Second point."))
    assert spent.audio is None
    assert spent.ended is False
    await plug.close()


async def test_the_far_end_hanging_up_ends_the_exchange_with_its_last_words():
    """The SIP participant leaving the room is the agent ending it, and
    what it said on the way out is still on the record."""
    plug = phone(
        {
            "greeting": "Front desk.",
            "replies": ["All sorted, goodbye now."],
            "hangs_up_after_replies": True,
        }
    )
    await plug.open()

    goodbye = await plug.deliver(_utterance("That is everything."))
    assert said(goodbye) == "All sorted, goodbye now."
    assert goodbye.ended is True, "the far end went and the plug did not notice"
    await plug.close()


async def test_a_far_end_that_hangs_up_saying_nothing_still_ends_the_exchange():
    plug = phone({"greeting": "Front desk.", "hangs_up_after_replies": True})
    await plug.open()
    gone = await plug.deliver(_utterance("Hello?"))
    assert gone.audio is None
    assert gone.ended is True
    await plug.close()


async def test_the_quiet_before_the_first_word_is_handed_up_as_quiet():
    """Time-to-first-word is read out of the audio a plug returns, so the
    quiet a line really carried has to be in it — at its real length, and
    as quiet rather than as whatever noise the line was making."""
    plug = phone({"greeting": "Hello there.", "answer_delay_seconds": 0.4})
    answered = await plug.open()
    await plug.close()

    band = answered.audio.sample_rate_hz
    quiet = silence(0.4, band)
    assert answered.audio.pcm == quiet + encode_speech("Hello there.", band)


async def test_closing_a_call_that_was_never_dialled_is_safe():
    """``close`` is called whatever happened, including before ``open``."""
    plug = phone({"replies": ["Noted."]})
    await plug.close()
    await plug.close()


# -- The band ----------------------------------------------------------------


def test_a_phone_call_is_narrowband_unless_the_connection_says_otherwise():
    assert phone().sample_rate_hz == DEFAULT_BAND_HZ == 8000
    assert phone(sample_rate_hz=16000).sample_rate_hz == 16000


@pytest.mark.parametrize(
    ("asked_for", "carried"), [(8000, 8000), (16000, 16000), (48000, 16000), (1, 8000)]
)
def test_the_band_carried_is_the_nearest_one_a_line_can_do(
    asked_for: int, carried: int
):
    assert negotiated_band(asked_for) == carried


# -- Every way a call fails to become a conversation -------------------------


@pytest.mark.parametrize(
    ("outcome", "ending", "quoted"),
    [
        ("busy", NOT_ANSWERED, "486"),
        ("no_answer", NOT_ANSWERED, "480"),
        ("declined", NOT_ANSWERED, "603"),
        ("carrier_failure", ERROR, "503"),
    ],
)
async def test_a_call_nobody_took_fails_honestly_and_names_what_happened(
    outcome: str, ending: str, quoted: str
):
    plug = phone({"outcome": outcome})
    with pytest.raises(PlugError) as refused:
        await plug.open()
    await plug.close()

    told = str(refused.value)
    assert quoted in told, "the carrier's own status has to be on the record"
    assert refused.value.ending == ending
    # Whatever else it says, it never says the agent did anything.
    assert "agent" not in told.lower()


def test_a_trunk_that_cannot_be_used_refuses_before_anything_is_dialled():
    """Construction-time, so no pipeline starts and no number is dialled."""
    with pytest.raises(PlugError) as refused:
        phone({"outcome": "bad_trunk_credentials"})
    assert refused.value.ending == ERROR
    assert "trunk" in str(refused.value)


def test_the_busy_and_declined_statuses_are_the_far_end_and_not_the_path():
    """Otherwise the endings above pin the stub's habits rather than the
    SIP vocabulary every bridge over a trunk surfaces."""
    for status_code, _phrase in REFUSALS.values():
        refusal = sip_refusal(status_code)
        answered_by_the_phone = status_code in NOT_ANSWERED_STATUSES
        assert refusal.ending == (NOT_ANSWERED if answered_by_the_phone else ERROR)
    assert 486 in NOT_ANSWERED_STATUSES  # busy
    assert 503 not in NOT_ANSWERED_STATUSES  # the carrier, not the phone


def test_a_carrier_refusal_carries_its_words_and_not_a_secret():
    told = "auth failed for user egma with password SENTINEL-trunk-abc"
    refusal = sip_refusal(
        401, "Unauthorized", told=without_secrets(told, ("SENTINEL-trunk-abc",))
    )
    assert "401" in str(refusal)
    assert "SENTINEL-trunk-abc" not in str(refusal)
    assert REDACTED in str(refusal)


# -- Config the plug does not understand -------------------------------------


@pytest.mark.parametrize(
    "config",
    [
        {},
        {"phoneNumber": ""},
        {"phoneNumber": 15551234567},
        {"phoneNumber": A_NUMBER, "phoneNumbre": "a typo"},
        {"phoneNumber": A_NUMBER, "callerId": 7},
        {"phoneNumber": A_NUMBER, "sample_rate_hz": "8000"},
        {"phoneNumber": A_NUMBER, "sample_rate_hz": 0},
        {"phoneNumber": A_NUMBER, "backend": "a-bridge-nobody-wrote"},
        {"phoneNumber": A_NUMBER, "scripted": "not a script"},
    ],
)
def test_config_the_plug_does_not_understand_is_refused(config: dict):
    with pytest.raises(PlugError):
        PhoneCall(
            modality="voice",
            config={"backend": "scripted"} | config,
            credentials=None,
        )


def test_a_config_typo_is_named_in_the_refusal():
    with pytest.raises(PlugError) as refusal:
        PhoneCall(
            modality="voice",
            config={"phoneNumber": A_NUMBER, "phoneNumbre": "a typo"},
            credentials=None,
        )
    assert "phoneNumbre" in str(refusal.value)


def test_a_script_for_a_backend_this_call_does_not_use_is_refused():
    """A script nobody reads was written by mistake, and a silently
    ignored one would change nothing while looking like it changed
    everything."""
    with pytest.raises(PlugError) as refusal:
        PhoneCall(
            modality="voice",
            config={
                "phoneNumber": A_NUMBER,
                "backend": "livekit",
                "scripted": {"replies": ["Noted."]},
            },
            credentials=None,
        )
    assert "scripted" in str(refusal.value)


def test_a_script_the_backend_does_not_understand_is_refused():
    with pytest.raises(PlugError) as refusal:
        phone({"repliez": ["a typo, not a script"]})
    assert "repliez" in str(refusal.value)


def test_credentials_on_a_phone_connection_are_refused():
    """The trunk is the deployment's, so a secret sealed onto a phone
    connection is read by nobody — and a secret nothing reads was handed
    over by mistake."""
    with pytest.raises(PlugError) as refusal:
        PhoneCall(
            modality="voice",
            config={"phoneNumber": A_NUMBER, "backend": "scripted"},
            credentials={"apiKey": "SENTINEL-not-read-here"},
        )
    told = str(refusal.value)
    assert "environment" in told
    assert "SENTINEL-not-read-here" not in told


def test_the_plug_speaks_voice_only():
    with pytest.raises(PlugError) as refusal:
        PhoneCall(
            modality="chat",
            config={"phoneNumber": A_NUMBER, "backend": "scripted"},
            credentials=None,
        )
    assert "chat" in str(refusal.value)


def test_a_deployment_names_its_own_default_bridge(monkeypatch: pytest.MonkeyPatch):
    """A spec that says nothing about backends is the ordinary case, and
    which bridge this deployment runs is the deployment's business."""
    monkeypatch.setenv("EGMA_SIMULATOR_MEDIA_BACKEND", "scripted")
    plug = PhoneCall(
        modality="voice", config={"phoneNumber": A_NUMBER}, credentials=None
    )
    assert isinstance(plug.backend, ScriptedBackend)


# -- Hearing the far end -----------------------------------------------------


def test_speech_is_told_from_the_quiet_a_line_carries():
    band = 8000
    assert carries_speech(encode_speech("hello", band))
    assert not carries_speech(silence(0.1, band))
    # A line's own hiss is not somebody talking.
    hiss = (SPEECH_LEVEL - 100).to_bytes(2, "little", signed=True) * 200
    assert not carries_speech(hiss)


# -- The driver seam ---------------------------------------------------------


def taken_by(method) -> list[tuple[str, object]]:
    """What one method is called with, name for name.

    What it answers with is deliberately not compared: a driver naturally
    answers with its own session, and narrowing a return is the one way a
    driver is allowed to differ.
    """
    return [
        (name, parameter.annotation)
        for name, parameter in inspect.signature(method).parameters.items()
    ]


def test_every_registered_backend_is_behind_the_seam():
    """The claim the seam exists to make: two drivers, one surface.

    Read off the drivers themselves rather than asserted about in prose,
    so that a third one — Daily, when somebody wants it — is one new
    module and one registry line or it does not pass this.
    """
    for backend_name in BACKENDS:
        driver = backend_for(backend_name)
        assert driver is not None, backend_name
        # Constructed the one way the plug constructs one.
        constructed = inspect.signature(driver.__init__).parameters
        assert {"config", "band_hz", "caller_id"} <= set(constructed), backend_name
        for name in ("create_session", "dial", "wait_answered", "teardown"):
            method = getattr(driver, name, None)
            assert method is not None, f"{backend_name} has no {name}"
            assert inspect.iscoroutinefunction(method), f"{backend_name}.{name}"
            assert taken_by(method) == taken_by(getattr(MediaBackend, name)), (
                f"{backend_name}.{name}"
            )


def test_a_session_is_the_same_surface_whichever_driver_opened_it():
    from egma_simulator.media.livekit import RoomSession
    from egma_simulator.media.scripted import ScriptedSession

    for session in (RoomSession, ScriptedSession):
        for name in ("send", "receive"):
            assert taken_by(getattr(session, name)) == taken_by(
                getattr(MediaSession, name)
            ), f"{session.__name__}.{name}"
        for name in ("sample_rate_hz", "far_end_left"):
            assert isinstance(getattr(session, name), property), (
                f"{session.__name__}.{name}"
            )


def test_an_unknown_backend_name_is_nobody():
    assert backend_for("daily") is None
    assert backend_for("scripted") is ScriptedBackend
    assert backend_for("livekit") is LiveKitBackend


# -- The LiveKit driver, as far as it goes without a LiveKit ------------------


def livekit_settings(**overrides) -> LiveKitSettings:
    return LiveKitSettings(
        url="ws://127.0.0.1:1",
        api_key="key",
        api_secret="secret",
        trunk_id="ST_trunk",
        **overrides,
    )


def test_the_livekit_driver_is_built_without_reaching_anything():
    """Building is not connecting: a driver constructs here and reaches
    LiveKit only when a call is placed, which is what keeps assembling a
    pipeline the validation step it has always been."""
    backend = LiveKitBackend(
        config={}, band_hz=8000, caller_id=None, settings=livekit_settings()
    )
    assert backend.room_name.startswith("egma-sim-")
    # One room per call, never reused.
    other = LiveKitBackend(
        config={}, band_hz=8000, caller_id=None, settings=livekit_settings()
    )
    assert other.room_name != backend.room_name


def test_the_livekit_driver_reads_no_connection_config():
    with pytest.raises(MediaBackendError) as refusal:
        LiveKitBackend(
            config={"replies": ["Noted."]},
            band_hz=8000,
            caller_id=None,
            settings=livekit_settings(),
        )
    assert "environment" in str(refusal.value)


@pytest.mark.parametrize(
    "missing",
    [
        "EGMA_SIMULATOR_LIVEKIT_URL",
        "EGMA_SIMULATOR_LIVEKIT_API_KEY",
        "EGMA_SIMULATOR_LIVEKIT_API_SECRET",
    ],
)
def test_a_livekit_deployment_missing_a_variable_is_refused_by_name(
    monkeypatch: pytest.MonkeyPatch, missing: str
):
    for name, value in SENTINEL_TRUNK_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv(missing)
    with pytest.raises(MediaBackendError) as refusal:
        LiveKitSettings.from_env()
    assert missing in str(refusal.value)


def test_a_deployment_with_no_trunk_at_all_is_refused_naming_both_ways(
    monkeypatch: pytest.MonkeyPatch,
):
    for name, value in SENTINEL_TRUNK_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("EGMA_SIMULATOR_SIP_TRUNK_ADDRESS")
    with pytest.raises(MediaBackendError) as refusal:
        LiveKitSettings.from_env()
    told = str(refusal.value)
    assert "EGMA_SIMULATOR_SIP_TRUNK_ID" in told
    assert "EGMA_SIMULATOR_SIP_TRUNK_ADDRESS" in told


def test_a_bring_your_own_trunk_arrives_whole_from_the_environment(
    monkeypatch: pytest.MonkeyPatch,
):
    for name, value in SENTINEL_TRUNK_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("EGMA_SIMULATOR_SIP_TRUNK_ID", raising=False)
    settings = LiveKitSettings.from_env()
    assert settings.trunk_address == "egma-test.pstn.twilio.com"
    assert settings.trunk_username == "egma-trunk-user"
    assert settings.trunk_number == "+15550000000"
    # And its secrets are the ones every quoted word gets scrubbed of.
    assert set(settings.secrets) == {
        SENTINEL_TRUNK_ENV["EGMA_SIMULATOR_LIVEKIT_API_SECRET"],
        SENTINEL_TRUNK_ENV["EGMA_SIMULATOR_SIP_TRUNK_PASSWORD"],
    }


def test_the_settings_never_print_their_secrets():
    """A record that lands in a log line by accident says nothing."""
    for name, value in SENTINEL_TRUNK_ENV.items():
        if not value.startswith("SENTINEL-"):
            continue
        settings = LiveKitSettings(
            url="ws://127.0.0.1:1",
            api_key="key",
            api_secret=SENTINEL_TRUNK_ENV["EGMA_SIMULATOR_LIVEKIT_API_SECRET"],
            trunk_id="ST_trunk",
            trunk_password=SENTINEL_TRUNK_ENV["EGMA_SIMULATOR_SIP_TRUNK_PASSWORD"],
        )
        assert value not in repr(settings), name


class OneWire:
    """A transport that keeps whatever was said down it, and nothing else."""

    def __init__(self) -> None:
        self.said: list[bytes] = []

    async def send_audio(self, frame) -> None:
        self.said.append(frame.audio)


async def test_a_real_line_takes_as_long_to_say_a_turn_as_the_turn_lasts():
    """A voice travels in real time, and everything measured about the
    answer depends on the persona having finished before it starts.

    Returning early would put the persona's own speaking time inside every
    time-to-first-word on the record — and this is the one place that can
    be held, because a session over a real line is the only thing that
    knows a line is real.
    """
    import time

    from egma_simulator.media.livekit import RoomSession

    wire = OneWire()
    session = RoomSession(wire, band_hz=8000)
    # Audio that arrived while the persona was still talking: the far end
    # listening, not the far end answering.
    session.note_arrival(encode_speech("interrupting", 8000))

    turn = silence(0.2, 8000)
    started = time.monotonic()
    await session.send(turn)
    spent = time.monotonic() - started

    assert wire.said == [turn]
    assert spent >= 0.19, f"the turn was said in {spent:.3f}s of a 0.2s line"
    assert await session.receive(0.01) is None, (
        "what the line carried while the persona spoke became the answer"
    )


async def test_a_room_session_is_over_when_the_far_end_leaves_it():
    from egma_simulator.media.livekit import RoomSession

    session = RoomSession(OneWire(), band_hz=8000)
    assert session.far_end_left is False
    session.note_departure()
    assert session.far_end_left is True


async def test_a_livekit_server_that_answers_nowhere_fails_without_a_secret():
    """The failure a misconfigured deployment really hits, hermetically:
    a closed port on loopback, the real driver, real trunk credentials in
    hand — and a refusal that names what could not be reached and no
    secret at all."""
    settings = LiveKitSettings(
        url="http://127.0.0.1:1",
        api_key="key",
        api_secret=SENTINEL_TRUNK_ENV["EGMA_SIMULATOR_LIVEKIT_API_SECRET"],
        trunk_id="ST_trunk",
        trunk_password=SENTINEL_TRUNK_ENV["EGMA_SIMULATOR_SIP_TRUNK_PASSWORD"],
    )
    backend = LiveKitBackend(
        config={}, band_hz=8000, caller_id=None, settings=settings
    )
    with pytest.raises(MediaBackendError) as refusal:
        await backend.create_session()
    await backend.teardown()

    told = str(refusal.value)
    assert "127.0.0.1:1" in told, "the reason has to name what could not be reached"
    assert refusal.value.ending == ERROR
    for secret in settings.secrets:
        assert secret not in told


def _utterance(text: str, band: int = DEFAULT_BAND_HZ):
    from egma_simulator.plugs import Utterance

    return Utterance(pcm=encode_speech(text, band), sample_rate_hz=band)
