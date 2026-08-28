"""One real chat simulation of a real Retell voice agent — opt-in.

Everything else on this lane converses with a playground-shaped stub, which
proves the plug speaks the documented protocol and nothing at all about the
platform behind it. This file is the other half, and the founder's one live
proof: a genuine chat simulation against a real Retell **voice** agent, over
the agent-playground-completion API, with a mocked tool answer and a node or
state transition on the record — and no audio anywhere, because the playground
synthesizes nothing and hears nothing.

It is written here and **run by the developer**, never by an agent and never
by CI: agents test against fakes only, and the live account is the developer's
to touch (ruling 2026-08-28). With its environment missing it skips — visibly,
never failing, never waiting on anybody, and never reaching a network.

## The one command

    TEST_RETELL_API_KEY=key_... \\
    TEST_RETELL_AGENT_ID=agent_... \\
    TEST_MODEL_API_KEY=sk-... \\
    uv run pytest tests/test_live_playground.py -v -s

## What it needs, and why each

- **TEST_RETELL_API_KEY** and **TEST_RETELL_AGENT_ID** — a real Retell key and
  a real **voice** agent on that account, conducted on a conversation flow or a
  Retell LLM (a custom-LLM agent is refused by construction and is the wrong
  agent for this proof). The agent should have at least one tool and a prompt
  that a booking-style scenario leads it to call, so a mocked answer lands.
- **TEST_MODEL_API_KEY** — a funded model key for the persona's own brain, so
  the caller reasons for real rather than reading a script. It is the OpenAI
  key `direct_models` gives the persona; each name also falls back to the
  provider's own plain variable, so one environment drives the whole thing.
- **TEST_RETELL_SCENARIO** — optional, the situation the persona calls about;
  tune it to what exercises your agent's tools. A booking-style default is
  used when it is unset.

It **banks its proof**: the whole record it read is written to a JSON file
under `tests/.live-proof/` (git-ignored) and its path is printed, and the
transcript, the coverage stamp, every mocked tool call and every transition
are printed to stdout — which is what the `-s` above is for. Watch it work.

## What only a live run can say

The exchange really was text — the record carries no audio and no provider
reference, because the playground stores nothing on Retell's side. The version
egma resolved was named on every request. Egma's mock answers reached the real
agent, marked `mocked` on the record with the tool that served them. And the
platform's own node or state transitions rode back beside the turns, verbatim,
which is what makes a chat record of a voice agent comparable with a voice one.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import aiohttp
import pytest
from conftest import (
    a_spec,
    assert_kept_secret,
    credential,
    direct_models,
    has_terminal,
    span_attribute,
    spans_for,
    terminal_event_for,
    turns_for,
)

from egma_simulator.plugs.retell import DEFAULT_BASE_URL

API_KEY = credential("TEST_RETELL_API_KEY", "RETELL_API_KEY")
AGENT_ID = credential("TEST_RETELL_AGENT_ID", "EGMA_RETELL_AGENT_ID")
MODEL_API_KEY = credential("TEST_MODEL_API_KEY", "OPENAI_API_KEY")
BASE_URL = credential("TEST_RETELL_BASE_URL", "") or DEFAULT_BASE_URL

REQUIRED = {
    "TEST_RETELL_API_KEY": API_KEY,
    "TEST_RETELL_AGENT_ID": AGENT_ID,
    "TEST_MODEL_API_KEY": MODEL_API_KEY,
}
MISSING = sorted(name for name, value in REQUIRED.items() if not value)

pytestmark = pytest.mark.skipif(
    bool(MISSING),
    reason=(
        "no live Retell playground environment: set "
        + ", ".join(MISSING)
        + " to conduct one real chat simulation of a real Retell voice agent, "
        "with a mocked tool answer and a transition on the record"
    ),
)

SIMULATION = "sim-playground-live-001"

DEFAULT_SCENARIO = (
    "You are calling to move a booked appointment. Ask what times are free "
    "later this week, accept whatever the agent offers, and confirm the new "
    "time back before finishing."
)
SCENARIO = credential("TEST_RETELL_SCENARIO", "") or DEFAULT_SCENARIO

PERSONALITY = (
    "Polite and warm; explains yourself in two or three full sentences at a "
    "time rather than clipped answers."
)

# A chat exchange pays a real second per turn and Retell's per-request cost, so
# the walls are short: this proves the path works, not that an agent can talk
# all day.
MAX_TURNS = 12
MAX_DURATION_SECONDS = 90
WITHIN_SECONDS = MAX_DURATION_SECONDS + 60

# What every discovered tool is answered with. Its only job is to reach the
# agent so the record can show it did: a small, unmistakably-Egma answer, the
# same one whatever the tool, because what is being proved is interception and
# not a chain-consistent world.
MOCK_ANSWER: dict[str, object] = {
    "ok": True,
    "note": "answered by an Egma mock tool during a chat simulation",
    "slots": ["Thursday 2:30pm", "Friday 10:00am"],
}

# Where a proof is banked, so a hand-run leaves something to keep and read.
PROOF_DIR = Path(__file__).with_name(".live-proof")


async def _read_json(
    session: aiohttp.ClientSession, url: str
) -> dict[str, object]:
    async with session.get(
        url,
        headers={"Authorization": f"Bearer {API_KEY}"},
        timeout=aiohttp.ClientTimeout(total=30),
    ) as response:
        assert response.status == 200, (
            f"{url} → {response.status}: {await response.text()}"
        )
        body = await response.json()
    assert isinstance(body, dict)
    return body


async def _mockable_tools() -> tuple[list[str], object]:
    """The names of the tools Egma can stand in front of, and the serving version.

    Read the way the run-start read reads it — resolve the serving version once
    by name, then read that version's engine document — so what is mocked is
    what the agent actually runs. A custom LLM holds nothing here and is the
    wrong agent for this proof; the read says so rather than guessing.
    """
    async with aiohttp.ClientSession() as session:
        agent = await _read_json(
            session, f"{BASE_URL}/get-agent/{AGENT_ID}?version=latest"
        )
        version = agent.get("version")
        engine = agent.get("response_engine")
        assert isinstance(engine, dict), f"no response engine on {AGENT_ID}: {agent}"
        engine_type = engine.get("type")
        if engine_type == "custom-llm":
            pytest.fail(
                f"agent {AGENT_ID} is a custom LLM: Retell holds none of its "
                "tools, and this lane refuses it by construction. Point "
                "TEST_RETELL_AGENT_ID at a conversation-flow or Retell-LLM "
                "voice agent for this proof."
            )

        engine_version = engine.get("version")
        query = (
            f"?version={engine_version}"
            if isinstance(engine_version, int)
            else ""
        )
        if engine_type == "conversation-flow":
            flow_id = engine.get("conversation_flow_id")
            document = await _read_json(
                session, f"{BASE_URL}/get-conversation-flow/{flow_id}{query}"
            )
            raw = document.get("tools")
        else:
            llm_id = engine.get("llm_id")
            document = await _read_json(
                session, f"{BASE_URL}/get-retell-llm/{llm_id}{query}"
            )
            raw = document.get("general_tools")

        tools = raw if isinstance(raw, list) else []
        names: list[str] = []
        for tool in tools:
            # Only the tool type Egma stands in front of by name; the platform's
            # own kinds — transfer, end call, SMS — run inside Retell.
            if isinstance(tool, dict) and tool.get("type") == "custom":
                name = tool.get("name")
                if isinstance(name, str) and name and name not in names:
                    names.append(name)
        return names, version


def _live_spec(mock_tools: list[dict], version: object) -> dict:
    """A playground spec against real Retell: no baseUrl, so the plug reaches
    Retell itself, and the persona's own funded brain."""
    spec = a_spec(
        SIMULATION,
        modality="chat",
        connection={
            "agent_platform": "retell",
            "connection_type": "retell_playground",
            "access_variant": "retell_playground.api_key",
            # No baseUrl: the plug reaches Retell's own address.
            "config": {"retellAgentId": AGENT_ID},
            "credentials": {"apiKey": API_KEY},
        },
        scenario=SCENARIO,
        personality=PERSONALITY,
        max_turns=MAX_TURNS,
        max_duration_seconds=MAX_DURATION_SECONDS,
        dynamic_variables={"egma_simulation": SIMULATION},
        mock_tools=mock_tools or None,
        models=direct_models(modality="chat", llm_key=MODEL_API_KEY),
    )
    if isinstance(version, int):
        spec["agent_version"] = version
    return spec


