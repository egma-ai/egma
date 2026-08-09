"""What the simulator promises, proved black-box at the contract seam.

The workbench offers specs; a real simulator process claims, conducts,
heartbeats and reports; the assertions below read what the workbench
recorded — and, where a platform stands on the other side of the exchange,
what that platform saw on its own wire. Nothing reaches inside the
simulator — that is the point: what the records show is all the control
plane will ever know.

Every exchange here is a real conversation: the persona on the scripted
model client, the agent played by the scripted counterpart plug. Nothing
in this suite reaches a network beyond loopback or a model beyond the
scripted one, which is why none of it can flake.
"""

from __future__ import annotations

import asyncio
from datetime import datetime

from conftest import (
    HEARTBEAT_SECONDS,
    SCRIPTED_TRUNK_ENV,
    SENTINEL_TRUNK_ENV,
    TRUNK_SENTINELS,
    all_terminal,
    assert_kept_secret,
    assert_one_speaker_to_a_channel,
    has_terminal,
    heartbeats_for,
    load_fixture_spec,
    loopback_spec,
    measures_for,
    milliseconds_of,
    phone_spec,
    retell_spec,
    scripted_spec,
    span_attribute,
    spans_for,
    status_events_for,
    terminal_event_for,
    turns_for,
)

from egma_simulator.model import GOODBYE
from egma_simulator.pipeline import channels_of
from egma_simulator.speech import decode_speech

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

    # The transcript, turn for turn, read where the transcript is — the
    # spans: the greeting, the persona's scenario sentence by sentence
    # against the counterpart's scripted answers, and the persona's
    # concluding goodbye.
    turns = turns_for(records, "sim-chat-001")
    assert turns == [
        ("agent", "Lakeside Dental, how can I help?"),
        ("human", "I need to move my Tuesday cleaning to Thursday."),
        ("agent", "Of course — could I take your name?"),
        ("human", "My name is Margaret Hale."),
        ("agent", "Done: you are moved to Thursday at half past two."),
        ("human", GOODBYE),
    ]

    # Timestamped, and in order: a turn span closes at the moment the turn
    # was observed, and those moments never run backwards. Read at the
    # close rather than the open, because a voice turn opens backwards
    # from it by however long the audio ran — which is what lets two turns
    # cross, and is exactly the shape barge-in will need.
    observed = [
        int(record["span"]["endTimeUnixNano"])
        for record in spans_for(records, "sim-chat-001")
        if record["span"]["name"].endswith("_turn")
    ]
    assert observed == sorted(observed)

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
    # measurement per answered turn — each its own timing span.
    measures = measures_for(records, "sim-chat-001")
    assert measures.count("first_response_latency") == 1
    assert measures.count("turn_response_latency") == 2

    # The workbench refused nothing: every document validated.
    assert [record for record in records if record["kind"] == "refusal"] == []

    # And the record's own order tells the story: claimed before running,
    # running before any turn, every turn before completed — one story told
    # across the two doors, which is what the one ordered sender buys.
    def first_status(status: str) -> int:
        for record in records:
            if record["kind"] == "report" and record["simulation_id"] == "sim-chat-001":
                event = record["event"]
                if event["kind"] == "status" and event["status"] == status:
                    return record["seq"]
        raise AssertionError(f"no status/{status} on record")

    turn_seqs = [
        record["seq"]
        for record in spans_for(records, "sim-chat-001")
        if record["span"]["name"].endswith("_turn")
    ]
    assert claims[0]["seq"] < first_status("running")
    assert first_status("running") < turn_seqs[0]
    assert turn_seqs[-1] < first_status("completed")


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
        simulation_id: turns_for(records, simulation_id) for simulation_id in ids
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
    assert len(turns_for(records, "sim-end-turns")) == 4


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
        lambda records: len(turns_for(records, "sim-cancel-001")) >= 2
    )
    await workbench.cancel("sim-cancel-001")

    records = await workbench.wait_for(has_terminal("sim-cancel-001"))
    terminal = terminal_event_for(records, "sim-cancel-001")
    assert terminal["status"] == "canceled"
    assert terminal["facts"]["ending"] == "canceled"

    turns = turns_for(records, "sim-cancel-001")
    assert len(turns) < 80, "the exchange was not stopped"
    assert terminal["facts"]["turn_count"] == len(turns)
    assert "completed" not in status_events_for(records, "sim-cancel-001")

    # Nothing more arrives after the terminal event, at either door: the
    # simulation is over.
    await asyncio.sleep(HEARTBEAT_SECONDS * 4)
    later = await workbench.records()
    assert len(turns_for(later, "sim-cancel-001")) == len(turns)


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
    unplugged["connection"]["type"] = "a-platform-with-no-plug-yet"
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
    assert turns_for(records, "sim-misconfigured-001") == []
    assert [record for record in records if record["kind"] == "refusal"] == []


