"""The phone plug, and the driver seam it stands on.

The plug's whole job is a call's lifecycle — dial, wait for somebody to
pick up, carry both directions of the line at once, notice the far end
hanging up, end deliberately — so what is pinned here is exactly that,
against the scripted media backend: no LiveKit server, no trunk, no
carrier, no network.

The line is driven the way the conductor drives it, one slice of audio at
a time, because that is the only door a voice plug has. Nothing here asks
for a turn: where a turn falls is the conductor's reading of the audio,
and this file is about the audio.

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
from conftest import SENTINEL_TRUNK_ENV, carry, hear

from egma_simulator.conductor import LINE_SLICE_SAMPLES
from egma_simulator.config import MediaSettings
from egma_simulator.contract import ERROR, NOT_ANSWERED
from egma_simulator.media import (
    BACKENDS,
    NOT_ANSWERED_STATUSES,
    MediaBackend,
    MediaBackendError,
    MediaSession,
    backend_for,
    sip_refusal,
)
from egma_simulator.media.livekit import LiveKitBackend
from egma_simulator.media.scripted import REFUSALS, ScriptedBackend, ScriptedSession
from egma_simulator.plugs import DuplexLine, PlugError, plug_for
from egma_simulator.plugs.phone import (
    BACKEND_VARIABLE,
    TELEPHONY_BAND_HZ,
    PhoneCall,
)
from egma_simulator.redaction import REDACTED, SecretRegistry
from egma_simulator.speech import (
    SPEECH_LEVEL,
    carries_speech,
    decode_speech,
    encode_speech,
    leading_silence_seconds,
)

A_NUMBER = "+15551234567"
THREE_SECONDS_OF_SLICES = round(3.0 * TELEPHONY_BAND_HZ / LINE_SLICE_SAMPLES)
"""Long enough for anything the far end has queued to have crossed."""

SCRIPTED = MediaSettings(backend="scripted")
"""A deployment that places its calls through the scripted bridge."""


def phone(script: dict | None = None, *, media=SCRIPTED, **config) -> PhoneCall:
    """One phone plug against the scripted backend, dialling a number."""
    whole = {"phoneNumber": A_NUMBER} | config
    if script is not None:
        whole["scripted"] = script
    return PhoneCall(
        modality="voice", config=whole, credentials=None, media=media
    )


def test_the_registry_knows_the_phone_plug():
    assert plug_for("phone") is PhoneCall


def test_a_phone_call_is_a_full_duplex_line():
    """The seam it wears is what decides which conductor it gets, so the
    verbs are the thing to pin — and a call has them now, exactly as the
    loopback counterpart does."""
    assert isinstance(phone({"replies": ["Noted."]}), DuplexLine)


# -- One whole call ----------------------------------------------------------


async def test_the_plug_dials_converses_and_hangs_up():
    plug = phone(
        {
            "greeting": "Lakeside Dental, how can I help?",
            "replies": ["Of course — could I take your name?", "Booked for Thursday."],
        }
    )
    assert plug.provider_reference is None, "no call exists before it is placed"

    await plug.open()
    # The join to the bridge's own telemetry, the way the chat plug offers
    # Retell's chat id.
    assert plug.provider_reference == "scripted-sip-participant-1"
    assert plug.backend.dialled == [A_NUMBER]

    assert await hear(plug) == "Lakeside Dental, how can I help?"
    assert not plug.far_end_left
    assert await hear(plug, "I need to move my cleaning.") == (
        "Of course — could I take your name?"
    )
    assert await hear(plug, "Margaret Hale.") == "Booked for Thursday."
    await plug.close()

    # And the far end's side of the same story: both stretches of persona
    # speech really went down the line, in order.
    heard = [
        decode_speech(pcm, TELEPHONY_BAND_HZ)
        for pcm in plug.backend.session.heard
    ]
    assert heard == ["I need to move my cleaning.", "Margaret Hale."]


async def test_a_line_that_answers_and_says_nothing_carries_quiet():
    """A phone answered in silence is ordinary, and it is not a fault. The
    line carries the quiet, because that is what the caller would hear —
    and how the conductor learns nobody is going to speak first."""
    plug = phone({"replies": ["Go on."]})
    await plug.open()
    assert await carry(plug, slices=20) == bytes(20 * LINE_SLICE_SAMPLES * 2)
    await plug.close()


async def test_a_stretch_of_speech_the_far_end_answers_with_nothing_stays_quiet():
    """The budget for quiet is spent in audio, so this costs CI nothing.

    Without it a spent script would leave the line waiting on a far end
    that never speaks until the simulation's duration limit, and the
    record would say "limit reached" about a line nobody was talking on.
    """
    plug = phone({"replies": ["Only one thing to say."]})
    await plug.open()
    assert await hear(plug, "First point.") == "Only one thing to say."
    assert await hear(plug, "Second point.") == ""
    assert not plug.far_end_left
    await plug.close()


async def test_the_far_end_hanging_up_ends_the_exchange_with_its_last_words():
    """The SIP participant leaving the room is the agent ending the call,
    and what it said on the way out still crossed the line first."""
    plug = phone(
        {
            "greeting": "Front desk.",
            "replies": ["All sorted, goodbye now."],
            "hangs_up_after_replies": True,
        }
    )
    await plug.open()
    assert await hear(plug) == "Front desk."

    assert await hear(plug, "That is everything.") == "All sorted, goodbye now."
    assert plug.far_end_left, "the far end went and the line did not notice"
    await plug.close()


async def test_a_far_end_that_hangs_up_saying_nothing_still_ends_the_exchange():
    plug = phone({"greeting": "Front desk.", "hangs_up_after_replies": True})
    await plug.open()
    assert await hear(plug) == "Front desk."
    assert plug.far_end_left
    await plug.close()


async def test_the_line_holds_its_last_words_until_they_have_been_handed_over():
    """A bridge knows the leg is down as soon as its own queue empties,
    which is a slice or two before those samples reach the conductor. A
    line that said so early would end the exchange on words nothing had
    heard."""
    plug = phone(
        {
            "greeting": "A goodbye long enough to still be arriving.",
            "hangs_up_after_replies": True,
        }
    )
    await plug.open()
    # One slice in, the goodbye is still arriving and the line says so.
    heard = await carry(plug, slices=1)
    assert not plug.far_end_left
    heard += await carry(plug, slices=THREE_SECONDS_OF_SLICES)
    assert decode_speech(heard, TELEPHONY_BAND_HZ) == (
        "A goodbye long enough to still be arriving."
    )
    assert plug.far_end_left
    await plug.close()


async def test_the_quiet_before_the_first_word_is_carried_as_quiet():
    """Time-to-first-word is read out of the audio the line carries, so
    the quiet a line really had has to be in it — at its real length, and
    as quiet rather than as whatever noise the line was making."""
    plug = phone({"greeting": "Hello there.", "answer_delay_seconds": 0.4})
    await plug.open()
    heard = await carry(plug, slices=THREE_SECONDS_OF_SLICES)
    await plug.close()

    asked_for = round(0.4 * TELEPHONY_BAND_HZ)
    quiet = round(leading_silence_seconds(heard, TELEPHONY_BAND_HZ) * TELEPHONY_BAND_HZ)
    assert asked_for <= quiet < asked_for + LINE_SLICE_SAMPLES
    assert decode_speech(heard, TELEPHONY_BAND_HZ) == "Hello there."


async def test_the_quiet_before_an_answer_is_spent_on_the_line():
    """And the same on an answer, where the wait is spent listening to the
    caller stop rather than queued in front of the words."""
    plug = phone({"replies": ["Yes."], "answer_delay_seconds": 0.5})
    await plug.open()
    await carry(plug, encode_speech("A question.", TELEPHONY_BAND_HZ))
    heard = await carry(plug, slices=THREE_SECONDS_OF_SLICES)
    await plug.close()

    asked_for = round(0.5 * TELEPHONY_BAND_HZ)
    quiet = round(leading_silence_seconds(heard, TELEPHONY_BAND_HZ) * TELEPHONY_BAND_HZ)
    assert asked_for <= quiet < asked_for + LINE_SLICE_SAMPLES
    assert decode_speech(heard, TELEPHONY_BAND_HZ) == "Yes."


async def test_far_end_speech_arriving_while_the_persona_speaks_is_heard():
    """The drop is gone, and this is the test that says so.

    The far end starts talking while the caller is still mid-sentence.
    The line used to wait out the caller's own audio and throw away
    everything that arrived meanwhile, so an agent talking over the
    persona vanished from the record entirely. Now both directions cross
    in the same slices: the far end's words come back while the caller's
    are still going out, and the call carries on afterwards.
    """
    plug = phone({"greeting": "Talking over you now.", "replies": ["And on we go."]})
    await plug.open()

    # One long stretch of caller speech, driven slice by slice, with the
    # far end's greeting already on its way.
    said = encode_speech(
        "A long sentence the caller is still in the middle of saying.",
        TELEPHONY_BAND_HZ,
    )
    heard = await carry(plug, said)

    assert len(heard) == len(said), "the two directions left the same clock"
    assert decode_speech(heard, TELEPHONY_BAND_HZ) == "Talking over you now."
    # And the caller really was still speaking when it arrived.
    assert carries_speech(said[-LINE_SLICE_SAMPLES * 2 :])

    # Conducted on, rather than merely survived: the call goes to its next
    # answer with nothing lost in between.
    assert await hear(plug, "And I carried on.") == "And on we go."
    await plug.close()


async def test_a_session_neither_waits_out_the_caller_nor_forgets_the_far_end():
    """The same claim one layer down, on the seam that did the dropping.

    ``send`` used to wait out the audio's own length and then empty
    everything the line had carried meanwhile. Both halves are gone: it
    returns at once, and what arrived is still there to be received.
    """
    session = ScriptedSession(band_hz=TELEPHONY_BAND_HZ, delay_seconds=0.0)
    session.say("Over the top of you.")
    queued = len(session._pending)

    await session.send(encode_speech("A whole sentence going out.", TELEPHONY_BAND_HZ))

    assert len(session._pending) == queued, "the far end's audio was thrown away"
    assert await session.receive(0.03) is not None


async def test_closing_a_call_that_was_never_dialled_is_safe():
    """``close`` is called whatever happened, including before ``open``."""
    plug = phone({"replies": ["Noted."]})
    await plug.close()
    await plug.close()


async def test_a_line_driven_before_the_call_was_answered_is_refused():
    plug = phone({"replies": ["Noted."]})
    with pytest.raises(PlugError):
        await plug.exchange(bytes(LINE_SLICE_SAMPLES * 2))
    await plug.close()


# -- The band ----------------------------------------------------------------


def test_a_phone_call_is_narrowband_and_nothing_can_ask_it_not_to_be():
    """A band a connection could ask for would be a band declared, and
    what a record stamps has to be a band the audio really carried. The
    bridge resamples down to this one, which can only take away detail
    that was never there — so a narrowband call is never stamped wide."""
    assert phone().sample_rate_hz == TELEPHONY_BAND_HZ == 8000
    with pytest.raises(PlugError) as refusal:
        phone(sample_rate_hz=16000)
    assert "sample_rate_hz" in str(refusal.value)


# -- Every way a call fails to become a conversation -------------------------


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


async def test_a_trunk_the_carrier_rejects_is_a_refusal_at_the_dial():
    """Where it really happens, in both drivers.

    Trunk credentials the carrier will not accept cannot be known before
    the carrier is asked, so this is a SIP refusal like any other — and a
    fault rather than a phone nobody answered, because nobody was ever
    reached to answer. Trunk configuration that is simply *missing* is a
    different thing and is refused at startup; see the config suite.
    """
    plug = phone({"outcome": "trunk_rejected"})
    with pytest.raises(PlugError) as refused:
        await plug.open()
    await plug.close()
    assert refused.value.ending == ERROR
    assert "403" in str(refused.value)


def test_a_simulator_that_places_no_calls_refuses_a_number_by_name():
    """The refusal a deployment that never configured a bridge gets, and
    it names the variable rather than describing the problem."""
    with pytest.raises(PlugError) as refusal:
        phone({"replies": ["Noted."]}, media=None)
    assert BACKEND_VARIABLE in str(refusal.value)


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
    """A carrier careless enough to echo a trunk password back must not
    get it repeated into a reason. What scrubs it is the same registry
    the process's log filter uses, not a second implementation."""
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


