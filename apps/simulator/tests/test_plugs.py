"""The platform-plug seam, and the scripted counterpart that proves it.

A plug is the one component that knows how to reach and talk to a
platform; everything else is plug-blind. The scripted counterpart is the
first plug — CI's fake platform — so its behavior is pinned here: the
greeting, the scripted replies in order, the deliberate ending, the
fallback when the script runs dry, and the refusal of config it does not
understand.
"""

from __future__ import annotations

import pytest

from egma_simulator.plugs import AgentReply, PlugError, plug_for
from egma_simulator.plugs.scripted import FALLBACK_REPLY, ScriptedCounterpart


def scripted(config: dict, *, modality: str = "chat") -> ScriptedCounterpart:
    return ScriptedCounterpart(modality=modality, config=config, credentials=None)


def test_the_registry_knows_the_scripted_plug_and_nothing_imaginary():
    assert plug_for("scripted") is ScriptedCounterpart
    assert plug_for("no-such-platform") is None


async def test_the_counterpart_greets_replies_in_order_then_falls_back():
    plug = scripted(
        {
            "greeting": "Front desk, good morning.",
            "replies": ["Certainly.", "One moment."],
        }
    )
    assert await plug.open() == "Front desk, good morning."
    assert await plug.deliver("I need help.") == AgentReply(
        text="Certainly.", ended=False
    )
    assert await plug.deliver("With a booking.") == AgentReply(
        text="One moment.", ended=False
    )
    # The script is dry and the counterpart was not told to end: it holds
    # the exchange open with a fixed line, deterministically.
    assert await plug.deliver("Hello?") == AgentReply(
        text=FALLBACK_REPLY, ended=False
    )
    await plug.close()


async def test_the_counterpart_can_end_the_exchange_with_its_last_reply():
    plug = scripted(
        {
            "replies": ["All sorted. Goodbye now."],
            "ends_after_replies": True,
        }
    )
    assert await plug.open() is None
    assert await plug.deliver("Please cancel it.") == AgentReply(
        text="All sorted. Goodbye now.", ended=True
    )
    await plug.close()


async def test_a_counterpart_with_nothing_to_say_ends_silently():
    plug = scripted({"replies": [], "ends_after_replies": True})
    assert await plug.open() is None
    assert await plug.deliver("Anyone there?") == AgentReply(text=None, ended=True)
    await plug.close()


async def test_the_counterpart_offers_its_provider_reference():
    plug = scripted({"provider_reference": "scripted-0001"})
    assert plug.provider_reference == "scripted-0001"
    assert scripted({}).provider_reference is None


def test_config_the_counterpart_does_not_know_is_refused():
    with pytest.raises(PlugError) as refusal:
        scripted({"repliez": ["typo"]})
    assert "repliez" in str(refusal.value)


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
def test_config_of_the_wrong_shape_is_refused(config: dict):
    with pytest.raises(PlugError):
        scripted(config)


def test_the_counterpart_speaks_chat_only_for_now():
    with pytest.raises(PlugError) as refusal:
        scripted({}, modality="voice")
    assert "voice" in str(refusal.value)