async def test_a_retell_chat_spec_conducts_a_multi_turn_exchange(
    workbench, start_simulator, start_retell_stub
):
    """The first real platform, black-box: a spec carrying a Retell chat
    connection block goes in, and a multi-turn transcript against a
    Retell-shaped platform comes back — with the credential used and never
    written down anywhere.

    Nothing outside the plug knows this exchange is any different from the
    scripted one, which is the whole extensibility claim.
    """
    sentinel = "SENTINEL-retell-key-c1d4e7f0a3b6"
    running = await start_retell_stub(
        api_key=sentinel,
        greeting="Lakeside Dental, how can I help?",
        replies=[
            "Of course — could I take your name?",
            "Done: Thursday at half past two.",
        ],
    )
    spec = retell_spec(
        "sim-retell-001",
        base_url=running.base_url,
        api_key=sentinel,
        agent_id="agent_lakeside_chat",
        scenario=(
            "I need to move my Tuesday cleaning to Thursday. "
            "My name is Margaret Hale."
        ),
    )
    await workbench.offer(spec)
    simulator = start_simulator(workbench, log_level="DEBUG")

    records = await workbench.wait_for(has_terminal("sim-retell-001"))

    turns = turns_for(records, "sim-retell-001")
    assert turns == [
        ("agent", "Lakeside Dental, how can I help?"),
        ("human", "I need to move my Tuesday cleaning to Thursday."),
        ("agent", "Of course — could I take your name?"),
        ("human", "My name is Margaret Hale."),
        ("agent", "Done: Thursday at half past two."),
        ("human", GOODBYE),
    ]

    terminal = terminal_event_for(records, "sim-retell-001")
    assert terminal["status"] == "completed"
    assert terminal["facts"]["ending"] == "persona_concluded"
    assert terminal["facts"]["turn_count"] == len(turns)
    # The join to the platform's own telemetry is Retell's chat id.
    assert terminal["facts"]["provider_reference"] == running.stub.chat_ids()[0]

    # And the platform's side of the same story: one chat opened against the
    # agent the connection block named, the persona's turns delivered in
    # order, the chat ended rather than left ongoing.
    stub = running.stub
    assert [call["endpoint"] for call in stub.calls] == [
        "create-chat",
        "create-chat-completion",
        "create-chat-completion",
        "end-chat",
    ]
    assert stub.calls[0]["agent_id"] == "agent_lakeside_chat"
    assert stub.delivered() == [
        "I need to move my Tuesday cleaning to Thursday.",
        "My name is Margaret Hale.",
    ]

    simulator.stop()
    assert_kept_secret(sentinel, records=records, simulator=simulator)


async def test_a_retell_key_the_platform_refuses_fails_honestly_and_silently(
    workbench, start_simulator, start_retell_stub
):
    """The failure path a wrong credential takes: the simulation ends failed
    with a reason naming what the platform said, and the key appears
    nowhere — not in the report, not in a log line, not in the log on disk."""
    sentinel = "SENTINEL-retell-key-wrong-8e2a5c9f"
    running = await start_retell_stub(api_key="the-only-key-this-stub-honors")
    spec = retell_spec(
        "sim-retell-badkey", base_url=running.base_url, api_key=sentinel
    )
    await workbench.offer(spec)
    simulator = start_simulator(workbench, log_level="DEBUG")

    records = await workbench.wait_for(has_terminal("sim-retell-badkey"))

    assert status_events_for(records, "sim-retell-badkey") == ["running", "failed"]
    terminal = terminal_event_for(records, "sim-retell-badkey")
    assert terminal["facts"]["ending"] == "error"
    assert terminal["facts"]["turn_count"] == 0
    assert "401" in terminal["reason"], terminal["reason"]
    # Nothing was conducted: no exchange happened off the record.
    assert turns_for(records, "sim-retell-badkey") == []

    simulator.stop()
    assert_kept_secret(sentinel, records=records, simulator=simulator)


async def test_a_platform_that_says_the_key_back_still_leaks_nothing(
    workbench, start_simulator, start_retell_stub
):
    """The reason a plug gives carries the platform's own words, and a
    careless platform's own words can include the key it was just given.
    The plug is what has to survive that: nothing downstream — not the
    report, not the log line, not the traceback under it — may repeat a
    secret because somebody else did first."""
    sentinel = "SENTINEL-retell-key-echoed-3d6f0b21"
    running = await start_retell_stub(
        api_key="the-only-key-this-stub-honors", echo_key_in_refusal=True
    )
    spec = retell_spec(
        "sim-retell-echoed", base_url=running.base_url, api_key=sentinel
    )
    await workbench.offer(spec)
    simulator = start_simulator(workbench, log_level="DEBUG")

    records = await workbench.wait_for(has_terminal("sim-retell-echoed"))
    assert terminal_event_for(records, "sim-retell-echoed")["status"] == "failed"

    simulator.stop()
    assert_kept_secret(sentinel, records=records, simulator=simulator)


