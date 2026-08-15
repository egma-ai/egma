"""What the simulator refuses to start with, and what it starts without.

The simulator is one more container, and a container's whole conversation
with whoever deployed it is its environment and its first log lines. So
the rule these tests hold is one rule: anything the simulator cannot work
without is refused at startup **by name**, and everything else has a
working default. Nobody should discover a mistyped variable halfway
through their first simulation, and nobody should have to set nine
variables to see one.

Every test here is hermetic — an environment, a temporary directory, and
no network at all.
"""

from __future__ import annotations

import pytest

from egma_simulator.config import (
    MediaSettings,
    ObjectStoreSettings,
    SimulatorConfig,
)
from egma_simulator.spec import PlatformCarrier

A_URL = "http://control-plane.internal:3100"


def test_one_variable_is_enough(env, tmp_path):
    """Everything but the control plane has a default that works."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)

    config = SimulatorConfig.from_env()

    assert config.control_plane_url == A_URL
    assert config.capacity == 2
    assert config.model_provider == "scripted"
    assert config.service_token is None
    assert config.claimant.startswith("egma-simulator-")
    assert config.log_level == "INFO"
    assert config.blob_dir == tmp_path / "blobs"


def test_empty_means_unset(env):
    """An optional variable left blank falls back rather than taking "".

    Compose hands an unset optional through as an empty string instead of
    leaving it out, so every entry in the compose file can carry a
    ``${VAR:-}`` default. If "" were a value, a blank model base URL would
    become a base URL of nothing and the first request would go nowhere.
    """
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    for name in (
        "EGMA_SIMULATOR_CAPACITY",
        "EGMA_SIMULATOR_CLAIMANT",
        "EGMA_SIMULATOR_HEARTBEAT_SECONDS",
        "EGMA_SIMULATOR_LOG_LEVEL",
        "EGMA_SIMULATOR_MODEL_BASE_URL",
        "EGMA_SIMULATOR_MODEL_PROVIDER",
        "EGMA_SIMULATOR_SERVICE_TOKEN",
    ):
        env.setenv(name, "")

    config = SimulatorConfig.from_env()

    assert config.capacity == 2
    assert config.claimant.startswith("egma-simulator-")
    assert config.heartbeat_seconds == 5.0
    assert config.log_level == "INFO"
    assert config.model_base_url == "https://api.openai.com/v1"
    assert config.model_provider == "scripted"
    assert config.service_token is None


def test_a_missing_control_plane_url_is_refused_by_name(env):
    with pytest.raises(ValueError, match="EGMA_SIMULATOR_CONTROL_PLANE_URL"):
        SimulatorConfig.from_env()


def test_a_control_plane_url_with_no_scheme_is_refused_by_name(env):
    """``api:3100`` is a natural thing to write and reaches nothing."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", "api:3100")

    with pytest.raises(ValueError, match="EGMA_SIMULATOR_CONTROL_PLANE_URL"):
        SimulatorConfig.from_env()


def test_a_capacity_that_is_not_a_number_is_refused_by_name(env):
    """Not ``invalid literal for int()``, which names nothing."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_CAPACITY", "lots")

    with pytest.raises(ValueError, match="EGMA_SIMULATOR_CAPACITY"):
        SimulatorConfig.from_env()


def test_a_capacity_below_one_is_refused_by_name(env):
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_CAPACITY", "0")

    with pytest.raises(ValueError, match="EGMA_SIMULATOR_CAPACITY"):
        SimulatorConfig.from_env()


def test_a_duration_that_is_not_a_number_is_refused_by_name(env):
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_HEARTBEAT_SECONDS", "often")

    with pytest.raises(ValueError, match="EGMA_SIMULATOR_HEARTBEAT_SECONDS"):
        SimulatorConfig.from_env()


def test_a_negative_duration_is_refused_by_name(env):
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_CLAIM_WAIT_SECONDS", "-1")

    with pytest.raises(ValueError, match="EGMA_SIMULATOR_CLAIM_WAIT_SECONDS"):
        SimulatorConfig.from_env()


DURATION_VARIABLES = [
    "EGMA_SIMULATOR_HEARTBEAT_SECONDS",
    "EGMA_SIMULATOR_CLAIM_WAIT_SECONDS",
    "EGMA_SIMULATOR_REPORT_DEADLINE_SECONDS",
]
"""Every variable read as a duration — all of them through one helper."""


@pytest.mark.parametrize("variable", DURATION_VARIABLES)
@pytest.mark.parametrize("written", ["nan", "inf", "-inf", "Infinity", "NaN"])
def test_a_duration_that_is_not_finite_is_refused_by_name(env, variable, written):
    """The numbers that read as numbers and behave as neither.

    ``float()`` accepts every one of these, and the range check cannot
    see two of them: every comparison against nan is False, and +inf is
    greater than zero, so both would be taken for a duration. What they
    would buy is silence rather than an error — an infinite heartbeat
    interval never beats again, so a simulation going along fine looks
    orphaned to the control plane, and an infinite report deadline
    retries one report until the process ends, holding a capacity slot
    nothing will ever free.
    """
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv(variable, written)

    with pytest.raises(ValueError, match=variable):
        SimulatorConfig.from_env()


@pytest.mark.parametrize("written", ["nan", "inf", "-inf"])
def test_a_capacity_that_is_not_finite_is_refused_by_name(env, written):
    """The other numeric variable, which `int()` turns down on its own."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_CAPACITY", written)

    with pytest.raises(ValueError, match="EGMA_SIMULATOR_CAPACITY"):
        SimulatorConfig.from_env()


