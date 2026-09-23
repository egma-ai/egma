"""The workbench's stand-in for egma's SDK-facing routes and the agent report.

A Pipecat bot's egma SDK sends its hello and mocked tool calls to
``/sdk/v1/*``; the simulator reads the hello's arrival from
``/v1/simulations/{id}/agent-report``. The workbench answers both from the
claimed spec's mock tools, in the shared seam fixture's shapes
(``sdk-https-exchange.v1.json``). It checks no API key: the workbench is a
local fixture.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

PROTOCOL_VERSION = 1
LARGEST_ANSWER_BYTES = 15 * 1024
LARGEST_PROVIDER_REFERENCE = 512

NOT_A_SIMULATION = {
    "error": "not_a_simulation",
    "message": (
        "This provider reference does not name a live Egma simulation in this "
        "API key's project."
    ),
}

HELLO_MALFORMED = (
    'egma.hello carries the agent\'s tools as a list of {"name": …} objects and '
    "names the simulation in provider_reference; this one does not."
)

TOOL_MALFORMED = (
    "egma.tool names the tool being called and carries its arguments as a JSON "
    "object or not at all; this one does not."
)


@dataclass
class StoredHello:
    """The latest hello for one simulation, as the API stores it as its agent report."""

    state: str
    at: str
    tools: list[dict[str, Any]] = field(default_factory=list)
    mocked_tools: list[str] = field(default_factory=list)
    code: int | None = None
    message: str | None = None


class SeamAnswer(Exception):
    """One non-200 answer of the SDK seam: a status and a JSON body."""

    def __init__(self, status: int, body: Mapping[str, Any]) -> None:
        super().__init__(body.get("message", ""))
        self.status = status
        self.body = dict(body)
        self.report: StoredHello | None = None


def _refused(code: int, message: str) -> SeamAnswer:
    error = "flows_function_mocked" if code == 905 else "seam_refused"
    return SeamAnswer(422, {"error": error, "code": code, "message": message})


def flows_refusal(names: list[str]) -> str:
    quoted = ", ".join(f'"{name}"' for name in names)
    if len(names) == 1:
        return (
            f"the test mocks {quoted}, and this is a Pipecat Flows function; Egma "
            "cannot mock it yet. Remove it from the test's mock tools. Flows "
            "functions that are not mocked run for real and are recorded."
        )
    return (
        f"the test mocks {quoted}, and these are Pipecat Flows functions; Egma "
        "cannot mock them yet. Remove them from the test's mock tools. Flows "
        "functions that are not mocked run for real and are recorded."
    )


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _provider_reference(body: Any) -> str | None:
    if not isinstance(body, dict):
        return None
    reference = body.get("provider_reference")
    if (
        not isinstance(reference, str)
        or not reference
        or len(reference) > LARGEST_PROVIDER_REFERENCE
    ):
        return None
    return reference


def _mocked(spec: Mapping[str, Any]) -> list[dict[str, Any]]:
    tools = spec.get("mock_tools")
    return list(tools) if isinstance(tools, list) else []


def hello(
    body: Any, live: Mapping[str, Mapping[str, Any]]
) -> tuple[dict[str, Any], StoredHello | None]:
    """Answer one hello and say what it records; SeamAnswer for other answers.

    A refused hello from a live simulation raises SeamAnswer carrying the
    refused report in ``report``.
    """
    reference = _provider_reference(body)
    tools = body.get("tools") if isinstance(body, dict) else None
    if (
        reference is None
        or not isinstance(tools, list)
        or any(
            not isinstance(tool, dict)
            or not isinstance(tool.get("name"), str)
            or not tool.get("name")
            or ("flows" in tool and not isinstance(tool["flows"], bool))
            for tool in tools
        )
    ):
        raise _refused(901, HELLO_MALFORMED)
    spec = live.get(reference)
    if spec is None:
        raise SeamAnswer(404, NOT_A_SIMULATION)
    mocked = [tool["tool_name"] for tool in _mocked(spec)]
    version = body.get("protocol_version")
    refusal: tuple[int, str] | None = None
    reply = {"protocol_version": PROTOCOL_VERSION, "mocked_tools": mocked}
    size = len(json.dumps(reply, separators=(",", ":")).encode("utf-8"))
    flows_mocked = [
        tool["name"] for tool in tools if tool.get("flows") and tool["name"] in mocked
    ]
    if version != PROTOCOL_VERSION:
        refusal = (
            904,
            f"this hello speaks protocol version {version}, and Egma speaks "
            f"{PROTOCOL_VERSION}. Upgrade the egma package.",
        )
    elif flows_mocked:
        refusal = (905, flows_refusal(flows_mocked))
    elif size > LARGEST_ANSWER_BYTES:
        refusal = (
            903,
            f"the list of tools Egma answers for is {size} bytes, more than the "
            f"{LARGEST_ANSWER_BYTES} the exchange carries.",
        )
    if refusal is not None:
        code, message = refusal
        refused = _refused(code, message)
        refused.report = StoredHello(
            state="refused", at=_now(), tools=list(tools), code=code, message=message
        )
        raise refused
    return reply, StoredHello(
        state="accepted", at=_now(), tools=list(tools), mocked_tools=mocked
    )


def tool(body: Any, live: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """Answer one mocked tool call; raise SeamAnswer for every non-200 answer."""
    reference = _provider_reference(body)
    if (
        reference is None
        or not isinstance(body.get("name"), str)
        or not body["name"]
        or ("arguments" in body and not isinstance(body["arguments"], dict))
        or ("flows" in body and not isinstance(body["flows"], bool))
    ):
        raise _refused(901, TOOL_MALFORMED)
    spec = live.get(reference)
    if spec is None:
        raise SeamAnswer(404, NOT_A_SIMULATION)
    name = body["name"]
    answers = {entry["tool_name"]: entry["answer"] for entry in _mocked(spec)}
    if body.get("flows") and name in answers:
        raise _refused(905, flows_refusal([name]))
    if name not in answers:
        named = ", ".join(answers) or "no tools at all"
        raise _refused(
            902,
            f"this simulation has no mock tool for '{name}', so Egma has nothing "
            f"to answer with. It answers for: {named}",
        )
    return dict(answers[name])


def confirm(body: Any, live: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    reference = _provider_reference(body)
    if reference is None or reference not in live:
        raise SeamAnswer(404, NOT_A_SIMULATION)
    return {"simulation": True}


def agent_report_answer(
    simulation_id: str, report: StoredHello | None
) -> dict[str, Any]:
    """The agent-report route's 200 body for one simulation."""
    if report is None:
        return {"simulation_id": simulation_id, "state": "waiting"}
    if report.state == "accepted":
        return {
            "simulation_id": simulation_id,
            "state": "accepted",
            "at": report.at,
            "tools": [tool["name"] for tool in report.tools],
            "mocked_tools": report.mocked_tools,
        }
    return {
        "simulation_id": simulation_id,
        "state": "refused",
        "at": report.at,
        "code": report.code,
        "message": report.message,
    }
