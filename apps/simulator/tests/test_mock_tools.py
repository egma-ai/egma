"""Verify mock-tool hello, answers, and refusals using the real handlers and room stub.
Assert returned RPC bytes and no duplicate simulator tool spans; the agent SDK
owns LiveKit tool evidence. Platform-served mocks are covered in
test_plug_retell_text_mode.py.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from conftest import A_PERSONALITY, a_spec
from room_stub import RoomStub

from egma_simulator import service as service_module
from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.config import SimulatorConfig
from egma_simulator.contract import ContractViolation
from egma_simulator.mock_tools import (
    ANSWER_TOO_LARGE,
    HELLO_METHOD,
    LARGEST_PAYLOAD_BYTES,
    MALFORMED_REQUEST,
    NOT_REPORTED,
    PROTOCOL_VERSION,
    TOOL_METHOD,
    UNKNOWN_TOOL,
    UNSUPPORTED_PROTOCOL_VERSION,
    MockToolRefusal,
    MockToolSeam,
)
from egma_simulator.model import ScriptedModel
from egma_simulator.pipeline import assemble
from egma_simulator.plugs import livekit as livekit_plug
from egma_simulator.redaction import SecretRegistry
from egma_simulator.service import RunningSimulation
from egma_simulator.spec import MockTool, SimulationSpec
from egma_simulator.speech import SCRIPTED_PAIR

A_URL = "wss://lakeside-dental.livekit.cloud"
A_KEY = "APIlakeside0000"
A_SECRET = "SENTINEL-livekit-api-secret-7f3b0c19d2a4"
A_SIMULATION = "sim_01K4RE2V6B8N0PZQTM5CHXW7JD"

def mocked_spec(
    *,
    mock_tools: list[dict] | None = None,
    scenario: str = "First point. Second point.",
    simulation_id: str = A_SIMULATION,
    connection_type: str = "livekit_room",
    modality: str = "voice",
) -> dict:
    """One spec whose connection names a room and whose run mocks tools."""
    document = a_spec(
        simulation_id,
        modality=modality,
        connection={
            "agent_platform": (
                "livekit" if connection_type == "livekit_room" else None
            ),
            "connection_type": connection_type,
            "access_variant": (
                "livekit_room.project_credentials"
                if connection_type == "livekit_room"
                else f"{connection_type}.test"
            ),
            "config": {"url": A_URL, "agentName": "front-desk"},
            "credentials": {"apiKey": A_KEY, "apiSecret": A_SECRET},
        },
        scenario=scenario,
        personality=A_PERSONALITY,
        max_turns=40,
        max_duration_seconds=300,
    )
    if mock_tools is not None:
        document["mock_tools"] = mock_tools
    return document


def answers(
    tool_name: str,
    answer: object = None,
    *,
    error: str | None = None,
) -> dict:
    """One resolved answer, as the claimed spec spells it."""
    return {
        "tool_name": tool_name,
        "answer": {"error": error} if error is not None else {"answer": answer},
    }


# -- The whole record --------------------------------------------------------


class RecordingControlPlane:
    """A control plane that files everything and directs nothing.

    The simulator's real reporter runs against it — the same write-ahead
    log, the same one ordered sender — so what lands here is the bytes
    that would have gone on the wire, report documents and span batches
    alike, in the order they were minted.
    """

    def __init__(self) -> None:
        self.filed: list[dict] = []

    async def report(self, simulation_id: str, serialized: bytes) -> None:
        del simulation_id
        self.filed.append(json.loads(serialized))

    async def spans(self, simulation_id: str, serialized: bytes) -> None:
        del simulation_id
        self.filed.append(json.loads(serialized))

    async def heartbeat(self, simulation_id: str, claimant: str) -> str | None:
        del simulation_id, claimant
        return None


def a_config(tmp_path: Path) -> SimulatorConfig:
    return SimulatorConfig(
        control_plane_url="http://127.0.0.1:1",
        claimant="sim-under-test",
        capacity=1,
        # One beat and then a long wait: the beat is not what is under
        # test here, and a busy one would only add noise to the record.
        heartbeat_seconds=3600.0,
        claim_wait_seconds=1.0,
        report_deadline_seconds=5.0,
        wal_dir=tmp_path / "wal",
        blob_dir=tmp_path / "blobs",
        log_level="INFO",
    )


async def conducted_record(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    stub: RoomStub,
    document: dict,
    session,
) -> RecordingControlPlane:
    """One whole simulation, conducted as the service conducts it.

    The spec goes in as a document — held to the contract on the way in,
    exactly as a claimed one is — and what comes back is everything the
    simulator would have sent: the lifecycle documents and the
    conversation's spans. ``session`` is what the agent's own side does in
    the room while the conversation runs.
    """
    monkeypatch.setattr(livekit_plug, "LiveKitRoomBackend", stub.driver)
    monkeypatch.setattr(
        service_module,
        "build_model_client",
        lambda spec: ScriptedModel(spec.scenario_instructions),
    )
    monkeypatch.setattr(
        service_module.SpeechProviders,
        "from_models",
        classmethod(lambda _cls, _models, *, vad: SCRIPTED_PAIR),
    )
    client = RecordingControlPlane()
    simulation = RunningSimulation(
        SimulationSpec.from_document(document),
        client=client,
        config=a_config(tmp_path),
        secrets=SecretRegistry(),
        blobs=FilesystemBlobStore(tmp_path / "blobs"),
    )

    async def agent_side() -> None:
        # A room where the exchange was never offered has nothing to wait
        # for, which is exactly what the far side would find on a live one.
        if stub.refuses_rpc is None:
            await stub.standing_ready.wait()
        await session(stub)

    await asyncio.gather(simulation.run(), agent_side())
    return client


def tool_spans(client: RecordingControlPlane) -> list[dict]:
    """Every tool call on the record, in the order it was authored."""
    return [
        span
        for document in client.filed
        for resource in document.get("resourceSpans", [])
        for scope in resource["scopeSpans"]
        for span in scope["spans"]
        if span["name"] == "tool_call"
    ]


def attributes_of(span: dict) -> dict:
    """One span's attributes, as the plain values they carry."""
    return {
        entry["key"]: next(iter(entry["value"].values()))
        for entry in span.get("attributes", [])
    }


