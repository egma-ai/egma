"""Answer a simulation's mocked tools from egma instead of their handlers.

Pipecat runs every tool call through ``LLMService._run_function_call``, a
private method, whatever registered the tool: ``register_function``, a
``FunctionSchema`` handler or a direct function in the LLM context, a
realtime model's tool, or a Pipecat Flows node. This module replaces that
method on each LLM service instance in the worker's pipeline. The
replacement checks each call's name:

- A name egma does not mock runs Pipecat's own runner, unchanged.
- A mocked name runs Pipecat's own runner with a courier standing in as
  the handler for this one call. The courier asks egma and hands the tagged
  answer back through Pipecat's result callback, so Pipecat broadcasts the
  call's frames, applies its timeout, and runs the LLM again exactly as it
  would for the real handler. The real handler is never called.

Pipecat resolves the handler from its registry at the start of the runner,
before its first ``await``. The courier's registry entry is put in place
just before, and the real entry is put back as soon as the courier runs, so
a registration Pipecat makes meanwhile is not overwritten.

A failed call reaches the model as ``{"error": "<sentence>"}``, where the
sentence is the mock tool author's, or says egma could not answer and the
real tool did not run. The observer records it as the call's error.
"""

from __future__ import annotations

import dataclasses
import logging
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from pipecat.services.llm_service import FunctionCallRegistryItem, LLMService

from .. import seam
from .census import is_flows_handler

logger = logging.getLogger("egma")

_HOOK = "_egma_run_function_call"
"""The attribute that marks an LLM service this module already hooked."""

_REAL_ENTRY = "_egma_real_entry"
"""Set on a courier: the registry entry it stands in for (or ``_ABSENT``)."""

_ABSENT = object()

Asker = Callable[[str, "dict[str, Any] | None", bool], Awaitable[seam.Served]]
"""Asks egma for one call: name, arguments (or None), whether it is Flows'."""

Failed = Callable[[str, str], None]
"""Told the tool call id and the message of every call that failed."""


def install(
    llm: LLMService, mocked: frozenset[str], ask: Asker, failed: Failed
) -> None:
    """Answer ``mocked`` names on this LLM service from egma.

    Installing twice replaces the mocked names and the asker; the service's
    own runner is wrapped once.
    """
    hooked = getattr(llm, _HOOK, None)
    if hooked is not None:
        hooked.mocked, hooked.ask, hooked.failed = mocked, ask, failed
        return
    hook = _Hook(llm, mocked, ask, failed)
    llm._run_function_call = hook.run_function_call  # type: ignore[method-assign]
    setattr(llm, _HOOK, hook)


def uninstall(llm: LLMService) -> None:
    """Give the service back its own runner."""
    hook = getattr(llm, _HOOK, None)
    if hook is None:
        return
    try:
        del llm._run_function_call
    except AttributeError:
        pass
    delattr(llm, _HOOK)


class _Hook:
    def __init__(
        self, llm: LLMService, mocked: frozenset[str], ask: Asker, failed: Failed
    ) -> None:
        self.llm = llm
        self.original = llm._run_function_call
        self.mocked = mocked
        self.ask = ask
        self.failed = failed

    async def run_function_call(self, runner_item: Any) -> Any:
        name = getattr(runner_item, "function_name", None)
        if not isinstance(name, str) or name not in self.mocked:
            return await self.original(runner_item)

        registry: dict[Any, Any] = self.llm._functions
        current = registry.get(name, _ABSENT)
        # A parallel call of the same name may have a courier in place; the
        # real entry is the one that courier stands in for.
        real = getattr(getattr(current, "handler", None), _REAL_ENTRY, current)
        flows = real is not _ABSENT and is_flows_handler(getattr(real, "handler", None))

        courier_entry: Any = None

        def restore() -> None:
            if registry.get(name, _ABSENT) is not courier_entry:
                return
            if real is _ABSENT:
                registry.pop(name, None)
            else:
                registry[name] = real

        async def courier(params: Any) -> None:
            restore()
            await self._answer(name, flows, params)

        setattr(courier, _REAL_ENTRY, real)
        courier_entry = (
            dataclasses.replace(real, handler=courier)
            if real is not _ABSENT and dataclasses.is_dataclass(real)
            else FunctionCallRegistryItem(
                function_name=name, handler=courier, cancel_on_interruption=True
            )
        )
        registry[name] = courier_entry
        try:
            return await self.original(runner_item)
        finally:
            restore()

    async def _answer(self, name: str, flows: bool, params: Any) -> None:
        arguments = params.arguments
        asked = dict(arguments) if isinstance(arguments, Mapping) else None
        try:
            served = await self.ask(name, asked, flows)
        except Exception as broke:
            served = seam.Served(
                failed=True,
                message=(
                    f'Egma could not answer the mocked tool "{name}": '
                    f"{type(broke).__name__}: {broke}. The real tool did not run."
                ),
            )
        if served.failed:
            self.failed(params.tool_call_id, served.message)
            await params.result_callback({"error": served.message})
            return
        await params.result_callback(served.value)