# -- Config the plug does not understand -------------------------------------


@pytest.mark.parametrize(
    "config",
    [
        {},
        {"phoneNumber": ""},
        {"phoneNumber": 15551234567},
        {"phoneNumber": A_NUMBER, "phoneNumbre": "a typo"},
        {"phoneNumber": A_NUMBER, "callerId": 7},
        {"phoneNumber": A_NUMBER, "sample_rate_hz": 16000},
        {"phoneNumber": A_NUMBER, "backend": "a-bridge-nobody-wrote"},
        {"phoneNumber": A_NUMBER, "scripted": "not a script"},
    ],
)
def test_config_the_plug_does_not_understand_is_refused(config: dict):
    with pytest.raises(PlugError):
        PhoneCall(
            modality="voice", config=config, credentials=None, media=SCRIPTED
        )


def test_a_config_typo_is_named_in_the_refusal():
    with pytest.raises(PlugError) as refusal:
        phone(phoneNumbre="a typo")
    assert "phoneNumbre" in str(refusal.value)


def test_a_script_for_a_backend_this_deployment_does_not_use_is_refused():
    """A script nobody reads was written by mistake, and a silently
    ignored one would change nothing while looking like it changed
    everything."""
    livekit = MediaSettings(
        backend="livekit",
        livekit_url="ws://127.0.0.1:1",
        livekit_api_key="key",
        livekit_api_secret="secret",
        trunk_id="ST_trunk",
    )
    with pytest.raises(PlugError) as refusal:
        PhoneCall(
            modality="voice",
            config={"phoneNumber": A_NUMBER, "scripted": {"replies": ["Noted."]}},
            credentials=None,
            media=livekit,
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
            config={"phoneNumber": A_NUMBER},
            credentials={"apiKey": "SENTINEL-not-read-here"},
            media=SCRIPTED,
        )
    told = str(refusal.value)
    assert "environment" in told
    assert "SENTINEL-not-read-here" not in told