def milliseconds_of(span: dict) -> float:
    return (int(span["endTimeUnixNano"]) - int(span["startTimeUnixNano"])) / 1_000_000


def terminal_reason(client: RecordingControlPlane) -> str:
    """What the report says went wrong, in the words a reader sees."""
    for document in client.filed:
        for event in document.get("events", []):
            if event["status"] in ("completed", "failed", "canceled"):
                return event.get("reason") or ""
    raise AssertionError("the simulation never reported a terminal state")


def terminal_facts(client: RecordingControlPlane) -> dict:
    for document in client.filed:
        for event in document.get("events", []):
            if event["status"] in ("completed", "failed", "canceled"):
                return event["facts"]
    raise AssertionError("the simulation never reported a terminal state")


async def test_a_spec_naming_mocked_tools_answers_every_call_and_records_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The whole claim, at the seam the contract draws.

    A spec goes in naming three answers. A session in the room reports
    four tools and calls two of them, and each call comes back with the
    answer that spec authored — the return branch untagged for the model
    to use, the failure branch tagged so the far side raises it. Nothing
    of any of it reaches the record: one call is one row, and that row is
    the agent's own.
    """
    stub = RoomStub(greeting="Front desk.", replies=["One moment.", "All set."])
    served: list[dict] = []

    async def session(agent: RoomStub) -> None:
        await agent.says_hello(
            "check_calendar", "book_appointment", "lookup_customer", "transfer_to_human"
        )
        served.append(await agent.calls("check_calendar", {"date": "2026-08-13"}))
        served.append(await agent.calls("book_appointment", {"at": "2026-08-13T09:00"}))

    client = await conducted_record(
        tmp_path,
        monkeypatch,
        stub,
        mocked_spec(
            mock_tools=[
                answers("check_calendar", {"slots": []}),
                answers(
                    "book_appointment",
                    error="the booking service is not accepting requests",
                ),
                answers("send_confirmation_sms", {"delivered": True}),
            ]
        ),
        session,
    )

    # Two calls reached egma and both were answered from the spec. The
    # failure branch keeps its tag: that is how the far side knows to raise
    # it rather than hand the model a string that looks like a failure.
    assert served == [
        {"answer": {"slots": []}},
        {"error": "the booking service is not accepting requests"},
    ]

    # And nothing of it is on egma's record. The agent's two other tools
    # ran their own implementations, and the two egma answered are the
    # agent's own rows to write — which is what keeps one call from
    # arriving as two records that can disagree.
    assert tool_spans(client) == []


async def test_a_simulation_that_mocks_nothing_records_exactly_what_it_used_to(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The ordinary case, and it has to stay the ordinary case.

    No mock tools, and nobody in the room asking: no tool spans at all,
    which is the record every simulation carried before mock tools
    existed.
    """
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])

    async def nobody_asks(_agent: RoomStub) -> None:
        return None

    client = await conducted_record(
        tmp_path, monkeypatch, stub, mocked_spec(), nobody_asks
    )

    assert tool_spans(client) == []
    facts = terminal_facts(client)
    assert facts["ending"] == "persona_concluded"
    # And nothing counts the agent's tools for it. What egma answered is
    # on the record as the calls it answered; what it did not answer for
    # ran with egma nowhere near it, and the record says nothing about it
    # rather than tallying an isolation nobody can vouch for.
    assert not [name for name in facts if "coverage" in name], facts


