"""Send LiveKit Agents production spans to an Egma project.

``monitor_livekit`` is separate from :func:`egma.mockable`. Monitoring is
enabled explicitly in a production worker. Mock tools remain active only in
simulations that Egma dispatches.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import threading
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit, urlunsplit

from livekit.agents import JobContext
from livekit.agents.telemetry import set_tracer_provider
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter,
)
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter

from .mockable import _egma_context

logger = logging.getLogger("egma")

_TRACE_PATH = "/v1/traces"
_FLUSH_MARKER = "_egma_monitoring_flush_registered"


@dataclass(frozen=True)
class _MonitoringState:
    """The one Egma exporter configured in this process."""

    endpoint: str
    api_key_digest: bytes
    provider: TracerProvider


_state: _MonitoringState | None = None
_state_lock = threading.Lock()


def monitor_livekit(
    ctx: JobContext,
    *,
    endpoint: str | None = None,
    api_key: str | None = None,
) -> None:
    """Export this LiveKit worker's spans to Egma.

    Call this once in the job entrypoint, before ``AgentSession.start``.
    ``endpoint`` defaults to ``EGMA_URL`` and ``api_key`` defaults to
    ``EGMA_API_KEY``. The API key is the existing Egma project API key.

    Repeated calls with the same settings reuse the exporter. Each job gets
    one shutdown callback so its last buffered spans are sent before exit.
    """

    # A simulation already has its own trace path. Exporting the agent side of
    # the same room through the production door would make one simulation look
    # like a second production conversation in Monitoring.
    if _egma_context(ctx) is not None:
        return

    trace_endpoint = _trace_endpoint(_setting(endpoint, "EGMA_URL"))
    project_key = _project_key(_setting(api_key, "EGMA_API_KEY"))
    add_shutdown_callback = getattr(ctx, "add_shutdown_callback", None)
    if not callable(add_shutdown_callback):
        raise ValueError(
            "LiveKit monitoring setup needs the LiveKit JobContext passed "
            "to monitor_livekit."
        )

    key_digest = hashlib.sha256(project_key.encode("utf-8")).digest()

    global _state
    with _state_lock:
        if _state is None:
            provider = _select_compatible_provider()
            _configure_provider(provider, trace_endpoint, project_key)
            _state = _MonitoringState(
                endpoint=trace_endpoint,
                api_key_digest=key_digest,
                provider=provider,
            )
        elif (
            _state.endpoint != trace_endpoint
            or _state.api_key_digest != key_digest
        ):
            raise ValueError(
                "LiveKit monitoring is already configured with different "
                "settings in this process. Restart the worker after changing "
                "EGMA_URL or EGMA_API_KEY."
            )

        _register_shutdown_flush(ctx, _state.provider)


def _setting(explicit: str | None, environment_name: str) -> str:
    value = explicit if explicit is not None else os.environ.get(environment_name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(
            f"LiveKit monitoring setup needs {environment_name}. "
            "Set it or pass the matching monitor_livekit argument."
        )
    return value.strip()


def _project_key(value: str) -> str:
    if "\r" in value or "\n" in value:
        raise ValueError(
            "LiveKit monitoring setup received an invalid EGMA_API_KEY."
        )
    return value


def _trace_endpoint(value: str) -> str:
    """Turn an Egma API base URL into the OTLP trace endpoint."""

    try:
        parsed = urlsplit(value)
        # Reading ``port`` makes urllib reject a malformed numeric port now,
        # before an exporter thread tries to use it later.
        _ = parsed.port
    except ValueError:
        raise ValueError(
            "LiveKit monitoring setup needs EGMA_URL to be a valid HTTP or "
            "HTTPS API URL."
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
        raise ValueError(
            "LiveKit monitoring setup needs EGMA_URL to be a valid HTTP or "
            "HTTPS API URL."
        )

    path = parsed.path.rstrip("/")
    if not path.endswith(_TRACE_PATH):
        path = f"{path}{_TRACE_PATH}"
    endpoint = SplitResult(
        scheme=parsed.scheme,
        netloc=parsed.netloc,
        path=path,
        query="",
        fragment="",
    )
    return urlunsplit(endpoint)


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


def _select_compatible_provider() -> TracerProvider:
    """Reuse compatible telemetry and refuse to erase an existing provider."""

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
                f"LiveKit monitoring found an incompatible {owner} tracer "
                "provider. Configure one OpenTelemetry SDK TracerProvider "
                "before monitor_livekit."
            )
        concrete[id(provider)] = provider

    if len(concrete) > 1:
        raise ValueError(
            "LiveKit monitoring found different LiveKit Agents and "
            "OpenTelemetry tracer providers. Configure one shared provider "
            "before monitor_livekit."
        )
    if concrete:
        return next(iter(concrete.values()))

    return TracerProvider(
        resource=Resource.create({SERVICE_NAME: "livekit-agents"})
    )


def _register_provider(provider: TracerProvider) -> None:
    """Make LiveKit and ordinary OpenTelemetry instrumentation share it."""

    global_provider = trace.get_tracer_provider()
    if isinstance(global_provider, trace.ProxyTracerProvider):
        trace.set_tracer_provider(provider)
    set_tracer_provider(provider)


def _build_exporter(endpoint: str, api_key: str) -> SpanExporter:
    try:
        return OTLPSpanExporter(
            endpoint=endpoint,
            headers={"Authorization": f"Bearer {api_key}"},
        )
    except Exception:
        # Exporter libraries can include constructor arguments in exception
        # text. Replace that text so a project key can never escape here.
        raise ValueError(
            "LiveKit monitoring could not create the Egma exporter. Check "
            "EGMA_URL and EGMA_API_KEY."
        ) from None


def _configure_provider(
    provider: TracerProvider, endpoint: str, api_key: str
) -> None:
    """Attach one safe Egma processor and register its shared provider."""

    exporter = _build_exporter(endpoint, api_key)
    try:
        processor = BatchSpanProcessor(exporter)
        _register_provider(provider)
        provider.add_span_processor(processor)
    except Exception:
        # Telemetry libraries can include exporter state in exception text.
        # Close the unused exporter and replace that text with a safe message.
        try:
            exporter.shutdown()
        except Exception:
            pass
        raise ValueError(
            "LiveKit monitoring could not configure the Egma exporter. "
            "Check the worker's OpenTelemetry setup."
        ) from None


def _register_shutdown_flush(ctx: JobContext, provider: TracerProvider) -> None:
    if getattr(ctx, _FLUSH_MARKER, False):
        return

    async def flush() -> None:
        try:
            flushed = await asyncio.to_thread(provider.force_flush)
        except Exception:
            logger.warning(
                "LiveKit monitoring could not flush every buffered span "
                "before this job stopped"
            )
            return
        if not flushed:
            logger.warning(
                "LiveKit monitoring could not flush every buffered span "
                "before this job stopped"
            )

    ctx.add_shutdown_callback(flush)
    setattr(ctx, _FLUSH_MARKER, True)
