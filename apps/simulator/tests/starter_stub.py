"""A local HTTP bot starter answering Pipecat start requests from a script.

Each request takes the next scripted answer; the last one repeats. Requests are
kept whole in ``asked`` so tests read the serialized start request.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

START_PATH = "/start"
A_ROOM = "https://lakeside.daily.co/egma-room-0001"


@dataclass(frozen=True)
class Answer:
    """One scripted answer."""

    status: int = 200
    body: Any = field(default_factory=lambda: {"dailyRoom": A_ROOM})
    raw: bytes | None = None
    headers: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Asked:
    path: str
    headers: dict[str, str] = field(repr=False)
    body: Any

    def header(self, name: str) -> str | None:
        for held, value in self.headers.items():
            if held.lower() == name.lower():
                return value
        return None


class FakeStarter:
    def __init__(self, answers: list[Answer]) -> None:
        self.answers = answers or [Answer()]
        self.asked: list[Asked] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def wire_url(self) -> str:
        if self._server is None:
            raise RuntimeError("the starter is not serving")
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}{START_PATH}"

    def _next(self) -> Answer:
        index = min(len(self.asked) - 1, len(self.answers) - 1)
        return self.answers[index]

    def start(self) -> None:
        served = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            close_connection = True

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("content-length", "0") or "0")
                sent = self.rfile.read(length).decode("utf-8") if length else ""
                try:
                    body: Any = json.loads(sent) if sent else None
                except ValueError:
                    body = sent
                served.asked.append(
                    Asked(path=self.path, headers=dict(self.headers.items()), body=body)
                )
                answer = served._next()
                payload = (
                    answer.raw
                    if answer.raw is not None
                    else json.dumps(answer.body).encode("utf-8")
                )
                self.send_response(answer.status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.send_header("connection", "close")
                for name, value in answer.headers.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_arguments: object) -> None:
                """Quiet."""

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(
            target=lambda: self._server.serve_forever(poll_interval=0.01)  # type: ignore[union-attr]
            if self._server is not None
            else None,
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None


@contextmanager
def starting(*answers: Answer) -> Iterator[FakeStarter]:
    starter = FakeStarter(list(answers))
    starter.start()
    try:
        yield starter
    finally:
        starter.stop()
