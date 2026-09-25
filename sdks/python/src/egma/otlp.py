"""Framework-free parts of Egma's OTLP/HTTP export.

Read ``EGMA_URL`` and ``EGMA_API_KEY``, build the trace exporter that
authenticates with the project key, and keep a simulation's root span
behind the rest of its evidence. The LiveKit exporter (``egma.export``)
and the Pipecat exporter (``egma.pipecat``) both build on this module,
which imports no agent framework.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
from collections.abc import Sequence
from urllib.parse import SplitResult, urlsplit, urlunsplit

from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter,
)
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SpanExporter,
    SpanExportResult,
)

logger = logging.getLogger("egma")

TRACE_PATH = "/v1/traces"
"""The trace door's path under ``EGMA_URL``."""

PROJECT_KEY_PATTERN = re.compile(r"egma_sk_[A-Za-z0-9_-]{43}\Z")
"""The shape of an Egma project API key."""

PROVIDER_REFERENCE = "egma.provider_reference"
"""What egma files a simulation's agent POV under.

egma's own attribute, in egma's own namespace, so it can never collide
with a semantic convention or with a framework's own key. A resource that
carries it is the agent's POV of one simulation; a resource without it is
production traffic and takes the path it always took.
"""

SIMULATION_BATCH_MILLIS = 1000
"""How long a simulation's spans may sit in the buffer: one second.

Short because somebody is waiting. A simulation is graded the moment the
agent's POV is complete, so the tail of the conversation has to land
within a second or two of the persona leaving rather than at whatever the
exporter's ordinary batching says. Production is not waited on the same
way and keeps the library's own default.
"""


class RootLastExporter(SpanExporter):
    """Send a simulation's completion root after all earlier evidence.

    Spans named ``root_span_name`` are held back within each batch until
    the batch's other spans are accepted. Once any send fails, a later
    root is refused too, so egma never sees a complete record that is
    missing part of its evidence.
    """

    def __init__(self, delegate: SpanExporter, root_span_name: str) -> None:
        self._delegate = delegate
        self._root_span_name = root_span_name
        self._serial = threading.Lock()
        self._failed = False

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        with self._serial:
            children = [span for span in spans if span.name != self._root_span_name]
            roots = [span for span in spans if span.name == self._root_span_name]
            if children:
                result = self._send(children)
                if result != SpanExportResult.SUCCESS:
                    self._failed = True
                    return SpanExportResult.FAILURE
            if roots:
                if self._failed:
                    return SpanExportResult.FAILURE
                result = self._send(roots)
                if result != SpanExportResult.SUCCESS:
                    self._failed = True
                    return SpanExportResult.FAILURE
            return SpanExportResult.SUCCESS

    def _send(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        try:
            return self._delegate.export(spans)
        except Exception:
            return SpanExportResult.FAILURE

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        with self._serial:
            return self._delegate.force_flush(timeout_millis) is not False

    def shutdown(self) -> None:
        with self._serial:
            self._delegate.shutdown()


def setting(explicit: str | None, environment_name: str, verb: str) -> str:
    """An explicit argument, else the environment variable, never blank."""
    value = explicit if explicit is not None else os.environ.get(environment_name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(
            f"{verb} needs {environment_name}. Set it or pass the matching argument."
        )
    return value.strip()


def project_key(value: str, verb: str) -> str:
    """The project API key, refused when it is not shaped like one."""
    if PROJECT_KEY_PATTERN.fullmatch(value) is None:
        raise ValueError(f"{verb} received an invalid EGMA_API_KEY.")
    return value


def api_base(value: str, verb: str) -> SplitResult:
    """Parse ``EGMA_URL`` as an HTTP or HTTPS API base URL."""

    try:
        parsed = urlsplit(value)
        # Reading ``port`` makes urllib reject a malformed numeric port now,
        # before an exporter thread tries to use it later.
        _ = parsed.port
    except ValueError:
        raise ValueError(
            f"{verb} needs EGMA_URL to be a valid HTTP or HTTPS API URL."
        ) from None

    invalid = (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or bool(parsed.query)
        or bool(parsed.fragment)
        or any(character.isspace() for character in value)
    )
    if invalid:
        raise ValueError(f"{verb} needs EGMA_URL to be a valid HTTP or HTTPS API URL.")
    return parsed


def api_root(value: str, verb: str) -> str:
    """``EGMA_URL`` without a trailing ``/`` or ``/v1/traces``.

    Either form of the setting names the same Egma: the trace door and the
    SDK routes both hang off this root.
    """

    parsed = api_base(value, verb)
    path = parsed.path.rstrip("/")
    if path.endswith(TRACE_PATH):
        path = path[: -len(TRACE_PATH)].rstrip("/")
    return urlunsplit(
        SplitResult(
            scheme=parsed.scheme,
            netloc=parsed.netloc,
            path=path,
            query="",
            fragment="",
        )
    )


def trace_endpoint(value: str, verb: str) -> str:
    """Turn an Egma API base URL into the OTLP trace endpoint."""
    return f"{api_root(value, verb)}{TRACE_PATH}"


def build_exporter(endpoint: str, api_key: str, verb: str) -> SpanExporter:
    """The OTLP/HTTP trace exporter, authenticated with the project key."""
    try:
        return OTLPSpanExporter(
            endpoint=endpoint,
            headers={"Authorization": f"Bearer {api_key}"},
        )
    except Exception:
        # Exporter libraries can include constructor arguments in exception
        # text. Replace that text so a project key can never escape here.
        raise ValueError(
            f"{verb} could not create the Egma exporter. Check EGMA_URL and "
            "EGMA_API_KEY."
        ) from None


def flush_on(processor: BatchSpanProcessor, why: str) -> asyncio.Task[None]:
    """Send whatever is buffered now, without holding the caller up.

    The task is handed back for the caller to hold, because a task nobody
    holds may be collected before it runs.
    """

    return asyncio.get_running_loop().create_task(flushed(processor, why))


async def flushed(processor: BatchSpanProcessor, why: str) -> None:
    """Flush buffered spans off the event loop; log rather than raise."""
    try:
        done = await asyncio.to_thread(processor.force_flush)
    except Exception:
        logger.warning("Egma could not flush every buffered span at %s", why)
        return
    if not done:
        logger.warning("Egma could not flush every buffered span at %s", why)
