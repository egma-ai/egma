"""Host local LiveKit and one packaged SDK worker for the full-stack E2E."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import signal
import subprocess
import sys
import tempfile
import threading

from google.protobuf.json_format import ParseDict
from livekit import api


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


def start_token_endpoint(
    *, public_server_file: Path, auth: str, agent_name: str, api_key: str,
    api_secret: str
) -> tuple[ThreadingHTTPServer, str]:
    """Serve only the authenticated token endpoint used by this fixture."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/livekit-token":
                self.send_error(404)
                return
            if self.headers.get("Authorization") != f"Bearer {auth}":
                self.send_error(401)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                asked = json.loads(self.rfile.read(length))
                room_name = asked["room_name"]
                identity = asked["participant_identity"]
                room_config = ParseDict(
                    asked.get("room_config", {
                        "agents": [{"agent_name": agent_name}],
                    }),
                    api.RoomConfiguration(),
                )
                token = (
                    api.AccessToken(api_key, api_secret)
                    .with_identity(identity)
                    .with_name(asked.get("participant_name", identity))
                    .with_grants(api.VideoGrants(room_join=True, room=room_name))
                    .with_room_config(room_config)
                    .to_jwt()
                )
                server_url = public_server_file.read_text(encoding="utf-8").strip()
                if not server_url.startswith("wss://"):
                    raise ValueError("public LiveKit URL is not ready")
                body = json.dumps({
                    "participant_token": token,
                    "server_url": server_url,
                }).encode()
            except Exception:
                self.send_error(503)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    endpoint = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=endpoint.serve_forever, daemon=True)
    thread.start()
    host, port = endpoint.server_address[:2]
    return endpoint, f"http://{host}:{port}/livekit-token"


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
    token_endpoint = None
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
            runtime_version = subprocess.check_output(
                [
                    str(python),
                    "-c",
                    "import importlib.metadata; print(importlib.metadata.version('livekit-agents'))",
                ],
                text=True,
            ).strip()
        elif language == "javascript":
            command, artifact = fixture.javascript_worker_environment(
                proof / "javascript-artifact"
            )
            worker_directory = Path(command[1]).parent
            runtime_version = json.loads(
                (worker_directory / "node_modules/@livekit/agents/package.json").read_text(
                    encoding="utf-8"
                )
            )["version"]
        else:
            raise RuntimeError(f"unsupported SIMULATION_E2E_LANGUAGE: {language}")
        agent_name = f"egma-{language}-full-stack-e2e"
        token_endpoint_url = None
        if os.environ.get("SIMULATION_E2E_TOKEN_ENDPOINT") == "1":
            token_endpoint, token_endpoint_url = start_token_endpoint(
                public_server_file=Path(required("SIMULATION_E2E_PUBLIC_LIVEKIT_FILE")),
                auth=required("SIMULATION_E2E_TOKEN_AUTH"),
                agent_name=agent_name,
                api_key=fixture.LIVEKIT_KEY,
                api_secret=fixture.LIVEKIT_SECRET,
            )
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
                "EGMA_E2E_NATIVE_HISTORY": str(proof / "native-history.json"),
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
                    "runtime": {"name": "livekit-agents", "version": runtime_version},
                    "localLivekitUrl": server.url,
                    "localTokenEndpoint": token_endpoint_url,
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
        if token_endpoint is not None:
            token_endpoint.shutdown()
            token_endpoint.server_close()
        server.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
