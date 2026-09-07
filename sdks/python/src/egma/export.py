"""The one Egma exporter in this process, shared by both verbs.

:func:`egma.monitor` and :func:`egma.simulation` send the same thing to
the same door: this worker's OpenTelemetry spans, over OTLP, with the
project API key on them. They differ in one fact and one only — a
simulation stamps the room it runs in on every span, so egma can file the
agent's POV under the simulation that room belongs to. Everything else,
from reading ``EGMA_URL`` to flushing the last buffered span when the job
stops, is written once, here.

## Why the room name rides two ways at once

The **resource** is fixed when a tracer provider is built, and this SDK
does not always build one: a customer who already runs Langfuse, or any
other OpenTelemetry setup, hands us a provider that exists. That provider
must keep working — refusing it, or replacing it, would take a customer's
own tracing away to add ours.

So the room name goes on twice:

- as a **resource attribute**, where this SDK builds the provider itself;
- as a **span attribute on every span**, through LiveKit's own
  ``set_tracer_provider(..., metadata=…)`` seam, which works on any
  provider, including one this SDK did not make.

egma's door reads the resource first and falls back to the spans when
every span in a resource agrees. Both ways carry the same string, so an
export is filed the same wherever the provider came from.

## One job per process

A provider's resource cannot be rewritten and LiveKit's metadata
processor is added once, so the room name this process exports under is
decided by the first job that asks. LiveKit runs one job per process by
default and that is the arrangement both verbs are written for: a second
job asking for different settings is refused here, loudly, rather than
quietly filing one conversation's spans under another conversation's
name.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import threading
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit, urlunsplit

from livekit.agents.telemetry import set_tracer_provider
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter,
)
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter

logger = logging.getLogger("egma")

_TRACE_PATH = "/v1/traces"
_FLUSH_MARKER = "_egma_export_flush_registered"
_PROJECT_KEY_PATTERN = re.compile(r"egma_sk_[A-Za-z0-9_-]{43}\Z")

PROVIDER_REFERENCE = "egma.provider_reference"
"""What egma files a simulation's agent POV under: the room's name.

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


def flush_on(processor: BatchSpanProcessor, why: str) -> asyncio.Task[None]:
    """Send whatever is buffered now, without holding the caller up.

    A session closing is a moment worth flushing at and a synchronous
    callback, so the wait goes on the loop rather than in the callback.
    The task is handed back for the caller to hold, because a task nobody
    holds may be collected before it runs.
    """

    return asyncio.get_running_loop().create_task(_flushed(processor, why))


async def _flushed(processor: BatchSpanProcessor, why: str) -> None:
    try:
        flushed = await asyncio.to_thread(processor.force_flush)
    except Exception:
        logger.warning("Egma could not flush every buffered span at %s", why)
        return
    if not flushed:
        logger.warning("Egma could not flush every buffered span at %s", why)


def _setting(explicit: str | None, environment_name: str, verb: str) -> str:
    value = (
        explicit if explicit is not None else os.environ.get(environment_name)
    )
    if not isinstance(value, str) or not value.strip():
        raise ValueError(
            f"{verb} needs {environment_name}. Set it or pass the matching "
            "argument."
        )
    return value.strip()


def _project_key(value: str, verb: str) -> str:
    if _PROJECT_KEY_PATTERN.fullmatch(value) is None:
        raise ValueError(f"{verb} received an invalid EGMA_API_KEY.")
    return value


def _trace_endpoint(value: str, verb: str) -> str:
    """Turn an Egma API base URL into the OTLP trace endpoint."""

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
        raise ValueError(
            f"{verb} needs EGMA_URL to be a valid HTTP or HTTPS API URL."
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


def _build_exporter(endpoint: str, api_key: str, verb: str) -> SpanExporter:
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


def _configure_provider(
    provider: TracerProvider,
    endpoint: str,
    api_key: str,
    verb: str,
    provider_reference: str,
) -> BatchSpanProcessor:
    """Attach one safe Egma processor and register its shared provider."""

    exporter = _build_exporter(endpoint, api_key, verb)
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
