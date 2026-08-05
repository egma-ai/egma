"""Minimal OTLP/HTTP sink that writes every export request body to disk verbatim.

Listens on http://127.0.0.1:4318/v1/traces (the OTLP/HTTP default). Each POST is
written unchanged as request-NNN.bin, and its headers are appended to
manifest.json. Nothing is decoded, re-encoded or reordered: the files on disk are
the bytes an OpenTelemetry exporter put on the wire.

Usage: python capture-server.py <output-dir>

See README.md in this directory for the whole procedure.
"""

from __future__ import annotations

import json
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

OUT_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else "capture-out")
MANIFEST = OUT_DIR / "manifest.json"

# The capture is checked into a public repository, and an exporter configured
# against a real backend carries its credentials in headers. So the manifest
# keeps only the headers a stock exporter always sends — everything not on this
# list is redacted, rather than trying to enumerate every name a secret might
# hide behind.
KEPT_HEADERS = {
    "host",
    "user-agent",
    "accept",
    "accept-encoding",
    "connection",
    "content-type",
    "content-length",
}

_lock = threading.Lock()
_requests: list[dict[str, object]] = []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)

        if self.path != "/v1/traces":
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        headers = {}
        for key, value in self.headers.items():
            headers[key] = value if key.lower() in KEPT_HEADERS else "<redacted>"

        # The server is threaded, so claiming an index, writing the file and
        # rewriting the manifest must happen as one step.
        with _lock:
            index = len(_requests)
            name = f"request-{index:03d}.bin"
            (OUT_DIR / name).write_bytes(body)
            _requests.append(
                {
                    "file": name,
                    "received_at": datetime.now(timezone.utc).isoformat(),
                    "method": self.command,
                    "path": self.path,
                    "byte_length": len(body),
                    "headers": headers,
                }
            )
            MANIFEST.write_text(json.dumps({"requests": _requests}, indent=2) + "\n")

        # An empty ExportTraceServiceResponse is a zero-length protobuf message.
        self.send_response(200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("otlp-capture: " + (fmt % args) + "\n")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    leftover = sorted(OUT_DIR.glob("request-*.bin"))
    if leftover:
        sys.stderr.write(
            f"otlp-capture: {OUT_DIR} already holds {len(leftover)} request-*.bin "
            "file(s); refusing to mix two captures. Empty it or pick another directory.\n"
        )
        raise SystemExit(1)
    server = ThreadingHTTPServer(("127.0.0.1", 4318), Handler)
    sys.stderr.write(f"otlp-capture: listening on http://127.0.0.1:4318, writing to {OUT_DIR}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