def _bank(records: list[dict]) -> Path:
    """Write the whole record read to a git-ignored file, and answer its path."""
    PROOF_DIR.mkdir(exist_ok=True)
    path = PROOF_DIR / f"playground-{int(time.time())}.json"
    path.write_text(json.dumps(records, indent=2), encoding="utf-8")
    return path


def _tool_calls(records: list[dict]) -> list[dict]:
    return [
        record["span"]
        for record in spans_for(records, SIMULATION)
        if record["span"]["name"] == "tool_call"
    ]


def _transitions(records: list[dict]) -> list[str]:
    """Every platform note the record carries beside an agent turn.

    A node or state transition Retell announces arrives in a role the record
    does not know and is preserved verbatim as that turn's platform notes,
    beside the words rather than among them. Those notes are where a transition
    lands on the record.
    """
    notes: list[str] = []
    for record in spans_for(records, SIMULATION):
        span = record["span"]
        if span["name"] != "agent_turn":
            continue
        note = span_attribute(span, "egma.turn.platform_notes")
        if note:
            notes.append(note)
    return notes


def _hand_back(records: list[dict], banked: Path) -> None:
    """Show the founder the promise working: the transcript, the mocked calls,
    the transitions, and where the whole record was banked."""
    print(f"\n--- banked proof ---\n{banked}")
    print("\n--- the transcript ---")
    for speaker, text in turns_for(records, SIMULATION):
        print(f"{speaker:>6}: {text}")

    terminal = terminal_event_for(records, SIMULATION) or {}
    coverage = (terminal.get("facts") or {}).get("mock_tool_coverage")
    print(f"\n--- the coverage stamp ---\n{json.dumps(coverage, indent=2)}")

    print("\n--- the mocked tool calls, on the record ---")
    for call in _tool_calls(records):
        provenance = span_attribute(call, "egma.tool.provenance")
        print(
            f"{span_attribute(call, 'egma.tool.name')}: "
            f"provenance={provenance}, "
            f"mock_tool={span_attribute(call, 'egma.tool.mock_tool')}, "
            f"result={span_attribute(call, 'egma.tool.result')}"
        )

    print("\n--- the transitions, on the record ---")
    for note in _transitions(records):
        print(note)


