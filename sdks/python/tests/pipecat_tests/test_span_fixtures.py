"""The SDK's spans against the worked examples egma's ingestion is built on.

``packages/simulation-contract/fixtures/spans/agent-pov/pipecat-*.json``
are the exports egma's trace door is tested with. A conversation run
through a real pipeline must produce only span names, attributes, resource
attributes, parents and JSON encodings those examples use.
"""

from __future__ import annotations

import pytest

pytest.importorskip("pipecat.frames.frames")

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    LLMContextFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from support import (
    PROJECT_KEY,
    DailyRunnerArguments,
    ScriptedLLM,
    Step,
    egma,
    exports,
    fixture,
    run_pipeline,
    simulation_body,
    worker_for,
)

from egma.pipecat import monitor, simulation

CALENDAR = "sim_01K5TB2H8Y4P7QCWF9XKMD6RZP"


def _examples() -> list[dict[str, Any]]:
    for ancestor in Path(__file__).resolve().parents:
        folder = (
            ancestor / "packages" / "simulation-contract" / "fixtures" / "spans"
        ) / "agent-pov"
        found = sorted(folder.glob("pipecat-*.json")) if folder.is_dir() else []
        if found:
            return [json.loads(path.read_text(encoding="utf-8")) for path in found]
    pytest.fail("the pipecat span examples are not in this checkout")


def _value(attribute: dict[str, Any]) -> Any:
    return next(iter(attribute["value"].values()))


class Vocabulary:
    """What the examples use: names, attributes per name, resource keys."""

    def __init__(self, examples: list[dict[str, Any]]) -> None:
        self.attributes: dict[str, set[str]] = {}
        self.resource: set[str] = set()
        self.scope: set[str] = set()
        self.parents: dict[str, set[str]] = {}
        for example in examples:
            for resource_spans in example["resourceSpans"]:
                self.resource |= {
                    a["key"] for a in resource_spans["resource"]["attributes"]
                }
                for scope_spans in resource_spans["scopeSpans"]:
                    self.scope.add(scope_spans["scope"]["name"])
                    names = {s["spanId"]: s["name"] for s in scope_spans["spans"]}
                    for span in scope_spans["spans"]:
                        keys = {a["key"] for a in span.get("attributes", [])}
                        self.attributes.setdefault(span["name"], set()).update(keys)
                        parent = names.get(span.get("parentSpanId", ""), "")
                        self.parents.setdefault(span["name"], set()).add(parent)


@pytest.fixture(scope="module")
def vocabulary() -> Vocabulary:
    return Vocabulary(_examples())


def _conversation(worker: Any, llm: ScriptedLLM):
    async def drive() -> None:
        for frame in [
            VADUserStartedSpeakingFrame(),
            UserStartedSpeakingFrame(),
            TranscriptionFrame(text="Is Thursday open?", user_id="c", timestamp=""),
            VADUserStoppedSpeakingFrame(),
            UserStoppedSpeakingFrame(),
        ]:
            await worker.queue_frame(frame)
            await asyncio.sleep(0.01)
        await worker.queue_frame(LLMContextFrame(context=LLMContext()))
        await asyncio.wait_for(llm.done.wait(), 10)
        await worker.queue_frame(BotStartedSpeakingFrame())
        await asyncio.sleep(0.01)
        await worker.queue_frame(BotStoppedSpeakingFrame())
        await asyncio.sleep(0.2)

    return drive


def _bot() -> tuple[ScriptedLLM, Any]:
    async def charge_card(params: Any) -> None:
        raise RuntimeError("card processor timed out")

    llm = ScriptedLLM(
        [
            Step(
                text="Let me look.",
                calls=[
                    ("check_calendar", {"day": "2026-08-13"}),
                    ("charge_card", {"amount_cents": 1200}),
                ],
            ),
        ]
    )
    llm.register_function("charge_card", charge_card)
    return llm, worker_for([llm])


def _check(spans: list[Any], vocabulary: Vocabulary) -> None:
    by_id = {span.context.span_id: span for span in spans}
    for span in spans:
        assert span.name in vocabulary.attributes, span.name
        assert set(span.attributes) <= vocabulary.attributes[span.name], span.name
        assert span.instrumentation_scope.name in vocabulary.scope
        # OpenTelemetry's own resource attributes ride along on every export.
        ours = {
            key
            for key in span.resource.attributes
            if not key.startswith("telemetry.sdk.") and key != "service.instance.id"
        }
        assert ours <= vocabulary.resource
        parent = by_id.get(span.parent.span_id).name if span.parent else ""
        allowed = set(vocabulary.parents[span.name])
        if span.name == "function_call":
            # A call outside any turn in progress sits at the root.
            allowed.add("pipecat_session")
        assert parent in allowed, (span.name, parent)
    for call in (s for s in spans if s.name == "function_call"):
        arguments = call.attributes["egma.tool.arguments"]
        assert arguments == json.dumps(json.loads(arguments), separators=(",", ":"))


async def test_a_simulations_spans_use_only_the_examples_vocabulary(
    egma, exports, vocabulary
):
    llm, worker = _bot()

    await simulation(
        worker, DailyRunnerArguments(body=simulation_body(CALENDAR), session_id="s")
    )
    await run_pipeline(worker, _conversation(worker, llm))

    spans = exports.only.spans
    _check(spans, vocabulary)
    assert {span.name for span in spans} >= {
        "pipecat_session",
        "user_turn",
        "user_speaking",
        "agent_turn",
        "agent_speaking",
        "function_call",
    }
    calls = {
        s.attributes["egma.tool.name"]: s for s in spans if s.name == "function_call"
    }
    assert calls["check_calendar"].attributes["egma.tool.result"] == '{"slots":[]}'
    assert (
        "card processor timed out" in calls["charge_card"].attributes["egma.tool.error"]
    )
    assert calls["charge_card"].status.status_code.name == "ERROR"


async def test_a_production_export_names_no_simulation(
    exports, vocabulary, monkeypatch
):
    monkeypatch.setenv("EGMA_URL", "https://app.egma.ai")
    monkeypatch.setenv("EGMA_API_KEY", PROJECT_KEY)
    llm, worker = _bot()

    await monitor(worker, DailyRunnerArguments(body={}))
    await run_pipeline(worker, _conversation(worker, llm))

    spans = exports.only.spans
    _check(spans, vocabulary)
    assert all("egma.provider_reference" not in s.resource.attributes for s in spans)
