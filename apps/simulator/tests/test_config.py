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

import os
from pathlib import Path

import pytest

from egma_simulator.config import SimulatorConfig

A_URL = "http://control-plane.internal:3100"


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """A clean environment, and somewhere harmless for the two directories.

    Whatever this machine has set is cleared first, so a developer with
    their own ``EGMA_SIMULATOR_*`` exported cannot make these pass or fail
    differently from anybody else's.
    """
    for name in list(os.environ):
        if name.startswith("EGMA_SIMULATOR_"):
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("EGMA_SIMULATOR_WAL_DIR", str(tmp_path / "wal"))
    monkeypatch.setenv("EGMA_SIMULATOR_BLOB_DIR", str(tmp_path / "blobs"))
    return monkeypatch


def test_one_variable_is_enough(env, tmp_path):
    """Everything but the control plane has a default that works."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)

    config = SimulatorConfig.from_env()

    assert config.control_plane_url == A_URL
    assert config.capacity == 4
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

    assert config.capacity == 4
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


def test_a_deployment_with_no_trunk_at_all_is_refused_naming_both_ways(env):
    """A call needs a trunk, and there are two ways to give one — so the
    refusal names both rather than picking one for somebody."""
    a_deployment_that_dials(env, EGMA_SIMULATOR_SIP_TRUNK_ADDRESS=None)
    with pytest.raises(ValueError) as refusal:
        SimulatorConfig.from_env()
    told = str(refusal.value)
    assert "EGMA_SIMULATOR_SIP_TRUNK_ID" in told
    assert "EGMA_SIMULATOR_SIP_TRUNK_ADDRESS" in told


def test_a_bring_your_own_trunk_arrives_whole(env):
    """Any carrier, inline, with the credential auth LiveKit documents."""
    a_deployment_that_dials(env)
    media = SimulatorConfig.from_env().media
    assert media.trunk_address == "trunk.example.pstn.twilio.com"
    assert media.trunk_username == "trunk-user"
    assert media.trunk_number == "+15550000000"


def test_a_stored_trunk_reference_is_the_other_way(env):
    a_deployment_that_dials(
        env,
        EGMA_SIMULATOR_SIP_TRUNK_ID="ST_1234",
        EGMA_SIMULATOR_SIP_TRUNK_ADDRESS=None,
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
