"""What the simulator promises, proved black-box at the contract seam.

The workbench offers specs; a real simulator process claims, conducts,
heartbeats and reports; every assertion below reads only what the
workbench recorded. Nothing inspects the simulator — that is the point:
what the records show is all the control plane will ever know.

Every exchange here is a real conversation: the persona on the scripted
model client, the agent played by the scripted counterpart plug. Nothing
in this suite reaches a network beyond loopback or a model beyond the
scripted one, which is why none of it can flake.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime

from conftest import (
    HEARTBEAT_SECONDS,
    all_terminal,
    events_for,
    has_terminal,
    heartbeats_for,
    load_fixture_spec,
    scripted_spec,
    status_events_for,
    terminal_event_for,
)

from egma_simulator.model import GOODBYE

LONG_SCENARIO = " ".join(f"Sentence number {n}." for n in range(1, 41))


async def test_a_scripted_persona_converses_with_the_scripted_counterpart(
    workbench, start_simulator
):
    """The whole exchange, turn for turn, timestamped, on the record."""
    spec = scripted_spec(
        "sim-chat-001",
        scenario=(
            "I need to move my Tuesday cleaning to Thursday. "
            "My name is Margaret Hale."
        ),
        greeting="Lakeside Dental, how can I help?",
        replies=[
            "Of course — could I take your name?",
            "Done: you are moved to Thursday at half past two.",
        ],
        provider_reference="scripted-accept-1",
    )
    await workbench.offer(spec)
    start_simulator(workbench)

    records = await workbench.wait_for(has_terminal("sim-chat-001"))

    claims = [
        record
        for record in records
        if record["kind"] == "claim" and "sim-chat-001" in record["granted"]
    ]
    assert len(claims) == 1
    assert len(heartbeats_for(records, "sim-chat-001")) >= 1

    statuses = status_events_for(records, "sim-chat-001")
    assert statuses[0] == "running"
    assert statuses[-1] == "completed"

    # The transcript, turn for turn: the greeting, the persona's scenario
    # sentence by sentence against the counterpart's scripted answers, and
    # the persona's concluding goodbye.
    turns = events_for(records, "sim-chat-001", "turn")
    assert [(turn["speaker"], turn["text"]) for turn in turns] == [
        ("agent", "Lakeside Dental, how can I help?"),
        ("human", "I need to move my Tuesday cleaning to Thursday."),
        ("agent", "Of course — could I take your name?"),
        ("human", "My name is Margaret Hale."),
        ("agent", "Done: you are moved to Thursday at half past two."),
        ("human", GOODBYE),
    ]

    # Timestamped, and in order: every turn carries its moment, and the
    # moments never run backwards.
    started_ats = [datetime.fromisoformat(turn["started_at"]) for turn in turns]
    assert started_ats == sorted(started_ats)

    terminal = terminal_event_for(records, "sim-chat-001")
    facts = terminal["facts"]
    assert facts["ending"] == "persona_concluded"
    assert facts["turn_count"] == len(turns)
    assert facts["audio"] is None
    assert facts["provider_reference"] == "scripted-accept-1"
    assert (
        datetime.fromisoformat(facts["ended_at"])
        >= datetime.fromisoformat(facts["started_at"])
    )

    # Measured, not judged: the first answer's latency, and one
    # measurement per answered turn.
    timings = events_for(records, "sim-chat-001", "timing")
    measures = [event["measure"] for event in timings]
    assert measures.count("first_response_latency") == 1
    assert measures.count("turn_response_latency") == 2

    # The workbench refused nothing: every document validated.
    assert [record for record in records if record["kind"] == "refusal"] == []

    # And the record's own order tells the story: claimed before running,
    # running before any turn, every turn before completed.
    def first_seq(kind: str, status: str | None = None) -> int:
        for record in records:
            if record["kind"] == "report" and record["simulation_id"] == "sim-chat-001":
                event = record["event"]
                if event["kind"] == kind and (
                    status is None or event.get("status") == status
                ):
                    return record["seq"]
        raise AssertionError(f"no {kind}/{status} on record")

    assert claims[0]["seq"] < first_seq("status", "running")
    assert first_seq("status", "running") < first_seq("turn")
    assert first_seq("turn") < first_seq("status", "completed")


async def test_two_golden_fixture_specs_conduct_two_visibly_different_exchanges(
    workbench, start_simulator
):
    """Different persona traits and scenarios, different conversations —
    with no code change: both walks come off fixture files alone."""
    flustered = load_fixture_spec("chat-scripted-flustered.json")
    hurried = load_fixture_spec("chat-scripted-hurried.json")
    await workbench.offer(flustered)
    await workbench.offer(hurried)
    start_simulator(workbench)

    ids = [flustered["simulation_id"], hurried["simulation_id"]]
    records = await workbench.wait_for(all_terminal(ids))

    transcripts = {
        simulation_id: [
            (turn["speaker"], turn["text"])
            for turn in events_for(records, simulation_id, "turn")
        ]
        for simulation_id in ids
    }
    for simulation_id, transcript in transcripts.items():
        assert len(transcript) >= 3, simulation_id

    # Visibly different: neither side of one conversation appears in the
    # other. The persona's turns differ because the scenarios do; the
    # agent's because each fixture scripts its own counterpart.
    human = {
        simulation_id: {text for speaker, text in transcript if speaker == "human"}
        for simulation_id, transcript in transcripts.items()
    }
    agent = {
        simulation_id: {text for speaker, text in transcript if speaker == "agent"}
        for simulation_id, transcript in transcripts.items()
    }
    assert human[ids[0]].isdisjoint(human[ids[1]] - {GOODBYE})
    assert agent[ids[0]].isdisjoint(agent[ids[1]])

    # And they end differently too: one persona concludes, the other's
    # counterpart ends the exchange itself.
    endings = {
        terminal_event_for(records, simulation_id)["facts"]["ending"]
        for simulation_id in ids
    }
    assert endings == {"persona_concluded", "agent_ended"}


async def test_every_ending_reason_is_reachable_and_reported_distinctly(
    workbench, start_simulator
):
    """Concluded, agent-ended, and both limits — four endings, four
    distinguishable records (the cancel directive's is pinned separately)."""
    concluded = scripted_spec(
        "sim-end-concluded",
        scenario="Only one thing today.",
        replies=["Noted."],
    )
    agent_ended = scripted_spec(
        "sim-end-agent",
        scenario=LONG_SCENARIO,
        replies=["We are all done here, goodbye now."],
        ends_after_replies=True,
    )
    by_turns = scripted_spec(
        "sim-end-turns",
        scenario=LONG_SCENARIO,
        max_turns=4,
    )
    by_duration = scripted_spec(
        "sim-end-duration",
        scenario=LONG_SCENARIO,
        turn_seconds=0.2,
        max_duration_seconds=1,
        max_turns=200,
    )
    for spec in (concluded, agent_ended, by_turns, by_duration):
        await workbench.offer(spec)
    start_simulator(workbench, capacity=4)

    records = await workbench.wait_for(
        all_terminal(
            ["sim-end-concluded", "sim-end-agent", "sim-end-turns", "sim-end-duration"]
        ),
        within_seconds=60,
    )

    def terminal(simulation_id: str) -> tuple[str, str, str | None]:
        event = terminal_event_for(records, simulation_id)
        return event["status"], event["facts"]["ending"], event["reason"]

    assert terminal("sim-end-concluded") == (
        "completed",
        "persona_concluded",
        "the persona concluded the scenario",
    )
    assert terminal("sim-end-agent") == (
        "completed",
        "agent_ended",
        "the agent ended the exchange",
    )
    assert terminal("sim-end-turns") == (
        "completed",
        "limit_reached",
        "the turn limit (4 turns) tripped",
    )
    assert terminal("sim-end-duration") == (
        "completed",
        "limit_reached",
        "the duration limit (1s) tripped",
    )

    # Distinct on the record: same ending enum for the two limits, and the
    # reason is what tells them apart — so the reasons must all differ.
    reasons = [
        terminal(simulation_id)[2]
        for simulation_id in (
            "sim-end-concluded",
            "sim-end-agent",
            "sim-end-turns",
            "sim-end-duration",
        )
    ]
    assert len(set(reasons)) == 4

    # The clipped walk really was clipped where the limit says.
    assert len(events_for(records, "sim-end-turns", "turn")) == 4


async def test_a_cancel_directive_stops_a_simulation_mid_exchange(
    workbench, start_simulator
):
    """The directive travels on a heartbeat answer; the simulation reports canceled."""
    spec = scripted_spec(
        "sim-cancel-001",
        scenario=LONG_SCENARIO,
        turn_seconds=0.15,
        max_turns=200,
        max_duration_seconds=600,
    )
    await workbench.offer(spec)
    start_simulator(workbench)

    await workbench.wait_for(
        lambda records: len(events_for(records, "sim-cancel-001", "turn")) >= 2
    )
    await workbench.cancel("sim-cancel-001")

    records = await workbench.wait_for(has_terminal("sim-cancel-001"))
    terminal = terminal_event_for(records, "sim-cancel-001")
    assert terminal["status"] == "canceled"
    assert terminal["facts"]["ending"] == "canceled"

    turns = events_for(records, "sim-cancel-001", "turn")
    assert len(turns) < 80, "the exchange was not stopped"
    assert terminal["facts"]["turn_count"] == len(turns)
    assert "completed" not in status_events_for(records, "sim-cancel-001")

    # Nothing more is reported after the terminal event: the simulation is over.
    await asyncio.sleep(HEARTBEAT_SECONDS * 4)
    later = await workbench.records()
    assert len(events_for(later, "sim-cancel-001", "turn")) == len(turns)


async def test_capacity_caps_simulations_in_flight(workbench, start_simulator):
    """Capacity N, N+2 queued: never more than N between running and terminal."""
    simulation_ids = [f"sim-cap-{n:03d}" for n in range(4)]
    for simulation_id in simulation_ids:
        await workbench.offer(
            scripted_spec(
                simulation_id,
                scenario="One. Two. Three. Four.",
                turn_seconds=0.1,
                max_turns=200,
            )
        )
    start_simulator(workbench, capacity=2)

    records = await workbench.wait_for(
        all_terminal(simulation_ids), within_seconds=60
    )

    # Every claim declared at most the free capacity and was granted no more.
    for record in records:
        if record["kind"] == "claim":
            assert record["capacity"] <= 2
            assert len(record["granted"]) <= record["capacity"]

    # Replay the records in order, counting simulations between their
    # running report and their terminal report: never more than two.
    in_flight = 0
    most_seen = 0
    for record in records:
        if record["kind"] != "report" or record["event"]["kind"] != "status":
            continue
        status = record["event"]["status"]
        if status == "running":
            in_flight += 1
            most_seen = max(most_seen, in_flight)
        elif status in ("completed", "failed", "canceled"):
            in_flight -= 1
    assert most_seen == 2, f"expected 2 in flight at peak, saw {most_seen}"

    for simulation_id in simulation_ids:
        terminal = terminal_event_for(records, simulation_id)
        assert terminal["status"] == "completed", simulation_id


async def test_a_killed_simulator_just_stops_heartbeating(
    workbench, start_simulator
):
    """SIGKILL mid-exchange: heartbeats stop and nothing terminal is ever reported."""
    spec = scripted_spec(
        "sim-kill-001",
        scenario=LONG_SCENARIO,
        turn_seconds=0.15,
        max_turns=200,
        max_duration_seconds=600,
    )
    await workbench.offer(spec)
    simulator = start_simulator(workbench)

    await workbench.wait_for(
        lambda records: "running" in status_events_for(records, "sim-kill-001")
        and len(heartbeats_for(records, "sim-kill-001")) >= 1
    )
    simulator.kill_hard()

    # A beat already on the wire may still land; after that grace, silence.
    # Only heartbeats and reports prove a live simulator — the workbench
    # answering a claim it was already holding open is its own act.
    def spoken_by_the_simulator(records: list[dict]) -> list[dict]:
        return [
            record
            for record in records
            if record["kind"] in ("heartbeat", "report", "refusal")
        ]

    await asyncio.sleep(HEARTBEAT_SECONDS * 2)
    settled = spoken_by_the_simulator(await workbench.records())
    await asyncio.sleep(HEARTBEAT_SECONDS * 5)
    afterwards = spoken_by_the_simulator(await workbench.records())

    assert afterwards == settled, "a dead simulator kept talking"
    assert terminal_event_for(await workbench.records(), "sim-kill-001") is None, (
        "a killed simulator reported a terminal state it could not know"
    )


async def test_an_over_granting_control_plane_does_not_take_the_simulator_down(
    over_granting_workbench, start_simulator
):
    """The simulator's own cap, with the workbench's clamping out of the way.

    A well-behaved control plane never hands out more than was asked for,
    which is exactly why the capacity test above cannot prove this: it is
    the workbench's arithmetic holding the line there, not the simulator's.
    Here the workbench over-grants on purpose.
    """
    workbench = over_granting_workbench
    accepted = [f"sim-flood-{n:03d}" for n in range(2)]
    for n in range(6):
        await workbench.offer(
            scripted_spec(
                f"sim-flood-{n:03d}",
                scenario="One. Two.",
                turn_seconds=0.1,
                max_turns=200,
            )
        )
    start_simulator(workbench, capacity=2)

    records = await workbench.wait_for(all_terminal(accepted), within_seconds=60)

    # It survived: the two it could hold ran to completion.
    for simulation_id in accepted:
        assert terminal_event_for(records, simulation_id)["status"] == "completed"

    # And it never exceeded its own capacity, whatever it was handed.
    in_flight = 0
    most_seen = 0
    for record in records:
        if record["kind"] != "report" or record["event"]["kind"] != "status":
            continue
        if record["event"]["status"] == "running":
            in_flight += 1
            most_seen = max(most_seen, in_flight)
        elif record["event"]["status"] in ("completed", "failed", "canceled"):
            in_flight -= 1
    assert most_seen <= 2, f"the simulator overloaded: {most_seen} in flight"

    # It is still alive and still claiming after the bad answer.
    claims_before = len([r for r in records if r["kind"] == "claim"])
    await asyncio.sleep(HEARTBEAT_SECONDS * 5)
    later = await workbench.records()
    assert len([r for r in later if r["kind"] == "claim"]) > claims_before


async def test_a_spec_naming_an_unknown_connection_type_is_refused_out_loud(
    workbench, start_simulator
):
    """No plug, no exchange, no report — and the simulator carries on."""
    unplugged = scripted_spec("sim-unplugged-001")
    unplugged["connection"]["type"] = "retell"
    await workbench.offer(unplugged)
    simulator = start_simulator(workbench)

    # A spec offered after the refusal still conducts: one spec the
    # simulator cannot serve does not cost the ones it can.
    await asyncio.sleep(HEARTBEAT_SECONDS * 2)
    await workbench.offer(scripted_spec("sim-plugged-001", scenario="One thing."))
    records = await workbench.wait_for(has_terminal("sim-plugged-001"))

    assert terminal_event_for(records, "sim-plugged-001")["status"] == "completed"

    # The refused spec was never conducted and never reported on: the row
    # is the control plane's sweep to account for.
    unplugged_reports = [
        record
        for record in records
        if record["kind"] in ("report", "refusal")
        and record["simulation_id"] == "sim-unplugged-001"
    ]
    assert unplugged_reports == []
    assert "no platform plug" in simulator.output()


async def test_a_plug_refusal_is_an_honest_failure_on_the_record(
    workbench, start_simulator
):
    """A plug that cannot conduct — here, config it does not know — ends
    the simulation ``failed`` with a reason a person can act on. Refusing
    config is the plug's promise; reporting the refusal honestly is the
    simulator's."""
    spec = scripted_spec("sim-misconfigured-001")
    spec["connection"]["config"]["repliez"] = ["a typo, not a script"]
    await workbench.offer(spec)
    start_simulator(workbench)

    records = await workbench.wait_for(has_terminal("sim-misconfigured-001"))

    assert status_events_for(records, "sim-misconfigured-001") == [
        "running",
        "failed",
    ]
    terminal = terminal_event_for(records, "sim-misconfigured-001")
    assert terminal["facts"]["ending"] == "error"
    assert terminal["facts"]["turn_count"] == 0
    assert "repliez" in terminal["reason"]

    # Nothing was conducted: no exchange happened off the record.
    assert events_for(records, "sim-misconfigured-001", "turn") == []
    assert [record for record in records if record["kind"] == "refusal"] == []


async def test_credentials_never_appear_in_logs_or_reports(
    workbench, start_simulator
):
    """A sentinel credential goes in; no byte of output or record carries it.

    The scripted counterpart takes no credentials — a real plug does — so
    the sentinel rides the spec exactly the way a platform key will, and
    the walk completes around it.
    """
    sentinel = "SENTINEL-do-not-log-4f9c2b7e8a1d"
    spec = scripted_spec("sim-secret-001", credentials={"apiKey": sentinel})
    await workbench.offer(spec)
    simulator = start_simulator(workbench, log_level="DEBUG")

    records = await workbench.wait_for(has_terminal("sim-secret-001"))
    terminal = terminal_event_for(records, "sim-secret-001")
    assert terminal["status"] == "completed"

    simulator.stop()

    everything_recorded = json.dumps(records)
    assert sentinel not in everything_recorded, "a report carried the credential"

    output = simulator.output()
    assert output, "expected the simulator to have logged something"
    assert sentinel not in output, "a log line carried the credential"

    wal_bytes = b"".join(
        path.read_bytes() for path in simulator.wal_dir.glob("*.jsonl")
    )
    assert wal_bytes, "expected write-ahead log entries"
    assert sentinel.encode() not in wal_bytes, "the WAL carried the credential"
