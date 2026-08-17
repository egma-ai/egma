"""One OpenTelemetry SDK for every simulation in this process.

The provider is process-wide because Pipecat obtains its tracer from the
OpenTelemetry API.  A simulation is task-local: the active simulation lives in
a context variable, so concurrent pipeline tasks inherit the right trace and
never share a root.

Only one piece of identity is adapted.  The SDK asks its ``IdGenerator`` for a
trace id when the parentless ``simulation`` span starts, and the adapter gives
it the trace id already defined by the simulation contract.  Span ids, child
propagation, span data, and serialization remain SDK-owned.

Completed spans wait in a processor until the conversation reaches one of its
existing flush seams.  The official OTLP encoder then builds the export
request.  We add the simulation id to the resource envelope required by the
service-token ingest door. A narrow OpenTelemetry 1.44 compatibility step
restores trace flags and link trace state that its encoder omits, then applies
OTLP/JSON's integer-enum and hex-id rules. It does not filter or rename any
scope, span, status, event, link, or attribute authored by Pipecat.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import threading
from collections.abc import Callable, Sequence
from contextvars import ContextVar, Token
from dataclasses import dataclass

from google.protobuf.json_format import MessageToDict
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.proto.common.v1.common_pb2 import AnyValue, KeyValue
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import (
    ReadableSpan,
    Span,
    SpanLimits,
    SpanProcessor,
    TracerProvider,
)
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.sdk.trace.id_generator import RandomIdGenerator
from opentelemetry.sdk.trace.sampling import ALWAYS_ON

logger = logging.getLogger(__name__)

SERVICE_NAME = "egma-simulator"
SIMULATION_ID_ATTRIBUTE = "egma.simulation_id"

_CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_EGMA_SIMULATION_ID = re.compile(r"^sim_([0-9A-HJKMNP-TV-Z]{26})$")

SerializedExport = bytes
ExportSink = Callable[[SerializedExport], None]


def trace_id_for(simulation_id: str) -> str:
    """Return the simulation contract's 128-bit trace identity as hex."""
    egma_shaped = _EGMA_SIMULATION_ID.match(simulation_id)
    if egma_shaped is not None:
        value = 0
        for character in egma_shaped.group(1):
            value = (value << 5) | _CROCKFORD_ALPHABET.index(character)
        if value == 0:
            raise ValueError(
                f"simulation {simulation_id} maps to the all-zero OpenTelemetry "
                "trace id, which OpenTelemetry reserves as invalid"
            )
        if value < 1 << 128:
            return format(value, "032x")
    opaque = hashlib.blake2b(simulation_id.encode(), digest_size=16).hexdigest()
    # A digest has no practical route to zero, but the SDK invariant is exact:
    # no accepted input may ever be handed the one forbidden trace id.
    return opaque if int(opaque, 16) != 0 else "0" * 31 + "1"


@dataclass(frozen=True)
class ActiveSimulation:
    simulation_id: str
    trace_id: int


_ACTIVE_SIMULATION: ContextVar[ActiveSimulation | None] = ContextVar(
    "egma_active_simulation", default=None
)
_ROOT_TRACE_ID: ContextVar[int | None] = ContextVar(
    "egma_simulation_root_trace_id", default=None
)


class SimulationTraceIdGenerator(RandomIdGenerator):
    """Give only a simulation root its existing contract trace identity."""

    def generate_trace_id(self) -> int:
        root_trace_id = _ROOT_TRACE_ID.get()
        return (
            root_trace_id if root_trace_id is not None else super().generate_trace_id()
        )

    def is_trace_id_random(self) -> bool:
        # TracerProvider asks this during the same start_span call, while the
        # root token is still set. Only that adapted id is deterministic;
        # ordinary fallback roots keep RandomIdGenerator's truthful flag.
        return _ROOT_TRACE_ID.get() is None


