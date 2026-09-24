"""Verify named startup errors and usable defaults with an isolated environment
and temporary directories. No network is needed.
"""

from __future__ import annotations

import pytest

from egma_simulator.config import (
    MediaSettings,
    SimulatorConfig,
)
from egma_simulator.spec import PlatformCarrier

A_URL = "http://control-plane.internal:3100"


def test_empty_means_unset(env):
    """Optional variables left blank fall back rather than taking "".

    Compose hands an unset optional through as an empty string instead of
    leaving it out, so every entry in the compose file can carry a
    ``${VAR:-}`` default.
    """
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    for name in (
        "EGMA_SIMULATOR_CAPACITY",
        "EGMA_SIMULATOR_CLAIMANT",
        "EGMA_SIMULATOR_HEARTBEAT_SECONDS",
        "EGMA_SIMULATOR_LOG_LEVEL",
        "EGMA_SIMULATOR_SERVICE_TOKEN",
        "EGMA_SIMULATOR_MODE",
        "EGMA_SIMULATOR_MODALITIES",
        "EGMA_SIMULATOR_THREAD_POOL_WORKERS",
    ):
        env.setenv(name, "")

    config = SimulatorConfig.from_env()

    assert config.capacity == 2
    assert config.claimant.startswith("egma-simulator-")
    assert config.heartbeat_seconds == 5.0
    assert config.log_level == "INFO"
    assert config.vad_provider == "scripted"
    assert config.service_token is None


def test_a_capacity_below_one_is_refused_by_name(env):
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_CAPACITY", "0")

    with pytest.raises(ValueError, match="EGMA_SIMULATOR_CAPACITY"):
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
    "EGMA_SIMULATOR_EXECUTION_DEADLINE_SECONDS",
]
"""Every variable read as a duration — all of them through one helper."""


@pytest.mark.parametrize("variable", DURATION_VARIABLES)
@pytest.mark.parametrize("written", ["nan", "inf"])
def test_a_duration_that_is_not_finite_is_refused_by_name(env, variable, written):
    """Reject NaN and infinities even though float() accepts them.
    Range checks alone can admit values that disable heartbeats or retry deadlines.
    """
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv(variable, written)

    with pytest.raises(ValueError, match=variable):
        SimulatorConfig.from_env()


def test_one_shot_voice_mode_has_one_slot_and_its_own_lifetime(env):
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_MODE", "one-shot")
    env.setenv("EGMA_SIMULATOR_EXECUTION_DEADLINE_SECONDS", "12")
    env.setenv("EGMA_SIMULATOR_THREAD_POOL_WORKERS", "1")

    config = SimulatorConfig.from_env()

    assert config.mode == "one-shot"
    assert config.capacity == 1
    assert config.modalities == ("voice",)
    assert config.execution_deadline_seconds == 12
    assert config.thread_pool_workers == 1


@pytest.mark.parametrize(
    ("variable", "value"),
    [
        ("EGMA_SIMULATOR_CAPACITY", "2"),
        ("EGMA_SIMULATOR_MODALITIES", "chat"),
    ],
)
def test_a_bounded_mode_refuses_non_voice_fleet_shape(env, variable, value):
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_MODE", "one-shot")
    env.setenv(variable, value)

    with pytest.raises(ValueError, match=variable):
        SimulatorConfig.from_env()


@pytest.mark.parametrize(
    "variable", ["EGMA_SIMULATOR_BLOB_DIR", "EGMA_SIMULATOR_WAL_DIR"]
)
def test_a_directory_that_cannot_be_written_is_refused_by_name(env, tmp_path, variable):
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


def test_the_service_token_is_read_and_kept_out_of_the_repr(env):
    """It is a credential, so it travels like one: never in a printed config."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_SERVICE_TOKEN", "egma_service_token_under_test")

    config = SimulatorConfig.from_env()

    assert config.service_token == "egma_service_token_under_test"
    assert "egma_service_token_under_test" not in repr(config)


# -- Placing phone calls -----------------------------------------------------
#
# The deployment selects and authenticates the media bridge. The carrier
# trunk arrives only on each work order. This keeps one owner for each fact.

A_LIVEKIT = {
    "EGMA_SIMULATOR_MEDIA_BACKEND": "livekit",
    "EGMA_SIMULATOR_LIVEKIT_URL": "wss://livekit.internal",
    "EGMA_SIMULATOR_LIVEKIT_API_KEY": "APIkey",
    "EGMA_SIMULATOR_LIVEKIT_API_SECRET": "SENTINEL-livekit-secret-4c81",
}


def a_deployment_that_dials(env, **changes: str | None):
    """A simulator bridge, minus or plus what one test is about."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    for name, value in (A_LIVEKIT | changes).items():
        if value is None:
            env.delenv(name, raising=False)
        else:
            env.setenv(name, value)


