"""``egma.pipecat.monitor``: production is exported, reported simulations are not.

A client controls the start request's body, so an ``egma`` key alone never
silences Monitoring. Only ``simulation``'s accepted hello in the same process
does. A Pipecat bot has no name of its own, so each production export carries
the name from ``agent_name`` or ``EGMA_AGENT_NAME``. Monitoring never stops
the bot: without usable settings it warns once and exports nothing.
"""

from __future__ import annotations

import pytest

pytest.importorskip("pipecat.frames.frames")

import asyncio
import logging

from pipecat.frames.frames import LLMContextFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from support import (
    PROJECT_KEY,
    DailyRunnerArguments,
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

from egma.pipecat import monitor, simulation, verbs

CALENDAR = "sim_01K5TB2H8Y4P7QCWF9XKMD6RZP"
STALE = "sim_01K5TB2H8Y4P7QCWF9XKMD6RZZ"


def bot() -> tuple[ScriptedLLM, object]:
    llm = ScriptedLLM([Step(text="Hello.")])
    return llm, worker_for([llm])


async def converse(worker, llm) -> None:
    async def drive() -> None:
        await worker.queue_frame(LLMContextFrame(context=LLMContext()))
        await asyncio.wait_for(llm.done.wait(), 10)

    await run_pipeline(worker, drive)


def roots(exports) -> list:
    return [span for sink in exports.sinks for span in sink.named("pipecat_session")]


@pytest.fixture
def production_settings(monkeypatch) -> None:
    monkeypatch.setenv("EGMA_URL", "https://app.egma.ai")
    monkeypatch.setenv("EGMA_API_KEY", PROJECT_KEY)
    monkeypatch.delenv("EGMA_AGENT_NAME", raising=False)


@pytest.fixture
def fresh_warnings(monkeypatch) -> None:
    """Each warning is logged once per process; start this test with none."""
    monkeypatch.setattr(verbs, "_warned", set())


async def test_production_without_egmas_key_is_exported_with_no_request_to_egma(
    exports, no_network, production_settings
):
    llm, worker = bot()

    await monitor(worker, DailyRunnerArguments(body={"tenant": "acme"}))
    await converse(worker, llm)

    assert no_network == []
    [root] = roots(exports)
    assert "egma.provider_reference" not in root.resource.attributes
    assert "egma.agent_name" not in root.resource.attributes
    assert exports.built[0][0] == "https://app.egma.ai/v1/traces"
    assert exports.built[0][1] == PROJECT_KEY


async def test_production_carries_the_agent_name_from_egma_agent_name(
    exports, no_network, production_settings, monkeypatch
):
    monkeypatch.setenv("EGMA_AGENT_NAME", "  dental-pipecat-agent  ")
    llm, worker = bot()

    await monitor(worker, DailyRunnerArguments(body={}))
    await converse(worker, llm)

    [root] = roots(exports)
    assert root.resource.attributes["egma.agent_name"] == "dental-pipecat-agent"


async def test_the_agent_name_argument_wins_over_the_environment(
    exports, no_network, production_settings, monkeypatch
):
    monkeypatch.setenv("EGMA_AGENT_NAME", "from-the-environment")
    llm, worker = bot()

    await monitor(worker, DailyRunnerArguments(body={}), agent_name="front-desk")
    await converse(worker, llm)

    [root] = roots(exports)
    assert root.resource.attributes["egma.agent_name"] == "front-desk"


async def test_without_an_agent_name_monitor_warns_once_and_still_exports(
    exports, no_network, production_settings, fresh_warnings, caplog
):
    caplog.set_level(logging.WARNING, logger="egma")
    first_llm, first = bot()
    second_llm, second = bot()

    await monitor(first, DailyRunnerArguments(body={}))
    await monitor(second, DailyRunnerArguments(body={}))
    await converse(first, first_llm)
    await converse(second, second_llm)

    assert len(roots(exports)) == 2
    unnamed = [
        record for record in caplog.records if "EGMA_AGENT_NAME" in record.getMessage()
    ]
    assert len(unnamed) == 1


async def test_simulation_then_monitor_exports_the_confirmed_simulation_once(
    egma, exports
):
    llm, worker = bot()
    runner_args = DailyRunnerArguments(body=simulation_body(CALENDAR))

    await simulation(worker, runner_args)
    await monitor(worker, runner_args)
    await converse(worker, llm)

    assert egma.routes_asked() == ["hello"]
    [root] = roots(exports)
    assert root.resource.attributes["egma.provider_reference"] == CALENDAR


@pytest.mark.parametrize(
    "reference",
    [
        pytest.param(CALENDAR, id="a live simulation"),
        pytest.param(STALE, id="a stale one"),
    ],
)
async def test_an_egma_key_alone_is_production_and_asks_egma_nothing(
    egma, exports, reference
):
    llm, worker = bot()

    await monitor(worker, DailyRunnerArguments(body=simulation_body(reference)))
    await converse(worker, llm)

    assert egma.routes_asked() == []
    [root] = roots(exports)
    assert "egma.provider_reference" not in root.resource.attributes


async def test_monitor_first_then_a_confirmed_simulation_keeps_one_record(
    egma, exports
):
    llm, worker = bot()
    runner_args = DailyRunnerArguments(body=simulation_body(CALENDAR))

    await monitor(worker, runner_args)
    await simulation(worker, runner_args)
    await converse(worker, llm)

    assert egma.routes_asked() == ["hello"]
    [production, simulated] = exports.sinks
    assert production.spans == []
    [root] = simulated.named("pipecat_session")
    assert root.resource.attributes["egma.provider_reference"] == CALENDAR


async def test_a_stale_simulation_then_monitor_is_production_without_asking_again(
    egma, exports
):
    llm, worker = bot()
    runner_args = DailyRunnerArguments(body=simulation_body(STALE))

    await simulation(worker, runner_args)
    await monitor(worker, runner_args)
    await converse(worker, llm)

    assert egma.routes_asked() == ["hello"]
    [root] = roots(exports)
    assert "egma.provider_reference" not in root.resource.attributes


async def test_monitor_twice_is_one_export(exports, production_settings):
    llm, worker = bot()

    await monitor(worker, DailyRunnerArguments(body={}))
    await monitor(worker, DailyRunnerArguments(body={}))
    await converse(worker, llm)

    assert len(exports.sinks) == 1
    assert len(roots(exports)) == 1


@pytest.mark.parametrize(
    ("variable", "value"),
    [
        pytest.param("EGMA_API_KEY", None, id="no key"),
        pytest.param("EGMA_API_KEY", "not-a-key", id="a key of the wrong shape"),
        pytest.param("EGMA_URL", None, id="no url"),
    ],
)
async def test_monitor_without_usable_settings_warns_once_and_the_bot_runs(
    exports,
    no_network,
    production_settings,
    fresh_warnings,
    caplog,
    monkeypatch,
    variable,
    value,
):
    if value is None:
        monkeypatch.delenv(variable, raising=False)
    else:
        monkeypatch.setenv(variable, value)
    caplog.set_level(logging.WARNING, logger="egma")
    first_llm, first = bot()
    _, second = bot()

    await monitor(first, DailyRunnerArguments(body={}))
    await monitor(second, DailyRunnerArguments(body={}))
    await converse(first, first_llm)

    assert exports.sinks == []
    assert no_network == []
    off = [record for record in caplog.records if "is off" in record.getMessage()]
    assert len(off) == 1
    assert variable in off[0].getMessage()