def test_an_unknown_log_level_is_refused_by_name(env):
    """Caught here rather than in logging setup, which names no variable."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_LOG_LEVEL", "CHATTY")

    with pytest.raises(ValueError, match="EGMA_SIMULATOR_LOG_LEVEL"):
        SimulatorConfig.from_env()


def test_a_log_level_is_taken_however_it_is_written(env):
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_LOG_LEVEL", "debug")

    assert SimulatorConfig.from_env().log_level == "DEBUG"


def test_an_unknown_model_provider_is_refused_by_name(env):
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_MODEL_PROVIDER", "telepathy")

    with pytest.raises(ValueError, match="EGMA_SIMULATOR_MODEL_PROVIDER"):
        SimulatorConfig.from_env()


@pytest.mark.parametrize(
    ("supplied", "missing"),
    [
        ({}, "EGMA_SIMULATOR_MODEL_NAME"),
        ({"EGMA_SIMULATOR_MODEL_NAME": "gpt-4o-mini"}, "EGMA_SIMULATOR_MODEL_API_KEY"),
    ],
)
def test_the_openai_provider_names_what_it_is_missing(env, supplied, missing):
    """The provider is optional; choosing it makes two more required."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_MODEL_PROVIDER", "openai")
    for name, value in supplied.items():
        env.setenv(name, value)

    with pytest.raises(ValueError, match=missing):
        SimulatorConfig.from_env()


def test_the_speech_legs_are_scripted_until_a_provider_is_named(env):
    """The pair CI and the free local demo run on, with nothing set."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)

    config = SimulatorConfig.from_env()

    assert config.stt_provider == "scripted"
    assert config.tts_provider == "scripted"
    assert config.deepgram_api_key is None
    assert config.elevenlabs_api_key is None


@pytest.mark.parametrize(
    "variable", ["EGMA_SIMULATOR_STT_PROVIDER", "EGMA_SIMULATOR_TTS_PROVIDER"]
)
def test_an_unknown_speech_provider_is_refused_by_name(env, variable):
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv(variable, "lip-reading")

    with pytest.raises(ValueError, match=variable):
        SimulatorConfig.from_env()


@pytest.mark.parametrize(
    ("provider_variable", "provider", "key_variable"),
    [
        (
            "EGMA_SIMULATOR_STT_PROVIDER",
            "deepgram",
            "EGMA_SIMULATOR_DEEPGRAM_API_KEY",
        ),
        (
            "EGMA_SIMULATOR_TTS_PROVIDER",
            "elevenlabs",
            "EGMA_SIMULATOR_ELEVENLABS_API_KEY",
        ),
    ],
)
def test_a_speech_provider_with_no_key_names_the_key_it_wants(
    env, provider_variable, provider, key_variable
):
    """Naming a provider is what makes its key required — and the refusal
    says which variable to set, at startup, before anything is claimed."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv(provider_variable, provider)

    with pytest.raises(ValueError, match=key_variable):
        SimulatorConfig.from_env()