async def test_a_connection_egma_stands_outside_records_no_tool_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A chat over somebody else's platform never stood in the tool path,
    so nothing about the agent's tools reaches its record."""
    monkeypatch.setattr(livekit_plug, "LiveKitRoomBackend", RoomStub().driver)
    monkeypatch.setattr(
        service_module,
        "build_model_client",
        lambda spec: ScriptedModel(spec.scenario_instructions),
    )
    monkeypatch.setattr(
        service_module.SpeechProviders,
        "from_models",
        classmethod(lambda _cls, _models, *, vad: SCRIPTED_PAIR),
    )
    client = RecordingControlPlane()
    document = a_spec(
        A_SIMULATION,
        connection={
            "agent_platform": None,
            "connection_type": "scripted",
            "access_variant": "scripted.in_memory",
            "config": {"turn_seconds": 0.0},
            "credentials": None,
        },
        scenario="One point.",
        personality=A_PERSONALITY,
        max_turns=40,
        max_duration_seconds=300,
    )
    await RunningSimulation(
        SimulationSpec.from_document(document),
        client=client,
        config=a_config(tmp_path),
        secrets=SecretRegistry(),
        blobs=FilesystemBlobStore(tmp_path / "blobs"),
    ).run()

    assert terminal_facts(client)["ending"] == "persona_concluded"
    assert tool_spans(client) == []


# -- The exchange, method by method ------------------------------------------


async def opened(
    stub: RoomStub,
    mock_tools: tuple[MockTool, ...] = (),
    *,
    seam: MockToolSeam | None = None,
    wait_for_the_agent: bool = True,
) -> object:
    """Join a room with mock RPC. Expose seam only for tests that inspect its state.
    Disable wait_for_the_agent when testing a room where hello cannot succeed.
    """
    spec = SimulationSpec.from_document(mocked_spec())
    plug = livekit_plug.LiveKitRoom(
        modality="voice",
        access_variant="livekit_room.project_credentials",
        config={"url": A_URL, "agentName": "front-desk"},
        credentials={"apiKey": A_KEY, "apiSecret": A_SECRET},
        simulation_id=spec.simulation_id,
        mock_tools=seam if seam is not None else MockToolSeam(mock_tools),
        driver=stub.driver,
    )
    await plug.prepare()
    if wait_for_the_agent:
        await plug.open()
    return plug


def a_mock(
    tool_name: str,
    answer: object = None,
    *,
    error: str | None = None,
) -> MockTool:
    """The same resolved answer, read as the simulator reads it.

    Built from :func:`answers` rather than beside it, so a suite exercising
    the seam directly and one going in through a spec document cannot come
    to disagree about what an answer looks like.
    """
    written = answers(tool_name, answer, error=error)
    return MockTool(
        tool_name=written["tool_name"],
        answer=written["answer"],
    )