async def test_a_retell_endpoint_that_answers_nowhere_fails_honestly(
    workbench, start_simulator
):
    """The other absence: nothing listening at all. Same honesty, same
    silence about the key."""
    sentinel = "SENTINEL-retell-key-unreachable-77b1"
    spec = retell_spec(
        "sim-retell-nowhere",
        base_url="http://127.0.0.1:1",
        api_key=sentinel,
    )
    await workbench.offer(spec)
    simulator = start_simulator(workbench, log_level="DEBUG")

    records = await workbench.wait_for(has_terminal("sim-retell-nowhere"))

    terminal = terminal_event_for(records, "sim-retell-nowhere")
    assert terminal["status"] == "failed"
    assert terminal["facts"]["ending"] == "error"
    assert "unreachable" in terminal["reason"], terminal["reason"]
    assert "127.0.0.1:1" in terminal["reason"], terminal["reason"]

    simulator.stop()
    assert_kept_secret(sentinel, records=records, simulator=simulator)


async def test_a_voice_spec_reports_a_whole_exchange_and_its_audio(
    workbench, start_simulator
):
    """What a voice simulation owes its record, read back off the record.

    A golden fixture goes in — no code path is chosen for it here — and
    what comes out is a transcript, an ending, the band the audio was
    actually carried at, and a reference to a recording. The recording is
    then opened and both channels are listened to.
    """
    spec = load_fixture_spec("voice-loopback.json")
    simulation_id = spec["simulation_id"]
    await workbench.offer(spec)
    simulator = start_simulator(workbench)

    records = await workbench.wait_for(has_terminal(simulation_id))

    # Voice adds facts to a report and no new shape to carry them: the
    # contract already had somewhere to put audio, and every document
    # below went through both sides' validation untouched.
    assert [record for record in records if record["kind"] == "refusal"] == []
    assert status_events_for(records, simulation_id) == ["running", "completed"]
    turns = turns_for(records, simulation_id)
    assert turns[0] == ("agent", spec["connection"]["config"]["greeting"])
    assert [speaker for speaker, _ in turns] == [
        "agent",
        "human",
        "agent",
        "human",
        "agent",
        "human",
        "agent",
    ]

    terminal = terminal_event_for(records, simulation_id)
    facts = terminal["facts"]
    assert facts["ending"] == "agent_ended"
    assert terminal["reason"] == "the agent ended the exchange"
    assert facts["turn_count"] == len(turns)
    assert facts["provider_reference"] == "loopback-voice-hurried-1"

    # The band is measured at execution. The fixture's connection asks for
    # 8 kHz, the counterpart carries it, and what the record keeps is the
    # band that flowed — never a number copied out of an editable config.
    audio = facts["audio"]
    assert audio["measured_sample_rate_hz"] == 8000

    # The reference is a reference: no bytes on the wire, and it resolves.
    assert "://" not in audio["recording"]
    recording = simulator.blob(audio["recording"])
    assert channels_of(recording)[2] == audio["measured_sample_rate_hz"]

    # Each channel is one speaker, proved by listening to it: what channel
    # 0 says is what the persona said, and what channel 1 says is what the
    # agent said — every turn of the transcript, on its own side, and on
    # neither of the other's.
    assert_one_speaker_to_a_channel(recording, turns)


async def test_a_voice_simulation_reports_a_measurement_for_every_turn(
    workbench, start_simulator
):
    """Metrics measure and graders judge: the runtime reports the numbers
    for every simulation, in the order they happened, and judges none."""
    spec = loopback_spec(
        "sim-voice-measures",
        scenario="First point. Second point.",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
        answer_delay_seconds=0.3,
    )
    await workbench.offer(spec)
    start_simulator(workbench)

    records = await workbench.wait_for(has_terminal("sim-voice-measures"))

    timed = [
        record["span"]
        for record in spans_for(records, "sim-voice-measures")
        if record["span"]["name"] in measures_for(records, "sim-voice-measures")
    ]
    measures = measures_for(records, "sim-voice-measures")
    assert measures.count("time_to_first_word") == 3
    assert measures.count("agent_speech_duration") == 3
    assert measures.count("persona_speech_duration") == 2
    # The wall-clock measures every simulation reports are still there:
    # voice adds measurements, it does not replace them.
    assert measures.count("first_response_latency") == 1
    assert measures.count("turn_response_latency") == 2

    # Every agent turn was quiet for as long as the counterpart waits —
    # read off the span's own duration, which is where the number is.
    quiet = [
        milliseconds_of(span)
        for span in timed
        if span["name"] == "time_to_first_word"
    ]
    assert all(abs(number - 300.0) < 20.0 for number in quiet), quiet
    assert len(quiet) == 3

    # Monotonically ordered: no measurement is stamped before the one the
    # simulator took ahead of it.
    stamped = [int(span["endTimeUnixNano"]) for span in timed]
    assert stamped == sorted(stamped)