def test_the_speech_provider_keys_are_read_and_kept_out_of_the_repr(env):
    """They are credentials, so they travel like one: never in a printed
    config, and registered for redaction wherever one is printed anyway."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_STT_PROVIDER", "deepgram")
    env.setenv("EGMA_SIMULATOR_DEEPGRAM_API_KEY", "deepgram_key_under_test")
    env.setenv("EGMA_SIMULATOR_TTS_PROVIDER", "elevenlabs")
    env.setenv("EGMA_SIMULATOR_ELEVENLABS_API_KEY", "elevenlabs_key_under_test")

    config = SimulatorConfig.from_env()

    assert config.deepgram_api_key == "deepgram_key_under_test"
    assert config.elevenlabs_api_key == "elevenlabs_key_under_test"
    assert "deepgram_key_under_test" not in repr(config)
    assert "elevenlabs_key_under_test" not in repr(config)


def test_every_speech_key_is_registered_for_redaction_at_startup(env):
    """A key kept out of logs by discipline is a key that leaks one day.

    The live tests plant real provider keys and scan every byte the
    process wrote, but CI never runs them — so the wiring that makes that
    scan pass is proved here, with no network and no account: configure
    both providers, ask for the registry a starting simulator builds, and
    require that it rewrites both keys.
    """
    from egma_simulator.__main__ import secrets_of

    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_STT_PROVIDER", "deepgram")
    env.setenv("EGMA_SIMULATOR_DEEPGRAM_API_KEY", "SENTINEL-deepgram-3f8a1c")
    env.setenv("EGMA_SIMULATOR_TTS_PROVIDER", "elevenlabs")
    env.setenv("EGMA_SIMULATOR_ELEVENLABS_API_KEY", "SENTINEL-elevenlabs-9d2b7e")

    registry = secrets_of(SimulatorConfig.from_env())

    # The shape a provider's own refusal arrives in: the library quotes
    # the request it made, key and all, and this is what rewrites it.
    scrubbed = registry.redact(
        "ElevenLabs API error for xi-api-key SENTINEL-elevenlabs-9d2b7e; "
        "deepgram token SENTINEL-deepgram-3f8a1c was rejected"
    )
    assert "SENTINEL-elevenlabs-9d2b7e" not in scrubbed
    assert "SENTINEL-deepgram-3f8a1c" not in scrubbed
    assert scrubbed.count("[redacted]") == 2


def test_one_real_leg_does_not_drag_the_other_along(env):
    """The two legs are chosen apart: a real mouth with scripted ears is a
    configuration somebody will want, and it needs one key, not two."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_TTS_PROVIDER", "elevenlabs")
    env.setenv("EGMA_SIMULATOR_ELEVENLABS_API_KEY", "elevenlabs_key_under_test")

    config = SimulatorConfig.from_env()

    assert (config.stt_provider, config.tts_provider) == ("scripted", "elevenlabs")
    assert config.deepgram_api_key is None


@pytest.mark.parametrize(
    "variable", ["EGMA_SIMULATOR_BLOB_DIR", "EGMA_SIMULATOR_WAL_DIR"]
)
def test_a_directory_that_cannot_be_written_is_refused_by_name(
    env, tmp_path, variable
):
    """A volume mounted wrongly is found now, not by losing a recording.

    Neither directory is written until a simulation is well under way — a
    recording at the end of a voice exchange, a report on its way out — so
    a bad mount would otherwise stay quiet until the first simulation, and
    then take it down.
    """
    blocked = tmp_path / "occupied"
    blocked.write_text("something that is not a directory")
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv(variable, str(blocked))

    with pytest.raises(ValueError, match=variable):
        SimulatorConfig.from_env()


def test_both_directories_exist_once_the_config_does(env, tmp_path):
    """Proving they are writable is also making them, which is the point."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)

    config = SimulatorConfig.from_env()

    assert config.blob_dir.is_dir()
    assert config.wal_dir.is_dir()
    assert list(tmp_path.glob("**/.egma-simulator-*")) == [], (
        "the write probe cleaned up after itself"
    )


def test_starting_misconfigured_says_one_sentence_and_stops(env, capsys):
    """The whole conversation a container has with whoever deployed it.

    A traceback down through the standard library would bury the sentence
    naming the variable under frames nobody deploying this can act on.
    """
    from egma_simulator.__main__ import main

    with pytest.raises(SystemExit) as stopped:
        main()

    assert stopped.value.code == 1
    said = capsys.readouterr().err
    assert "EGMA_SIMULATOR_CONTROL_PLANE_URL" in said
    assert "Traceback" not in said


def test_the_service_token_is_read_and_kept_out_of_the_repr(env):
    """It is a credential, so it travels like one: never in a printed config."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_SERVICE_TOKEN", "egma_service_token_under_test")

    config = SimulatorConfig.from_env()

    assert config.service_token == "egma_service_token_under_test"
    assert "egma_service_token_under_test" not in repr(config)