async def test_hello_answers_the_names_this_simulation_answers_for():
    """The reply is the whole of what the other side needs: wrap exactly
    these, leave everything else alone."""
    stub = RoomStub(greeting="Front desk.")
    plug = await opened(
        stub, (a_mock("check_calendar", {"slots": []}), a_mock("book_appointment", 1))
    )

    said = await stub.says_hello("check_calendar", "book_appointment", "hang_up")
    assert said == {
        "protocol_version": PROTOCOL_VERSION,
        "mocked_tools": ["check_calendar", "book_appointment"],
    }
    await plug.close()


async def test_the_seam_says_whether_the_agent_ever_reported():
    """The one fact a LiveKit simulation is required to see.

    A hello is how the agent's own SDK announces itself. Without one,
    every mocked tool in the simulation called its real backend and
    nothing on the record would say so — which is why the plug reads this
    and fails the simulation rather than conducting it.
    """
    seam = MockToolSeam((a_mock("check_calendar", {"slots": []}),))

    assert seam.agent_reported is False

    await seam.hello(
        json.dumps(
            {
                "protocol_version": PROTOCOL_VERSION,
                "tools": [{"name": "check_calendar", "schema": {}}],
            }
        )
    )

    assert seam.agent_reported is True


async def test_a_hello_egma_refused_is_told_apart_from_one_that_never_came():
    """Two failures, two sentences, because they are in two places.

    A hello that never arrived is a worker with no SDK call in it. A hello
    Egma received and refused told the agent nothing either — so nothing
    was isolated, and the simulation still fails — but the SDK did call
    and the fault is on Egma's side or in the test's own mock tools.
    Sending a developer to add a call they already made is the wrong half
    of the system.
    """
    seam = MockToolSeam((a_mock("check_calendar", {"slots": []}),))
    assert seam.why_unreported == NOT_REPORTED

    with pytest.raises(MockToolRefusal):
        await seam.hello('{"protocol_version":99,"tools":[]}')

    assert seam.agent_reported is False
    said = seam.why_unreported
    assert said != NOT_REPORTED
    assert "Egma refused the report" in said
    # Egma's own words for why, which is the half this sentence cannot know.
    assert "99" in said


async def test_hello_answers_a_test_that_mocks_nothing_with_an_empty_list():
    """A test naming no tools is answered, not ignored.

    The rule is one rule: egma answers for exactly the tools the test
    names, and a test that names none has egma answering for none. That is
    an empty list rather than a silence, because the other side needs a
    reply to learn to wrap nothing — a hello nobody answered would leave
    it waiting, and the census would never reach the record.
    """
    stub = RoomStub(greeting="Front desk.")
    plug = await opened(stub)

    said = await stub.says_hello("check_calendar", "book_appointment")
    assert said == {"protocol_version": PROTOCOL_VERSION, "mocked_tools": []}
    await plug.close()


async def test_a_second_hello_replaces_the_census_rather_than_adding_to_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A new hello replaces the tool census but cannot change test-owned mock answers.
    A covered name stays callable even when absent from the latest census.
    """
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    said: list[dict] = []

    async def two_sessions(agent: RoomStub) -> None:
        said.append(await agent.says_hello("check_calendar", "lookup_customer"))
        said.append(await agent.says_hello("transfer_to_human"))
        said.append(await agent.calls("check_calendar", {"date": "2026-08-13"}))

    client = await conducted_record(
        tmp_path,
        monkeypatch,
        stub,
        mocked_spec(mock_tools=[answers("check_calendar", {"slots": []})]),
        two_sessions,
    )

    first, second, answered = said
    assert first == second == {
        "protocol_version": PROTOCOL_VERSION,
        "mocked_tools": ["check_calendar"],
    }
    assert answered == {"answer": {"slots": []}}
    assert tool_spans(client) == []


async def test_a_call_the_census_never_reported_is_answered_all_the_same(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Answers stand ready for every name this simulation covers, whether
    or not the census mentioned it — the safe way round, because the other
    way lets a tool the agent gained afterwards reach a real backend."""
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    said: list[dict] = []

    async def gains_a_tool(agent: RoomStub) -> None:
        await agent.says_hello("check_calendar")
        said.append(await agent.calls("send_confirmation_sms"))

    client = await conducted_record(
        tmp_path,
        monkeypatch,
        stub,
        mocked_spec(
            mock_tools=[
                answers("check_calendar", {"slots": []}),
                answers("send_confirmation_sms", {"delivered": True}),
            ]
        ),
        gains_a_tool,
    )

    assert said == [{"answer": {"delivered": True}}]
    assert tool_spans(client) == []