async def test_two_voice_simulations_at_once_keep_their_audio_apart(
    workbench, start_simulator
):
    """A pipeline is one simulation's, and so is its recording.

    Voice brings a second pipeline into the same process, which is where a
    shared leg or a shared buffer would show up as one simulation's words
    on another's channel.
    """
    ids = ["sim-voice-a", "sim-voice-b"]
    await workbench.offer(
        loopback_spec(
            "sim-voice-a",
            scenario="Ask about the invoice.",
            replies=["The invoice is on its way."],
        )
    )
    await workbench.offer(
        loopback_spec(
            "sim-voice-b",
            scenario="Ask about the delivery.",
            replies=["The delivery lands on Friday."],
        )
    )
    simulator = start_simulator(workbench, capacity=2)

    records = await workbench.wait_for(all_terminal(ids))

    recordings = {}
    for simulation_id in ids:
        facts = terminal_event_for(records, simulation_id)["facts"]
        assert facts["audio"] is not None, simulation_id
        persona_audio, agent_audio, band = channels_of(
            simulator.blob(facts["audio"]["recording"])
        )
        recordings[simulation_id] = (
            decode_speech(persona_audio, band),
            decode_speech(agent_audio, band),
        )

    assert "The invoice is on its way." in recordings["sim-voice-a"][1]
    assert "The delivery lands on Friday." in recordings["sim-voice-b"][1]
    assert "delivery" not in recordings["sim-voice-a"][1]
    assert "invoice" not in recordings["sim-voice-b"][1]
    assert "Ask about the invoice." in recordings["sim-voice-a"][0]
    assert "Ask about the delivery." in recordings["sim-voice-b"][0]


async def test_one_scenario_over_chat_and_over_voice_is_one_transcript(
    workbench, start_simulator
):
    """The diagnostic the modality split exists for.

    Same persona, same scenario, same script — one exchanged as text, one
    spoken and transcribed through the speech legs. The persona brain is
    one component for both, so the two transcripts are the same, and a
    difference between them could only ever be the speech stack.
    """
    scenario = "First point. Second point."
    script = ["Certainly.", "Done."]
    greeting = "Front desk, hello."
    await workbench.offer(
        scripted_spec(
            "sim-same-chat",
            scenario=scenario,
            greeting=greeting,
            replies=script,
        )
    )
    await workbench.offer(
        loopback_spec(
            "sim-same-voice",
            scenario=scenario,
            greeting=greeting,
            replies=script,
        )
    )
    start_simulator(workbench, capacity=2)

    records = await workbench.wait_for(
        all_terminal(["sim-same-chat", "sim-same-voice"])
    )

    assert turns_for(records, "sim-same-chat") == turns_for(
        records, "sim-same-voice"
    )

    # And the record still tells them apart where it should: only one of
    # them has audio to account for.
    chat = terminal_event_for(records, "sim-same-chat")["facts"]
    voice = terminal_event_for(records, "sim-same-voice")["facts"]
    assert chat["audio"] is None
    assert voice["audio"]["measured_sample_rate_hz"] == 16000


