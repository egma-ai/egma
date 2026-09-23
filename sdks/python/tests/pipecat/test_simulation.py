"""``egma.pipecat.simulation`` in a real Pipecat pipeline.

The bot here is a small receptionist: a scripted LLM between Pipecat's own
context aggregators, with ``check_calendar`` registered through
``register_function`` and ``charge_card`` given as a ``FunctionSchema``
handler in the context. The test world mocks ``check_calendar`` (answered)
and ``cancel_booking`` (failed); ``charge_card`` is never mocked.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import (
    FunctionCallResultFrame,
    LLMConfigureOutputFrame,
    LLMMessagesAppendFrame,
    LLMTextFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
)
from support import (
    PROJECT_KEY,
    DailyRunnerArguments,
    Recording,
    RunnerArgs,
    ScriptedLLM,
    Step,
    egma,
    exports,
    fixture,
    no_network,
    run_pipeline,
    simulation_body,
    worker_for,
)

from egma import NotReported
from egma.pipecat import simulation

CALENDAR = "sim_01K5TB2H8Y4P7QCWF9XKMD6RZP"
"""The fixture's world that mocks check_calendar and cancel_booking."""


class Reception:
    """The bot: its pipeline, and what each real tool was asked."""

    def __init__(self, script: list[Step], **llm: Any) -> None:
        self.ran: dict[str, list[dict[str, Any]]] = {
            "check_calendar": [],
            "charge_card": [],
            "cancel_booking": [],
        }

        async def check_calendar(params: Any) -> None:
            self.ran["check_calendar"].append(dict(params.arguments))
            await params.result_callback({"really": "ran"})

        async def charge_card(params: Any) -> None:
            self.ran["charge_card"].append(dict(params.arguments))
            await params.result_callback({"charged": params.arguments["amount_cents"]})

        async def cancel_booking(params: Any) -> None:
            self.ran["cancel_booking"].append(dict(params.arguments))
            await params.result_callback({"cancelled": True})

        self.check_calendar = check_calendar
        self.context = LLMContext(
            messages=[{"role": "system", "content": "You are a receptionist."}],
            tools=ToolsSchema(
                standard_tools=[
                    FunctionSchema(
                        name="check_calendar",
                        description="Look up free slots on a day.",
                        properties={"day": {"type": "string"}},
                        required=["day"],
                    ),
                    FunctionSchema(
                        name="charge_card",
                        description="Charge the card on file.",
                        properties={"amount_cents": {"type": "integer"}},
                        required=["amount_cents"],
                        handler=charge_card,
                    ),
                    FunctionSchema(
                        name="cancel_booking",
                        description="Cancel a booking.",
                        properties={"booking": {"type": "string"}},
                        required=["booking"],
                        handler=cancel_booking,
                    ),
                ]
            ),
        )
        self.llm = ScriptedLLM(script, **llm)
        self.llm.register_function("check_calendar", check_calendar)
        pair = LLMContextAggregatorPair(self.context)
        self.results = Recording(FunctionCallResultFrame)
        self.top = Recording(LLMConfigureOutputFrame)
        self.text = Recording(LLMTextFrame)
        self.worker = worker_for(
            [self.top, pair.user(), self.llm, self.results, self.text, pair.assistant()]
        )

    async def say(self, text: str) -> None:
        """Send one user message the way RTVI send-text does, and wait."""
        await self.worker.queue_frame(
            LLMMessagesAppendFrame(
                messages=[{"role": "user", "content": text}], run_llm=True
            )
        )
        await asyncio.wait_for(self.llm.done.wait(), 10)
        # The last answer's frames reach the end of the pipeline.
        await asyncio.sleep(0.2)

    def result_of(self, name: str) -> list[Any]:
        return [f.result for f in self.results.frames if f.function_name == name]


def a_simulation(**extra: Any) -> DailyRunnerArguments:
    return DailyRunnerArguments(
        body=simulation_body(CALENDAR, **extra), session_id="s-1"
    )