class SimulationExporter(SpanExporter):
    """Route SDK spans to the reporter registered for their trace."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._routes: dict[int, tuple[str, ExportSink]] = {}

    def register(self, simulation_id: str, trace_id: int, sink: ExportSink) -> None:
        with self._lock:
            if trace_id in self._routes:
                raise RuntimeError(
                    f"trace {trace_id:032x} already has an active simulation"
                )
            self._routes[trace_id] = (simulation_id, sink)

    def unregister(self, trace_id: int) -> None:
        with self._lock:
            self._routes.pop(trace_id, None)

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        if not spans:
            return SpanExportResult.SUCCESS

        trace_ids = {
            span.context.trace_id for span in spans if span.context is not None
        }
        if len(trace_ids) != 1:
            logger.error("an OpenTelemetry export mixed %d traces", len(trace_ids))
            return SpanExportResult.FAILURE
        trace_id = next(iter(trace_ids))
        with self._lock:
            route = self._routes.get(trace_id)
        if route is None:
            logger.error("no reporter is registered for trace %032x", trace_id)
            return SpanExportResult.FAILURE

        simulation_id, sink = route
        try:
            request = encode_spans(spans)
            # opentelemetry-exporter-otlp-proto-common 1.44.0's
            # trace_encoder._span_flags keeps only the remote-context masks,
            # while _encode_links omits the link context's trace_state.
            # Restore only those SDK fields before serialization so the raw
            # envelope loses none of what Pipecat authored. OR keeps the
            # encoder's remote-context mask bits intact. Pairing by SDK-minted
            # span id avoids depending on grouping order.
            sources = {
                span.context.span_id: span for span in spans if span.context is not None
            }
            # A provider Resource is process-wide. The ingest requires this
            # one per-simulation envelope attribute, so it is added after the
            # SDK groups spans. Scope grouping is unchanged; span and link
            # fields receive only the 1.44 loss-prevention repairs above.
            for resource_spans in request.resource_spans:
                _stamp_simulation_id(resource_spans.resource, simulation_id)
                for scope_spans in resource_spans.scope_spans:
                    for encoded_span in scope_spans.spans:
                        source = sources.get(int.from_bytes(encoded_span.span_id))
                        if source is None:
                            continue
                        encoded_span.flags |= int(source.context.trace_flags)
                        for encoded_link, source_link in zip(
                            encoded_span.links, source.links, strict=True
                        ):
                            encoded_link.trace_state = (
                                source_link.context.trace_state.to_header()
                            )
                            encoded_link.flags |= int(source_link.context.trace_flags)
            sink(_as_otlp_json(request))
        except Exception:
            logger.exception("could not hand trace %032x to its reporter", trace_id)
            return SpanExportResult.FAILURE
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        return None


def _stamp_simulation_id(resource, simulation_id: str) -> None:  # type: ignore[no-untyped-def]
    """Set the reserved route key once and preserve every other resource field."""
    matching = [
        index
        for index, attribute in enumerate(resource.attributes)
        if attribute.key == SIMULATION_ID_ATTRIBUTE
    ]
    value = AnyValue(string_value=simulation_id)
    if not matching:
        resource.attributes.append(KeyValue(key=SIMULATION_ID_ATTRIBUTE, value=value))
        return

    resource.attributes[matching[0]].value.CopyFrom(value)
    for index in reversed(matching[1:]):
        del resource.attributes[index]


class SimulationSpanProcessor(SpanProcessor):
    """Buffer ended spans by trace until that simulation asks to flush."""

    def __init__(self, exporter: SimulationExporter) -> None:
        self._exporter = exporter
        self._lock = threading.Lock()
        self._pending: dict[int, list[ReadableSpan]] = {}

    def on_start(self, span: Span, parent_context=None) -> None:  # type: ignore[no-untyped-def]
        return None

    def on_end(self, span: ReadableSpan) -> None:
        if span.context is None:
            return
        with self._lock:
            self._pending.setdefault(span.context.trace_id, []).append(span)

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        del timeout_millis  # Export is synchronous and writes the WAL before return.
        active = _ACTIVE_SIMULATION.get()
        targets = None if active is None else {active.trace_id}
        with self._lock:
            trace_ids = list(self._pending) if targets is None else list(targets)

        succeeded = True
        for trace_id in trace_ids:
            with self._lock:
                batch = self._pending.pop(trace_id, [])
            if not batch:
                continue
            if self._exporter.export(batch) is SpanExportResult.SUCCESS:
                continue
            succeeded = False
            # Preserve original ReadableSpan objects and their order for the
            # next flush. New spans may have ended while export ran.
            with self._lock:
                self._pending[trace_id] = batch + self._pending.get(trace_id, [])
        return succeeded

    def discard(self, trace_id: int) -> None:
        with self._lock:
            self._pending.pop(trace_id, None)

    def shutdown(self) -> None:
        self.force_flush()
        self._exporter.shutdown()


def _as_otlp_json(request) -> bytes:  # type: ignore[no-untyped-def]
    """Serialize the official request with OTLP/JSON's hex id exception."""
    # Protobuf's default JSON printer writes symbolic enum names. OTLP/JSON
    # requires the protobuf field numbers instead, so keep integers here and
    # repair only the trace/span id exception defined by OTLP below.
    document = MessageToDict(request, use_integers_for_enums=True)
    for resource in document.get("resourceSpans", []):
        for scoped in resource.get("scopeSpans", []):
            for span in scoped.get("spans", []):
                for key in ("traceId", "spanId", "parentSpanId"):
                    encoded = span.get(key)
                    if encoded:
                        span[key] = base64.b64decode(encoded).hex()
                for link in span.get("links", []):
                    for key in ("traceId", "spanId"):
                        encoded = link.get(key)
                        if encoded:
                            link[key] = base64.b64decode(encoded).hex()
    return json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode()


