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