# -- Placing phone calls -----------------------------------------------------
#
# A bridge and a trunk are what let a simulator dial at all, and both are
# the deployment's rather than any one simulation's. So they follow the
# same rule as everything else here: naming a backend is what makes its
# variables required, the refusal names the variable, and a deployment
# that names none starts in silence and simply places no calls.

A_LIVEKIT = {
    "EGMA_SIMULATOR_MEDIA_BACKEND": "livekit",
    "EGMA_SIMULATOR_LIVEKIT_URL": "wss://livekit.internal",
    "EGMA_SIMULATOR_LIVEKIT_API_KEY": "APIkey",
    "EGMA_SIMULATOR_LIVEKIT_API_SECRET": "SENTINEL-livekit-secret-4c81",
    "EGMA_SIMULATOR_SIP_TRUNK_ADDRESS": "trunk.example.pstn.twilio.com",
    "EGMA_SIMULATOR_SIP_TRUNK_NUMBER": "+15550000000",
    "EGMA_SIMULATOR_SIP_TRUNK_USERNAME": "trunk-user",
    "EGMA_SIMULATOR_SIP_TRUNK_PASSWORD": "SENTINEL-trunk-password-9f30",
}


def a_deployment_that_dials(env, **changes: str | None):
    """The environment of a simulator that can place calls, minus or plus
    whatever one test is about."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    for name, value in (A_LIVEKIT | changes).items():
        if value is None:
            env.delenv(name, raising=False)
        else:
            env.setenv(name, value)


def test_a_simulator_that_names_no_bridge_starts_and_places_no_calls(env):
    """Dialling is opt-in: nobody who never wanted a phone call should
    have to explain a trunk."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    assert SimulatorConfig.from_env().media is None


def test_a_bridge_nobody_wrote_is_refused_by_name(env):
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_MEDIA_BACKEND", "a-bridge-nobody-wrote")
    with pytest.raises(ValueError) as refusal:
        SimulatorConfig.from_env()
    assert "EGMA_SIMULATOR_MEDIA_BACKEND" in str(refusal.value)


def test_the_scripted_bridge_needs_nothing_else(env):
    """It places no real call, so it wants no server and no trunk."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_MEDIA_BACKEND", "scripted")
    media = SimulatorConfig.from_env().media
    assert media is not None
    assert media.backend == "scripted"
    assert media.secrets == ()


@pytest.mark.parametrize(
    "missing",
    [
        "EGMA_SIMULATOR_LIVEKIT_URL",
        "EGMA_SIMULATOR_LIVEKIT_API_KEY",
        "EGMA_SIMULATOR_LIVEKIT_API_SECRET",
    ],
)
def test_a_livekit_deployment_missing_a_variable_is_refused_by_name(env, missing):
    a_deployment_that_dials(env, **{missing: None})
    with pytest.raises(ValueError) as refusal:
        SimulatorConfig.from_env()
    assert missing in str(refusal.value)


def test_a_bridge_with_no_trunk_anywhere_starts_and_refuses_when_asked_to_dial(
    env,
):
    """The trunk is the platform's now, so its absence is not a startup fault.

    A simulator that names a bridge and holds no trunk used to refuse to
    start. It cannot any more: the trunk arrives on each work order, so a
    container waiting for one is an ordinary deployment — the whole
    of what "a second simulator on another host needs no settings" means.

    What is *not* given up is the refusal. It moves to the moment a call is
    about to be placed, and it names both ways a trunk can be given,
    because picking one for somebody is what a refusal must not do.
    """
    a_deployment_that_dials(env, EGMA_SIMULATOR_SIP_TRUNK_ADDRESS=None)

    standing = SimulatorConfig.from_env().media
    assert standing is not None
    assert standing.trunk_address is None

    # Assembling never refuses: this runs for every simulation, and a
    # simulation that never dials must not fail over a trunk it was never
    # going to use.
    settled = MediaSettings.for_simulation(standing, PlatformCarrier())
    assert settled is not None

    with pytest.raises(ValueError) as refusal:
        settled.checked()
    told = str(refusal.value)
    assert "carrier trunk" in told
    assert "EGMA_SIMULATOR_SIP_TRUNK_ID" in told


def test_a_half_configured_phone_does_not_break_the_work_that_never_dials(env):
    """The rule the refusal's new home exists for.

    A platform holding a media backend and no trunk, or a container with no
    media server behind the backend the platform named, are both real
    states somebody is in mid-setup. Neither may fail a chat simulation:
    the telephone-free half of the product goes on working, and the phone
    says what is wrong when somebody asks it to dial.
    """
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)

    for carrier in (
        PlatformCarrier(media_backend="livekit"),
        PlatformCarrier(media_backend="livekit", trunk_address="a.example.com"),
        PlatformCarrier(media_backend="a-bridge-nobody-wrote"),
    ):
        settled = MediaSettings.for_simulation(None, carrier)
        assert settled is not None, carrier
        # And each of them still refuses at the moment of dialling.
        with pytest.raises(ValueError):
            settled.checked()


def test_a_bridge_this_container_cannot_reach_is_named_when_a_call_is_placed(env):
    """The media server is bootstrap configuration and can never come from
    the store, so a container missing it is where the refusal points."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)

    settled = MediaSettings.for_simulation(
        None,
        PlatformCarrier(media_backend="livekit", trunk_address="a.example.com"),
    )
    assert settled is not None

    with pytest.raises(ValueError) as refusal:
        settled.checked()
    told = str(refusal.value)
    assert "EGMA_SIMULATOR_LIVEKIT_URL" in told
    assert "EGMA_SIMULATOR_LIVEKIT_API_SECRET" in told


