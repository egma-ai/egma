"""egma answering for the agent's tools, whole, with no LiveKit anywhere.

The exchange is two methods on egma's participant, and everything below
is proved against the room-shaped LiveKit in :mod:`room_stub`, whose
rooms now carry calls as well as audio. What answers those calls is
egma's own code, unchanged — so what is proved here about a census, an
answer, a delay, a late-attached call or a refusal is proved about the
code a customer's server runs.

The first test is the whole claim, black box: a spec naming mocked tools
goes in at the top, and the record comes out carrying the census, the
coverage stamp, and each mocked call with its arguments, its answer, its
provenance and a duration that reflects the declared delay. Everything
after it takes one part of that story apart.
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
    PROTOCOL_VERSION,
    TOOL_METHOD,
    UNKNOWN_TOOL,
    UNSUPPORTED_PROTOCOL_VERSION,
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

A_DECLARED_DELAY_MS = 60
"""Short enough to cost CI nothing, long enough that a span holding it
cannot be a rounding error. The delay is real time on a real clock, here
as in a live room: it is the one thing about this exchange that cannot be
rendered into the audio."""


def mocked_spec(
    *,
    mock_tools: list[dict] | None = None,
    scenario: str = "First point. Second point.",
    simulation_id: str = A_SIMULATION,
    connection_kind: str = "livekit_room",
    modality: str = "voice",
) -> dict:
    """One spec whose connection names a room and whose run mocks tools."""
    document = a_spec(
        simulation_id,
        modality=modality,
        connection={
            "agent_platform": (
                "livekit_agents" if connection_kind == "livekit_room" else None
            ),
            "connection_kind": connection_kind,
            "access_variant": (
                "livekit_room.project_credentials"
                if connection_kind == "livekit_room"
                else f"{connection_kind}.test"
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
    delay_milliseconds: int = 0,
) -> dict:
    """One resolved answer, as the claimed spec spells it."""
    return {
        "tool_name": tool_name,
        "answer": {"error": error} if error is not None else {"answer": answer},
        "delay_milliseconds": delay_milliseconds,
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


def golden_result_for(tool_name: str) -> str:
    """What the contract's own golden flush records for one served call.

    The seam and the published bytes are the two halves of one promise,
    and a test that restated the bytes here could only prove the seam
    agrees with this file. This reads them off the golden flush, so a
    change to either side fails.
    """
    from egma_simulator.contract import contract_dir

    document = json.loads(
        (
            contract_dir()
            / "fixtures"
            / "spans"
            / "valid"
            / "voice-mocked-tool-calls.json"
        ).read_text(encoding="utf-8")
    )
    for span in document["resourceSpans"][0]["scopeSpans"][0]["spans"]:
        held = attributes_of(span)
        if held.get("egma.tool.name") == tool_name:
            return held["egma.tool.result"]
    raise AssertionError(f"the golden flush records no call to {tool_name}")


def terminal_facts(client: RecordingControlPlane) -> dict:
    for document in client.filed:
        for event in document.get("events", []):
            if event["status"] in ("completed", "failed", "canceled"):
                return event["facts"]
    raise AssertionError("the simulation never reported a terminal state")


async def test_a_spec_naming_mocked_tools_comes_back_as_a_record_of_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The whole claim, at the seam the contract draws.

    A spec goes in naming three answers. A session in the room reports
    four tools, calls two of them, and what comes out is the record: a
    coverage stamp naming what was discovered, covered and left running
    real, and a span per call carrying the arguments it was made with, the
    answer it was served, where that answer came from, and a duration that
    holds the delay the mock tool declared.
    """
    stub = RoomStub(greeting="Front desk.", replies=["One moment.", "All set."])

    async def session(agent: RoomStub) -> None:
        await agent.says_hello(
            "check_calendar", "book_appointment", "lookup_customer", "transfer_to_human"
        )
        await agent.calls("check_calendar", {"date": "2026-08-13"})
        await agent.calls("book_appointment", {"at": "2026-08-13T09:00"})

    client = await conducted_record(
        tmp_path,
        monkeypatch,
        stub,
        mocked_spec(
            mock_tools=[
                answers(
                    "check_calendar",
                    {"slots": []},
                    delay_milliseconds=A_DECLARED_DELAY_MS,
                ),
                answers(
                    "book_appointment",
                    error="the booking service is not accepting requests",
                ),
                answers("send_confirmation_sms", {"delivered": True}),
            ]
        ),
        session,
    )

    # The coverage stamp: what the agent said it had, what egma stood
    # ready for, and what ran its own implementation untouched.
    assert terminal_facts(client)["mock_tool_coverage"] == {
        "discovered": [
            "check_calendar",
            "book_appointment",
            "lookup_customer",
            "transfer_to_human",
        ],
        "covered": ["check_calendar", "book_appointment", "send_confirmation_sms"],
        "uncovered": ["lookup_customer", "transfer_to_human"],
    }

    calendar, booking = tool_spans(client)
    assert attributes_of(calendar) == {
        "egma.tool.name": "check_calendar",
        "egma.tool.arguments": '{"date":"2026-08-13"}',
        # What the call was given: the tool's own return value, which is
        # what the agent received and what a grader reads. Held to the
        # golden file rather than restated, so the record the seam writes
        # and the record the contract publishes cannot drift apart.
        "egma.tool.result": golden_result_for("check_calendar"),
        "egma.tool.provenance": "mocked",
        "egma.tool.mock_tool": "check_calendar",
    }
    assert attributes_of(calendar)["egma.tool.result"] == '{"slots":[]}'
    # The declared delay is readable as the time the exchange took, and
    # there is no attribute repeating the number for the two to disagree.
    assert milliseconds_of(calendar) >= A_DECLARED_DELAY_MS

    # A failure has no return value, so the tag stays on: what a test that
    # wants the apology path gets is the words its author wrote, kept
    # tellable from a tool that returned a string.
    assert attributes_of(booking)["egma.tool.result"] == (
        '{"error":"the booking service is not accepting requests"}'
    )
    assert attributes_of(booking)["egma.tool.provenance"] == "mocked"
    assert milliseconds_of(booking) >= 0