async def test_a_phone_spec_dials_a_number_and_reports_the_whole_call(
    workbench, start_simulator
):
    """A spec whose connection names a phone number becomes a call, and
    what comes back is what every other voice simulation owes — a
    transcript, a distinct ending, per-turn timings that never run
    backwards, the band the audio was carried at, and a dual-channel
    recording that resolves.

    The media backend is the scripted one, so there is no LiveKit server,
    no trunk, no carrier and no network in this — and nothing above the
    plug knows that, which is the whole extensibility claim.

    A real deployment's LiveKit and trunk credentials are in the process
    the whole time, planted as sentinels, so the scan at the end is a
    scan of a process that really held them.
    """
    spec = phone_spec(
        "sim-phone-001",
        number="+15550100200",
        scenario=(
            "I need to move my Tuesday cleaning to Thursday. "
            "My name is Margaret Hale."
        ),
        greeting="Lakeside Dental, how can I help?",
        replies=[
            "Of course — could I take your name?",
            "Done: Thursday at half past two.",
        ],
        answer_delay_seconds=0.3,
        provider_reference="SP_scripted_lakeside_1",
    )
    await workbench.offer(spec)
    simulator = start_simulator(
        workbench, log_level="DEBUG", extra_env=SCRIPTED_TRUNK_ENV
    )

    records = await workbench.wait_for(has_terminal("sim-phone-001"))

    assert [record for record in records if record["kind"] == "refusal"] == []
    assert status_events_for(records, "sim-phone-001") == ["running", "completed"]

    turns = turns_for(records, "sim-phone-001")
    assert turns == [
        ("agent", "Lakeside Dental, how can I help?"),
        ("human", "I need to move my Tuesday cleaning to Thursday."),
        ("agent", "Of course — could I take your name?"),
        ("human", "My name is Margaret Hale."),
        ("agent", "Done: Thursday at half past two."),
        ("human", GOODBYE),
    ]
    # Read at the close: a voice turn opens backwards from the moment it
    # was observed by however long the audio ran, so two of them may cross
    # in time while the order they were heard in never does.
    observed = [
        int(record["span"]["endTimeUnixNano"])
        for record in spans_for(records, "sim-phone-001")
        if record["span"]["name"].endswith("_turn")
    ]
    assert observed == sorted(observed)

    terminal = terminal_event_for(records, "sim-phone-001")
    facts = terminal["facts"]
    assert facts["ending"] == "persona_concluded"
    assert facts["turn_count"] == len(turns)
    # The join to the bridge's own telemetry: LiveKit's SIP participant
    # identity on a real call, and the scripted bridge's stand-in here.
    assert facts["provider_reference"] == "SP_scripted_lakeside_1"

    # Measured, and measured per turn: the far end was quiet for exactly
    # as long as it waits before speaking, on every one of its turns, and
    # nothing was stamped before the measurement reported ahead of it.
    measures = measures_for(records, "sim-phone-001")
    assert measures.count("time_to_first_word") == 3
    assert measures.count("agent_speech_duration") == 3
    assert measures.count("persona_speech_duration") == 2
    assert measures.count("first_response_latency") == 1
    assert measures.count("turn_response_latency") == 2
    timed = [
        record["span"]
        for record in spans_for(records, "sim-phone-001")
        if record["span"]["name"] in measures
    ]
    quiet = [
        milliseconds_of(span)
        for span in timed
        if span["name"] == "time_to_first_word"
    ]
    assert all(abs(number - 300.0) < 20.0 for number in quiet), quiet
    assert len(quiet) == 3
    stamped = [int(span["endTimeUnixNano"]) for span in timed]
    assert stamped == sorted(stamped)

    # A phone call is narrowband, and the band on the record is the one
    # that flowed rather than one copied out of a config.
    audio = facts["audio"]
    assert audio["measured_sample_rate_hz"] == 8000

    # The reference is a reference: no bytes on the wire, and it resolves
    # to a recording with one speaker to a channel.
    assert "://" not in audio["recording"]
    recording = simulator.blob(audio["recording"])
    assert channels_of(recording)[2] == 8000
    assert_one_speaker_to_a_channel(
        recording, [turn for turn in turns if turn[1] != GOODBYE]
    )

    simulator.stop()
    for sentinel in TRUNK_SENTINELS:
        assert_kept_secret(sentinel, records=records, simulator=simulator)


async def test_every_call_that_never_became_a_conversation_fails_honestly(
    workbench, start_simulator
):
    """Busy, no answer, declined, a carrier that failed, and a trunk the
    carrier rejects: five ways a call never happens, five records that say
    which — and not one of them ever reads as the agent failing.

    A busy line and a rung-out phone are ``not_answered``: the simulator
    reached out and nothing picked up. A carrier that failed and a trunk
    it would not accept are ``error``: the call never reached the far end
    and somebody has something to fix. Neither is ever graded.
    """
    outcomes = {
        "sim-phone-busy": ("busy", "not_answered"),
        "sim-phone-noanswer": ("no_answer", "not_answered"),
        "sim-phone-declined": ("declined", "not_answered"),
        "sim-phone-carrier": ("carrier_failure", "error"),
        "sim-phone-trunk": ("trunk_rejected", "error"),
    }
    for simulation_id, (outcome, _ending) in outcomes.items():
        await workbench.offer(phone_spec(simulation_id, outcome=outcome))

    simulator = start_simulator(
        workbench, capacity=5, log_level="DEBUG", extra_env=SCRIPTED_TRUNK_ENV
    )

    records = await workbench.wait_for(all_terminal(list(outcomes)), within_seconds=60)

    reasons = []
    for simulation_id, (_outcome, ending) in outcomes.items():
        terminal = terminal_event_for(records, simulation_id)
        assert terminal["status"] == "failed", simulation_id
        assert terminal["facts"]["ending"] == ending, simulation_id
        assert terminal["facts"]["turn_count"] == 0, simulation_id
        # Nothing was conducted, so no exchange happened off the record.
        assert turns_for(records, simulation_id) == [], simulation_id
        reason = terminal["reason"]
        assert "agent" not in reason.lower(), (simulation_id, reason)
        reasons.append(reason)

    # Distinct on the record: the ending enum is shared, and the reason is
    # what tells a reader which call this was.
    assert len(set(reasons)) == len(reasons), reasons
    assert "486" in reasons[0], reasons[0]
    assert "403" in reasons[-1], reasons[-1]

    simulator.stop()
    for sentinel in TRUNK_SENTINELS:
        assert_kept_secret(sentinel, records=records, simulator=simulator)


