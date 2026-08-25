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
    assert config.vad_provider == "scripted"
    assert config.service_token is None
    assert config.claimant.startswith("egma-simulator-")
    assert config.log_level == "INFO"
    assert config.blob_dir == tmp_path / "blobs"


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
    ):
        env.setenv(name, "")

    config = SimulatorConfig.from_env()

    assert config.capacity == 2
    assert config.claimant.startswith("egma-simulator-")
    assert config.heartbeat_seconds == 5.0
    assert config.log_level == "INFO"
    assert config.vad_provider == "scripted"
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


def test_a_simulator_that_names_no_bridge_starts_and_places_no_calls(env):
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    assert SimulatorConfig.from_env().media is None


def test_a_bridge_nobody_wrote_is_refused_by_name(env):
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_MEDIA_BACKEND", "a-bridge-nobody-wrote")
    with pytest.raises(ValueError) as refusal:
        SimulatorConfig.from_env()
    assert "EGMA_SIMULATOR_MEDIA_BACKEND" in str(refusal.value)


def test_the_scripted_bridge_needs_nothing_else(env):
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


def test_a_work_order_carrier_cannot_select_a_media_backend(env):
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    carrier = PlatformCarrier(trunk_address="a.example.com")
    assert MediaSettings.for_simulation(None, carrier) is None


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


@pytest.mark.parametrize(
    "missing",
    ["trunk_address", "trunk_number", "trunk_username", "trunk_password"],
)
def test_every_work_order_carrier_value_is_required(env, missing: str):
    a_deployment_that_dials(env)
    values = {
        "trunk_address": "trunk.example",
        "trunk_number": "+15551110000",
        "trunk_username": "user",
        "trunk_password": "secret",
    }
    values[missing] = None
    carrier = PlatformCarrier(**values)
    media = MediaSettings.for_simulation(SimulatorConfig.from_env().media, carrier)
    assert media is not None
    with pytest.raises(ValueError) as refusal:
        media.checked()
    told = str(refusal.value)
    assert f"platform.carrier.{missing}" in told


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