def test_the_plug_speaks_voice_only():
    with pytest.raises(PlugError) as refusal:
        PhoneCall(
            modality="chat",
            config={"phoneNumber": A_NUMBER},
            credentials=None,
            media=SCRIPTED,
        )
    assert "chat" in str(refusal.value)


def test_the_deployment_the_simulator_started_with_is_what_places_the_call(
    monkeypatch: pytest.MonkeyPatch,
):
    """A spec names a number and nothing else about how it travels; which
    bridge this simulator dials through was settled at startup."""
    monkeypatch.setenv("EGMA_SIMULATOR_MEDIA_BACKEND", "scripted")
    plug = PhoneCall(
        modality="voice", config={"phoneNumber": A_NUMBER}, credentials=None
    )
    assert isinstance(plug.backend, ScriptedBackend)


# -- Hearing the far end -----------------------------------------------------


def test_speech_is_told_from_the_quiet_a_line_carries():
    from egma_simulator.speech import silence

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
    from egma_simulator.media.room import RoomSession
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


def livekit_settings(**overrides) -> MediaSettings:
    """A deployment with a LiveKit and a trunk, as startup would have
    checked it — pointed at a port nothing answers on."""
    return MediaSettings(
        **{
            "backend": "livekit",
            "livekit_url": "ws://127.0.0.1:1",
            "livekit_api_key": "key",
            "livekit_api_secret": "secret",
            "trunk_id": "ST_trunk",
        }
        | overrides
    )