async def test_a_livekit_that_cannot_be_reached_fails_without_a_credential(
    workbench, start_simulator
):
    """The same honesty through the driver that really holds the secrets.

    The simulator is started with a whole LiveKit deployment's worth of
    credentials — every secret one a sentinel — pointed at a port nothing
    answers on. So the code that fails is the code that would carry a
    trunk password if anything ever did, and the scan afterwards is a scan
    of a process that really held one.
    """
    await workbench.offer(phone_spec("sim-phone-livekit", backend="livekit"))
    simulator = start_simulator(
        workbench, log_level="DEBUG", extra_env=SENTINEL_TRUNK_ENV
    )

    records = await workbench.wait_for(
        has_terminal("sim-phone-livekit"), within_seconds=90
    )

    terminal = terminal_event_for(records, "sim-phone-livekit")
    assert terminal["status"] == "failed"
    assert terminal["facts"]["ending"] == "error"
    assert "127.0.0.1:1" in terminal["reason"], terminal["reason"]
    assert turns_for(records, "sim-phone-livekit") == []

    simulator.stop()
    for sentinel in TRUNK_SENTINELS:
        assert_kept_secret(sentinel, records=records, simulator=simulator)


async def test_the_far_end_hanging_up_is_the_agent_ending_the_exchange(
    workbench, start_simulator
):
    """A call the agent ends mid-scenario, with everything said up to that
    moment on the record — transcript and recording both.

    The persona still had things to say, so nothing here is a limit and
    nothing here is a failure: the agent ended it, and that is what the
    record says.
    """
    spec = phone_spec(
        "sim-phone-hangup",
        scenario=LONG_SCENARIO,
        greeting="Front desk.",
        replies=["I am afraid I have to go. Goodbye."],
        hangs_up_after_replies=True,
    )
    await workbench.offer(spec)
    simulator = start_simulator(workbench, extra_env=SCRIPTED_TRUNK_ENV)

    records = await workbench.wait_for(has_terminal("sim-phone-hangup"))

    terminal = terminal_event_for(records, "sim-phone-hangup")
    assert terminal["status"] == "completed"
    assert terminal["facts"]["ending"] == "agent_ended"
    assert terminal["reason"] == "the agent ended the exchange"

    # The partial transcript: the greeting, one persona turn, the agent's
    # last words — and nothing after them, because there was no line left.
    turns = turns_for(records, "sim-phone-hangup")
    assert turns == [
        ("agent", "Front desk."),
        ("human", "Sentence number 1."),
        ("agent", "I am afraid I have to go. Goodbye."),
    ]
    assert terminal["facts"]["turn_count"] == len(turns)

    # And the recording of it, resolvable and readable, one speaker to a
    # channel — a call cut short still leaves the audio it had.
    audio = terminal["facts"]["audio"]
    assert audio is not None
    recording = simulator.blob(audio["recording"])
    assert_one_speaker_to_a_channel(recording, turns)


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
    assert_kept_secret(sentinel, records=records, simulator=simulator)


async def test_a_voice_simulation_lets_no_credential_out_either(
    workbench, start_simulator
):
    """The same sentinel, through the modality that emits the most.

    A voice simulation writes bytes a chat one never does — a whole
    recording — and speaks through a library that logs on its own, so
    everything it emits is scanned here too: the reported records, every
    byte of the child's output, the write-ahead log, and the recording.
    """
    sentinel = "SENTINEL-do-not-log-9a71c3e5b2f4"
    spec = loopback_spec(
        "sim-voice-secret",
        scenario="First point. Second point.",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
        credentials={"apiKey": sentinel},
    )
    await workbench.offer(spec)
    simulator = start_simulator(workbench, log_level="DEBUG")

    records = await workbench.wait_for(has_terminal("sim-voice-secret"))
    terminal = terminal_event_for(records, "sim-voice-secret")
    assert terminal["status"] == "completed"
    recording = simulator.blob(terminal["facts"]["audio"]["recording"])

    simulator.stop()
    assert_kept_secret(sentinel, records=records, simulator=simulator)

    assert recording, "expected a recording to have been written"
    assert sentinel.encode() not in recording, "the recording carried the credential"
    # And not spoken into it either — a credential read aloud would be in
    # the samples rather than in the file's bytes.
    for channel in channels_of(recording)[:2]:
        spoken = decode_speech(channel, channels_of(recording)[2])
        assert sentinel not in spoken, "the credential was spoken into the audio"


# -- The conversation, streamed as spans ----------------------------------


