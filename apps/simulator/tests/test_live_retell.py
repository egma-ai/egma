"""Opt-in simulation against a real Retell chat agent with a scripted persona.
Run with TEST_RETELL_API_KEY and TEST_RETELL_AGENT_ID:
uv run pytest tests/test_live_retell.py -v
Check workbench reports and query Retell to verify platform chat termination.
Skip without credentials.
"""

from __future__ import annotations

import os

import aiohttp
import pytest
from conftest import (
    assert_kept_secret,
    has_terminal,
    retell_spec,
    terminal_event_for,
    turns_for,
)

from egma_simulator.plugs.retell import DEFAULT_BASE_URL

API_KEY = os.environ.get("TEST_RETELL_API_KEY", "").strip()
AGENT_ID = os.environ.get("TEST_RETELL_AGENT_ID", "").strip()
BASE_URL = os.environ.get("TEST_RETELL_BASE_URL", "").strip() or DEFAULT_BASE_URL

pytestmark = pytest.mark.skipif(
    not (API_KEY and AGENT_ID),
    reason=(
        "no live Retell credentials: set TEST_RETELL_API_KEY and "
        "TEST_RETELL_AGENT_ID to conduct a real conversation"
    ),
)

# Short walls on purpose: a live exchange pays real seconds per turn, and
# this test proves the path works, not that an agent can talk all day.
MAX_TURNS = 8
MAX_DURATION_SECONDS = 45


async def test_the_persona_conducts_a_real_conversation_with_a_retell_agent(
    workbench, start_simulator
):
    spec = retell_spec(
        "sim-retell-live-001",
        base_url=BASE_URL,
        api_key=API_KEY,
        agent_id=AGENT_ID,
        scenario=(
            "You are calling about an appointment. "
            "Ask whether you can move it to Thursday."
        ),
        personality="Polite and brief; asks one thing at a time.",
        max_turns=MAX_TURNS,
        max_duration_seconds=MAX_DURATION_SECONDS,
    )
    await workbench.offer(spec)
    simulator = start_simulator(workbench)

    records = await workbench.wait_for(
        has_terminal("sim-retell-live-001"), within_seconds=90
    )
    terminal = terminal_event_for(records, "sim-retell-live-001")
    assert terminal["status"] == "completed", terminal["reason"]

    # A real agent said real words, and the transcript alternates the way a
    # conversation does.
    spoken = turns_for(records, "sim-retell-live-001")
    agent_turns = [text for speaker, text in spoken if speaker == "agent"]
    human_turns = [text for speaker, text in spoken if speaker == "human"]
    assert agent_turns, f"the agent never said anything: {spoken}"
    assert human_turns, f"the persona never said anything: {spoken}"
    assert all(text.strip() for text in agent_turns)

    chat_id = terminal["facts"]["provider_reference"]
    assert chat_id, "no Retell chat id came back to join the record to theirs"

    simulator.stop()

    # The credential conducted the whole exchange and appears nowhere.
    assert_kept_secret(API_KEY, records=records, simulator=simulator)

    # And the exchange was really ended at the platform, which only the
    # platform can say.
    assert await _chat_status(chat_id) == "ended"


async def _chat_status(chat_id: str) -> str:
    async with aiohttp.ClientSession() as session:
        async with session.get(
            f"{BASE_URL}/get-chat/{chat_id}",
            headers={"Authorization": f"Bearer {API_KEY}"},
            timeout=aiohttp.ClientTimeout(total=30),
        ) as response:
            assert response.status == 200, await response.text()
            return (await response.json())["chat_status"]