# --- inert without the key ----------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({}, id="no body keys"),
        pytest.param(None, id="no body"),
        pytest.param({"tenant": "acme"}, id="the customer's own keys"),
        pytest.param({"egma": "sim_x"}, id="an egma key that is not an object"),
        pytest.param({"egma": {}}, id="no simulation id"),
        pytest.param({"egma": {"simulation_id": ""}}, id="an empty simulation id"),
        pytest.param(
            {"egma": {"simulation_id": 7}}, id="a simulation id that is not text"
        ),
    ],
)
async def test_without_egmas_key_nothing_happens_and_nothing_is_asked(
    body, no_network, exports, monkeypatch
):
    monkeypatch.delenv("EGMA_URL", raising=False)
    bot = Reception(
        [Step(calls=[("check_calendar", {"day": "Tuesday"})]), Step(text="Done.")]
    )
    observers_before = list(bot.worker._observer._observers)

    await simulation(bot.worker, RunnerArgs(body=body))

    assert "_run_function_call" not in vars(bot.llm)
    assert bot.worker._observer._observers == observers_before
    assert not hasattr(bot.worker, "_egma_pipecat_session")

    await run_pipeline(bot.worker, lambda: bot.say("Is Tuesday free?"))

    assert bot.ran["check_calendar"] == [{"day": "Tuesday"}]
    assert no_network == []
    assert exports.sinks == []


# --- the hello and the mocked tools -------------------------------------------


async def test_a_simulation_reports_its_tools_and_egma_answers_the_mocked_one(
    egma, exports
):
    bot = Reception(
        [
            Step(
                text="Let me check.",
                calls=[
                    ("check_calendar", {"day": "Tuesday"}),
                    ("charge_card", {"amount_cents": 1200}),
                ],
            ),
            Step(text="Tuesday is open."),
        ]
    )

    await simulation(bot.worker, a_simulation())
    await run_pipeline(bot.worker, lambda: bot.say("Is Tuesday free?"))

    [hello] = egma.bodies("hello")
    assert hello["provider_reference"] == CALENDAR
    assert hello["protocol_version"] == 1
    assert [tool["name"] for tool in hello["tools"]] == [
        "check_calendar",
        "charge_card",
        "cancel_booking",
    ]
    assert hello["tools"][0]["schema"]["parameters"]["properties"] == {
        "day": {"type": "string"}
    }
    assert not any("flows" in tool for tool in hello["tools"])
    assert egma.asked[0].authorization == f"Bearer {PROJECT_KEY}"

    # The mocked tool: egma answered, and its handler never ran.
    assert egma.bodies("tool") == [
        {
            "provider_reference": CALENDAR,
            "name": "check_calendar",
            "arguments": {"day": "Tuesday"},
        }
    ]
    assert bot.ran["check_calendar"] == []
    assert bot.result_of("check_calendar") == [{"slots": []}]

    # The unmocked tool ran for real.
    assert bot.ran["charge_card"] == [{"amount_cents": 1200}]
    assert bot.result_of("charge_card") == [{"charged": 1200}]

    # Both calls are on the record.
    calls = {
        span.attributes["egma.tool.name"]: span
        for span in exports.only.named("function_call")
    }
    assert json.loads(calls["check_calendar"].attributes["egma.tool.result"]) == {
        "slots": []
    }
    assert json.loads(calls["charge_card"].attributes["egma.tool.result"]) == {
        "charged": 1200
    }
    assert json.loads(calls["check_calendar"].attributes["egma.tool.arguments"]) == {
        "day": "Tuesday"
    }


async def test_the_real_registration_is_back_after_a_mocked_call(egma, exports):
    bot = Reception([Step(calls=[("check_calendar", {"day": "Monday"})]), Step()])

    await simulation(bot.worker, a_simulation())
    await run_pipeline(bot.worker, lambda: bot.say("Monday?"))

    assert bot.llm._functions["check_calendar"].handler is bot.check_calendar
    assert bot.ran["check_calendar"] == []