def test_the_platforms_trunk_is_what_a_simulator_holding_none_dials_over(env):
    """The proof of the whole ticket, at the seam the carrier passes through.

    This container knows a bridge and nothing else — no trunk address, no
    number, no credential. Everything a call is authenticated with rides
    the work order, and what comes out is a deployment able to dial.
    """
    a_deployment_that_dials(
        env,
        EGMA_SIMULATOR_SIP_TRUNK_ADDRESS=None,
        EGMA_SIMULATOR_SIP_TRUNK_NUMBER=None,
        EGMA_SIMULATOR_SIP_TRUNK_USERNAME=None,
        EGMA_SIMULATOR_SIP_TRUNK_PASSWORD=None,
    )

    settled = MediaSettings.for_simulation(
        SimulatorConfig.from_env().media,
        PlatformCarrier(
            trunk_address="the-platform-holds-this.pstn.twilio.com",
            trunk_number="+15551110000",
            trunk_username="platform-trunk-user",
            trunk_password="SENTINEL-platform-trunk-password",
        ),
    )

    assert settled is not None
    assert settled.trunk_address == "the-platform-holds-this.pstn.twilio.com"
    assert settled.trunk_number == "+15551110000"
    assert settled.trunk_username == "platform-trunk-user"
    assert settled.trunk_password == "SENTINEL-platform-trunk-password"
    # And the bridge is still this container's, which is the other half of
    # the split: the media server's key and secret are read by a
    # third-party binary at creation and can never come from the store.
    assert settled.livekit_url == "wss://livekit.internal"
    assert settled.livekit_api_secret == "SENTINEL-livekit-secret-4c81"


def test_the_platforms_trunk_wins_over_the_one_in_this_environment(env):
    """One value here, a different value for the same setting on the work
    order, and the call goes over the second. The stored reference goes
    with it: a container quietly dialling its own trunk while the
    platform's settings page showed another is the disagreement this
    whole effort exists to end."""
    a_deployment_that_dials(env, EGMA_SIMULATOR_SIP_TRUNK_ID="ST_left_behind")

    settled = MediaSettings.for_simulation(
        SimulatorConfig.from_env().media,
        PlatformCarrier(
            trunk_address="the-platform-holds-this.pstn.twilio.com",
            trunk_number="+15551110000",
            trunk_username="platform-trunk-user",
            trunk_password="SENTINEL-platform-trunk-password",
        ),
    )

    assert settled is not None
    assert settled.trunk_id is None
    assert settled.trunk_address == "the-platform-holds-this.pstn.twilio.com"
    assert settled.trunk_username == "platform-trunk-user"