def flush_of(record: dict) -> int:
    return record["flush"]


async def test_a_chat_simulation_streams_its_conversation_as_spans(
    workbench, start_simulator
):
    """The whole conversation arrives as OTLP, while it happens — and the
    terminal report arrives after the last span."""
    spec = scripted_spec(
        "sim-spans-chat",
        scenario="Move my Tuesday cleaning to Thursday. My name is Margaret Hale.",
        greeting="Lakeside Dental, how can I help?",
        replies=[
            "Of course — could I take your name?",
            "Done: you are moved to Thursday at half past two.",
        ],
        tool_calls=[
            {
                "name": "reschedule_appointment",
                "arguments": '{"appointment_id":"apt-88213"}',
            },
            {"name": "send_confirmation_sms"},
        ],
    )
    await workbench.offer(spec)
    start_simulator(workbench)

    records = await workbench.wait_for(has_terminal("sim-spans-chat"))
    recorded = spans_for(records, "sim-spans-chat")
    spans = [record["span"] for record in recorded]
    names = [span["name"] for span in spans]

    # Every turn of the transcript, with the speaker in the span name and
    # the words in the one attribute the vocabulary declares — which is the
    # whole of the record, because the report door carries no turn.
    assert turns_for(records, "sim-spans-chat") == [
        ("agent", "Lakeside Dental, how can I help?"),
        ("human", "Move my Tuesday cleaning to Thursday."),
        ("agent", "Of course — could I take your name?"),
        ("human", "My name is Margaret Hale."),
        ("agent", "Done: you are moved to Thursday at half past two."),
        ("human", GOODBYE),
    ]
    # And what the lifecycle keeps about them is the count, which agrees
    # with the spans without repeating them.
    assert terminal_event_for(records, "sim-spans-chat")["facts"][
        "turn_count"
    ] == names.count("human_turn") + names.count("agent_turn")

    # The measurements, as spans whose own duration is the number.
    assert names.count("first_response_latency") == 1
    assert names.count("turn_response_latency") == 2
    for span in spans:
        if span["name"].endswith("_latency"):
            duration = int(span["endTimeUnixNano"]) - int(span["startTimeUnixNano"])
            assert duration > 0

    # The tool calls the platform reported, arguments where it gave them.
    calls = [span for span in spans if span["name"] == "tool_call"]
    assert [span_attribute(span, "egma.tool.name") for span in calls] == [
        "reschedule_appointment",
        "send_confirmation_sms",
    ]
    assert span_attribute(calls[0], "egma.tool.arguments") == (
        '{"appointment_id":"apt-88213"}'
    )
    assert span_attribute(calls[1], "egma.tool.arguments") is None

    # One trace, the root last, and every other span named under it.
    root = next(span for span in spans if span["name"] == "simulation")
    assert names[-1] == "simulation"
    assert "parentSpanId" not in root
    for span in spans:
        assert span["traceId"] == root["traceId"]
        if span is not root:
            assert span["parentSpanId"] == root["spanId"]

    # Every flush disjoint from every other, so a resend lands nothing twice.
    by_flush: dict[int, set[str]] = {}
    for record in recorded:
        by_flush.setdefault(flush_of(record), set()).add(record["span"]["spanId"])
    assert len(by_flush) > 1, "the whole conversation arrived in one batch"
    seen: set[str] = set()
    for ids in by_flush.values():
        assert seen.isdisjoint(ids)
        seen |= ids

    # And the ordering the whole design leans on: every span landed before
    # the terminal report did.
    last_span = max(record["seq"] for record in recorded)
    terminal_seq = next(
        record["seq"]
        for record in records
        if record["kind"] == "report"
        and record["simulation_id"] == "sim-spans-chat"
        and record["event"]["kind"] == "status"
        and record["event"]["status"] in ("completed", "failed", "canceled")
    )
    assert last_span < terminal_seq

    # Streamed rather than posted at the end: every turn but the last rode
    # a flush that left while the conversation was still going, which is
    # what a reader watching this live would see. The last is the persona
    # concluding — the words that end the walk, so they leave with the
    # flush that closes the record and could not have left before it.
    root_flush = next(
        flush_of(record)
        for record in recorded
        if record["span"]["name"] == "simulation"
    )
    spoken_turns = names.count("human_turn") + names.count("agent_turn")
    said_while_running = [
        record
        for record in recorded
        if record["span"]["name"].endswith("_turn")
        and flush_of(record) < root_flush
    ]
    assert len(said_while_running) == spoken_turns - 1

    # Nothing was refused on the way.
    assert [record for record in records if record["kind"] == "refusal"] == []