async def test_parallel_calls_to_one_mocked_tool_are_each_answered(egma, exports):
    bot = Reception(
        [
            Step(
                calls=[
                    ("check_calendar", {"day": "Monday"}),
                    ("check_calendar", {"day": "Friday"}),
                ]
            ),
            Step(text="Both are open."),
        ]
    )

    await simulation(bot.worker, a_simulation())
    await run_pipeline(bot.worker, lambda: bot.say("Monday or Friday?"))

    assert sorted(body["arguments"]["day"] for body in egma.bodies("tool")) == [
        "Friday",
        "Monday",
    ]
    assert bot.result_of("check_calendar") == [{"slots": []}, {"slots": []}]
    assert bot.ran["check_calendar"] == []
    assert bot.llm._functions["check_calendar"].handler is bot.check_calendar


async def test_a_forced_failure_reaches_the_model_and_the_record_as_an_error(
    egma, exports
):
    bot = Reception([Step(calls=[("cancel_booking", {"booking": "B-7"})]), Step()])

    await simulation(bot.worker, a_simulation())
    await run_pipeline(bot.worker, lambda: bot.say("Cancel B-7."))

    assert bot.ran["cancel_booking"] == []
    assert bot.result_of("cancel_booking") == [
        {"error": "the calendar service is unavailable"}
    ]
    [call] = exports.only.named("function_call")
    assert call.attributes["egma.tool.error"] == "the calendar service is unavailable"
    assert "egma.tool.result" not in call.attributes
    assert call.status.status_code.name == "ERROR"


async def test_egma_unreachable_mid_simulation_is_an_error_and_the_tool_never_runs(
    egma, exports
):
    bot = Reception(
        [Step(calls=[("check_calendar", {"day": "Tuesday"})]), Step(text="Sorry.")]
    )

    await simulation(bot.worker, a_simulation())
    await egma.stop()
    await run_pipeline(bot.worker, lambda: bot.say("Is Tuesday free?"))

    assert bot.ran["check_calendar"] == []
    [result] = bot.result_of("check_calendar")
    assert result["error"].startswith(
        'Egma could not answer the mocked tool "check_calendar": '
    )
    assert result["error"].endswith("The real tool did not run.")
    [call] = exports.only.named("function_call")
    assert call.attributes["egma.tool.error"] == result["error"]


# --- NotReported --------------------------------------------------------------


async def test_egma_unreachable_at_the_start_raises_not_reported(egma, exports):
    bot = Reception([])
    await egma.stop()

    with pytest.raises(NotReported) as refused:
        await simulation(bot.worker, a_simulation())

    message = str(refused.value)
    assert f"simulation {CALENDAR}" in message
    assert "did not report to Egma" in message
    assert "EGMA_URL and EGMA_API_KEY" in message
    assert "_run_function_call" not in vars(bot.llm)
    assert all(sink.batches == [] for sink in exports.sinks)


async def test_a_busy_egma_is_asked_again(egma, exports):
    egma.hello_statuses = [503, 429]
    bot = Reception([])

    await simulation(bot.worker, a_simulation())

    assert egma.routes_asked() == ["hello", "hello", "hello"]
    assert "_run_function_call" in vars(bot.llm)
    # The worker never runs here, so its session is ended by hand.
    await bot.worker._egma_pipecat_session.finish()
    assert "_run_function_call" not in vars(bot.llm)


async def test_a_refused_key_raises_not_reported_with_egmas_words(
    egma, exports, fixture, monkeypatch
):
    monkeypatch.setenv("EGMA_API_KEY", f"egma_sk_{'x' * 43}")
    bot = Reception([])

    with pytest.raises(NotReported) as refused:
        await simulation(bot.worker, a_simulation())

    assert "HTTP 401" in str(refused.value)
    assert fixture["exchanges"]["unauthenticated"]["response"]["message"] in str(
        refused.value
    )
    assert egma.routes_asked() == ["hello"]