def test_a_container_that_names_no_bridge_dials_over_the_platforms(env):
    """Adding capacity is starting a container and nothing else.

    Nothing here says this simulator may dial; the platform's own media
    backend does. What the container still supplies is the media server it
    reaches — bootstrap configuration, never a setting.
    """
    a_deployment_that_dials(env, EGMA_SIMULATOR_MEDIA_BACKEND=None)
    assert SimulatorConfig.from_env().media is None

    settled = MediaSettings.for_simulation(
        None,
        PlatformCarrier(
            media_backend="livekit",
            trunk_address="the-platform-holds-this.pstn.twilio.com",
            trunk_number="+15551110000",
        ),
    )

    assert settled is not None
    assert settled.backend == "livekit"
    assert settled.livekit_url == "wss://livekit.internal"
    assert settled.trunk_address == "the-platform-holds-this.pstn.twilio.com"


def test_a_deployment_nobody_gave_a_carrier_dials_nothing_and_says_nothing(env):
    """Neither side names a backend, which is every platform before
    somebody has done the carrier paperwork. It is an ordinary state, not
    a fault, and a simulator in it simply places no calls."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    assert MediaSettings.for_simulation(None, PlatformCarrier()) is None


def test_a_bring_your_own_trunk_arrives_whole(env):
    """Any carrier, inline, with the credential auth LiveKit documents."""
    a_deployment_that_dials(env)
    media = SimulatorConfig.from_env().media
    assert media.trunk_address == "trunk.example.pstn.twilio.com"
    assert media.trunk_username == "trunk-user"
    assert media.trunk_number == "+15550000000"


@pytest.mark.parametrize(
    ("missing", "given"),
    [
        ("EGMA_SIMULATOR_SIP_TRUNK_PASSWORD", "EGMA_SIMULATOR_SIP_TRUNK_USERNAME"),
        ("EGMA_SIMULATOR_SIP_TRUNK_USERNAME", "EGMA_SIMULATOR_SIP_TRUNK_PASSWORD"),
    ],
)
def test_half_a_trunk_credential_is_refused_naming_the_missing_half(
    env, missing, given
):
    """Credential auth is a username *and* a password, and half of one
    authenticates nobody.

    Left alone this is the worst kind of misconfiguration: the simulator
    starts, claims work, dials, and the carrier answers 403 on every call —
    a refusal that reads exactly like wrong credentials rather than like
    absent ones. Said here, it costs a startup line and no calls at all.
    """
    a_deployment_that_dials(env, **{missing: None})
    with pytest.raises(ValueError) as refusal:
        SimulatorConfig.from_env()
    told = str(refusal.value)
    assert missing in told
    assert given in told


def test_a_trunk_the_carrier_authenticates_by_address_needs_no_credential(env):
    """Some carriers allow a trunk by IP rather than by password. Neither
    half given is a deployment that meant it, and it starts."""
    a_deployment_that_dials(
        env,
        EGMA_SIMULATOR_SIP_TRUNK_USERNAME=None,
        EGMA_SIMULATOR_SIP_TRUNK_PASSWORD=None,
    )
    media = SimulatorConfig.from_env().media
    assert media.trunk_username is None
    assert media.trunk_password is None
    assert media.trunk_address == "trunk.example.pstn.twilio.com"


def test_a_stored_trunk_reference_is_the_other_way(env):
    a_deployment_that_dials(
        env,
        EGMA_SIMULATOR_SIP_TRUNK_ID="ST_1234",
        EGMA_SIMULATOR_SIP_TRUNK_ADDRESS=None,
    )
    assert SimulatorConfig.from_env().media.trunk_id == "ST_1234"


def test_a_stored_trunk_is_not_refused_over_a_leftover_inline_half(env):
    """The credential-pair rule binds the inline trunk only. A deployment
    that moved to a stored trunk and left one stale inline variable behind
    is a working deployment, not half of a broken one — the inline fields
    are never read once EGMA_SIMULATOR_SIP_TRUNK_ID selects the trunk."""
    a_deployment_that_dials(
        env,
        EGMA_SIMULATOR_SIP_TRUNK_ID="ST_1234",
        EGMA_SIMULATOR_SIP_TRUNK_ADDRESS=None,
        EGMA_SIMULATOR_SIP_TRUNK_USERNAME="left-behind",
        EGMA_SIMULATOR_SIP_TRUNK_PASSWORD=None,
    )
    assert SimulatorConfig.from_env().media.trunk_id == "ST_1234"


def test_the_telephony_secrets_never_print(env):
    """A config that landed in a log line by accident says nothing."""
    a_deployment_that_dials(env)
    config = SimulatorConfig.from_env()
    printed = repr(config) + repr(config.media)
    assert A_LIVEKIT["EGMA_SIMULATOR_LIVEKIT_API_SECRET"] not in printed
    assert A_LIVEKIT["EGMA_SIMULATOR_SIP_TRUNK_PASSWORD"] not in printed


def test_every_telephony_secret_is_registered_for_redaction_at_startup(env):
    """A secret kept out of logs by discipline is a secret that leaks one
    day. The LiveKit client and the SIP service both log plenty on their
    own, so what makes a live run's scan pass is proved here instead —
    with no server, no trunk and no network."""
    from egma_simulator.__main__ import secrets_of

    a_deployment_that_dials(env)
    registry = secrets_of(SimulatorConfig.from_env())

    scrubbed = registry.redact(
        "livekit refused api secret "
        f"{A_LIVEKIT['EGMA_SIMULATOR_LIVEKIT_API_SECRET']} and the carrier "
        f"refused password {A_LIVEKIT['EGMA_SIMULATOR_SIP_TRUNK_PASSWORD']}"
    )
    assert A_LIVEKIT["EGMA_SIMULATOR_LIVEKIT_API_SECRET"] not in scrubbed
    assert A_LIVEKIT["EGMA_SIMULATOR_SIP_TRUNK_PASSWORD"] not in scrubbed
    assert scrubbed.count("[redacted]") == 2


# -- Where recordings go -----------------------------------------------------
#
# Naming an object-storage endpoint is the whole of what selects it, the
# same way naming a media backend is the whole of what selects a bridge.
# Absent, the filesystem store stands — which is what lets this suite, and
# every contributor's checkout, run with no container at all.

AN_OBJECT_STORE = {
    "EGMA_SIMULATOR_S3_ENDPOINT": "http://minio:9000",
    "EGMA_SIMULATOR_S3_ACCESS_KEY_ID": "egma-object-storage",
    "EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY": "SENTINEL-object-storage-secret-71bd",
}


def a_deployment_with_object_storage(env, **changes: str | None):
    """The environment of a simulator whose recordings leave its disk,
    minus or plus whatever one test is about."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    for name, value in (AN_OBJECT_STORE | changes).items():
        if value is None:
            env.delenv(name, raising=False)
        else:
            env.setenv(name, value)


