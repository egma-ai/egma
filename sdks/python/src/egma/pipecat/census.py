"""Find a Pipecat worker's LLM services and the tools they can call.

The census sent with the hello is every tool the bot can call as the
pipeline is built: the standard tools advertised in each LLM context
(``FunctionSchema`` objects and direct functions), then any name
registered on an LLM service with ``register_function`` that no context
advertises. A tool whose handler Pipecat Flows made is marked
``"flows": true``, so egma can refuse a test that mocks it.

Pipecat Flows gives the LLM a node's functions when the node is entered,
after the pipeline starts, so the first census holds none of them. The
session learns them from the tool sets the pipeline carries later.
"""

from __future__ import annotations

import functools
import logging
from collections.abc import Iterator
from typing import Any

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.llm_service import LLMService

logger = logging.getLogger("egma")

FLOWS_MODULES = ("pipecat.flows", "pipecat_flows")
"""Where Pipecat Flows makes the handler of each node function
(``FlowManager._create_transition_func``): ``pipecat.flows`` inside
``pipecat-ai`` for every supported version, ``pipecat_flows`` in the retired
standalone package."""


def processors_in(worker: Any) -> Iterator[Any]:
    """Every processor in the worker's pipeline, nested pipelines included."""
    seen: set[int] = set()
    stack = [worker.pipeline]
    while stack:
        processor = stack.pop()
        if id(processor) in seen:
            continue
        seen.add(id(processor))
        yield processor
        try:
            children = list(processor.processors)
        except Exception:
            children = []
        stack.extend(reversed(children))


def llm_services_in(worker: Any) -> list[LLMService]:
    """The LLM services in the worker's pipeline, in pipeline order."""
    return [p for p in processors_in(worker) if isinstance(p, LLMService)]


def contexts_in(worker: Any) -> list[LLMContext]:
    """The distinct LLM contexts the pipeline's context aggregators hold."""
    found: list[LLMContext] = []
    for processor in processors_in(worker):
        try:
            context = getattr(processor, "context", None)
        except Exception:
            continue
        if isinstance(context, LLMContext) and all(
            context is not other for other in found
        ):
            found.append(context)
    return found


def _from_flows(module: str) -> bool:
    return any(
        module == package or module.startswith(f"{package}.")
        for package in FLOWS_MODULES
    )


def is_flows_handler(handler: Any) -> bool:
    """Whether a tool handler was made by Pipecat Flows.

    Looks through partials, bound methods, direct-function wrappers and
    ``functools.wraps`` decorators to the function underneath.
    """
    for _ in range(8):
        if handler is None:
            return False
        if _from_flows(getattr(handler, "__module__", None) or ""):
            return True
        if isinstance(handler, functools.partial):
            handler = handler.func
            continue
        inner = None
        for attribute in ("function", "__func__", "__wrapped__"):
            candidate = getattr(handler, attribute, None)
            if candidate is not None and candidate is not handler:
                inner = candidate
                break
        handler = inner
    return False


def tools_census(tools: Any) -> dict[str, dict[str, Any]]:
    """Census entries for a tool set: a ``ToolsSchema``, a list, or nothing.

    Reads what an ``LLMContext`` or an ``LLMSetToolsFrame`` carries. A tool
    whose handler Pipecat Flows made is marked ``"flows": true``.
    """
    if isinstance(tools, list):
        try:
            tools = ToolsSchema(standard_tools=tools)
        except Exception:
            return {}
    if not isinstance(tools, ToolsSchema):
        return {}
    flows_direct = {
        wrapper.name
        for wrapper in getattr(tools, "direct_functions", [])
        if is_flows_handler(getattr(wrapper, "function", None))
    }
    entries: dict[str, dict[str, Any]] = {}
    for schema in tools.standard_tools:
        name = getattr(schema, "name", None)
        if not isinstance(name, str) or not name or name in entries:
            continue
        entry: dict[str, Any] = {"name": name, "schema": _schema_of(schema)}
        if name in flows_direct or is_flows_handler(getattr(schema, "handler", None)):
            entry["flows"] = True
        entries[name] = entry
    return entries


def _registered(llm: LLMService) -> dict[str, Any]:
    """Names registered on the service, with their handlers.

    Reads the service's private registry. The built-in cancel tools and the
    catch-all handler are left out.
    """
    registry = getattr(llm, "_functions", None)
    if not isinstance(registry, dict):
        return {}
    builtin = getattr(llm, "_cancel_tool_names", set()) or set()
    return {
        name: getattr(item, "handler", None)
        for name, item in registry.items()
        if isinstance(name, str) and name not in builtin
    }


def census_of(worker: Any, llms: list[LLMService]) -> list[dict[str, Any]]:
    """The hello's census: ``{"name", "schema", "flows"?}`` for every tool."""
    registered: dict[str, Any] = {}
    for llm in llms:
        registered.update(_registered(llm))

    entries: dict[str, dict[str, Any]] = {}
    for context in contexts_in(worker):
        for name, entry in tools_census(context.tools).items():
            if name in entries:
                continue
            if is_flows_handler(registered.get(name)):
                entry["flows"] = True
            entries[name] = entry

    for name, handler in registered.items():
        if name in entries:
            continue
        entry: dict[str, Any] = {"name": name}
        if is_flows_handler(handler):
            entry["flows"] = True
        entries[name] = entry
    return list(entries.values())


def _schema_of(schema: FunctionSchema) -> dict[str, Any]:
    try:
        described = schema.to_default_dict()
    except Exception:
        logger.warning(
            "could not read the schema of tool %r, so its census entry "
            "carries the name alone",
            getattr(schema, "name", "?"),
            exc_info=True,
        )
        return {"name": getattr(schema, "name", "")}
    return described if isinstance(described, dict) else {"name": schema.name}
