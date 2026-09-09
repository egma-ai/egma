"""Provision one isolated Retell voice agent for the full-stack E2E."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import signal
import sys
import threading
import time
from typing import Any, MutableSequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


RETELL_API = "https://api.retellai.com"
DEFAULT_KEY_FILE = Path("/tmp/egma-simulation-e2e-retell-key")


def load_api_key(path: Path = DEFAULT_KEY_FILE) -> str:
    """Read the dedicated key without ever placing it in output or errors."""
    mode = path.stat().st_mode & 0o777
    if mode & 0o077:
        raise RuntimeError("the Retell E2E key file must be owner-only")
    key = path.read_text(encoding="utf-8").strip()
    if not key:
        raise RuntimeError("the Retell E2E key file is empty")
    return key


class RetellApi:
    def __init__(self, api_key: str, base_url: str = RETELL_API):
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")

    def request(
        self, method: str, path: str, body: dict[str, Any] | None = None,
        *, missing_ok: bool = False,
    ) -> dict[str, Any]:
        encoded = None if body is None else json.dumps(body).encode()
        request = Request(
            f"{self._base_url}{path}",
            data=encoded,
            method=method,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=30) as response:
                payload = response.read()
        except HTTPError as error:
            if missing_ok and error.code == 404:
                return {}
            raise RuntimeError(
                f"Retell {method} {path} failed with HTTP {error.code}"
            ) from None
        except (URLError, TimeoutError):
            raise RuntimeError(f"Retell {method} {path} was unavailable") from None
        if not payload:
            return {}
        decoded = json.loads(payload)
        if not isinstance(decoded, dict):
            raise RuntimeError(f"Retell {method} {path} returned a non-object")
        return decoded


@dataclass
class RetellFixture:
    agentId: str
    agentVersion: int
    llmId: str
    webhookCalls: MutableSequence[dict[str, Any]]
    providerMetadata: dict[str, Any]
    _api: RetellApi
    _agent_deleted: bool = False
    _llm_deleted: bool = False
    _closed: bool = False

    def cleanup(self) -> None:
        """Delete only resources this fixture created, agent before engine."""
        if self._closed:
            return
        if not self._agent_deleted:
            try:
                self._api.request(
                    "DELETE", f"/delete-agent/{self.agentId}", missing_ok=True
                )
                self._agent_deleted = True
            except RuntimeError as error:
                raise RuntimeError(str(error)) from None
        if not self._llm_deleted:
            try:
                self._api.request(
                    "DELETE", f"/delete-retell-llm/{self.llmId}", missing_ok=True
                )
                self._llm_deleted = True
            except RuntimeError as error:
                raise RuntimeError(str(error)) from None
        self._closed = self._agent_deleted and self._llm_deleted


def _custom_tool(
    *, name: str, description: str, url: str, auth_token: str,
    properties: dict[str, Any], required: list[str]
) -> dict[str, Any]:
    return {
        "type": "custom",
        "name": name,
        "description": description,
        "url": url,
        "method": "POST",
        "headers": {"Authorization": f"Bearer {auth_token}"},
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required,
        },
    }


def provision_retell_fixture(
    *, webhook_url: str, webhook_auth_token: str,
    webhook_calls: MutableSequence[dict[str, Any]] | None = None,
    api_key: str | None = None,
) -> RetellFixture:
    """Create and publish a dedicated voice agent and its dedicated LLM."""
    if not webhook_url.startswith("https://"):
        raise ValueError("the Retell fixture webhook must use https")
    if not webhook_auth_token:
        raise ValueError("the Retell fixture webhook auth token is required")
    api = RetellApi(api_key or load_api_key())
    calls: MutableSequence[dict[str, Any]] = (
        [] if webhook_calls is None else webhook_calls
    )
    suffix = f"{int(time.time())}-{time.time_ns() % 1_000_000}"
    llm_id: str | None = None
    agent_id: str | None = None
    try:
        llm = api.request("POST", "/create-retell-llm", {
            "model": "gpt-4.1-mini",
            "model_temperature": 0,
            "start_speaker": "user",
            "general_prompt": (
                "You are the Egma isolated E2E appointment agent. Ask for the requested day. "
                "Call check_availability exactly once. State the returned slot. When the caller "
                "accepts it, call record_request exactly once, confirm the recorded request, "
                "then call end_call. Never invent a tool result."
            ),
            "general_tools": [
                _custom_tool(
                    name="check_availability",
                    description="Return the available appointment for the requested day.",
                    url=f"{webhook_url.rstrip('/')}/check-availability",
                    auth_token=webhook_auth_token,
                    properties={"day": {"type": "string", "enum": ["Tuesday"]}},
                    required=["day"],
                ),
                _custom_tool(
                    name="record_request",
                    description="Record the caller's accepted appointment request.",
                    url=f"{webhook_url.rstrip('/')}/record-request",
                    auth_token=webhook_auth_token,
                    properties={
                        "day": {"type": "string", "enum": ["Tuesday"]},
                        "time": {
                            "type": "string",
                            "enum": ["9:40 AM", "11:20 AM"],
                        },
                    },
                    required=["day", "time"],
                ),
                {"type": "end_call", "name": "end_call", "description": "End the call after confirmation."},
            ],
        })
        llm_id = str(llm["llm_id"])
        agent = api.request("POST", "/create-agent", {
            "response_engine": {"type": "retell-llm", "llm_id": llm_id},
            "voice_id": "retell-Cimo",
            "agent_name": f"Egma CI fixture {suffix}",
            "version_description": "Ephemeral Egma simulation evidence E2E fixture",
            "opt_in_signed_url": True,
        })
        agent_id = str(agent["agent_id"])
        published = api.request("POST", f"/publish-agent/{agent_id}", {})
        version = int(published.get("version", agent.get("version", 0)))
        return RetellFixture(
            agentId=agent_id,
            agentVersion=version,
            llmId=llm_id,
            webhookCalls=calls,
            providerMetadata={
                "provider": "retell",
                "resourceKind": "ephemeral_voice_agent",
                "agentVersion": version,
                "toolNames": ["check_availability", "record_request", "end_call"],
            },
            _api=api,
        )
    except Exception:
        if agent_id is not None:
            try:
                api.request("DELETE", f"/delete-agent/{agent_id}")
            except RuntimeError:
                pass
        if llm_id is not None:
            try:
                api.request("DELETE", f"/delete-retell-llm/{llm_id}")
            except RuntimeError:
                pass
        raise


def _run_from_environment() -> None:
    """Provision for the TypeScript E2E and stay alive until it asks to clean up."""
    webhook_url = os.environ.get("SIMULATION_E2E_RETELL_WEBHOOK_URL", "")
    webhook_auth = os.environ.get("SIMULATION_E2E_RETELL_WEBHOOK_AUTH", "")
    ready_path = Path(os.environ.get("SIMULATION_E2E_RETELL_READY", ""))
    stop_path = Path(os.environ.get("SIMULATION_E2E_RETELL_STOP", ""))
    api_key = os.environ.get("SIMULATION_E2E_RETELL_API_KEY", "").strip()
    if not ready_path.name or not stop_path.name:
        raise RuntimeError("Retell fixture ready and stop paths are required")

    fixture = provision_retell_fixture(
        webhook_url=webhook_url,
        webhook_auth_token=webhook_auth,
        api_key=api_key or None,
    )
    stopping = threading.Event()

    def stop(_signal: int, _frame: object) -> None:
        stopping.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    ready_path.parent.mkdir(parents=True, exist_ok=True)
    ready_path.write_text(json.dumps({
        "agentId": fixture.agentId,
        "agentVersion": fixture.agentVersion,
        "providerMetadata": fixture.providerMetadata,
    }), encoding="utf-8")
    ready_path.chmod(0o600)
    try:
        while not stopping.wait(0.1):
            if stop_path.exists():
                break
    finally:
        last_failure: RuntimeError | None = None
        for attempt in range(3):
            try:
                fixture.cleanup()
                last_failure = None
                break
            except RuntimeError as error:
                last_failure = error
                if attempt < 2:
                    time.sleep(1)
        if last_failure is not None:
            raise last_failure


if __name__ == "__main__":
    try:
        _run_from_environment()
    except Exception as error:
        # RetellApi errors never carry request bodies or credentials.
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
