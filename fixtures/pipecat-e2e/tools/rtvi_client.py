"""An RTVI client for the e2e bot: start a session, join its Daily room, speak RTVI.

It does what Egma's persona does at the transport level, with every event
timed, so a proof can read what a client sees:

    # Start on Pipecat Cloud (key from EGMA_PIPECAT_PUBLIC_KEY), join, greet.
    uv run tools/rtvi_client.py pcc --agent egma-e2e \
        --body '{"egma": {"simulation_id": "sim_test"}}'

    # Start through a start URL (Pipecat's development runner), then chat.
    uv run tools/rtvi_client.py url --start-url http://localhost:7860/start \
        --say "When are you open on Saturday?" --no-audio-response

    # Only send the start request and print the answer's shape.
    uv run tools/rtvi_client.py pcc --agent egma-e2e --no-join

Tokens never reach the output: `dailyToken` prints as its length, a short
SHA-256 prefix and its decoded (unsigned) claims.
"""

from __future__ import annotations

import argparse
import array
import base64
import hashlib
import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from daily import CallClient, Daily, EventHandler

PCC_START = "https://api.pipecat.daily.co/v1/public/{agent}/start"
RTVI_VERSION = "2.1.0"
AUDIO_RMS_THRESHOLD = 250.0
AUDIO_GAP_S = 0.4
TURN_QUIET_S = 2.5


