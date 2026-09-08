"""Local HTTP token endpoint used by the real driver request code.
Configure token and server field aliases, status, custom JSON, or raw invalid bytes.
Retain complete requests in asked so tests can inspect the serialized contract.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

TOKEN_PATH = "/egma/livekit-token"
DEFAULT_SERVER_URL = "wss://acme.livekit.cloud"
"""The server a scripted answer names unless a test says otherwise."""
"""Where the fake serves. A path rather than the root, because a real one
sits beside whatever else the customer's service does."""


@dataclass(frozen=True)
class Asked:
    """One request this endpoint was sent, as it arrived."""

    path: str
    headers: dict[str, str] = field(repr=False)
    body: Any
    """The parsed JSON body, or the raw text where it was not JSON."""

    def header(self, name: str) -> str | None:
        """One header by name, the way HTTP means names: case-blind."""
        for held, value in self.headers.items():
            if held.lower() == name.lower():
                return value
        return None


class FakeTokenEndpoint:
    """One scripted token endpoint, and the record of what it was asked."""

    def __init__(
        self,
        *,
        token: str = "fake.token.for.tests",
        alias: str = "participant_token",
        server_url: str | None = DEFAULT_SERVER_URL,
        server_url_key: str = "server_url",
        status: int = 200,
        body: dict[str, Any] | None = None,
        raw: str | None = None,
        content_type: str = "application/json",
    ) -> None:
        self.token = token
        self.alias = alias
        self.server_url = server_url
        self.server_url_key = server_url_key
        self.status = status
        self.body = body
        self.raw = raw
        self.content_type = content_type
        self.asked: list[Asked] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        """The HTTPS URL shape a real connection stores.

        The test backend maps this loopback-only address to :attr:`wire_url`
        after the production parser has enforced HTTPS. The socket request is
        still real; only the local test server's missing TLS layer is replaced.
        """
        return self.wire_url.replace("http://", "https://", 1)

    @property
    def wire_url(self) -> str:
        """Where the local HTTP server actually listens in this test."""
        if self._server is None:
            raise RuntimeError("the endpoint is not serving")
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}{TOKEN_PATH}"

    def answer(self) -> tuple[int, bytes, str]:
        """What it sends back, as the wire will carry it."""
        if self.raw is not None:
            return self.status, self.raw.encode("utf-8"), self.content_type
        held: dict[str, Any] = (
            dict(self.body)
            if self.body is not None
            else {self.alias: self.token}
        )
        if self.server_url is not None and self.body is None:
            held[self.server_url_key] = self.server_url
        return (
            self.status,
            json.dumps(held).encode("utf-8"),
            self.content_type,
        )

    def start(self) -> None:
        served = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            # One request per connection. A kept-alive socket leaves the
            # handler thread blocked on a read the client has finished
            # with, and stopping then waits it out — half a second per
            # test, spent on nothing.
            close_connection = True

            def do_POST(self) -> None:  # noqa: N802 — the stdlib's own name
                length = int(self.headers.get("content-length", "0") or "0")
                sent = self.rfile.read(length).decode("utf-8") if length else ""
                try:
                    body: Any = json.loads(sent) if sent else None
                except ValueError:
                    body = sent
                served.asked.append(
                    Asked(
                        path=self.path,
                        headers=dict(self.headers.items()),
                        body=body,
                    )
                )

                status, payload, content_type = served.answer()
                self.send_response(status)
                self.send_header("content-type", content_type)
                self.send_header("content-length", str(len(payload)))
                self.send_header("connection", "close")
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_arguments: object) -> None:
                """Quiet: the stdlib logs every request to stderr."""

        # Port 0: the operating system picks a free one, so two suites
        # running at once never collide.
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        # A short poll, because stopping waits out one interval and the
        # stdlib's default half-second would be the whole cost of every
        # test that uses this.
        self._thread = threading.Thread(
            target=lambda: self._serve(), daemon=True
        )
        self._thread.start()

    def _serve(self) -> None:
        if self._server is not None:
            self._server.serve_forever(poll_interval=0.01)

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None


@contextmanager
def serving(**scripted: object) -> Iterator[FakeTokenEndpoint]:
    """One scripted endpoint, serving for the length of one test."""
    endpoint = FakeTokenEndpoint(**scripted)  # type: ignore[arg-type]
    endpoint.start()
    try:
        yield endpoint
    finally:
        endpoint.stop()
