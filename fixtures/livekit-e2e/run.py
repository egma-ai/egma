"""Run packaged LiveKit SDK workers through the shipped Egma simulator."""

from __future__ import annotations

import argparse
import atexit
import contextlib
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).resolve().parent
SIMULATOR_PYTHON = ROOT / "apps/simulator/.venv/bin/python"
LIVEKIT_KEY = "devkey"
LIVEKIT_SECRET = "secret"
PROJECT_KEY = "egma_sk_" + "a" * 43
START_SECONDS = 60
SIMULATION_SECONDS = 150
HELD_SECRETS: set[str] = set()
UPLOAD_SUFFIXES = (".log", "-proof-summary.json", "-agent-spans.jsonl")


def redacted(text: str) -> str:
    for secret in HELD_SECRETS:
        if secret:
            text = text.replace(secret, "[REDACTED]")
    return text


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def request_json(url: str, *, body: dict | None = None) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method="POST" if data else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as answer:
            raw = answer.read()
            return answer.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        message = error.read().decode(errors="replace")
        raise RuntimeError(f"{url} answered {error.code}: {message[:500]}") from error


def wait_http(url: str, process: ManagedProcess | None = None) -> None:
    deadline = time.monotonic() + START_SECONDS
    while time.monotonic() < deadline:
        if process is not None:
            process.require_running()
        try:
            with urllib.request.urlopen(url, timeout=1):
                return
        except (OSError, urllib.error.URLError):
            time.sleep(0.1)
    raise RuntimeError(f"nothing answered {url} within {START_SECONDS}s")