def token_facts(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    facts: dict[str, Any] = {
        "redacted": True,
        "length": len(token),
        "sha256_8": hashlib.sha256(token.encode()).hexdigest()[:8],
    }
    parts = token.split(".")
    if len(parts) == 3:
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        try:
            facts["claims"] = json.loads(base64.urlsafe_b64decode(padded))
        except ValueError:
            facts["claims"] = "undecodable"
    return facts


def redact(answer: Any) -> Any:
    if isinstance(answer, dict):
        return {
            key: token_facts(value) if key in {"dailyToken", "token"} else redact(value)
            for key, value in answer.items()
        }
    if isinstance(answer, list):
        return [redact(item) for item in answer]
    return answer


def post_start(url: str, payload: dict, headers: dict[str, str], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json", **headers},
        method="POST",
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status, raw = response.status, response.read()
            response_headers = dict(response.headers)
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
        response_headers = dict(error.headers)
    elapsed = time.monotonic() - started
    try:
        body: Any = json.loads(raw)
    except ValueError:
        body = raw.decode(errors="replace")[:2000]
    return {
        "status": status,
        "elapsed_s": round(elapsed, 3),
        "content_type": response_headers.get("Content-Type")
        or response_headers.get("content-type"),
        "body": body,
    }


class Recorder:
    """Timestamps every event relative to the start request and writes JSONL."""

    def __init__(self, out: Path | None, quiet: bool) -> None:
        self.t0 = time.monotonic()
        self.lock = threading.Lock()
        self.events: list[dict[str, Any]] = []
        self.out = out.open("w") if out else None
        self.quiet = quiet

    def now(self) -> float:
        return round(time.monotonic() - self.t0, 3)

    def log(self, kind: str, **data: Any) -> dict[str, Any]:
        event = {"t": self.now(), "kind": kind, **data}
        with self.lock:
            self.events.append(event)
            if self.out:
                self.out.write(json.dumps(event, default=str) + "\n")
                self.out.flush()
        if not self.quiet:
            print(json.dumps(event, default=str)[:400], flush=True)
        return event


class Client(EventHandler):
    def __init__(self, recorder: Recorder) -> None:
        super().__init__()
        self.rec = recorder
        self.call: CallClient | None = None
        self.local_id: str | None = None
        self.bot_id: str | None = None
        self.bot_joined = threading.Event()
        self.bot_track = threading.Event()
        self.bot_ready = threading.Event()
        self.bot_left = threading.Event()
        self.mic_state: str | None = None
        self.last_rtvi = 0.0
        self.audio_active = False
        self.audio_started = 0.0
        self.audio_last_loud = 0.0
        self.audio_peak = 0.0
        self.audio_segments: list[dict[str, float]] = []

    # Daily callbacks run on Daily's own thread.

    def on_call_state_updated(self, state):
        self.rec.log("call-state", state=state)

    def on_error(self, message):
        self.rec.log("daily-error", message=message)

    def on_participant_joined(self, participant):
        info = participant.get("info", {})
        self.rec.log(
            "participant-joined",
            id=participant.get("id"),
            user_name=info.get("userName"),
            is_owner=info.get("isOwner"),
        )
        if not info.get("isLocal") and self.bot_id is None:
            self.bot_id = participant.get("id")
            self.bot_joined.set()
            self._watch_audio()
            self._note_mic(participant)

    def on_participant_updated(self, participant):
        if participant.get("id") == self.bot_id:
            self._note_mic(participant)

    def on_participant_left(self, participant, reason):
        self.rec.log("participant-left", id=participant.get("id"), reason=reason)
        if participant.get("id") == self.bot_id:
            self.bot_left.set()

    def on_app_message(self, message, sender):
        self.last_rtvi = time.monotonic()
        if isinstance(message, dict) and message.get("label") == "rtvi-ai":
            self.rec.log(
                "rtvi",
                type=message.get("type"),
                id=message.get("id"),
                data=message.get("data"),
            )
            if message.get("type") == "bot-ready":
                self.bot_ready.set()
        else:
            self.rec.log("app-message", message=message, sender=sender)

    def _note_mic(self, participant) -> None:
        state = participant.get("media", {}).get("microphone", {}).get("state")
        if state != self.mic_state:
            self.mic_state = state
            self.rec.log("bot-microphone", state=state)
            if state == "playable":
                self.bot_track.set()

    def _watch_audio(self) -> None:
        assert self.call is not None and self.bot_id is not None
        self.call.update_subscriptions(
            participant_settings={self.bot_id: {"media": {"microphone": "subscribed"}}}
        )
        self.call.set_audio_renderer(
            self.bot_id, self._on_audio, audio_source="microphone", sample_rate=16000
        )

    def _on_audio(self, participant_id, audio_data, audio_source):
        samples = array.array("h", audio_data.audio_frames)
        if not samples:
            return
        rms = math.sqrt(sum(s * s for s in samples) / len(samples))
        now = time.monotonic()
        if rms >= AUDIO_RMS_THRESHOLD:
            if not self.audio_active:
                self.audio_active = True
                self.audio_started = now
                self.audio_peak = 0.0
                self.rec.log("bot-audio-start", rms=round(rms))
            self.audio_last_loud = now
            self.audio_peak = max(self.audio_peak, rms)
        elif self.audio_active and now - self.audio_last_loud > AUDIO_GAP_S:
            self.audio_active = False
            duration = round(self.audio_last_loud - self.audio_started, 2)
            self.audio_segments.append(
                {
                    "start": round(self.audio_started - self.rec.t0, 3),
                    "end": round(self.audio_last_loud - self.rec.t0, 3),
                }
            )
            self.rec.log("bot-audio-end", duration_s=duration, peak_rms=round(self.audio_peak))

    # Sending.

    def send_rtvi(self, message_type: str, data: dict | None) -> str:
        assert self.call is not None
        message_id = str(uuid.uuid4())[:8]
        message = {"label": "rtvi-ai", "type": message_type, "id": message_id}
        if data is not None:
            message["data"] = data
        self.call.send_app_message(message)
        self.rec.log("sent", type=message_type, id=message_id, data=data)
        return message_id


def wait_turn_over(client: Client, rec: Recorder, since: float, limit: float) -> dict[str, Any]:
    """Wait until the turn is over, then for RTVI and the bot's audio to go quiet.

    Over: a `bot-llm-stopped` came after the last `llm-function-call-stopped`,
    and every `llm-function-call-started` has its `llm-function-call-stopped`.
    A tool result that starts no new completion ends the turn after the quiet
    time alone. Events are compared by arrival order, not by time.
    """
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        time.sleep(0.2)
        events = [e for e in rec.events if e["t"] >= since and e["kind"] == "rtvi"]
        order = {id(e): i for i, e in enumerate(events)}
        started = [e for e in events if e["type"] == "llm-function-call-started"]
        stopped = [e for e in events if e["type"] == "llm-function-call-stopped"]
        llm_stops = [e for e in events if e["type"] == "bot-llm-stopped"]
        quiet = time.monotonic() - max(client.last_rtvi, client.audio_last_loud)
        if len(started) > len(stopped) or quiet < TURN_QUIET_S or client.audio_active:
            continue
        answered = llm_stops and (not stopped or order[id(llm_stops[-1])] > order[id(stopped[-1])])
        if answered:
            return {"over": True, "at": llm_stops[-1]["t"], "by": "model stopped"}
        if stopped:
            return {"over": True, "at": stopped[-1]["t"], "by": "quiet after a tool result"}
    return {"over": False, "at": None, "by": None}


def summarize_turn(rec: Recorder, client: Client, since: float, until: float) -> dict[str, Any]:
    window = [e for e in rec.events if since <= e["t"] <= until]
    rtvi = [e for e in window if e["kind"] == "rtvi"]
    llm_text = "".join(
        e["data"].get("text", "") for e in rtvi if e["type"] == "bot-llm-text" and e.get("data")
    )
    tts_text = " ".join(
        e["data"].get("text", "") for e in rtvi if e["type"] == "bot-tts-text" and e.get("data")
    )
    output: list[dict[str, Any]] = []
    for e in rtvi:
        data = e.get("data") or {}
        if e["type"] == "bot-output" and data.get("spoken_status") in {None, "new"}:
            output.append(
                {
                    "t": e["t"],
                    "text": data.get("text"),
                    "aggregated_by": data.get("aggregated_by"),
                    "will_be_spoken": data.get("will_be_spoken"),
                }
            )
    segments = [s for s in client.audio_segments if since <= s["start"] <= until]
    return {
        "types_seen": sorted({e["type"] for e in rtvi}),
        "llm_text": llm_text,
        "tts_text": tts_text,
        "bot_output": output,
        "bot_transcription": [
            e["data"].get("text")
            for e in rtvi
            if e["type"] == "bot-transcription" and e.get("data")
        ],
        "function_events": [
            {"t": e["t"], "type": e["type"], "data": e.get("data")}
            for e in rtvi
            if e["type"].startswith("llm-function-call")
        ],
        "llm_started": [e["t"] for e in rtvi if e["type"] == "bot-llm-started"],
        "llm_stopped": [e["t"] for e in rtvi if e["type"] == "bot-llm-stopped"],
        "tts_started": [e["t"] for e in rtvi if e["type"] == "bot-tts-started"],
        "bot_started_speaking": [e["t"] for e in rtvi if e["type"] == "bot-started-speaking"],
        "audio_segments": segments,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("mode", choices=["pcc", "url", "join"])
    parser.add_argument("--agent", default="egma-e2e", help="Pipecat Cloud agent name")
    parser.add_argument("--key-env", default="EGMA_PIPECAT_PUBLIC_KEY")
    parser.add_argument("--start-url", help="start URL for mode url")
    parser.add_argument("--header", action="append", default=[], help="'Name: value' (url mode)")
    parser.add_argument("--body", default="{}", help="JSON for the start request's body field")
    parser.add_argument("--exp-seconds", type=int, default=600)
    parser.add_argument("--no-transport", action="store_true", help="omit transport: daily")
    parser.add_argument("--room", help="room URL for mode join")
    parser.add_argument("--token-env", help="env var holding the meeting token for mode join")
    parser.add_argument("--no-join", action="store_true")
    parser.add_argument("--no-client-ready", action="store_true")
    parser.add_argument(
        "--client-ready-when",
        choices=["joined", "bot-joined", "bot-track"],
        default="bot-joined",
    )
    parser.add_argument("--say", action="append", default=[], help="send-text, in order")
    parser.add_argument("--no-audio-response", action="store_true")
    parser.add_argument("--not-immediately", action="store_true")
    parser.add_argument("--wait-bot", type=float, default=150.0)
    parser.add_argument("--wait-ready", type=float, default=15.0)
    parser.add_argument("--greeting-wait", type=float, default=30.0)
    parser.add_argument("--turn-limit", type=float, default=60.0)
    parser.add_argument("--linger", type=float, default=3.0)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    rec = Recorder(args.out, args.quiet)
    room_url: str | None = None
    token: str | None = None
    summary: dict[str, Any] = {}

    if args.mode in {"pcc", "url"}:
        payload: dict[str, Any] = {
            "createDailyRoom": True,
            "dailyRoomProperties": {
                "exp": int(time.time()) + args.exp_seconds,
                "eject_at_room_exp": True,
            },
            "body": json.loads(args.body),
        }
        if args.mode == "pcc":
            key = os.environ.get(args.key_env, "")
            url = PCC_START.format(agent=args.agent)
            headers = {"Authorization": f"Bearer {key}"}
        else:
            if not args.no_transport:
                payload["transport"] = "daily"
            url = args.start_url
            headers = dict(h.split(":", 1) for h in args.header)
            headers = {k.strip(): v.strip() for k, v in headers.items()}
        rec.log("start-request", url=url, header_names=sorted(headers), payload=payload)
        answer = post_start(url, payload, headers, timeout=60)
        rec.log("start-answer", **redact(answer))
        summary["start"] = redact(answer)
        body = answer["body"] if isinstance(answer["body"], dict) else {}
        room_url, token = body.get("dailyRoom"), body.get("dailyToken")
        if answer["status"] != 200 or not room_url or args.no_join:
            print(json.dumps({"summary": summary}, indent=2, default=str))
            return 0 if answer["status"] == 200 else 2
    else:
        room_url = args.room
        token = os.environ.get(args.token_env or "", "") or None

    Daily.init()
    client = Client(rec)
    call = CallClient(event_handler=client)
    client.call = call
    call.update_subscription_profiles(
        {
            "base": {
                "camera": "unsubscribed",
                "screenVideo": "unsubscribed",
                "microphone": "subscribed",
            }
        }
    )
    call.set_user_name("egma-e2e-client")
    joined = threading.Event()

    def on_joined(data, error):
        if error:
            rec.log("join-error", error=error)
        else:
            local = data.get("participants", {}).get("local", {})
            client.local_id = local.get("id")
            rec.log("joined", id=client.local_id, is_owner=local.get("info", {}).get("isOwner"))
        joined.set()

    call.join(
        room_url,
        meeting_token=token,
        client_settings={"inputs": {"camera": False, "microphone": False}},
        completion=on_joined,
    )
    joined.wait(30)
    for participant_id, participant in call.participants().items():
        if participant_id != "local":
            client.on_participant_joined(participant)

    gate = {"joined": joined, "bot-joined": client.bot_joined, "bot-track": client.bot_track}
    if not gate[args.client_ready_when].wait(args.wait_bot):
        rec.log("timeout", waiting_for=args.client_ready_when)
    if not args.no_client_ready:
        client.send_rtvi(
            "client-ready",
            {
                "version": RTVI_VERSION,
                "about": {"library": "egma-e2e-client", "library_version": "0.1.0"},
            },
        )
    greeting_from = rec.now()
    if not client.bot_ready.wait(args.wait_ready):
        rec.log("timeout", waiting_for="bot-ready")
    greeting = wait_turn_over(client, rec, greeting_from, args.greeting_wait)
    summary["greeting"] = {**greeting, **summarize_turn(rec, client, greeting_from, rec.now())}

    summary["turns"] = []
    for text in args.say:
        since = rec.now()
        client.send_rtvi(
            "send-text",
            {
                "content": text,
                "options": {
                    "run_immediately": not args.not_immediately,
                    "audio_response": not args.no_audio_response,
                },
            },
        )
        over = wait_turn_over(client, rec, since, args.turn_limit)
        summary["turns"].append(
            {"said": text, **over, **summarize_turn(rec, client, since, rec.now())}
        )

    time.sleep(args.linger)
    left = threading.Event()
    call.leave(completion=lambda error: left.set())
    left.wait(10)
    call.release()
    summary["milestones"] = {
        kind: next((e["t"] for e in rec.events if e["kind"] == kind), None)
        for kind in ["joined", "participant-joined", "bot-audio-start"]
    }
    summary["milestones"]["bot-microphone-playable"] = next(
        (
            e["t"]
            for e in rec.events
            if e["kind"] == "bot-microphone" and e.get("state") == "playable"
        ),
        None,
    )
    summary["milestones"]["bot-ready"] = next(
        (e["t"] for e in rec.events if e["kind"] == "rtvi" and e["type"] == "bot-ready"), None
    )
    print(json.dumps({"summary": summary}, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