def _ensure_sdk_enabled() -> None:
    """Refuse a process that global OTel settings made evidence-blind."""
    if os.environ.get("OTEL_SDK_DISABLED", "").lower().strip() == "true":
        raise RuntimeError(
            "OTEL_SDK_DISABLED cannot be true in the simulator because every "
            "terminal lifecycle report requires complete trace evidence"
        )


_ensure_sdk_enabled()
_EXPORTER = SimulationExporter()
_PROCESSOR = SimulationSpanProcessor(_EXPORTER)
# Simulation trace evidence must not inherit process-wide truncation settings. The
# SDK uses these model-specific limits for every span, event, and link;
# ``UNSET`` means no limit and, because every argument is explicit, bypasses
# all OTEL_*_LIMIT environment variables. ``max_attributes`` is only the SDK's
# fallback for a model-specific value and is not consulted here.
_UNLIMITED = SpanLimits.UNSET
_EVIDENCE_SPAN_LIMITS = SpanLimits(
    max_attributes=_UNLIMITED,
    max_events=_UNLIMITED,
    max_links=_UNLIMITED,
    max_span_attributes=_UNLIMITED,
    max_event_attributes=_UNLIMITED,
    max_link_attributes=_UNLIMITED,
    max_attribute_length=_UNLIMITED,
    max_span_attribute_length=_UNLIMITED,
)
_PROVIDER = TracerProvider(
    resource=Resource.create({"service.name": SERVICE_NAME}),
    id_generator=SimulationTraceIdGenerator(),
    sampler=ALWAYS_ON,
    span_limits=_EVIDENCE_SPAN_LIMITS,
    shutdown_on_exit=False,
)
_PROVIDER.add_span_processor(_PROCESSOR)
trace.set_tracer_provider(_PROVIDER)
if trace.get_tracer_provider() is not _PROVIDER:
    raise RuntimeError("another OpenTelemetry TracerProvider was installed first")


def tracer(scope_name: str, scope_version: str):  # type: ignore[no-untyped-def]
    return _PROVIDER.get_tracer(scope_name, scope_version)


def activate(
    simulation_id: str, sink: ExportSink
) -> tuple[ActiveSimulation, Token[ActiveSimulation | None]]:
    active = ActiveSimulation(
        simulation_id=simulation_id,
        trace_id=int(trace_id_for(simulation_id), 16),
    )
    _EXPORTER.register(simulation_id, active.trace_id, sink)
    return active, _ACTIVE_SIMULATION.set(active)


def activate_root_trace_id(active: ActiveSimulation) -> Token[int | None]:
    """Offer the contract trace id for the root's one SDK id request."""
    return _ROOT_TRACE_ID.set(active.trace_id)


def deactivate_root_trace_id(token: Token[int | None]) -> None:
    _ROOT_TRACE_ID.reset(token)


def flush() -> None:
    if not _PROVIDER.force_flush():
        raise RuntimeError("OpenTelemetry could not write every ended span to the WAL")


def deactivate(
    active: ActiveSimulation, token: Token[ActiveSimulation | None], *, discard: bool
) -> None:
    try:
        if discard:
            _PROCESSOR.discard(active.trace_id)
        _EXPORTER.unregister(active.trace_id)
    finally:
        _ACTIVE_SIMULATION.reset(token)