async def test_a_simulation_that_mocks_nothing_records_exactly_what_it_used_to(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The ordinary case, and it has to stay the ordinary case.

    No mock tools, and nobody in the room asking: no tool spans, and the
    coverage stamp says the asking happened and nothing came back — which
    is a different sentence from the stamp being absent, and the honest
    one for a room egma really stood ready in.
    """
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])

    async def nobody_asks(_agent: RoomStub) -> None:
        return None

    client = await conducted_record(
        tmp_path, monkeypatch, stub, mocked_spec(), nobody_asks
    )

    assert tool_spans(client) == []
    assert terminal_facts(client)["mock_tool_coverage"] == {
        "discovered": [],
        "covered": [],
        "uncovered": [],
    }


async def test_a_connection_egma_stands_outside_claims_nothing_about_tools(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Absent, not empty. A chat over somebody else's platform never asked
    the agent what tools it has, so its record says nothing rather than
    saying nothing was found."""
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
            "connection_kind": "scripted",
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

    assert "mock_tool_coverage" not in terminal_facts(client)


# -- The exchange, method by method ------------------------------------------


async def opened(
    stub: RoomStub,
    mock_tools: tuple[MockTool, ...] = (),
    *,
    seam: MockToolSeam | None = None,
) -> object:
    """One room, joined, with egma standing ready to answer in it.

    ``seam`` is for the one test that has to ask what the seam claims
    afterwards; everything else only cares what comes back on the wire.
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
    await plug.open()
    return plug


def a_mock(
    tool_name: str,
    answer: object = None,
    *,
    error: str | None = None,
    delay_milliseconds: int = 0,
) -> MockTool:
    """The same resolved answer, read as the simulator reads it.

    Built from :func:`answers` rather than beside it, so a suite exercising
    the seam directly and one going in through a spec document cannot come
    to disagree about what an answer looks like.
    """
    written = answers(
        tool_name, answer, error=error, delay_milliseconds=delay_milliseconds
    )
    return MockTool(
        tool_name=written["tool_name"],
        answer=written["answer"],
        delay_milliseconds=written["delay_milliseconds"],
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


async def test_a_second_hello_replaces_the_census_rather_than_adding_to_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A census is a snapshot of the agent's tools, so an agent that
    announces itself again is announcing what it has now."""
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])

    async def two_sessions(agent: RoomStub) -> None:
        await agent.says_hello("check_calendar", "lookup_customer")
        await agent.says_hello("check_calendar", "transfer_to_human")

    client = await conducted_record(
        tmp_path,
        monkeypatch,
        stub,
        mocked_spec(mock_tools=[answers("check_calendar", {"slots": []})]),
        two_sessions,
    )

    assert terminal_facts(client)["mock_tool_coverage"] == {
        "discovered": ["check_calendar", "transfer_to_human"],
        "covered": ["check_calendar"],
        "uncovered": ["transfer_to_human"],
    }


