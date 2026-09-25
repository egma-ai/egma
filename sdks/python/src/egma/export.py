"""LiveKit's OTLP exporter for ``monitor`` and ``simulation``.

Use the project API key and export the simulation room as its provider
reference. Set that reference on resources when creating a provider and
on spans through LiveKit metadata when extending an existing provider.
This preserves the customer's tracing setup, whose resource is immutable.

Ingestion prefers the resource value, falling back to matching span
values. One job per process is supported: the first job fixes exporter
settings, and another job requesting different settings is refused.
The framework-free parts live in ``egma.otlp``.
"""

from __future__ import annotations

import hashlib
import logging
import threading
from dataclasses import dataclass

from livekit.agents.telemetry import set_tracer_provider
from opentelemetry import trace
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter

from . import otlp
from .otlp import PROVIDER_REFERENCE, SIMULATION_BATCH_MILLIS, flush_on

__all__ = [
    "PROVIDER_REFERENCE",
    "SIMULATION_BATCH_MILLIS",
    "flush_on",
    "install",
]

logger = logging.getLogger("egma")

_FLUSH_MARKER = "_egma_export_flush_registered"

_ROOT_SPAN = "agent_session"
"""LiveKit's session span: the end of a simulation's agent POV."""


@dataclass(frozen=True)
class _Export:
    """The one Egma exporter configured in this process, and its terms."""

    verb: str
    endpoint: str
    api_key_digest: bytes
    provider_reference: str
    provider: TracerProvider
    processor: BatchSpanProcessor


_state: _Export | None = None
_state_lock = threading.Lock()


class _SimulationEvidenceExporter(otlp.RootLastExporter):
    """Keep a simulation completion root behind all earlier evidence."""

    def __init__(self, delegate: SpanExporter) -> None:
        super().__init__(delegate, root_span_name=_ROOT_SPAN)


# Module-level names for the framework-free steps in egma.otlp: the LiveKit
# tests monkeypatch them here, and _configure_provider reads them from here.
_setting = otlp.setting
_project_key = otlp.project_key
_trace_endpoint = otlp.trace_endpoint
_build_exporter = otlp.build_exporter
_flushed = otlp.flushed


def install(
    ctx: object,
    *,
    verb: str,
    endpoint: str | None,
    api_key: str | None,
    provider_reference: str = "",
) -> BatchSpanProcessor:
    """Export this worker's spans to Egma, once per process.

    ``provider_reference`` is the room a simulation runs in, or ``""`` for
    production. Returns the processor, so a caller with a second moment
    worth flushing at — a session closing — can ask for one.
    """
    trace_endpoint = _trace_endpoint(_setting(endpoint, "EGMA_URL", verb), verb)
    project_key = _project_key(_setting(api_key, "EGMA_API_KEY", verb), verb)
    add_shutdown_callback = getattr(ctx, "add_shutdown_callback", None)
    if not callable(add_shutdown_callback):
        raise ValueError(
            f"{verb} needs the LiveKit JobContext this job was given."
        )

    key_digest = hashlib.sha256(project_key.encode("utf-8")).digest()

    global _state
    with _state_lock:
        if _state is None:
            provider = _select_compatible_provider(verb, provider_reference)
            processor = _configure_provider(
                provider, trace_endpoint, project_key, verb, provider_reference
            )
            _state = _Export(
                verb=verb,
                endpoint=trace_endpoint,
                api_key_digest=key_digest,
                provider_reference=provider_reference,
                provider=provider,
                processor=processor,
            )
        elif (
            _state.endpoint != trace_endpoint
            or _state.api_key_digest != key_digest
        ):
            raise ValueError(
                f"{verb} is already configured with different settings in "
                "this process. Restart the worker after changing EGMA_URL or "
                "EGMA_API_KEY."
            )
        elif (
            _state.verb != verb
            or _state.provider_reference != provider_reference
        ):
            raise ValueError(
                f"{verb} cannot be configured in this process: it already "
                f"exports for {_state.verb}"
                + (
                    f" in room {_state.provider_reference!r}"
                    if _state.provider_reference
                    else " in a production room"
                )
                + ". A provider's resource is fixed when it is built, so one "
                "process exports one conversation. Run LiveKit with one job "
                "per process."
            )

        _register_shutdown_flush(ctx, _state.processor, verb)
        return _state.processor


