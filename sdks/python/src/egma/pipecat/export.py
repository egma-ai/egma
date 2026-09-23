"""One private OpenTelemetry provider per Pipecat bot session.

The observer writes egma's spans through this provider only. It is never
registered as the global tracer provider, so a customer's own tracing
(Langfuse, Pipecat's own tracing, anything else) keeps its provider, and
several bots in one process each keep their own record.

A simulation's resource carries ``egma.provider_reference`` and exports
every second; a production resource carries none and uses the default
batch interval. Both send the ``pipecat_session`` root after every other
span, because its arrival tells egma the record is complete.
"""

from __future__ import annotations

import asyncio
import logging

from opentelemetry import trace
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter

from .. import otlp
from .._frameworks import installed_version

logger = logging.getLogger("egma")

SCOPE = "egma.pipecat"
"""The instrumentation scope egma's ingestion reads Pipecat spans under."""

ROOT_SPAN = "pipecat_session"
"""The root span: the whole bot run. Its arrival completes the record."""

SERVICE = "pipecat"

SESSION_ID = "session.id"
"""The runner's session id, which egma keeps as the provider call id."""

FLUSH_TIMEOUT_MILLIS = 10_000
"""The longest the final flush of a session may take."""


def _build_exporter(endpoint: str, api_key: str, verb: str) -> SpanExporter:
    """The OTLP exporter. A module-level name, so tests can send spans to memory."""
    return otlp.build_exporter(endpoint, api_key, verb)


class SessionExport:
    """The provider, processor and tracer of one bot session's export."""

    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        verb: str,
        provider_reference: str,
        session_id: str,
    ) -> None:
        self.provider_reference = provider_reference
        attributes: dict[str, str] = {SERVICE_NAME: SERVICE}
        if provider_reference:
            attributes[otlp.PROVIDER_REFERENCE] = provider_reference
        if session_id:
            attributes[SESSION_ID] = session_id
        self.provider = TracerProvider(resource=Resource.create(attributes))
        exporter = otlp.RootLastExporter(
            _build_exporter(endpoint, api_key, verb), root_span_name=ROOT_SPAN
        )
        try:
            self.processor = (
                BatchSpanProcessor(
                    exporter, schedule_delay_millis=otlp.SIMULATION_BATCH_MILLIS
                )
                if provider_reference
                else BatchSpanProcessor(exporter)
            )
            self.provider.add_span_processor(self.processor)
        except Exception:
            # Telemetry libraries can include exporter state in exception text.
            try:
                exporter.shutdown()
            except Exception:
                pass
            raise ValueError(f"{verb} could not configure the Egma exporter.") from None
        self.tracer: trace.Tracer = self.provider.get_tracer(
            SCOPE, installed_version("egma")
        )
        self._closed = False

    async def close(self) -> None:
        """Send everything ended so far, then stop the export's worker thread."""
        if self._closed:
            return
        self._closed = True
        try:
            flushed = await asyncio.to_thread(
                self.processor.force_flush, FLUSH_TIMEOUT_MILLIS
            )
        except Exception:
            flushed = False
        if not flushed:
            logger.warning("Egma could not send every span of this bot session")
        try:
            await asyncio.to_thread(self.provider.shutdown)
        except Exception:
            logger.warning("Egma could not stop this bot session's exporter")

    def discard(self) -> None:
        """Stop the export without awaiting. Spans already ended still go out."""
        if self._closed:
            return
        self._closed = True
        try:
            self.provider.shutdown()
        except Exception:
            pass