async def test_a_call_the_census_never_reported_lands_late_attached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Answers stand ready for every name this simulation covers, whether
    or not the census mentioned it — the safe way round, because the other
    way lets a tool the agent gained afterwards reach a real backend. What
    such a call cannot promise is its arguments, and the flag owns that."""
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])

    async def gains_a_tool(agent: RoomStub) -> None:
        await agent.says_hello("check_calendar")
        await agent.calls("send_confirmation_sms")

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

    (served,) = tool_spans(client)
    assert attributes_of(served) == {
        "egma.tool.name": "send_confirmation_sms",
        # Held to the golden flush, which records this very call: the
        # arguments never arrived, so the attribute is absent rather than
        # empty, and a reader never takes thin arguments for none passed.
        "egma.tool.result": golden_result_for("send_confirmation_sms"),
        "egma.tool.provenance": "mocked",
        "egma.tool.mock_tool": "send_confirmation_sms",
        "egma.tool.late_attached": True,
    }
    # Covered names the whole set egma stood ready for, so a late-attached
    # name is exactly one that is covered and was never discovered.
    coverage = terminal_facts(client)["mock_tool_coverage"]
    assert set(coverage["covered"]) - set(coverage["discovered"]) == {
        "send_confirmation_sms"
    }


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

    # On the record too, and honestly: no result and no mock tool, because
    # nothing answered it — but stamped `refused`, because egma was in the
    # path and said no. A span with no stamp at all is the other fact
    # entirely: the real tool ran, with egma nowhere near it.
    (refused_call,) = tool_spans(client)
    assert attributes_of(refused_call) == {
        "egma.tool.name": "charge_card",
        "egma.tool.arguments": '{"amount":4200}',
        "egma.tool.provenance": "refused",
    }


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


async def test_a_reply_too_large_to_send_covers_nothing_and_records_no_census():
    """A project with more mocked tools than one message can name.

    Refused before anything is written down, which is the ordering that
    matters: the reply is what tells the other side which tools to wrap,
    so a reply that never arrives wrapped nothing — and a census recorded
    ahead of the refusal would leave the stamp claiming an isolation that
    did not happen.
    """
    stub = RoomStub(greeting="Front desk.")
    seam = MockToolSeam(
        tuple(
            a_mock(f"tool_number_{number:04d}", {"ok": True}) for number in range(900)
        )
    )
    plug = await opened(stub, seam=seam)

    refusal = await refused(
        stub, HELLO_METHOD, '{"protocol_version":1,"tools":[{"name":"one_tool"}]}'
    )
    assert refusal.code == ANSWER_TOO_LARGE
    assert str(LARGEST_PAYLOAD_BYTES) in refusal.message

    assert seam.coverage() == {
        "discovered": [],
        "covered": [],
        "uncovered": [],
    }
    await plug.close()


async def test_an_oversized_answer_is_refused_before_its_delay_is_waited_out():
    """A fault to raise at once, not something to make a conversation wait
    thirty seconds for."""
    stub = RoomStub(greeting="Front desk.")
    plug = await opened(
        stub,
        (
            a_mock(
                "read_the_file",
                "x" * (LARGEST_PAYLOAD_BYTES + 1),
                delay_milliseconds=30_000,
            ),
        ),
    )

    began = asyncio.get_running_loop().time()
    await refused(stub, TOOL_METHOD, '{"name":"read_the_file"}')
    assert asyncio.get_running_loop().time() - began < 1.0
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


async def test_a_hello_egma_refused_covers_nothing_at_all(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The stamp never claims an isolation that did not happen.

    A session whose hello egma refused was told nothing, so it wrapped
    nothing, so every tool it has ran its own implementation. Naming those
    tools covered would be the record saying the simulation was isolated
    when it was not — which is the one thing this stamp exists to make
    impossible.
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

    assert terminal_facts(client)["mock_tool_coverage"] == {
        "discovered": [],
        "covered": [],
        "uncovered": [],
    }


async def test_an_exchange_that_cannot_be_offered_never_sinks_the_conversation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    """Nothing about mock tools may fail a conversation that would have run.

    A room where egma answered for nothing is exactly the room every
    simulation was before mock tools existed, so a participant that will
    not take the methods costs the exchange and nothing else: it is said
    loudly, the conversation goes on, and the record claims nothing about
    tools — which is the truth, because egma never stood in their path.
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

    facts = terminal_facts(client)
    assert facts["ending"] == "persona_concluded"
    assert "mock_tool_coverage" not in facts
    assert any(
        "could not offer the mock-tool exchange" in record.getMessage()
        for record in caplog.records
    )


# -- What the seam claims, and when ------------------------------------------


def test_a_seam_nobody_stood_ready_with_claims_nothing():
    """A room that was never joined has no stamp to make: egma was not
    there, so it learned nothing and claims nothing."""
    assert MockToolSeam((a_mock("check_calendar", {"slots": []}),)).coverage() is None


async def test_a_spec_answering_one_tool_twice_is_refused():
    """Matching is by name and nothing else, so two answers for one name
    are two answers with no rule to choose between them. Taking either
    silently would make the record's answer a matter of which the control
    plane happened to write first."""
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
    assert spec.mock_tools[0].delay_milliseconds == 250
    assert spec.mock_tools[1].fails
    # An authored `null` is an answer, and the tagged shape is what keeps
    # it tellable from no answer at all.
    assert not spec.mock_tools[2].fails
    assert spec.mock_tools[2].answer == {"answer": None}

    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
    )
    assert assembled.conductor is not None
    assert assembled.mock_tool_coverage is None, (
        "no room was joined, so nothing is claimed"
    )
