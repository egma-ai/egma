"""Shared rig for the simulator's suites.

The acceptance tests are black-box at the contract seam: the workbench
serves real HTTP on a loopback port, the simulator runs as a real child
process configured only through its environment, and every assertion reads
the workbench's records back over HTTP — nothing reaches into either
process. The rig here is exactly that wiring.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import subprocess
import sys
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

import aiohttp
import pytest
from aiohttp import web
from retell_stub import RetellStub, RunningStub, serving

from egma_simulator.contract import contract_dir
from egma_simulator.workbench.app import WorkbenchState, build_app

# Tuned far below the 5-second production default so a whole acceptance
# story fits in seconds; the behavior under test is the same loop.
HEARTBEAT_SECONDS = 0.2
CLAIM_HOLD_SECONDS = 0.5


@dataclass
class Workbench:
    """One running workbench and the addresses the suites need."""

    base_url: str
    state: WorkbenchState

    session: aiohttp.ClientSession

    async def offer(self, spec: dict) -> None:
        async with self.session.post(
            f"{self.base_url}/workbench/specs", json=spec
        ) as response:
            assert response.status == 204, await response.text()

    async def cancel(self, simulation_id: str) -> None:
        async with self.session.post(
            f"{self.base_url}/workbench/simulations/{simulation_id}/cancel"
        ) as response:
            assert response.status == 204, await response.text()

    async def records(self) -> list[dict]:
        async with self.session.get(
            f"{self.base_url}/workbench/records"
        ) as response:
            assert response.status == 200, await response.text()
            body = await response.json()
        return body["records"]

    async def wait_for(
        self,
        predicate: Callable[[list[dict]], bool],
        *,
        within_seconds: float = 30.0,
        interval: float = 0.05,
    ) -> list[dict]:
        """Poll the records until ``predicate`` holds; fail loudly if it never does."""
        deadline = asyncio.get_running_loop().time() + within_seconds
        records = await self.records()
        while not predicate(records):
            if asyncio.get_running_loop().time() > deadline:
                pytest.fail(
                    "records never satisfied the predicate; last records:\n"
                    + "\n".join(json.dumps(record) for record in records)
                )
            await asyncio.sleep(interval)
            records = await self.records()
        return records


async def _serve_workbench(state: WorkbenchState) -> AsyncIterator[Workbench]:
    runner = web.AppRunner(build_app(state))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    try:
        async with aiohttp.ClientSession() as session:
            yield Workbench(
                base_url=f"http://127.0.0.1:{port}", state=state, session=session
            )
    finally:
        await runner.cleanup()


@pytest.fixture
async def workbench() -> AsyncIterator[Workbench]:
    async for running in _serve_workbench(
        WorkbenchState(hold_seconds=CLAIM_HOLD_SECONDS)
    ):
        yield running


@pytest.fixture
async def over_granting_workbench() -> AsyncIterator[Workbench]:
    """A control plane that hands out more than the simulator asked for."""
    async for running in _serve_workbench(
        WorkbenchState(hold_seconds=CLAIM_HOLD_SECONDS, over_grant=3)
    ):
        yield running


@dataclass
class SimulatorProcess:
    """One simulator child process and the files catching its output."""

    process: subprocess.Popen
    stdout_path: Path
    stderr_path: Path
    wal_dir: Path
    extra_env: dict[str, str] = field(default_factory=dict)

    def output(self) -> str:
        return (
            self.stdout_path.read_text(errors="replace")
            + self.stderr_path.read_text(errors="replace")
        )

    def kill_hard(self) -> None:
        """SIGKILL: no goodbye, no cleanup — the crash the orphan sweep exists for."""
        self.process.send_signal(signal.SIGKILL)
        self.process.wait(timeout=10)

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)


@pytest.fixture
def start_simulator(
    tmp_path: Path,
) -> Callable[..., SimulatorProcess]:
    started: list[SimulatorProcess] = []

    def start(
        workbench: Workbench,
        *,
        capacity: int = 2,
        log_level: str = "INFO",
        claimant: str = "sim-under-test",
    ) -> SimulatorProcess:
        stdout_path = tmp_path / f"simulator-{len(started)}.out"
        stderr_path = tmp_path / f"simulator-{len(started)}.err"
        wal_dir = tmp_path / f"wal-{len(started)}"
        env = os.environ | {
            "EGMA_SIMULATOR_CONTROL_PLANE_URL": workbench.base_url,
            "EGMA_SIMULATOR_CLAIMANT": claimant,
            "EGMA_SIMULATOR_CAPACITY": str(capacity),
            "EGMA_SIMULATOR_HEARTBEAT_SECONDS": str(HEARTBEAT_SECONDS),
            "EGMA_SIMULATOR_CLAIM_WAIT_SECONDS": "2",
            "EGMA_SIMULATOR_WAL_DIR": str(wal_dir),
            "EGMA_SIMULATOR_LOG_LEVEL": log_level,
        }
        with open(stdout_path, "wb") as stdout, open(stderr_path, "wb") as stderr:
            process = subprocess.Popen(
                [sys.executable, "-m", "egma_simulator"],
                stdout=stdout,
                stderr=stderr,
                env=env,
            )
        simulator = SimulatorProcess(
            process=process,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            wal_dir=wal_dir,
        )
        started.append(simulator)
        return simulator

    yield start

    for simulator in started:
        simulator.stop()


@pytest.fixture
async def start_retell_stub() -> AsyncIterator[Callable[..., Awaitable[RunningStub]]]:
    """Start Retell-shaped stubs on loopback; each stops when the test ends.

    The keyword arguments are :class:`RetellStub`'s script — the key it
    honors, the greeting, the replies, whether the agent ends the exchange
    itself.
    """
    async with contextlib.AsyncExitStack() as stack:

        async def start(**script: object) -> RunningStub:
            return await stack.enter_async_context(serving(RetellStub(**script)))

        yield start


@pytest.fixture
def quick_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """Collapse delivery backoff so retry behavior can be tested in milliseconds.

    Only the waiting is shortened. The attempt sequence, the deadline
    arithmetic, and what is given up on are exactly the production ones.
    """
    from egma_simulator import reporting

    monkeypatch.setattr(reporting, "FIRST_BACKOFF_SECONDS", 0.001)
    monkeypatch.setattr(reporting, "MAX_BACKOFF_SECONDS", 0.005)


def load_fixture_spec(name: str) -> dict:
    with open(
        contract_dir() / "fixtures" / "spec" / "valid" / name, encoding="utf-8"
    ) as handle:
        return json.load(handle)


def scripted_spec(
    simulation_id: str,
    *,
    scenario: str = "State the first point. State the second point.",
    personality: str = "Terse test person; sticks to the script.",
    greeting: str | None = None,
    replies: list[str] | None = None,
    ends_after_replies: bool = False,
    turn_seconds: float = 0.0,
    provider_reference: str | None = None,
    max_turns: int = 60,
    max_duration_seconds: int = 600,
    credentials: dict | None = None,
) -> dict:
    """One spec against the scripted counterpart, the whole suite's staple.

    The persona's turns derive from ``scenario`` (sentence by sentence, then
    a concluding goodbye); the agent's from the plug config built here.
    """
    config: dict = {"turn_seconds": turn_seconds}
    if greeting is not None:
        config["greeting"] = greeting
    if replies is not None:
        config["replies"] = replies
    if ends_after_replies:
        config["ends_after_replies"] = True
    if provider_reference is not None:
        config["provider_reference"] = provider_reference
    return {
        "contract_version": 1,
        "simulation_id": simulation_id,
        "modality": "chat",
        "connection": {
            "type": "scripted",
            "config": config,
            "credentials": credentials,
        },
        "persona": {
            "traits": {"personality": personality, "language": "en-US"}
        },
        "scenario": {"instructions": scenario},
        "limits": {
            "max_duration_seconds": max_duration_seconds,
            "max_turns": max_turns,
        },
    }


def retell_spec(
    simulation_id: str,
    *,
    base_url: str,
    api_key: str,
    agent_id: str = "agent_stubbed_0001",
    scenario: str = "State the first point. State the second point.",
    personality: str = "Terse test person; sticks to the script.",
    max_turns: int = 60,
    max_duration_seconds: int = 600,
) -> dict:
    """One spec against a Retell chat connection, pointed wherever asked.

    The connection block is exactly what the control plane stores for a
    ``retell`` connection — the agent id in the config, the key in the
    credentials — plus the base URL, which is what lets the exchange land on
    a Retell-shaped stub instead of the platform itself.
    """
    return {
        "contract_version": 1,
        "simulation_id": simulation_id,
        "modality": "chat",
        "connection": {
            "type": "retell",
            "config": {"retellAgentId": agent_id, "baseUrl": base_url},
            "credentials": {"apiKey": api_key},
        },
        "persona": {"traits": {"personality": personality, "language": "en-US"}},
        "scenario": {"instructions": scenario},
        "limits": {
            "max_duration_seconds": max_duration_seconds,
            "max_turns": max_turns,
        },
    }


# -- Record readers: the acceptance suite's entire vocabulary -----------------


def events_for(records: list[dict], simulation_id: str, kind: str) -> list[dict]:
    return [
        record["event"]
        for record in records
        if record["kind"] == "report"
        and record["simulation_id"] == simulation_id
        and record["event"]["kind"] == kind
    ]


def status_events_for(records: list[dict], simulation_id: str) -> list[str]:
    return [event["status"] for event in events_for(records, simulation_id, "status")]


def terminal_event_for(records: list[dict], simulation_id: str) -> dict | None:
    for event in events_for(records, simulation_id, "status"):
        if event["status"] in ("completed", "failed", "canceled"):
            return event
    return None


def heartbeats_for(records: list[dict], simulation_id: str) -> list[dict]:
    return [
        record
        for record in records
        if record["kind"] == "heartbeat" and record["simulation_id"] == simulation_id
    ]


def has_terminal(simulation_id: str) -> Callable[[list[dict]], bool]:
    def check(records: list[dict]) -> bool:
        return terminal_event_for(records, simulation_id) is not None

    return check


def all_terminal(simulation_ids: list[str]) -> Callable[[list[dict]], bool]:
    def check(records: list[dict]) -> bool:
        return all(
            terminal_event_for(records, simulation_id) is not None
            for simulation_id in simulation_ids
        )

    return check
