"""Small OTLP protobuf receiver for the agent SDK side of the E2E lane."""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
    ExportTraceServiceResponse,
)

OUTPUT = Path(os.environ["EGMA_E2E_OTLP_RECORDS"])
EXPECTED_AUTHORIZATION = os.environ["EGMA_E2E_AUTHORIZATION"]
WRITE_LOCK = threading.Lock()


def value_of(attribute) -> object:
    value = attribute.value
    selected = value.WhichOneof("value")
    if selected is None:
        return None
    held = getattr(value, selected)
    if selected == "array_value":
        return [
            value_of(type("Attribute", (), {"value": item})()) for item in held.values
        ]
    if selected == "kvlist_value":
        return {item.key: value_of(item) for item in held.values}
    return held


class Collector(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(404)
            return
        self.send_response(200)
        self.end_headers()

    def do_POST(self) -> None:
        if self.path != "/v1/traces":
            self.send_error(404)
            return
        if self.headers.get("Authorization") != EXPECTED_AUTHORIZATION:
            self.send_error(401)
            return
        request = ExportTraceServiceRequest()
        try:
            request.ParseFromString(self._body())
            records = self._records(request)
        except (ValueError, KeyError) as error:
            self.send_error(400, str(error))
            return
        with WRITE_LOCK, OUTPUT.open("a", encoding="utf-8") as output:
            for record in records:
                output.write(json.dumps(record, separators=(",", ":")) + "\n")
        answer = ExportTraceServiceResponse().SerializeToString()
        self.send_response(200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.send_header("Content-Length", str(len(answer)))
        self.end_headers()
        self.wfile.write(answer)

    def _body(self) -> bytes:
        content_length = self.headers.get("Content-Length")
        if content_length is not None:
            return self.rfile.read(int(content_length))
        if self.headers.get("Transfer-Encoding", "").lower() != "chunked":
            raise ValueError("OTLP request has no body length")
        body = bytearray()
        while True:
            line = self.rfile.readline()
            if not line:
                raise ValueError("OTLP chunked body ended early")
            size = int(line.split(b";", 1)[0], 16)
            if size == 0:
                while self.rfile.readline() not in {b"\r\n", b"\n", b""}:
                    pass
                return bytes(body)
            body.extend(self.rfile.read(size))
            if self.rfile.read(2) != b"\r\n":
                raise ValueError("OTLP chunk was not terminated")
            if len(body) > 16 * 1024 * 1024:
                raise ValueError("OTLP request exceeded 16 MiB")

    @staticmethod
    def _records(request: ExportTraceServiceRequest) -> list[dict]:
        records = []
        for resource_spans in request.resource_spans:
            resource = {
                attribute.key: value_of(attribute)
                for attribute in resource_spans.resource.attributes
            }
            provider_reference = resource.get("egma.provider_reference")
            if not isinstance(provider_reference, str) or not provider_reference:
                raise ValueError("OTLP resource did not name a provider reference")
            for scope_spans in resource_spans.scope_spans:
                for span in scope_spans.spans:
                    records.append(
                        {
                            "provider_reference": provider_reference,
                            "scope": scope_spans.scope.name,
                            "name": span.name,
                            "attributes": {
                                attribute.key: value_of(attribute)
                                for attribute in span.attributes
                            },
                            "span": MessageToDict(
                                span, preserving_proto_field_name=True
                            ),
                        }
                    )
        if not records:
            raise ValueError("OTLP export carried no spans")
        return records


def main() -> None:
    server = ThreadingHTTPServer(
        ("127.0.0.1", int(os.environ["EGMA_E2E_OTLP_PORT"])), Collector
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
