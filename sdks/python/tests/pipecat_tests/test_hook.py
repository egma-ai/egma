"""The private parts of Pipecat the SDK relies on, checked on the installed version.

Mock tools replace ``LLMService._run_function_call`` on each LLM service.
That method is not public API, so these checks run on every supported
minor and fail before a changed Pipecat can run a mocked tool for real.
"""

from __future__ import annotations

import ast
import dataclasses
import inspect
import textwrap
from pathlib import Path

import pipecat
from pipecat.services.llm_service import (
    FunctionCallParams,
    FunctionCallRegistryItem,
    LLMService,
)

PIPECAT = Path(pipecat.__file__).parent

REALTIME_MODULES = [
    "services/openai/realtime/llm.py",
    "services/google/gemini_live/llm.py",
    "services/aws/nova_sonic/llm.py",
    "services/xai/realtime/llm.py",
    "services/inworld/realtime/llm.py",
    "services/ultravox/llm.py",
    "services/openai/live/llm.py",
]
"""Speech-to-speech services. Each must run tools through the same runner."""


def _source_of(function) -> ast.FunctionDef | ast.AsyncFunctionDef:
    tree = ast.parse(textwrap.dedent(inspect.getsource(function)))
    return tree.body[0]  # type: ignore[return-value]


def test_the_runner_the_sdk_replaces_is_where_it_was():
    runner = LLMService._run_function_call
    assert inspect.iscoroutinefunction(runner)
    assert list(inspect.signature(runner).parameters) == ["self", "runner_item"]


def test_every_tool_call_goes_through_that_runner():
    calling = ast.unparse(_source_of(LLMService.run_function_calls))
    assert "self._run_parallel_function_calls" in calling
    assert "self._run_sequential_function_calls" in calling
    for method in (
        LLMService._run_parallel_function_calls,
        LLMService._sequential_runner_handler,
    ):
        assert "self._run_function_call(" in ast.unparse(_source_of(method))


def test_no_service_in_this_pipecat_brings_its_own_runner():
    defining = sorted(
        str(path.relative_to(PIPECAT))
        for path in PIPECAT.rglob("*.py")
        if "def _run_function_call(" in path.read_text(encoding="utf-8")
    )
    assert defining == ["services/llm_service.py"]


def test_realtime_models_run_tools_through_the_same_runner():
    for module in REALTIME_MODULES:
        path = PIPECAT / module
        if not path.exists():
            continue
        source = path.read_text(encoding="utf-8")
        assert "self.run_function_calls(" in source, module
        assert "def run_function_calls(" not in source, module


def test_the_runner_resolves_the_handler_before_its_first_await():
    """The courier's registry entry is read in that synchronous prologue."""
    runner = _source_of(LLMService._run_function_call)
    first_await = min(
        node.lineno for node in ast.walk(runner) if isinstance(node, ast.Await)
    )
    lookups = [
        node.lineno
        for node in ast.walk(runner)
        if isinstance(node, ast.Subscript)
        and ast.unparse(node.value) == "self._functions"
    ]
    assert lookups and min(lookups) < first_await
    body = ast.unparse(runner)
    assert "item.handler(params)" in body or "item.handler.invoke(" in body


def test_the_registry_entry_and_call_parameters_keep_their_shape():
    assert dataclasses.is_dataclass(FunctionCallRegistryItem)
    fields = {field.name for field in dataclasses.fields(FunctionCallRegistryItem)}
    assert {"function_name", "handler", "cancel_on_interruption"} <= fields
    parameters = {field.name for field in dataclasses.fields(FunctionCallParams)}
    assert {
        "function_name",
        "tool_call_id",
        "arguments",
        "result_callback",
    } <= parameters


def test_flows_makes_its_handlers_where_the_sdk_looks_for_them():
    from pipecat.flows.manager import FlowManager

    assert FlowManager.__module__ == "pipecat.flows.manager"
    maker = _source_of(FlowManager._create_transition_func)
    assert any(
        isinstance(node, ast.AsyncFunctionDef) and node.name == "transition_func"
        for node in ast.walk(maker)
    )