def _livekit_provider() -> trace.TracerProvider:
    """Read the provider that LiveKit's dynamic tracer currently uses."""

    from livekit.agents.telemetry import tracer as livekit_tracer

    provider = getattr(livekit_tracer, "_tracer_provider", None)
    if provider is None:
        raise ValueError(
            "This LiveKit Agents version does not expose a compatible "
            "telemetry provider. Use a supported Egma SDK version."
        )
    return provider


def _select_compatible_provider(
    verb: str, provider_reference: str
) -> TracerProvider:
    """Reuse compatible telemetry and refuse to erase an existing provider.

    A customer's own provider is reused as it stands, resource and all.
    That resource cannot carry the room name — it was built before this
    SDK ran — which is exactly why the room name also rides every span
    through LiveKit's metadata seam below.
    """

    providers = {
        "LiveKit Agents": _livekit_provider(),
        "OpenTelemetry": trace.get_tracer_provider(),
    }
    concrete: dict[int, TracerProvider] = {}

    for owner, provider in providers.items():
        if isinstance(
            provider,
            (trace.ProxyTracerProvider, trace.NoOpTracerProvider),
        ):
            continue
        if not isinstance(provider, TracerProvider):
            raise ValueError(
                f"{verb} found an incompatible {owner} tracer provider. "
                "Configure one OpenTelemetry SDK TracerProvider before it."
            )
        concrete[id(provider)] = provider

    if len(concrete) > 1:
        raise ValueError(
            f"{verb} found different LiveKit Agents and OpenTelemetry tracer "
            "providers. Configure one shared provider before it."
        )
    if concrete:
        return next(iter(concrete.values()))

    attributes: dict[str, str] = {SERVICE_NAME: "livekit-agents"}
    if provider_reference:
        attributes[PROVIDER_REFERENCE] = provider_reference
    return TracerProvider(resource=Resource.create(attributes))


def _register_provider(provider: TracerProvider, provider_reference: str) -> None:
    """Make LiveKit and ordinary OpenTelemetry instrumentation share it.

    The room name goes through LiveKit's own ``metadata`` seam, which
    stamps it on every span the provider starts. That is the copy egma
    reads when the resource could not carry one.
    """

    global_provider = trace.get_tracer_provider()
    if isinstance(global_provider, trace.ProxyTracerProvider):
        trace.set_tracer_provider(provider)
    if provider_reference:
        set_tracer_provider(
            provider, metadata={PROVIDER_REFERENCE: provider_reference}
        )
        return
    set_tracer_provider(provider)


def _configure_provider(
    provider: TracerProvider,
    endpoint: str,
    api_key: str,
    verb: str,
    provider_reference: str,
) -> BatchSpanProcessor:
    """Attach one safe Egma processor and register its shared provider."""

    native_exporter = _build_exporter(endpoint, api_key, verb)
    exporter = (
        _SimulationEvidenceExporter(native_exporter)
        if provider_reference
        else native_exporter
    )
    try:
        processor = (
            BatchSpanProcessor(
                exporter, schedule_delay_millis=SIMULATION_BATCH_MILLIS
            )
            if provider_reference
            else BatchSpanProcessor(exporter)
        )
        _register_provider(provider, provider_reference)
        provider.add_span_processor(processor)
        return processor
    except Exception:
        # Telemetry libraries can include exporter state in exception text.
        # Close the unused exporter and replace that text with a safe message.
        try:
            exporter.shutdown()
        except Exception:
            pass
        raise ValueError(
            f"{verb} could not configure the Egma exporter. Check the "
            "worker's OpenTelemetry setup."
        ) from None


def _register_shutdown_flush(
    ctx: object, processor: BatchSpanProcessor, verb: str
) -> None:
    if getattr(ctx, _FLUSH_MARKER, False):
        return

    async def flush() -> None:
        await _flushed(processor, "job shutdown")

    ctx.add_shutdown_callback(flush)  # type: ignore[attr-defined]
    setattr(ctx, _FLUSH_MARKER, True)