async def test_a_flows_function_known_at_the_start_fails_the_start_in_egmas_words(
    egma, exports, fixture
):
    async def route_to_billing(params: Any) -> None:
        raise AssertionError("a mocked Flows function ran")

    # A handler made by Pipecat Flows, registered before the SDK line.
    route_to_billing.__module__ = "pipecat.flows.manager"
    bot = Reception([])
    bot.llm.register_function("route_to_billing", route_to_billing)
    reference = fixture["worlds"]["flows"]["simulation_id"]

    with pytest.raises(NotReported) as refused:
        await simulation(
            bot.worker, DailyRunnerArguments(body=simulation_body(reference))
        )

    assert (
        str(refused.value)
        == fixture["exchanges"]["hello_flows_mocked"]["response"]["message"]
    )
    [hello] = egma.bodies("hello")
    assert {"name": "route_to_billing", "flows": True} in hello["tools"]


async def test_mocked_tools_with_no_llm_in_the_pipeline_raise_not_reported(
    egma, exports
):
    worker = worker_for([Recording()])

    with pytest.raises(NotReported, match="no Pipecat LLM service"):
        await simulation(worker, a_simulation())


async def test_a_stale_simulation_runs_as_production(egma, exports, caplog):
    bot = Reception([Step(calls=[("check_calendar", {"day": "Tuesday"})]), Step()])
    stale = "sim_01K5TB2H8Y4P7QCWF9XKMD6RZZ"

    await simulation(bot.worker, DailyRunnerArguments(body=simulation_body(stale)))
    await run_pipeline(bot.worker, lambda: bot.say("Tuesday?"))

    assert egma.routes_asked() == ["hello"]
    assert bot.ran["check_calendar"] == [{"day": "Tuesday"}]
    assert all(sink.batches == [] for sink in exports.sinks)
    assert "not a live simulation" in caplog.text


def test_settings_are_required_for_a_simulation(monkeypatch):
    monkeypatch.delenv("EGMA_URL", raising=False)
    bot = Reception([])
    with pytest.raises(ValueError, match="EGMA_URL"):
        asyncio.run(simulation(bot.worker, a_simulation()))


async def test_a_worker_that_is_not_a_pipeline_worker_is_named(egma):
    with pytest.raises(TypeError, match="PipelineWorker"):
        await simulation(object(), a_simulation())


# --- chat ---------------------------------------------------------------------


async def test_a_confirmed_chat_simulation_turns_speech_off_first(egma, exports):
    bot = Reception([Step(text="Hello there.")])

    await simulation(bot.worker, a_simulation(modality="chat"))
    await run_pipeline(bot.worker, lambda: bot.say("Hi"))

    assert [frame.skip_tts for frame in bot.top.frames] == [True]
    assert bot.text.frames and all(frame.skip_tts for frame in bot.text.frames)


@pytest.mark.parametrize(
    "reference",
    [
        pytest.param("sim_01K5TB2H8Y4P7QCWF9XKMD6RZZ", id="egma says not a simulation"),
    ],
)
async def test_an_unconfirmed_chat_marker_leaves_speech_alone(egma, exports, reference):
    bot = Reception([Step(text="Hello there.")])

    await simulation(
        bot.worker,
        DailyRunnerArguments(body=simulation_body(reference, modality="chat")),
    )
    await run_pipeline(bot.worker, lambda: bot.say("Hi"))

    assert bot.top.frames == []
    assert not any(frame.skip_tts for frame in bot.text.frames)


async def test_a_voice_simulation_leaves_speech_alone(egma, exports):
    bot = Reception([Step(text="Hello there.")])

    await simulation(bot.worker, a_simulation(modality="voice"))
    await run_pipeline(bot.worker, lambda: bot.say("Hi"))

    assert bot.top.frames == []