def test_a_simulator_that_names_no_endpoint_keeps_its_recordings_on_disk(env):
    """No container to run, and nothing to configure, is the whole point:
    a first voice simulation costs a self-hoster no object storage, and a
    contributor's checkout costs them none either."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)

    config = SimulatorConfig.from_env()

    assert config.object_store is None
    assert config.blob_dir.is_dir()


def test_naming_an_endpoint_is_what_sends_recordings_to_object_storage(env):
    a_deployment_with_object_storage(env)

    store = SimulatorConfig.from_env().object_store

    assert store is not None
    assert store.endpoint == "http://minio:9000"
    assert store.access_key_id == "egma-object-storage"
    assert store.bucket == "egma-recordings"
    assert store.region == "us-east-1"


def test_the_bucket_and_the_region_can_both_be_moved(env):
    """Two settings a self-hoster running the deployment's own compose file
    never has to think about — the test above proves what they default to —
    and that a deployment on somebody else's S3 can still move."""
    a_deployment_with_object_storage(
        env,
        EGMA_SIMULATOR_S3_BUCKET="somebody-elses-bucket",
        EGMA_SIMULATOR_S3_REGION="eu-west-2",
    )

    store = SimulatorConfig.from_env().object_store

    assert store.bucket == "somebody-elses-bucket"
    assert store.region == "eu-west-2"


def test_object_storage_leaves_no_blob_directory_to_prove(env):
    """The directory is proved by writing to it, and nothing will write to
    it: a deployment whose recordings go to a bucket must not be refused
    over a filesystem it was never going to touch."""
    a_deployment_with_object_storage(env, EGMA_SIMULATOR_BLOB_DIR=None)

    config = SimulatorConfig.from_env()

    assert config.blob_dir is None
    assert config.wal_dir.is_dir(), "the write-ahead log still needs its volume"