async def test_a_voice_simulation_produces_the_same_shapes_plus_its_audio_facts(
    workbench, start_simulator
):
    """The same conversation-span shapes as chat, and the turns carry the
    length of the audio rather than being instants."""
    spec = loopback_spec(
        "sim-spans-voice",
        scenario="First point. Second point.",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
        answer_delay_seconds=0.3,
    )
    await workbench.offer(spec)
    start_simulator(workbench)

    records = await workbench.wait_for(has_terminal("sim-spans-voice"))
    spans = [record["span"] for record in spans_for(records, "sim-spans-voice")]
    names = [span["name"] for span in spans]

    # The same shapes chat produces, named identically.
    assert names.count("human_turn") == 3
    assert names.count("agent_turn") == 3
    assert names.count("first_response_latency") == 1
    assert names.count("turn_response_latency") == 2
    assert names[-1] == "simulation"

    # Plus what only voice can measure, one span per measurement.
    assert names.count("time_to_first_word") == 3
    assert names.count("agent_speech_duration") == 3
    assert names.count("persona_speech_duration") == 2

    def durations(name: str) -> list[int]:
        return [
            int(span["endTimeUnixNano"]) - int(span["startTimeUnixNano"])
            for span in spans
            if span["name"] == name
        ]

    # A voice turn has a length, where a chat turn is one instant: what the
    # simulator heard and what it spoke, ear to ear.
    assert all(length > 0 for length in durations("agent_turn"))
    # Every persona turn the counterpart actually heard, except the last —
    # the persona's goodbye concludes the scenario, so the walk ends before
    # it is ever spoken, and a turn nobody said is honestly an instant.
    assert all(length > 0 for length in durations("human_turn")[:-1])
    assert durations("human_turn")[-1] == 0

    # The quiet before the agent's first word is the delay the counterpart
    # was told to wait — measured out of the audio, and the span's own
    # duration is that number.
    assert all(
        abs(length - 300_000_000) < 20_000_000 for length in durations(
            "time_to_first_word"
        )
    ), durations("time_to_first_word")

    # A persona turn is exactly as long as the audio the persona spoke.
    assert durations("persona_speech_duration") == durations("human_turn")[:-1]


async def test_an_answer_that_only_called_a_tool_is_flushed_like_any_other(
    workbench, start_simulator
):
    """A flush closes an answer, not a turn.

    An agent that calls a tool and says nothing produces no transcript
    turn, so a flush keyed on turns would leave that answer's tool calls
    and its measurement sitting in a buffer until the agent next spoke —
    or until the conversation was over, which is the one moment live
    evidence is no longer live.
    """
    spec = scripted_spec(
        "sim-spans-tool-only",
        scenario="Move my Tuesday cleaning to Thursday. Any afternoon suits.",
        greeting="Lakeside Dental, how can I help?",
        replies=[None, "Moved — Thursday at three."],
        tool_calls=[
            {
                "name": "reschedule_appointment",
                "arguments": '{"appointment_id":"apt-88213"}',
            }
        ],
    )
    await workbench.offer(spec)
    start_simulator(workbench)

    records = await workbench.wait_for(has_terminal("sim-spans-tool-only"))
    recorded = spans_for(records, "sim-spans-tool-only")

    # The wordless answer said nothing, so the transcript never mentions
    # it — the agent's two turns are the greeting and the later words.
    said = turns_for(records, "sim-spans-tool-only")
    assert [text for speaker, text in said if speaker == "agent"] == [
        "Lakeside Dental, how can I help?",
        "Moved — Thursday at three.",
    ]

    def flush_carrying(name: str, said: str | None = None) -> int:
        for record in recorded:
            span = record["span"]
            if span["name"] != name:
                continue
            if said is not None and span_attribute(span, "egma.turn.text") != said:
                continue
            return record["flush"]
        raise AssertionError(f"no {name} span was ever recorded")

    tool_flush = flush_carrying("tool_call")
    words_flush = flush_carrying("agent_turn", "Moved — Thursday at three.")
    root_flush = flush_carrying("simulation")

    # It left while the conversation was still going, not with the root.
    assert tool_flush < root_flush
    # And on its own account: the words that came an answer later rode a
    # later flush, so nothing swept the tool call along with them.
    assert tool_flush < words_flush

    # The whole answer went together — its measurement rode the same flush
    # as the call it measured, which is what "a flush is an answer" means.
    assert any(
        record["flush"] == tool_flush
        and record["span"]["name"] == "turn_response_latency"
        for record in recorded
    ), "the wordless answer's measurement was split from its tool call"

    # The invariants the design rests on, unchanged by the extra flush.
    by_flush: dict[int, set[str]] = {}
    for record in recorded:
        by_flush.setdefault(record["flush"], set()).add(record["span"]["spanId"])
    seen: set[str] = set()
    for ids in by_flush.values():
        assert seen.isdisjoint(ids)
        seen |= ids
    assert [record["span"]["name"] for record in recorded][-1] == "simulation"
    assert [record for record in records if record["kind"] == "refusal"] == []
