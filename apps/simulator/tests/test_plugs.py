"""The text and voice plug seams, with one deterministic plug for each."""

from __future__ import annotations

import pytest

from egma_simulator.media import VoiceMedia
from egma_simulator.plugs import (
    AgentReply,
    PlugError,
    VoiceConnection,
    plug_for,
)
from egma_simulator.plugs.loopback import LoopbackCounterpart
from egma_simulator.plugs.scripted import FALLBACK_REPLY, ScriptedCounterpart


def scripted(config: dict, *, modality: str = "chat") -> ScriptedCounterpart:
    return ScriptedCounterpart(
        modality=modality,
        access_variant="scripted.in_memory",
        config=config,
        credentials=None,
    )


def loopback(config: dict, *, modality: str = "voice") -> LoopbackCounterpart:
    return LoopbackCounterpart(
        modality=modality,
        access_variant="loopback.in_process",
        config=config,
        credentials=None,
    )


def test_the_registry_knows_the_two_plugs_and_nothing_imaginary():
    assert plug_for("scripted") is ScriptedCounterpart
    assert plug_for("loopback") is LoopbackCounterpart
    assert plug_for("no-such-platform") is None


async def test_the_chat_counterpart_greets_replies_then_falls_back():
    plug = scripted(
        {
            "greeting": "Front desk, good morning.",
            "replies": ["Certainly.", "One moment."],
        }
    )
    assert await plug.open() == "Front desk, good morning."
    assert await plug.deliver("I need help.") == AgentReply("Certainly.")
    assert await plug.deliver("With a booking.") == AgentReply("One moment.")
    assert await plug.deliver("Hello?") == AgentReply(FALLBACK_REPLY)
    await plug.close()


async def test_the_chat_counterpart_can_end_with_words_or_silence():
    speaking = scripted(
        {"replies": ["All sorted. Goodbye now."], "ends_after_replies": True}
    )
    assert await speaking.open() is None
    assert await speaking.deliver("Please cancel it.") == AgentReply(
        "All sorted. Goodbye now.", ended=True
    )
    await speaking.close()

    silent = scripted({"replies": [], "ends_after_replies": True})
    assert await silent.open() is None
    assert await silent.deliver("Anyone there?") == AgentReply(None, ended=True)
    await silent.close()


def test_the_chat_counterpart_offers_its_provider_reference():
    assert scripted({"provider_reference": "scripted-0001"}).provider_reference == (
        "scripted-0001"
    )
    assert scripted({}).provider_reference is None


def test_chat_config_the_counterpart_does_not_know_is_refused():
    with pytest.raises(PlugError, match="repliez"):
        scripted({"repliez": ["typo"]})


@pytest.mark.parametrize(
    "config",
    [
        {"greeting": 7},
        {"replies": "not a list"},
        {"replies": [1, 2]},
        {"ends_after_replies": "yes"},
        {"turn_seconds": "fast"},
        {"turn_seconds": -1},
        {"provider_reference": 12},
    ],
)
def test_chat_config_of_the_wrong_shape_is_refused(config: dict):
    with pytest.raises(PlugError):
        scripted(config)


def test_the_chat_counterpart_refuses_voice():
    with pytest.raises(PlugError, match="voice"):
        scripted({}, modality="voice")


def test_the_loopback_counterpart_is_one_pipecat_voice_connection():
    connection = loopback({})
    assert isinstance(connection, VoiceConnection)
    assert not hasattr(connection, "exchange")
    assert not hasattr(connection, "sample_rate_hz")


async def test_the_loopback_prepares_and_closes_one_transport():
    connection = loopback(
        {
            "greeting": "Front desk, good morning.",
            "replies": ["Certainly."],
        }
    )
    media = await connection.prepare()
    assert isinstance(media, VoiceMedia)
    assert media.input and media.output
    assert not connection.far_end_left

    await connection.close()
    await connection.close()
    assert connection.far_end_left


def test_the_loopback_counterpart_offers_its_provider_reference():
    assert loopback({"provider_reference": "loopback-0001"}).provider_reference == (
        "loopback-0001"
    )
    assert loopback({}).provider_reference is None


def test_loopback_config_it_does_not_know_is_refused():
    with pytest.raises(PlugError, match="turn_seconds"):
        loopback({"turn_seconds": 1})


@pytest.mark.parametrize(
    "config",
    [
        {"greeting": 7},
        {"replies": "not a list"},
        {"replies": [1, 2]},
        {"ends_after_replies": "yes"},
        {"answer_delay_seconds": "slowly"},
        {"answer_delay_seconds": -1},
        {"echoes_what_it_hears": "yes"},
        {"provider_reference": 12},
    ],
)
def test_loopback_config_of_the_wrong_shape_is_refused(config: dict):
    with pytest.raises(PlugError):
        loopback(config)


def test_a_loopback_cannot_echo_and_read_a_script():
    with pytest.raises(PlugError, match="echoes_what_it_hears"):
        loopback({"echoes_what_it_hears": True, "replies": ["Noted."]})


def test_the_loopback_counterpart_refuses_chat():
    with pytest.raises(PlugError, match="chat"):
        loopback({}, modality="chat")