def test_the_livekit_driver_is_built_without_reaching_anything():
    """Building is not connecting: a driver constructs here and reaches
    LiveKit only when a call is placed, which is what keeps assembling a
    pipeline the validation step it has always been."""
    backend = LiveKitBackend(
        settings=livekit_settings(), config={}, band_hz=8000, caller_id=None
    )
    assert backend.room_name.startswith("egma-sim-")
    # One room per call, never reused.
    other = LiveKitBackend(
        settings=livekit_settings(), config={}, band_hz=8000, caller_id=None
    )
    assert other.room_name != backend.room_name


def test_the_livekit_driver_reads_no_connection_config():
    with pytest.raises(MediaBackendError) as refusal:
        LiveKitBackend(
            settings=livekit_settings(),
            config={"replies": ["Noted."]},
            band_hz=8000,
            caller_id=None,
        )
    assert "deployment" in str(refusal.value)


async def test_a_livekit_server_that_answers_nowhere_fails_without_a_secret():
    """The failure a misconfigured deployment really hits, hermetically:
    a closed port on loopback, the real driver, real trunk credentials in
    hand — and a refusal that names what could not be reached and no
    secret at all."""
    settings = livekit_settings(
        livekit_url="http://127.0.0.1:1",
        livekit_api_secret=SENTINEL_TRUNK_ENV["EGMA_SIMULATOR_LIVEKIT_API_SECRET"],
        trunk_password=SENTINEL_TRUNK_ENV["EGMA_SIMULATOR_SIP_TRUNK_PASSWORD"],
    )
    backend = LiveKitBackend(
        settings=settings, config={}, band_hz=8000, caller_id=None
    )
    with pytest.raises(MediaBackendError) as refusal:
        await backend.create_session()
    await backend.teardown()

    told = str(refusal.value)
    assert "127.0.0.1:1" in told, "the reason has to name what could not be reached"
    assert refusal.value.ending == ERROR
    for secret in settings.secrets:
        assert secret not in told
