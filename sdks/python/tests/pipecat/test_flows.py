"""Pipecat Flows functions in a simulation, with a real ``FlowManager``.

Flows gives the LLM a node's functions when the node is entered, after the
SDK line has sent the first hello. A function the test mocks is therefore
found later: the SDK reports it again with ``"flows": true`` (egma refuses
that report, which fails the simulation on egma's side) and answers the
call with egma's refusal, never running the Flows handler. A Flows function
the test does not mock runs for real and is recorded.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from pipecat.flows import FlowManager, FlowsFunctionSchema
from pipecat.frames.frames import FunctionCallResultFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
)
from support import (
    DailyRunnerArguments,
    Recording,
    ScriptedLLM,
    Step,
    egma,
    exports,
    fixture,
    run_pipeline,
    simulation_body,
    worker_for,
)

from egma.pipecat import simulation


class FrontDesk:
    """A Flows bot with one node: route_to_billing and check_store_hours."""

    def __init__(self, script: list[Step]) -> None:
        self.ran: list[tuple[str, dict[str, Any]]] = []

        async def route_to_billing(args: dict[str, Any], flow_manager: Any):
            self.ran.append(("route_to_billing", dict(args)))
            return {"next": "billing"}, {
                "name": "billing",
                "task_messages": [{"role": "system", "content": "Take payment."}],
                "functions": [],
                "respond_immediately": False,
            }

        async def check_store_hours(args: dict[str, Any], flow_manager: Any):
            self.ran.append(("check_store_hours", dict(args)))
            return {"hours": "9 to 5"}, None

        self.node = {
            "name": "front_desk",
            "task_messages": [{"role": "system", "content": "Help the caller."}],
            "functions": [
                FlowsFunctionSchema(
                    name="route_to_billing",
                    description="Send the caller to billing.",
                    properties={},
                    required=[],
                    handler=route_to_billing,
                ),
                FlowsFunctionSchema(
                    name="check_store_hours",
                    description="Read the store's hours for a day.",
                    properties={"day": {"type": "string"}},
                    required=["day"],
                    handler=check_store_hours,
                ),
            ],
        }
        self.llm = ScriptedLLM(script)
        pair = LLMContextAggregatorPair(LLMContext())
        self.results = Recording(FunctionCallResultFrame)
        self.worker = worker_for(
            [pair.user(), self.llm, self.results, pair.assistant()]
        )
        self.flow_manager = FlowManager(
            worker=self.worker, llm=self.llm, context_aggregator=pair
        )

    async def start(self) -> None:
        await self.flow_manager.initialize(self.node)
        await asyncio.wait_for(self.llm.done.wait(), 10)
        await asyncio.sleep(0.3)

    def result_of(self, name: str) -> list[Any]:
        return [f.result for f in self.results.frames if f.function_name == name]


async def test_a_mocked_flows_function_is_reported_refused_and_never_runs(
    egma, exports, fixture
):
    reference = fixture["worlds"]["flows"]["simulation_id"]
    bot = FrontDesk([Step(calls=[("route_to_billing", {})]), Step(text="Sorry.")])

    await simulation(bot.worker, DailyRunnerArguments(body=simulation_body(reference)))
    await run_pipeline(bot.worker, bot.start)

    refusal = fixture["exchanges"]["hello_flows_mocked"]["response"]["message"]
    first, again = egma.bodies("hello")
    assert first["tools"] == [], "the node's functions are not known at the SDK line"
    reported = {tool["name"]: tool for tool in again["tools"]}
    assert reported["route_to_billing"]["flows"] is True
    assert reported["check_store_hours"]["flows"] is True
    assert egma.reports[reference]["state"] == "refused"
    assert egma.reports[reference]["message"] == refusal

    # The call itself: egma's refusal reaches the model, the Flows handler
    # never runs, and the flow stays where it was.
    assert bot.ran == []
    [result] = bot.result_of("route_to_billing")
    assert refusal in result["error"]
    assert result["error"].endswith("The real tool did not run.")
    assert bot.flow_manager.current_node == "front_desk"
    [tool] = egma.bodies("tool")
    assert tool["name"] == "route_to_billing"
    assert tool["flows"] is True

    [call] = exports.only.named("function_call")
    assert call.attributes["egma.tool.error"] == result["error"]


async def test_an_unmocked_flows_function_runs_and_is_recorded(egma, exports, fixture):
    reference = fixture["worlds"]["calendar"]["simulation_id"]
    bot = FrontDesk(
        [Step(calls=[("check_store_hours", {"day": "Saturday"})]), Step(text="9 to 5.")]
    )

    await simulation(bot.worker, DailyRunnerArguments(body=simulation_body(reference)))
    await run_pipeline(bot.worker, bot.start)

    assert bot.ran == [("check_store_hours", {"day": "Saturday"})]
    assert egma.bodies("tool") == []
    assert len(egma.bodies("hello")) == 1, "nothing mocked is a Flows function"
    [call] = exports.only.named("function_call")
    assert call.attributes["egma.tool.name"] == "check_store_hours"
    assert json.loads(call.attributes["egma.tool.arguments"]) == {"day": "Saturday"}
    assert json.loads(call.attributes["egma.tool.result"]) == {"hours": "9 to 5"}