# -- Every way the exchange refuses ------------------------------------------


async def refused(stub: RoomStub, method: str, payload: str):
    """One call egma will not answer, and the error the room carried back."""
    from livekit import rtc

    with pytest.raises(rtc.RpcError) as refusal:
        await stub.room.perform_rpc(method, payload)
    return refusal.value


async def test_a_call_outside_the_answers_is_refused_and_never_waved_through(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A protocol error, not a pass-through.

    The other side was told exactly which names egma answers for. A call
    for any other name is that side asking for something it was never
    offered, and answering it — or quietly letting it run real while
    saying nothing — would put a tool egma had no answer for on the record
    as one it served.
    """
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])

    async def asks_for_the_unmocked(agent: RoomStub) -> None:
        await agent.says_hello("check_calendar", "charge_card")
        from livekit import rtc

        with pytest.raises(rtc.RpcError) as refusal:
            await agent.calls("charge_card", {"amount": 4200})
        assert refusal.value.code == UNKNOWN_TOOL
        assert "charge_card" in refusal.value.message
        assert "check_calendar" in refusal.value.message

    client = await conducted_record(
        tmp_path,
        monkeypatch,
        stub,
        mocked_spec(mock_tools=[answers("check_calendar", {"slots": []})]),
        asks_for_the_unmocked,
    )

    # And egma writes nothing down about it. The refusal reaches the model
    # as that tool failing, and the agent's own span for the call carries
    # the error — which is where a reader of the transcript finds it.
    assert tool_spans(client) == []


@pytest.mark.parametrize(
    ("named", "method", "payload", "code", "quoted"),
    [
        (
            "a payload that is not JSON",
            TOOL_METHOD,
            "not json at all",
            MALFORMED_REQUEST,
            "not JSON",
        ),
        (
            "a payload that is JSON but not an object",
            TOOL_METHOD,
            '["check_calendar"]',
            MALFORMED_REQUEST,
            "a list",
        ),
        (
            "a call that names no tool",
            TOOL_METHOD,
            '{"arguments":{}}',
            MALFORMED_REQUEST,
            "nothing",
        ),
        (
            "arguments that are not an object",
            TOOL_METHOD,
            '{"name":"check_calendar","arguments":"date=today"}',
            MALFORMED_REQUEST,
            "text",
        ),
        (
            "a census that is not a list",
            HELLO_METHOD,
            '{"protocol_version":1,"tools":{"name":"check_calendar"}}',
            MALFORMED_REQUEST,
            "an object",
        ),
        (
            "a tool in the census that names itself nothing",
            HELLO_METHOD,
            '{"protocol_version":1,"tools":[{"schema":{}}]}',
            MALFORMED_REQUEST,
            "nothing",
        ),
        (
            "a hello in a version egma does not speak",
            HELLO_METHOD,
            '{"protocol_version":99,"tools":[]}',
            UNSUPPORTED_PROTOCOL_VERSION,
            "99",
        ),
        (
            "a hello that declares no version at all",
            HELLO_METHOD,
            '{"tools":[]}',
            UNSUPPORTED_PROTOCOL_VERSION,
            "nothing",
        ),
    ],
)
async def test_a_message_egma_cannot_read_is_refused_naming_the_fault(
    named: str, method: str, payload: str, code: int, quoted: str
):
    """Every way a message goes wrong, refused in a sentence that says
    what was wrong with it — the reader is whoever is writing the other
    side, and a silent answer would leave them guessing."""
    stub = RoomStub(greeting="Front desk.")
    plug = await opened(stub, (a_mock("check_calendar", {"slots": []}),))

    refusal = await refused(stub, method, payload)
    assert refusal.code == code, named
    assert quoted in refusal.message, named
    await plug.close()


async def test_a_refusal_names_the_shape_it_got_and_never_the_bytes():
    """A payload is the customer's own data and a refusal about it travels
    into logs, so what is named is the kind of thing that arrived."""
    stub = RoomStub(greeting="Front desk.")
    plug = await opened(stub, (a_mock("check_calendar", {"slots": []}),))

    refusal = await refused(
        stub, TOOL_METHOD, '{"name":"check_calendar","arguments":"SENSITIVE-0007"}'
    )
    assert "SENSITIVE-0007" not in refusal.message
    await plug.close()


async def test_a_method_nobody_offered_is_refused_by_the_room_itself():
    """Two methods and no more. Anything else is refused before egma is
    reached at all, which is the transport's own answer and the right
    one: egma never registered it, so there is nothing to ask."""
    from livekit import rtc

    stub = RoomStub(greeting="Front desk.")
    plug = await opened(stub, (a_mock("check_calendar", {"slots": []}),))

    refusal = await refused(stub, "egma.please_do_something_else", "{}")
    assert refusal.code == rtc.RpcError.ErrorCode.UNSUPPORTED_METHOD
    await plug.close()


async def test_an_answer_too_large_for_the_wire_is_refused_naming_the_size():
    """The cap belongs to the transport, and authoring already refuses an
    answer this large. It is checked here anyway, because an answer that
    cannot be sent has to fail as an answer somebody can fix rather than
    as a call that mysteriously did not come back."""
    stub = RoomStub(greeting="Front desk.")
    plug = await opened(
        stub, (a_mock("read_the_file", "x" * (LARGEST_PAYLOAD_BYTES + 1)),)
    )

    refusal = await refused(stub, TOOL_METHOD, '{"name":"read_the_file"}')
    assert refusal.code == ANSWER_TOO_LARGE
    assert str(LARGEST_PAYLOAD_BYTES) in refusal.message
    assert "read_the_file" in refusal.message
    await plug.close()


async def test_a_reply_too_large_to_send_is_refused_before_it_is_sent():
    """A test naming more mocked tools than one message can carry.

    Refused as an answer about the answer, naming the cap, rather than as
    a hello that mysteriously failed — and refused before the census is
    kept, so a reply the other side never received leaves this side
    believing nothing about what the agent holds.
    """
    # The worker's own hello is the one refused here, so this room never
    # reports and the plug would fail the simulation over it. Correctly:
    # a reply that never arrived told the agent to wrap nothing. What this
    # test is about is one step earlier, so the exchange is opened without
    # the ordinary reporting worker in front of it.
    stub = RoomStub(greeting="Front desk.", agent_reports=False)
    seam = MockToolSeam(
        tuple(
            a_mock(f"tool_number_{number:04d}", {"ok": True}) for number in range(900)
        )
    )
    plug = await opened(stub, seam=seam, wait_for_the_agent=False)

    refusal = await refused(
        stub, HELLO_METHOD, '{"protocol_version":1,"tools":[{"name":"one_tool"}]}'
    )
    assert refusal.code == ANSWER_TOO_LARGE
    assert str(LARGEST_PAYLOAD_BYTES) in refusal.message

    # And the seam still answers for every name this simulation covers: a
    # hello nobody could reply to changes nothing about what egma serves.
    answered = await stub.room.perform_rpc(
        TOOL_METHOD, '{"name":"tool_number_0000"}'
    )
    assert json.loads(answered) == {"answer": {"ok": True}}
    await plug.close()


async def test_no_credential_and_no_test_content_ever_rides_an_answer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """What comes back is the authored answer and nothing beside it.

    The room's key pair is in the process while this runs, and the
    scenario the persona is working to is in the same spec — an answer
    that carried either would hand the agent its own test to read, or hand
    somebody the customer's project.
    """
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    said: list[str] = []

    async def keeps_what_it_was_told(agent: RoomStub) -> None:
        said.append(json.dumps(await agent.says_hello("check_calendar")))
        said.append(json.dumps(await agent.calls("check_calendar", {"date": "x"})))

    await conducted_record(
        tmp_path,
        monkeypatch,
        stub,
        mocked_spec(
            mock_tools=[answers("check_calendar", {"slots": []})],
            scenario=(
                "Ask to move the Tuesday cleaning to Thursday. Say you are Margaret."
            ),
        ),
        keeps_what_it_was_told,
    )

    assert said, "the session was never answered"
    for answered in said:
        for kept in (A_SECRET, A_KEY, "Margaret", "Tuesday", A_PERSONALITY):
            assert kept not in answered


async def test_a_hello_egma_refused_leaves_the_agent_wrapping_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A session whose hello egma refused was told nothing.

    So it wrapped nothing, and every tool it has ran its own
    implementation — with no call reaching egma and no span of egma's on
    the record to suggest otherwise.
    """
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])

    async def a_session_egma_will_not_speak_to(agent: RoomStub) -> None:
        from livekit import rtc

        with pytest.raises(rtc.RpcError) as refusal:
            await agent.says_hello("check_calendar", protocol_version=99)
        assert refusal.value.code == UNSUPPORTED_PROTOCOL_VERSION

    client = await conducted_record(
        tmp_path,
        monkeypatch,
        stub,
        mocked_spec(mock_tools=[answers("check_calendar", {"slots": []})]),
        a_session_egma_will_not_speak_to,
    )

    assert tool_spans(client) == []


