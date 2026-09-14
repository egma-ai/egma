"""Temporary CI probe: record waiting code paths without runtime payloads."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from egma_simulator.__main__ import _run
from egma_simulator.config import SimulatorConfig


def snapshot() -> dict:
    tasks = []
    live = []
    for task in asyncio.all_tasks():
        stack = []
        current = task.get_coro()
        for _ in range(40):
            frame = getattr(current, "cr_frame", getattr(current, "gi_frame", None))
            if frame is None:
                break
            code = frame.f_code
            stack.append({
                "file": Path(code.co_filename).name,
                "function": code.co_qualname,
                "line": frame.f_lineno,
            })
            if frame.f_globals.get("__name__") == "egma_simulator.live" and code.co_name == "conduct":
                values = frame.f_locals
                entry = {}
                for name in ("concluded", "end_requested", "agent_left", "faulted"):
                    event = values.get(name)
                    if isinstance(event, asyncio.Event):
                        entry[name] = event.is_set()
                target = values.get("conclusion_target")
                entry["conclusion_target"] = target if isinstance(target, int) else None
                evidence = values.get("evidence")
                entry["assistant_turns_finished"] = getattr(evidence, "assistant_turns_finished", None)
                service = values.get("live")
                entry["assistant_turn_open"] = getattr(getattr(service, "_assistant_turn", None), "open", None)
                live.append(entry)
            current = getattr(current, "cr_await", getattr(current, "gi_yieldfrom", None))
            if current is None:
                break
        tasks.append(stack)
    return {"live": live, "waiting_code_paths": tasks}


async def main() -> None:
    service = asyncio.create_task(_run(SimulatorConfig.from_env()))

    async def probe() -> None:
        await asyncio.sleep(90)
        destination = Path(os.environ["EGMA_E2E_RUNTIME_PROBE_FILE"])
        destination.parent.mkdir(parents=True, exist_ok=True)
        with open(destination, "w", encoding="utf-8", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
            json.dump(snapshot(), output, indent=2)

    pending_probe = asyncio.create_task(probe())
    try:
        await service
    finally:
        pending_probe.cancel()
        await asyncio.gather(pending_probe, return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