def test_a_bridge_starts_without_a_trunk_and_refuses_a_carrierless_call(env):
    """The container can wait for work; only a claimed phone call needs a trunk."""
    a_deployment_that_dials(env)
    standing = SimulatorConfig.from_env().media
    assert standing is not None
    assert standing.trunk_address is None

    settled = MediaSettings.for_simulation(standing, PlatformCarrier())
    assert settled is not None
    with pytest.raises(ValueError, match="platform.carrier.trunk_address"):
        settled.checked()


def test_daytona_livekit_uses_only_scoped_room_credentials(env):
    a_deployment_that_dials(
        env,
        EGMA_SIMULATOR_LIVEKIT_API_KEY=None,
        EGMA_SIMULATOR_LIVEKIT_API_SECRET=None,
        EGMA_SIMULATOR_LIVEKIT_ROOM_TOKEN="room-token",
        EGMA_SIMULATOR_LIVEKIT_API_TOKEN="api-token",
        EGMA_SIMULATOR_LIVEKIT_ROOM_NAME="egma-sim-runtime-1",
    )

    media = SimulatorConfig.from_env().media

    assert media is not None
    assert media.livekit_api_key is None
    assert media.livekit_api_secret is None
    assert media.livekit_room_name == "egma-sim-runtime-1"
    assert "room-token" not in repr(media)
    assert "api-token" not in repr(media)


def test_a_phone_call_uses_only_the_work_order_carrier(env):
    """Bridge facts come from deployment; every trunk fact comes from the claim."""
    a_deployment_that_dials(env)
    settled = MediaSettings.for_simulation(
        SimulatorConfig.from_env().media,
        PlatformCarrier(
            trunk_address="platform.pstn.twilio.com",
            trunk_number="+15551110000",
            trunk_username="platform-user",
            trunk_password="SENTINEL-platform-trunk-password",
        ),
    )

    assert settled is not None
    assert settled.livekit_url == "wss://livekit.internal"
    assert settled.livekit_api_secret == "SENTINEL-livekit-secret-4c81"
    assert settled.trunk_address == "platform.pstn.twilio.com"
    assert settled.trunk_number == "+15551110000"
    assert settled.trunk_username == "platform-user"
    assert settled.trunk_password == "SENTINEL-platform-trunk-password"
    settled.checked()


def test_a_container_without_a_bridge_cannot_be_enabled_by_a_work_order(env):
    a_deployment_that_dials(env, EGMA_SIMULATOR_MEDIA_BACKEND=None)
    assert SimulatorConfig.from_env().media is None
    assert (
        MediaSettings.for_simulation(
            None, PlatformCarrier(trunk_address="platform.pstn.twilio.com")
        )
        is None
    )


def test_telephony_secrets_never_print(env):
    a_deployment_that_dials(env)
    config = SimulatorConfig.from_env()
    settled = MediaSettings.for_simulation(
        config.media,
        PlatformCarrier(
            trunk_address="trunk.example",
            trunk_number="+15551110000",
            trunk_username="user",
            trunk_password="SENTINEL-platform-trunk-password",
        ),
    )
    printed = repr(config) + repr(config.media) + repr(settled)
    assert A_LIVEKIT["EGMA_SIMULATOR_LIVEKIT_API_SECRET"] not in printed
    assert "SENTINEL-platform-trunk-password" not in printed


def test_only_the_bridge_secret_is_registered_at_startup(env):
    """A carrier password does not enter the process before a claim."""
    from egma_simulator.__main__ import secrets_of

    a_deployment_that_dials(env)
    registry = secrets_of(SimulatorConfig.from_env())
    scrubbed = registry.redact(
        f"livekit refused {A_LIVEKIT['EGMA_SIMULATOR_LIVEKIT_API_SECRET']}"
    )
    assert A_LIVEKIT["EGMA_SIMULATOR_LIVEKIT_API_SECRET"] not in scrubbed
    assert scrubbed.count("[redacted]") == 1


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


def test_naming_an_endpoint_is_what_sends_recordings_to_object_storage(env):
    a_deployment_with_object_storage(env)

    store = SimulatorConfig.from_env().object_store

    assert store is not None
    assert store.endpoint == "http://minio:9000"
    assert store.access_key_id == "egma-object-storage"
    assert store.bucket == "egma-recordings"
    assert store.region == "us-east-1"


def test_object_storage_accepts_an_sts_session_token(env):
    a_deployment_with_object_storage(
        env, EGMA_SIMULATOR_S3_SESSION_TOKEN="temporary-session-token"
    )

    store = SimulatorConfig.from_env().object_store

    assert store is not None
    assert store.session_token == "temporary-session-token"
    assert "temporary-session-token" not in repr(store)


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


@pytest.mark.parametrize(
    "bucket", ["egma-Recordings", "egma recordings", "egma/recordings", "no"]
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