async def test_an_exchange_that_cannot_be_offered_never_sinks_the_conversation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    """Failed RPC registration prevents hello and must fail simulation startup.
    Log the registration fault and report the setup error instead of completing.
    """
    caplog.set_level("ERROR")
    stub = RoomStub(
        greeting="Front desk.",
        replies=["Noted."],
        refuses_rpc="this participant takes no methods",
    )

    async def nobody_can_ask(_agent: RoomStub) -> None:
        return None

    client = await conducted_record(
        tmp_path,
        monkeypatch,
        stub,
        mocked_spec(mock_tools=[answers("check_calendar", {"slots": []})]),
        nobody_can_ask,
    )

    assert terminal_facts(client)["ending"] == "agent_never_joined"
    assert "did not report to Egma" in terminal_reason(client)
    assert tool_spans(client) == []
    assert any(
        "could not offer the mock-tool exchange" in record.getMessage()
        for record in caplog.records
    )


# -- What the seam reads out of a spec ---------------------------------------


async def test_a_spec_answering_one_tool_twice_is_refused():
    """Matching is by name and nothing else, so two answers for one name
    are two answers with no rule to choose between them. Taking either
    silently would make the record's answer a matter of which one the
    control plane happened to write first."""
    document = mocked_spec(
        mock_tools=[
            answers("check_calendar", {"slots": []}),
            answers("check_calendar", {"slots": ["09:00"]}),
        ]
    )
    with pytest.raises(ContractViolation) as refused_spec:
        SimulationSpec.from_document(document)
    assert "check_calendar" in " ".join(refused_spec.value.complaints)


def test_the_golden_fixture_is_a_spec_the_simulator_reads_whole(tmp_path: Path):
    """The fixture the contract package carries is not decoration: the
    answers it names are the answers the seam would stand ready with."""
    from conftest import load_fixture_spec

    spec = SimulationSpec.from_document(
        load_fixture_spec("voice-livekit-mocked-tools.json")
    )
    assert [mock.tool_name for mock in spec.mock_tools] == [
        "check_calendar",
        "book_appointment",
        "send_confirmation_sms",
    ]
    assert spec.mock_tools[1].fails
    # An authored `null` is an answer, and the tagged shape is what keeps
    # it tellable from no answer at all.
    assert not spec.mock_tools[2].fails
    assert spec.mock_tools[2].answer == {"answer": None}

    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
    )
    assert assembled.conductor is not None
    assert [answer.tool_name for answer in assembled.mock_tools.answers()] == [
        "check_calendar",
        "book_appointment",
        "send_confirmation_sms",
    ]
