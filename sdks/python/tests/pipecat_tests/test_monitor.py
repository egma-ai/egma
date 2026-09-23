"""``egma.pipecat.monitor``: production is exported, confirmed simulations are not.

A client controls the start request's body, so an ``egma`` key alone never
silences Monitoring. Only a simulation egma confirmed live does: through
``simulation``'s accepted hello in the same process, or through monitor's
own confirmation request when ``simulation`` did not run.
"""

from __future__ import annotations

import pytest

pytest.importorskip("pipecat.frames.frames")

import asyncio

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

from egma.pipecat import monitor, simulation

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


async def test_production_without_egmas_key_is_exported_with_no_request_to_egma(
    exports, no_network, monkeypatch
):
    monkeypatch.setenv("EGMA_URL", "https://app.egma.ai")
    monkeypatch.setenv("EGMA_API_KEY", PROJECT_KEY)
    llm, worker = bot()

    await monitor(worker, DailyRunnerArguments(body={"tenant": "acme"}))
    await converse(worker, llm)

    assert no_network == []
    [root] = roots(exports)
    assert "egma.provider_reference" not in root.resource.attributes
    assert exports.built[0][0] == "https://app.egma.ai/v1/traces"
    assert exports.built[0][1] == PROJECT_KEY


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


async def test_monitor_alone_asks_egma_and_stays_silent_for_a_live_simulation(
    egma, exports
):
    llm, worker = bot()

    await monitor(worker, DailyRunnerArguments(body=simulation_body(CALENDAR)))
    await converse(worker, llm)

    assert egma.routes_asked() == ["confirm"]
    assert egma.bodies("confirm") == [{"provider_reference": CALENDAR}]
    assert roots(exports) == []
    assert exports.sinks == []


@pytest.mark.parametrize(
    "reachable",
    [pytest.param(True, id="egma says no"), pytest.param(False, id="egma down")],
)
async def test_an_unconfirmed_egma_key_is_production(egma, exports, reachable):
    if not reachable:
        await egma.stop()
    llm, worker = bot()

    await monitor(worker, DailyRunnerArguments(body=simulation_body(STALE)))
    await converse(worker, llm)

    if reachable:
        assert egma.routes_asked() == ["confirm"]
    [root] = roots(exports)
    assert "egma.provider_reference" not in root.resource.attributes


async def test_monitor_first_then_a_confirmed_simulation_keeps_one_record(
    egma, exports
):
    egma.live.discard(CALENDAR)
    llm, worker = bot()
    runner_args = DailyRunnerArguments(body=simulation_body(CALENDAR))

    await monitor(worker, runner_args)
    egma.live.add(CALENDAR)
    await simulation(worker, runner_args)
    await converse(worker, llm)

    assert egma.routes_asked() == ["confirm", "hello"]
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


async def test_monitor_twice_is_one_export(exports, monkeypatch):
    monkeypatch.setenv("EGMA_URL", "https://app.egma.ai")
    monkeypatch.setenv("EGMA_API_KEY", PROJECT_KEY)
    llm, worker = bot()

    await monitor(worker, DailyRunnerArguments(body={}))
    await monitor(worker, DailyRunnerArguments(body={}))
    await converse(worker, llm)

    assert len(exports.sinks) == 1
    assert len(roots(exports)) == 1


async def test_monitor_needs_its_settings(monkeypatch):
    monkeypatch.delenv("EGMA_API_KEY", raising=False)
    monkeypatch.setenv("EGMA_URL", "https://app.egma.ai")
    _, worker = bot()
    with pytest.raises(ValueError, match="EGMA_API_KEY"):
        await monitor(worker, DailyRunnerArguments(body={}))
