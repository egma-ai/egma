"""Host local LiveKit and one packaged SDK worker for the full-stack E2E."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading


ROOT = Path(__file__).resolve().parents[2]
LIVEKIT_FIXTURE = ROOT / "fixtures" / "livekit-e2e"


def load_livekit_fixture():
    spec = importlib.util.spec_from_file_location(
        "egma_livekit_e2e_run", LIVEKIT_FIXTURE / "run.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load the LiveKit fixture runner")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def main() -> int:
    fixture = load_livekit_fixture()
    proof = Path(
        os.environ.get(
            "SIMULATION_E2E_PROVIDER_DIR",
            tempfile.mkdtemp(prefix="egma-simulation-livekit-"),
        )
    )
    proof.mkdir(parents=True, exist_ok=True)
    server = fixture.start_livekit(proof)
    worker = None
    stopped = threading.Event()

    def stop(_signum=None, _frame=None):
        stopped.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        language = os.environ.get("SIMULATION_E2E_LANGUAGE", "python").strip()
        if language == "python":
            python, artifact = fixture.python_worker_environment(
                proof / "python-artifact"
            )
            command = [
                str(python),
                str(LIVEKIT_FIXTURE / "python_worker.py"),
                "start",
            ]
        elif language == "javascript":
            command, artifact = fixture.javascript_worker_environment(
                proof / "javascript-artifact"
            )
        else:
            raise RuntimeError(f"unsupported SIMULATION_E2E_LANGUAGE: {language}")
        agent_name = f"egma-{language}-full-stack-e2e"
        worker = fixture.start_process(
            f"{language} worker",
            command,
            proof / f"{language}-worker.log",
            env=os.environ
            | {
                "PYTHONUNBUFFERED": "1",
                "LIVEKIT_URL": server.url,
                "LIVEKIT_API_KEY": fixture.LIVEKIT_KEY,
                "LIVEKIT_API_SECRET": fixture.LIVEKIT_SECRET,
                "OPENAI_API_KEY": required("LIVEKIT_E2E_OPENAI_API_KEY"),
                "EGMA_URL": required("SIMULATION_E2E_API_ORIGIN"),
                "EGMA_API_KEY": required("SIMULATION_E2E_PROJECT_KEY"),
                "EGMA_E2E_AGENT_NAME": agent_name,
                "EGMA_E2E_SILENT_START": "1",
                "EGMA_E2E_LONG_LIVED_ENTRY": (
                    "1" if language == "javascript" else "0"
                ),
                "LOG_LEVEL": "info",
            },
            cwd=LIVEKIT_FIXTURE,
        )
        worker.wait_for_output(r"registered worker|worker registered|successfully registered")
        ready = Path(required("SIMULATION_E2E_PROVIDER_READY"))
        ready.write_text(
            json.dumps(
                {
                    "url": server.url,
                    "apiKey": fixture.LIVEKIT_KEY,
                    "apiSecret": fixture.LIVEKIT_SECRET,
                    "agentName": agent_name,
                    "language": language,
                    "artifact": {
                        "file": artifact.path.name,
                        "sha256": artifact.sha256,
                        "version": artifact.version,
                    },
                }
            ),
            encoding="utf-8",
        )
        ready.chmod(0o600)
        while not stopped.wait(0.2):
            worker.require_running()
    finally:
        if worker is not None:
            worker.stop()
        server.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