@dataclass
class ManagedProcess:
    label: str
    process: subprocess.Popen
    log_path: Path
    process_group: int

    def output(self) -> str:
        return self.log_path.read_text(encoding="utf-8", errors="replace")

    def require_running(self) -> None:
        code = self.process.poll()
        if code is not None:
            raise RuntimeError(
                f"{self.label} exited {code}\n--- {self.label} log ---\n"
                + redacted(self.output()[-8000:])
            )

    def wait_for_output(self, pattern: str) -> None:
        deadline = time.monotonic() + START_SECONDS
        while time.monotonic() < deadline:
            self.require_running()
            if re.search(pattern, self.output(), re.IGNORECASE):
                return
            time.sleep(0.1)
        raise RuntimeError(
            f"{self.label} did not report {pattern!r} within {START_SECONDS}s\n"
            + redacted(self.output()[-8000:])
        )

    def stop(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(self.process_group, signal.SIGTERM)
        if self.process.poll() is None:
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        with contextlib.suppress(ProcessLookupError):
            os.killpg(self.process_group, signal.SIGKILL)
        if self.process.poll() is None:
            self.process.wait(timeout=10)


def start_process(
    label: str,
    command: list[str],
    log_path: Path,
    *,
    env: dict[str, str],
    cwd: Path = ROOT,
) -> ManagedProcess:
    log = log_path.open("wb")
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    log.close()
    return ManagedProcess(label, process, log_path, os.getpgid(process.pid))


def checked(command: list[str], *, cwd: Path, log_path: Path) -> None:
    with log_path.open("wb") as log:
        completed = subprocess.run(
            command,
            cwd=cwd,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=600,
        )
    if completed.returncode:
        raise RuntimeError(
            f"{' '.join(command[:3])} exited {completed.returncode}\n"
            + redacted(log_path.read_text(encoding="utf-8", errors="replace")[-8000:])
        )


def pinned_livekit_image() -> str:
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    matched = re.search(
        r"^  livekit:\n(?:    .*\n)*?    image: ([^\s]+)",
        compose,
        re.MULTILINE,
    )
    if matched is None:
        raise RuntimeError("docker-compose.yml has no pinned livekit image")
    return matched.group(1)


@dataclass
class LiveKitServer:
    name: str
    url: str
    container_log: Path

    def stop(self) -> None:
        logs = subprocess.run(
            ["docker", "logs", "--tail", "500", self.name],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        self.container_log.write_text(logs.stdout + logs.stderr, encoding="utf-8")
        subprocess.run(
            ["docker", "rm", "--force", self.name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=30,
        )


def start_livekit(directory: Path) -> LiveKitServer:
    if shutil.which("docker") is None:
        raise RuntimeError("docker is required for the LiveKit end-to-end proof")
    http_port, tcp_port, udp_port = free_port(), free_port(), free_port()
    name = f"egma-livekit-e2e-{os.getpid()}-{http_port}"
    config = (
        f"port: {http_port}\n"
        "rtc:\n"
        f"  tcp_port: {tcp_port}\n"
        f"  udp_port: {udp_port}\n"
        "  use_external_ip: false\n"
        "  node_ip: 127.0.0.1\n"
    )
    completed = subprocess.run(
        [
            "docker",
            "run",
            "--detach",
            "--rm",
            "--name",
            name,
            "--publish",
            f"127.0.0.1:{http_port}:{http_port}",
            "--publish",
            f"127.0.0.1:{tcp_port}:{tcp_port}",
            "--publish",
            f"127.0.0.1:{udp_port}:{udp_port}/udp",
            "--env",
            f"LIVEKIT_CONFIG={config}",
            pinned_livekit_image(),
            "--dev",
            "--bind",
            "0.0.0.0",
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=300,
    )
    if completed.returncode:
        raise RuntimeError(f"docker could not start LiveKit: {completed.stderr[:500]}")
    server = LiveKitServer(
        name, f"ws://127.0.0.1:{http_port}", directory / "livekit.log"
    )
    try:
        wait_http(f"http://127.0.0.1:{http_port}")
    except Exception:
        logs = subprocess.run(
            ["docker", "logs", "--tail", "100", name],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        server.container_log.write_text(logs.stdout + logs.stderr, encoding="utf-8")
        server.stop()
        raise
    return server


@dataclass(frozen=True)
class SDKArtifact:
    path: Path
    version: str
    sha256: str


def python_worker_environment(directory: Path) -> tuple[Path, SDKArtifact]:
    directory.mkdir(parents=True)
    wheel_dir = directory / "python-wheel"
    venv = directory / "python-venv"
    wheel_dir.mkdir()
    offered = os.environ.get("LIVEKIT_E2E_PYTHON_WHEEL", "").strip()
    if offered:
        wheels = [Path(offered).resolve(strict=True)]
    else:
        checked(
            [
                "uv",
                "build",
                "sdks/python",
                "--wheel",
                "--out-dir",
                str(wheel_dir),
            ],
            cwd=ROOT,
            log_path=directory / "python-build.log",
        )
        wheels = list(wheel_dir.glob("*.whl"))
    if len(wheels) != 1:
        raise RuntimeError(f"expected one Python wheel, found {wheels}")
    checked(
        ["uv", "venv", "--python", "3.11", str(venv)],
        cwd=ROOT,
        log_path=directory / "python-venv.log",
    )
    checked(
        [
            "uv",
            "pip",
            "install",
            "--python",
            str(venv / "bin/python"),
            str(wheels[0]),
            "livekit-agents[openai,silero]==1.7.1",
        ],
        cwd=ROOT,
        log_path=directory / "python-install.log",
    )
    checked(
        [
            str(venv / "bin/python"),
            "-c",
            (
                "import egma,sys; from pathlib import Path; "
                "assert Path(egma.__file__).is_relative_to(Path(sys.prefix))"
            ),
        ],
        cwd=ROOT,
        log_path=directory / "python-package-check.log",
    )
    wheel = wheels[0]
    version = wheel.name.removeprefix("egma-").split("-", 1)[0]
    artifact = SDKArtifact(
        path=wheel,
        version=version,
        sha256=hashlib.sha256(wheel.read_bytes()).hexdigest(),
    )
    return venv / "bin/python", artifact


def javascript_worker_environment(directory: Path) -> tuple[list[str], SDKArtifact]:
    directory.mkdir(parents=True)
    pack_dir = directory / "javascript-pack"
    worker_dir = directory / "javascript-worker"
    pack_dir.mkdir(parents=True)
    worker_dir.mkdir()
    offered = os.environ.get("LIVEKIT_E2E_JAVASCRIPT_PACKAGE", "").strip()
    if offered:
        packages = [Path(offered).resolve(strict=True)]
    else:
        checked(
            ["pnpm", "--filter", "@egma/livekit", "build"],
            cwd=ROOT,
            log_path=directory / "javascript-build.log",
        )
        checked(
            [
                "pnpm",
                "--config.node-linker=hoisted",
                "--filter",
                "@egma/livekit",
                "pack",
                "--pack-destination",
                str(pack_dir),
            ],
            cwd=ROOT,
            log_path=directory / "javascript-pack.log",
        )
        packages = list(pack_dir.glob("*.tgz"))
    if len(packages) != 1:
        raise RuntimeError(f"expected one JavaScript package, found {packages}")
    package = packages[0]
    package_json = json.loads((FIXTURE / "package.json").read_text(encoding="utf-8"))
    package_json["dependencies"]["@egma/livekit"] = f"file:{package}"
    (worker_dir / "package.json").write_text(
        json.dumps(package_json, indent=2) + "\n", encoding="utf-8"
    )
    shutil.copy2(FIXTURE / "javascript_worker.mjs", worker_dir)
    checked(
        [
            "pnpm",
            "--dir",
            str(worker_dir),
            "--config.node-linker=hoisted",
            "--ignore-workspace",
            "install",
            "--frozen-lockfile=false",
        ],
        cwd=ROOT,
        log_path=directory / "javascript-install.log",
    )
    checked(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import('@egma/livekit').then(m => { "
                "if (typeof m.simulation !== 'function') process.exit(1) })"
            ),
        ],
        cwd=worker_dir,
        log_path=directory / "javascript-package-check.log",
    )
    version = package.name.removesuffix(".tgz").rsplit("-", 1)[-1]
    artifact = SDKArtifact(
        path=package,
        version=version,
        sha256=hashlib.sha256(package.read_bytes()).hexdigest(),
    )
    return ["node", str(worker_dir / "javascript_worker.mjs"), "start"], artifact


def direct_models(openai_key: str, modality: str) -> dict:
    models = {
        "llm": {
            "provider": "openai",
            "model": "gpt-4o-mini",
            "adapter": "openai_chat_completions",
            "key": openai_key,
        },
        "stt": {
            "provider": "openai",
            "model": "gpt-live-transcribe",
            "adapter": "openai_realtime",
        },
        "tts": {
            "provider": "openai",
            "model": "gpt-4o-mini-tts",
            "adapter": "openai",
            "voice_id": "alloy",
            "speed": 1.0,
        },
    }
    if modality == "voice":
        models["stt"]["key"] = openai_key
        models["tts"]["key"] = openai_key
    return models


def simulation_spec(
    *,
    simulation_id: str,
    agent_name: str,
    livekit_url: str,
    openai_key: str,
    modality: str,
    language: str,
) -> dict:
    return {
        "contract_version": 5,
        "simulation_id": simulation_id,
        "modality": modality,
        "connection": {
            "agent_platform": "livekit",
            "connection_type": "livekit_room",
            "access_variant": "livekit_room.project_credentials",
            "config": {"url": livekit_url, "agentName": agent_name},
            "credentials": {"apiKey": LIVEKIT_KEY, "apiSecret": LIVEKIT_SECRET},
        },
        "persona": {
            "name": "Robin",
            "personality": "Polite and concise. Follow the task exactly.",
            "language": "en-US",
        },
        "scenario": {
            "instructions": (
                "Ask if Tuesday has a dental appointment. If Tuesday is full, "
                "thank the receptionist and finish."
            )
        },
        "limits": {
            "max_duration_seconds": 120 if modality == "voice" else 90,
            "max_turns": 16 if modality == "voice" else 8,
        },
        "models": direct_models(openai_key, modality),
        "mock_tools": [
            {
                "tool_name": "check_availability",
                "answer": {
                    "answer": (
                        "Tuesday is completely full. The next opening is "
                        "Thursday morning."
                    )
                },
            }
        ],
        "job_dispatch_metadata": {"egma_e2e": f"{language}-{modality}-delayed"},
    }


def terminal_event(records: list[dict], simulation_id: str) -> dict | None:
    for record in records:
        if (
            record.get("kind") != "report"
            or record.get("simulation_id") != simulation_id
        ):
            continue
        event = record.get("event", {})
        if event.get("kind") == "status" and event.get("status") in {
            "completed",
            "failed",
            "cancelled",
        }:
            return event
    return None


def wait_for_terminal(
    workbench_url: str, simulation_id: str
) -> tuple[list[dict], dict]:
    deadline = time.monotonic() + SIMULATION_SECONDS
    records: list[dict] = []
    while time.monotonic() < deadline:
        _, body = request_json(f"{workbench_url}/workbench/records")
        records = body["records"]
        terminal = terminal_event(records, simulation_id)
        if terminal is not None:
            return records, terminal
        time.sleep(0.2)
    raise RuntimeError(
        f"simulation {simulation_id} did not finish within {SIMULATION_SECONDS}s; "
        f"last record kinds: {[record.get('kind') for record in records[-20:]]}"
    )


def wait_for_agent_spans(
    records_path: Path, provider_reference: str, required_names: set[str]
) -> list[dict]:
    deadline = time.monotonic() + 30
    records: list[dict] = []
    while time.monotonic() < deadline:
        if records_path.exists():
            records = [
                json.loads(line)
                for line in records_path.read_text(encoding="utf-8").splitlines()
                if line
            ]
        if (
            records
            and all(
                record.get("provider_reference") == provider_reference
                for record in records
            )
            and required_names.issubset({record.get("name") for record in records})
        ):
            return records
        time.sleep(0.1)
    observed_counts: dict[str, int] = {}
    for record in records:
        name = str(record.get("name", "<missing>"))
        observed_counts[name] = observed_counts.get(name, 0) + 1
    observed_names = set(observed_counts)
    missing_names = sorted(required_names - observed_names)
    mismatched_references = sum(
        record.get("provider_reference") != provider_reference for record in records
    )
    raise AssertionError(
        "the SDK did not send all required attributed OTLP spans within 30s; "
        f"missing names: {missing_names}; observed counts: {observed_counts}; "
        f"provider-reference mismatches: {mismatched_references}"
    )


def assert_no_secret_in_artifacts(directory: Path) -> None:
    for path in directory.rglob("*"):
        if not path.is_file() or path.name.endswith("-spec.json"):
            continue
        content = path.read_bytes()
        for secret in HELD_SECRETS:
            if secret and secret.encode() in content:
                raise AssertionError(f"a provider credential appeared in {path.name}")


def publish_sanitized_artifacts(directory: Path) -> None:
    upload = directory / "upload"
    for source in directory.rglob("*"):
        if upload in source.parents or not source.is_file():
            continue
        if not source.name.endswith(UPLOAD_SUFFIXES):
            continue
        target = upload / source.relative_to(directory)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            redacted(source.read_text(encoding="utf-8", errors="replace")),
            encoding="utf-8",
        )
    if upload.exists():
        for path in upload.rglob("*"):
            if not path.is_file():
                continue
            for secret in HELD_SECRETS:
                if secret and secret.encode() in path.read_bytes():
                    raise AssertionError(f"a provider credential appeared in {path}")


def span_attribute(span_record: dict, name: str) -> object:
    for attribute in span_record.get("span", {}).get("attributes", []):
        if attribute.get("key") != name:
            continue
        value = attribute.get("value", {})
        return next(iter(value.values()), None)
    return None


def decoded_tool_output(record: dict) -> object:
    output = record["attributes"].get("lk.pii.function_tool.output")
    if isinstance(output, str):
        with contextlib.suppress(json.JSONDecodeError):
            return json.loads(output)
    return output


def wait_for_file(path: Path, process: ManagedProcess) -> None:
    deadline = time.monotonic() + START_SECONDS
    while time.monotonic() < deadline:
        process.require_running()
        if path.exists():
            return
        time.sleep(0.1)
    raise AssertionError(f"{path.name} was not written within {START_SECONDS}s")


def run_production_inert_case(
    directory: Path,
    *,
    openai_key: str,
    python: Path,
    artifact: SDKArtifact,
) -> None:
    directory.mkdir(parents=True)
    livekit = start_livekit(directory)
    processes: list[ManagedProcess] = []
    try:
        otlp_port = free_port()
        otlp_url = f"http://127.0.0.1:{otlp_port}"
        otlp_records = directory / "production-agent-spans.jsonl"
        collector = start_process(
            "OTLP collector",
            [str(SIMULATOR_PYTHON), str(FIXTURE / "otlp_collector.py")],
            directory / "otlp-collector.log",
            env=os.environ
            | {
                "EGMA_E2E_OTLP_PORT": str(otlp_port),
                "EGMA_E2E_OTLP_RECORDS": str(otlp_records),
                "EGMA_E2E_AUTHORIZATION": f"Bearer {PROJECT_KEY}",
            },
            cwd=FIXTURE,
        )
        processes.append(collector)
        wait_http(f"{otlp_url}/health", collector)

        marker = directory / "production-simulation-returned"
        real_tool_sentinel = directory / "production-real-tool-called"
        agent_name = "egma-python-production-e2e"
        worker = start_process(
            "Python production worker",
            [str(python), str(FIXTURE / "python_worker.py"), "dev"],
            directory / "python-production-worker.log",
            env=os.environ
            | {
                "PYTHONUNBUFFERED": "1",
                "LIVEKIT_URL": livekit.url,
                "LIVEKIT_API_KEY": LIVEKIT_KEY,
                "LIVEKIT_API_SECRET": LIVEKIT_SECRET,
                "OPENAI_API_KEY": openai_key,
                "EGMA_URL": otlp_url,
                "EGMA_API_KEY": PROJECT_KEY,
                "EGMA_E2E_AGENT_NAME": agent_name,
                "EGMA_E2E_PRODUCTION_INERT_MARKER": str(marker),
                "EGMA_E2E_REAL_TOOL_SENTINEL": str(real_tool_sentinel),
            },
            cwd=FIXTURE,
        )
        processes.append(worker)
        worker.wait_for_output(
            r"registered worker|worker registered|successfully registered"
        )
        room_name = f"customer-production-{os.getpid()}-{free_port()}"
        checked(
            [
                str(python),
                str(FIXTURE / "livekit_control.py"),
                livekit.url,
                LIVEKIT_KEY,
                LIVEKIT_SECRET,
                room_name,
                agent_name,
            ],
            cwd=FIXTURE,
            log_path=directory / "livekit-control.log",
        )
        wait_for_file(marker, worker)
        time.sleep(1)
        if otlp_records.exists() and otlp_records.stat().st_size:
            raise AssertionError("an ordinary production room exported Egma spans")
        expected_real_answer = "The real calendar has a Tuesday appointment at 9:40."
        if marker.read_text(encoding="utf-8") != expected_real_answer:
            raise AssertionError(
                "the ordinary room did not receive the real tool result"
            )
        if (
            not real_tool_sentinel.exists()
            or real_tool_sentinel.read_text(encoding="utf-8") != "Tuesday"
        ):
            raise AssertionError("the ordinary room's original tool was not callable")
        summary = {
            "artifact": {
                "file": artifact.path.name,
                "sha256": artifact.sha256,
                "version": artifact.version,
            },
            "language": "python",
            "mode": "production_room_inert",
            "simulation_returned": True,
            "original_tool_call": True,
            "sdk_span_count": 0,
        }
        (directory / "python-production-proof-summary.json").write_text(
            json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        print("PASS ordinary production room remained outside Egma simulation")
    finally:
        for process in reversed(processes):
            process.stop()
        livekit.stop()
        assert_no_secret_in_artifacts(directory)


def run_workbench_case(
    directory: Path,
    *,
    openai_key: str,
    language: str,
    modality: str,
    worker_command: list[str],
    artifact: SDKArtifact,
    expect_startup_failure: bool,
) -> None:
    directory.mkdir(parents=True)
    nltk_data = directory.parent / "nltk-data"
    if modality == "voice" and not (nltk_data / "tokenizers/punkt_tab").exists():
        checked(
            [
                str(SIMULATOR_PYTHON),
                "-m",
                "nltk.downloader",
                "-d",
                str(nltk_data),
                "punkt_tab",
            ],
            cwd=ROOT,
            log_path=directory.parent / "nltk-download.log",
        )
    livekit = start_livekit(directory)
    processes: list[ManagedProcess] = []
    try:
        workbench_port = free_port()
        workbench_url = f"http://127.0.0.1:{workbench_port}"
        otlp_port = free_port()
        otlp_url = f"http://127.0.0.1:{otlp_port}"
        otlp_records = directory / f"{language}-{modality}-agent-spans.jsonl"
        agent_name = f"egma-{language}-{modality}-e2e"
        simulation_id = f"sim-livekit-{language}-{modality}-delayed"
        spec_path = directory / f"{language}-{modality}-spec.json"
        spec_path.write_text(
            json.dumps(
                simulation_spec(
                    simulation_id=simulation_id,
                    agent_name=agent_name,
                    livekit_url=livekit.url,
                    openai_key=openai_key,
                    modality=modality,
                    language=language,
                )
            ),
            encoding="utf-8",
        )
        spec_path.chmod(0o600)

        workbench = start_process(
            "workbench",
            [
                str(SIMULATOR_PYTHON),
                "-m",
                "egma_simulator.workbench",
                "--specs",
                str(spec_path),
                "--port",
                str(workbench_port),
                "--hold-seconds",
                "0.5",
            ],
            directory / "workbench.log",
            env=os.environ.copy(),
        )
        processes.append(workbench)
        wait_http(f"{workbench_url}/workbench/records", workbench)

        collector = start_process(
            "OTLP collector",
            [str(SIMULATOR_PYTHON), str(FIXTURE / "otlp_collector.py")],
            directory / "otlp-collector.log",
            env=os.environ
            | {
                "EGMA_E2E_OTLP_PORT": str(otlp_port),
                "EGMA_E2E_OTLP_RECORDS": str(otlp_records),
                "EGMA_E2E_AUTHORIZATION": f"Bearer {PROJECT_KEY}",
            },
            cwd=FIXTURE,
        )
        processes.append(collector)
        wait_http(f"{otlp_url}/health", collector)

        sentinel = directory / "real-tool-called"
        worker_env = os.environ | {
            "PYTHONUNBUFFERED": "1",
            "LIVEKIT_URL": livekit.url,
            "LIVEKIT_API_KEY": LIVEKIT_KEY,
            "LIVEKIT_API_SECRET": LIVEKIT_SECRET,
            "OPENAI_API_KEY": openai_key,
            "EGMA_URL": otlp_url,
            "EGMA_API_KEY": PROJECT_KEY,
            "EGMA_E2E_AGENT_NAME": agent_name,
            "EGMA_E2E_SETUP_DELAY_MS": "50",
            "EGMA_E2E_SESSION_DELAY_MS": "10000",
            "EGMA_E2E_SILENT_START": "1",
            # Match customer workers that keep their entry point alive until
            # AgentSession closes. Completion must not depend on entry return.
            "EGMA_E2E_LONG_LIVED_ENTRY": "1" if language == "javascript" else "0",
            "EGMA_E2E_REAL_TOOL_SENTINEL": str(sentinel),
        }
        worker = start_process(
            f"{language} worker",
            worker_command,
            directory / f"{language}-{modality}-worker.log",
            env=worker_env,
            cwd=FIXTURE,
        )
        processes.append(worker)
        worker.wait_for_output(
            r"registered worker|worker registered|successfully registered"
        )

        simulator_env = os.environ | {
            "PYTHONUNBUFFERED": "1",
            "EGMA_SIMULATOR_CONTROL_PLANE_URL": workbench_url,
            "EGMA_SIMULATOR_CLAIMANT": "livekit-e2e",
            "EGMA_SIMULATOR_CAPACITY": "1",
            "EGMA_SIMULATOR_HEARTBEAT_SECONDS": "0.2",
            "EGMA_SIMULATOR_CLAIM_WAIT_SECONDS": "0.5",
            "EGMA_SIMULATOR_WAL_DIR": str(directory / "wal"),
            "EGMA_SIMULATOR_BLOB_DIR": str(directory / "blobs"),
            "EGMA_SIMULATION_CONTRACT_DIR": str(ROOT / "packages/simulation-contract"),
            "EGMA_SIMULATOR_LOG_LEVEL": "INFO",
        }
        if modality == "voice":
            simulator_env["EGMA_SIMULATOR_VAD_PROVIDER"] = "silero"
            simulator_env["NLTK_DATA"] = str(nltk_data)
        simulator_source = os.environ.get("LIVEKIT_E2E_SIMULATOR_SOURCE", "").strip()
        if simulator_source:
            source_path = Path(simulator_source).resolve(strict=True)
            simulator_env["PYTHONPATH"] = str(source_path)
        simulator = start_process(
            "simulator",
            [str(SIMULATOR_PYTHON), "-m", "egma_simulator"],
            directory / "simulator.log",
            env=simulator_env,
        )
        processes.append(simulator)

        records, terminal = wait_for_terminal(workbench_url, simulation_id)
        if expect_startup_failure:
            if terminal.get("status") != "failed" or "no egma.hello" not in str(
                terminal.get("reason", "")
            ):
                raise AssertionError(
                    f"baseline did not reproduce startup race: {terminal}"
                )
            print(
                f"PASS {language} {modality} baseline reproduced delayed-hello "
                "startup failure"
            )
            return

        if terminal.get("status") != "completed":
            raise AssertionError(f"{language} {modality} did not complete: {terminal}")
        if terminal["facts"]["turn_count"] < 2:
            raise AssertionError(f"{language} {modality} had no exchange: {terminal}")
        if sentinel.exists():
            raise AssertionError("the mocked real tool implementation executed")

        simulator_spans = [
            record
            for record in records
            if record.get("kind") == "span"
            and record.get("simulation_id") == simulation_id
        ]
        turn_spans = [
            record
            for record in simulator_spans
            if record.get("span", {}).get("name") in {"human_turn", "agent_turn"}
        ]
        human_turns = [
            str(span_attribute(record, "egma.turn.text"))
            for record in turn_spans
            if record["span"]["name"] == "human_turn"
        ]
        agent_turns = [
            str(span_attribute(record, "egma.turn.text"))
            for record in turn_spans
            if record["span"]["name"] == "agent_turn"
        ]
        if not human_turns or "tuesday" not in human_turns[0].lower():
            raise AssertionError(f"first human input was not received: {human_turns}")
        if not agent_turns or not any(
            "thursday" in text.lower() for text in agent_turns
        ):
            raise AssertionError(f"agent did not use the mock answer: {agent_turns}")
        if modality == "chat" and turn_spans[0]["span"]["name"] != "human_turn":
            raise AssertionError("the silent-start worker spoke before the first input")
        if terminal["facts"]["turn_count"] != len(turn_spans):
            raise AssertionError("terminal turn count does not match the trace")

        provider_reference = terminal["facts"]["provider_reference"]
        caller_span_name = "agent_turn" if modality == "chat" else "user_turn"
        required_names = {
            "agent_session",
            "llm_request",
            "function_tool",
            caller_span_name,
        }
        agent_spans = wait_for_agent_spans(
            otlp_records, provider_reference, required_names
        )
        # The final customer evidence must arrive while the worker still owns
        # the job. A process exit is not a completion protocol.
        worker.require_running()
        caller_inputs = [
            record["attributes"].get(
                "lk.pii.user_input"
                if modality == "chat"
                else "lk.pii.user_transcript"
            )
            for record in agent_spans
            if record["name"] == caller_span_name
        ]
        if not any(
            isinstance(text, str) and "tuesday" in text.lower()
            for text in caller_inputs
        ):
            raise AssertionError(
                f"agent evidence omitted the caller input: {caller_inputs}"
            )
        tool_spans = [
            record for record in agent_spans if record["name"] == "function_tool"
        ]
        expected_output = (
            "Tuesday is completely full. The next opening is Thursday morning."
        )
        successful_mock_calls = [
            record
            for record in tool_spans
            if record["attributes"].get("lk.function_tool.name") == "check_availability"
            and decoded_tool_output(record) == expected_output
            and record["attributes"].get("lk.function_tool.is_error") is False
        ]
        if not successful_mock_calls or len(successful_mock_calls) != len(tool_spans):
            raise AssertionError(
                f"expected every tool span to use the configured mock: {tool_spans}"
            )
        names = {record["name"] for record in agent_spans}
        if not required_names.issubset(names):
            raise AssertionError(f"agent trace lacks {required_names - names}")

        summary = {
            "artifact": {
                "file": artifact.path.name,
                "sha256": artifact.sha256,
                "version": artifact.version,
            },
            "language": language,
            "modality": modality,
            "order": "simulator_first_direct_dispatch",
            "setup_delay_ms": 50,
            "session_delay_ms": 10000,
            "completed": True,
            "turn_count": terminal["facts"]["turn_count"],
            "mock_call": True,
            "mock_call_count": len(successful_mock_calls),
            "sdk_span_count": len(agent_spans),
            "worker_alive_after_final_evidence": True,
            "provider_reference": provider_reference,
        }
        (directory / f"{language}-{modality}-proof-summary.json").write_text(
            json.dumps(summary, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(
            f"PASS {language} {modality} completed through packaged SDK, "
            "LiveKit, and simulator"
        )
    finally:
        for process in reversed(processes):
            process.stop()
        livekit.stop()
        if spec_path.exists():
            spec_path.unlink()
        assert_no_secret_in_artifacts(directory)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--expect-startup-failure",
        action="store_true",
        help="prove the delayed-hello failure against the pre-fix simulator",
    )
    parser.add_argument(
        "--case",
        choices=(
            "all",
            "python-chat",
            "python-voice",
            "python-all",
            "javascript-chat",
            "javascript-voice",
            "javascript-all",
            "production-inert",
        ),
        default="all",
    )
    args = parser.parse_args()
    if args.expect_startup_failure and args.case not in {"all", "python-chat"}:
        parser.error("--expect-startup-failure only supports --case python-chat or all")
    openai_key = (
        os.environ.get("LIVEKIT_E2E_OPENAI_API_KEY", "").strip()
        or os.environ.get("OPENAI_API_KEY", "").strip()
    )
    if not openai_key:
        raise RuntimeError(
            "LIVEKIT_E2E_OPENAI_API_KEY is required; this lane cannot skip "
            "its real model proof"
        )
    if not SIMULATOR_PYTHON.exists():
        raise RuntimeError("run `uv sync --frozen` in apps/simulator before this lane")

    HELD_SECRETS.add(openai_key)
    artifact_root = Path(
        os.environ.get("LIVEKIT_E2E_ARTIFACT_DIR", ROOT / ".proofs/livekit-e2e")
    )
    artifact_root.mkdir(parents=True, exist_ok=True)
    directory = Path(
        tempfile.mkdtemp(prefix=time.strftime("%Y%m%d-%H%M%S-"), dir=artifact_root)
    )
    print(f"LiveKit E2E logs: {directory}")
    atexit.register(publish_sanitized_artifacts, directory)
    ran = 0
    if (
        args.case == "all"
        or args.case.startswith("python-")
        or args.case == "production-inert"
    ):
        python, python_artifact = python_worker_environment(
            directory / "python-artifact"
        )
        python_command = [str(python), str(FIXTURE / "python_worker.py"), "start"]
    if args.case == "all" or args.case.startswith("javascript-"):
        javascript_command, javascript_artifact = javascript_worker_environment(
            directory / "javascript-artifact"
        )

    if args.case in {"all", "python-all", "python-chat"}:
        run_workbench_case(
            directory / "python-chat",
            openai_key=openai_key,
            language="python",
            modality="chat",
            worker_command=python_command,
            artifact=python_artifact,
            expect_startup_failure=args.expect_startup_failure,
        )
        ran += 1
    if not args.expect_startup_failure and args.case in {
        "all",
        "python-all",
        "python-voice",
    }:
        run_workbench_case(
            directory / "python-voice",
            openai_key=openai_key,
            language="python",
            modality="voice",
            worker_command=python_command,
            artifact=python_artifact,
            expect_startup_failure=False,
        )
        ran += 1
    if not args.expect_startup_failure and args.case in {
        "all",
        "javascript-all",
        "javascript-chat",
    }:
        run_workbench_case(
            directory / "javascript-chat",
            openai_key=openai_key,
            language="javascript",
            modality="chat",
            worker_command=javascript_command,
            artifact=javascript_artifact,
            expect_startup_failure=False,
        )
        ran += 1
    if not args.expect_startup_failure and args.case in {
        "all",
        "javascript-all",
        "javascript-voice",
    }:
        run_workbench_case(
            directory / "javascript-voice",
            openai_key=openai_key,
            language="javascript",
            modality="voice",
            worker_command=javascript_command,
            artifact=javascript_artifact,
            expect_startup_failure=False,
        )
        ran += 1
    if not args.expect_startup_failure and args.case in {
        "all",
        "python-all",
        "production-inert",
    }:
        run_production_inert_case(
            directory / "production-inert",
            openai_key=openai_key,
            python=python,
            artifact=python_artifact,
        )
        ran += 1
    if ran == 0:
        raise AssertionError(f"the requested case did not run: {args.case}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