@pytest.mark.timeout(WITHIN_SECONDS + 60)
async def test_a_real_retell_voice_agent_is_conducted_in_text(
    workbench, start_simulator
):
    tool_names, version = await _mockable_tools()
    mock_tools = [
        {"tool_name": name, "answer": {"answer": MOCK_ANSWER}} for name in tool_names
    ]

    await workbench.offer(_live_spec(mock_tools, version))
    # A real persona brain, no speech: chat synthesizes and hears nothing.
    simulator = start_simulator(workbench, direct_model=True)

    records = await workbench.wait_for(
        has_terminal(SIMULATION), within_seconds=WITHIN_SECONDS
    )

    # The scan comes first, before anything about the conversation is asserted:
    # the likeliest place a credential reaches a log is a refusal, so a scan
    # written below a status assertion would never run on the run that failed.
    simulator.stop()
    assert_kept_secret(API_KEY, records=records, simulator=simulator)
    assert_kept_secret(MODEL_API_KEY, records=records, simulator=simulator)

    banked = _bank(records)
    _hand_back(records, banked)

    terminal = terminal_event_for(records, SIMULATION)
    assert terminal is not None
    assert terminal["status"] == "completed", terminal.get("reason")
    facts = terminal["facts"]

    # No audio and no provider reference: the two facts that say this really was
    # a text exchange the playground kept nothing of.
    assert facts["audio"] is None, "a chat simulation carried audio"
    assert facts["provider_reference"] is None, (
        "the playground answered a provider reference it is not supposed to keep"
    )

    # The coverage stamp is present with its three classes: the run read the
    # agent's tools before the first turn.
    coverage = facts["mock_tool_coverage"]
    assert coverage is not None, "no coverage stamp: the world was never read"
    assert set(coverage) >= {"discovered", "covered", "uncovered"}, coverage

    # A genuine exchange happened: the persona reasoned and the agent answered.
    spoken = turns_for(records, SIMULATION)
    agent_turns = [text for speaker, text in spoken if speaker == "agent"]
    human_turns = [text for speaker, text in spoken if speaker == "human"]
    assert agent_turns, f"the agent never said anything: {spoken}"
    assert human_turns, f"the persona never said anything: {spoken}"

    # A transition on the record: a node or state the platform announced,
    # preserved beside a turn. This is half of what the proof exists to show.
    transitions = _transitions(records)
    assert transitions, (
        "no node or state transition on the record: use an agent and a scenario "
        "whose conversation moves through its flow or its states"
    )

    # A mocked tool answer on the record: the other half. Every tool call the
    # agent made that the run covered is marked mocked, never run for real.
    calls = _tool_calls(records)
    assert calls, (
        "the agent called no tool, so no mocked answer could land: set "
        "TEST_RETELL_SCENARIO to something that leads your agent to a tool"
    )
    covered = set(tool_names)
    mocked = [
        call
        for call in calls
        if span_attribute(call, "egma.tool.name") in covered
    ]
    assert mocked, (
        "the agent called only tools no mock covered; the ones this run mocked "
        f"were {sorted(covered)} and it called "
        f"{[span_attribute(call, 'egma.tool.name') for call in calls]}"
    )
    for call in mocked:
        assert span_attribute(call, "egma.tool.provenance") == "mocked", (
            "a covered tool call was not marked mocked: an authored answer did "
            "not reach the agent"
        )
        assert span_attribute(call, "egma.tool.mock_tool"), (
            "a mocked call carries no mock-tool name"
        )

    # Nothing the simulator sent was refused on its way in. A throttled account
    # would have failed the run loudly rather than degrading into a shorter
    # exchange, so a completed run with no refusal is also the rate-limit's
    # answer — what the actual limit is stays informational, read off this run.
    assert [record for record in records if record["kind"] == "refusal"] == []