@pytest.mark.parametrize(
    "missing",
    [
        "EGMA_SIMULATOR_S3_ACCESS_KEY_ID",
        "EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY",
    ],
)
def test_object_storage_missing_a_credential_is_refused_by_name(env, missing):
    """A simulator that cannot authenticate to the store would conduct
    every voice simulation to the end and then lose its recording, one
    after another, with the store's refusal rather than the one sentence
    that says which variable to set."""
    a_deployment_with_object_storage(env, **{missing: None})

    with pytest.raises(ValueError) as refusal:
        SimulatorConfig.from_env()

    assert missing in str(refusal.value)


def test_an_endpoint_with_no_scheme_is_refused_by_name(env):
    """`minio:9000` is the natural thing to write next to a compose service
    name, and it reaches nothing."""
    a_deployment_with_object_storage(env, EGMA_SIMULATOR_S3_ENDPOINT="minio:9000")

    with pytest.raises(ValueError) as refusal:
        SimulatorConfig.from_env()

    assert "EGMA_SIMULATOR_S3_ENDPOINT" in str(refusal.value)


@pytest.mark.parametrize(
    "bucket", ["Egma-Recordings", "egma recordings", "egma/recordings", "no"]
)
def test_a_bucket_name_no_store_would_take_is_refused_by_name(env, bucket):
    """A bucket is not a free-text field, and a name with a separator in it
    is worse than one merely refused: it would silently make the first part
    of every key mean something the key confinement never agreed to."""
    a_deployment_with_object_storage(env, EGMA_SIMULATOR_S3_BUCKET=bucket)

    with pytest.raises(ValueError) as refusal:
        SimulatorConfig.from_env()

    assert "EGMA_SIMULATOR_S3_BUCKET" in str(refusal.value)


def test_neither_half_of_the_object_storage_credential_ever_prints(env):
    """A config that landed in a log line by accident says nothing."""
    a_deployment_with_object_storage(env)
    config = SimulatorConfig.from_env()

    printed = repr(config) + repr(config.object_store)

    assert AN_OBJECT_STORE["EGMA_SIMULATOR_S3_ACCESS_KEY_ID"] not in printed
    assert AN_OBJECT_STORE["EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY"] not in printed


def test_the_object_storage_credential_is_registered_for_redaction(env):
    """botocore logs a refused request at DEBUG, headers and all, so what
    keeps the write credential out of a chatty log is proved here — with
    no store, no bucket and no network."""
    from egma_simulator.__main__ import secrets_of

    a_deployment_with_object_storage(env)
    registry = secrets_of(SimulatorConfig.from_env())

    scrubbed = registry.redact(
        "the store refused key "
        f"{AN_OBJECT_STORE['EGMA_SIMULATOR_S3_ACCESS_KEY_ID']} signing with "
        f"{AN_OBJECT_STORE['EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY']}"
    )

    assert AN_OBJECT_STORE["EGMA_SIMULATOR_S3_ACCESS_KEY_ID"] not in scrubbed
    assert AN_OBJECT_STORE["EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY"] not in scrubbed
    assert scrubbed.count("[redacted]") == 2


def test_a_config_with_nowhere_to_put_recordings_is_refused(tmp_path):
    """The pairing is checked, not promised.

    `blob_dir` and `object_store` are one decision written as two fields,
    and the store is chosen by asking which of them is there. Neither set
    would reach the filesystem store with `None` for its directory, which
    fails inside a write the conductor then swallows — a simulation that
    reports no audio and no reason why.
    """
    with pytest.raises(ValueError, match="exactly one place"):
        SimulatorConfig(
            control_plane_url=A_URL,
            claimant="test",
            capacity=1,
            heartbeat_seconds=1.0,
            claim_wait_seconds=1.0,
            report_deadline_seconds=1.0,
            wal_dir=tmp_path,
            blob_dir=None,
            log_level="INFO",
        )


def test_a_config_with_two_places_to_put_recordings_is_refused(tmp_path):
    """And both set is the other way to break it: a deployment writing to
    a bucket while a directory nobody reads fills up beside it."""
    with pytest.raises(ValueError, match="exactly one place"):
        SimulatorConfig(
            control_plane_url=A_URL,
            claimant="test",
            capacity=1,
            heartbeat_seconds=1.0,
            claim_wait_seconds=1.0,
            report_deadline_seconds=1.0,
            wal_dir=tmp_path,
            blob_dir=tmp_path / "blobs",
            log_level="INFO",
            object_store=ObjectStoreSettings(
                endpoint="http://minio:9000",
                bucket="egma-recordings",
                region="us-east-1",
                access_key_id="key",
                secret_access_key="secret",
            ),
        )
