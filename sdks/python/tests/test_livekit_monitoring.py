"""The LiveKit monitoring helper, from setup through the last span.

These tests never use an external service. They use real OpenTelemetry
providers, in-memory exporters, and one local HTTP collector. This proves that
Egma is added beside existing telemetry only once and that a LiveKit job
flushes Egma's own processor when it stops.
"""

from __future__ import annotations

import queue
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from room_stub import egma_metadata

from egma import monitor_livekit
from egma import monitoring as livekit_monitoring

PROJECT_KEY = f"egma_sk_{'a' * 43}"


@dataclass
class StubJob:
    metadata: str = ""


@dataclass(eq=False)
class StubJobContext:
    """A LiveKit job context, down to its shutdown callback contract."""

    job: StubJob = field(default_factory=StubJob)
    shutdown_callbacks: list[Any] = field(default_factory=list)

    def add_shutdown_callback(self, callback: Any) -> None:
        self.shutdown_callbacks.append(callback)


@pytest.fixture(autouse=True)
def reset_monitoring_state(monkeypatch):
    """Give every test a process that has not configured Egma yet."""

    monkeypatch.setattr(livekit_monitoring, "_state", None)


def install_provider(monkeypatch, provider: TracerProvider) -> None:
    """Keep a test provider local instead of changing Python's global one."""

    monkeypatch.setattr(
        livekit_monitoring, "_select_compatible_provider", lambda: provider
    )
    monkeypatch.setattr(
        livekit_monitoring, "_register_provider", lambda selected: None
    )


def test_environment_configures_the_exact_egma_trace_endpoint(monkeypatch):
    provider = TracerProvider()
    install_provider(monkeypatch, provider)
    built_with: list[tuple[str, str]] = []

    def build_exporter(endpoint: str, api_key: str) -> InMemorySpanExporter:
        built_with.append((endpoint, api_key))
        return InMemorySpanExporter()

    monkeypatch.setattr(livekit_monitoring, "_build_exporter", build_exporter)
    monkeypatch.setenv("EGMA_URL", "https://api.egma.ai/")
    monkeypatch.setenv("EGMA_API_KEY", PROJECT_KEY)
    context = StubJobContext()

    monitor_livekit(context)

    assert built_with == [
        ("https://api.egma.ai/v1/traces", PROJECT_KEY)
    ]
    assert len(context.shutdown_callbacks) == 1
    provider.shutdown()


async def test_real_exporter_posts_protobuf_with_the_project_key(monkeypatch):
    received: queue.Queue[tuple[str, str, str, bytes]] = queue.Queue()

    class Collector(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            body = self.rfile.read(int(self.headers["content-length"]))
            received.put(
                (
                    self.path,
                    self.headers["authorization"],
                    self.headers["content-type"],
                    body,
                )
            )
            self.send_response(200)
            self.send_header("content-type", "application/x-protobuf")
            self.end_headers()

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Collector)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    provider = TracerProvider()
    install_provider(monkeypatch, provider)
    context = StubJobContext()
    key = PROJECT_KEY

    try:
        monitor_livekit(
            context,
            endpoint=f"http://127.0.0.1:{server.server_port}",
            api_key=key,
        )
        with provider.get_tracer("livekit-agents").start_as_current_span("call"):
            pass
        await context.shutdown_callbacks[0]()

        path, authorization, content_type, body = received.get(timeout=1)
        assert path == "/v1/traces"
        assert authorization == f"Bearer {key}"
        assert content_type == "application/x-protobuf"
        assert body
    finally:
        server.shutdown()
        server.server_close()
        provider.shutdown()


def test_an_egma_simulation_does_not_create_a_production_exporter(monkeypatch):
    monkeypatch.delenv("EGMA_URL", raising=False)
    monkeypatch.delenv("EGMA_API_KEY", raising=False)
    context = StubJobContext(job=StubJob(metadata=egma_metadata()))

    monitor_livekit(context)

    assert livekit_monitoring._state is None
    assert context.shutdown_callbacks == []


@pytest.mark.parametrize(
    ("environment", "said"),
    [
        ({"EGMA_API_KEY": PROJECT_KEY}, "EGMA_URL"),
        ({"EGMA_URL": "https://api.egma.ai"}, "EGMA_API_KEY"),
    ],
)
def test_missing_configuration_names_the_setting_without_showing_a_key(
    monkeypatch, environment, said
):
    monkeypatch.delenv("EGMA_URL", raising=False)
    monkeypatch.delenv("EGMA_API_KEY", raising=False)
    for name, value in environment.items():
        monkeypatch.setenv(name, value)

    with pytest.raises(ValueError) as refused:
        monitor_livekit(StubJobContext())

    assert said in str(refused.value)
    assert PROJECT_KEY not in str(refused.value)


def test_invalid_endpoint_never_echoes_a_credential(monkeypatch):
    secret = "egma_sk_do_not_repeat"

    with pytest.raises(ValueError) as refused:
        monitor_livekit(
            StubJobContext(),
            endpoint="file:///tmp/collector",
            api_key=secret,
        )

    assert "HTTP" in str(refused.value)
    assert secret not in str(refused.value)


@pytest.mark.parametrize(
    "invalid_key",
    [
        "not-an-egma-key",
        "egma_sk_short",
        f"egma_sk_{'a' * 42}",
        f"egma_sk_{'a' * 44}",
        f"egma_sk_{'a' * 42}*",
        f"egma_sk_{'a' * 21}\n{'a' * 21}",
    ],
)
def test_invalid_project_key_is_refused_before_exporter_setup(invalid_key):
    with pytest.raises(ValueError) as refused:
        monitor_livekit(
            StubJobContext(),
            endpoint="https://api.egma.ai",
            api_key=invalid_key,
        )

    assert "invalid EGMA_API_KEY" in str(refused.value)
    assert invalid_key not in str(refused.value)


def test_processor_setup_failure_never_echoes_a_credential(monkeypatch):
    provider = TracerProvider()
    install_provider(monkeypatch, provider)
    secret = f"egma_sk_{'b' * 43}"
    monkeypatch.setattr(
        livekit_monitoring,
        "_build_exporter",
        lambda _endpoint, _key: InMemorySpanExporter(),
    )

    def refuse_processor(_exporter):
        raise RuntimeError(secret)

    monkeypatch.setattr(
        livekit_monitoring, "BatchSpanProcessor", refuse_processor
    )

    with pytest.raises(ValueError) as refused:
        monitor_livekit(
            StubJobContext(),
            endpoint="https://api.egma.ai",
            api_key=secret,
        )

    assert "exporter" in str(refused.value)
    assert secret not in str(refused.value)
    provider.shutdown()


async def test_existing_telemetry_and_egma_both_receive_the_same_span(
    monkeypatch,
):
    provider = TracerProvider()
    existing = InMemorySpanExporter()
    egma = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(existing))
    monkeypatch.setattr(livekit_monitoring, "_livekit_provider", lambda: provider)
    monkeypatch.setattr(
        livekit_monitoring.trace, "get_tracer_provider", lambda: provider
    )
    registered: list[TracerProvider] = []
    monkeypatch.setattr(
        livekit_monitoring,
        "set_tracer_provider",
        lambda selected: registered.append(selected),
    )
    monkeypatch.setattr(
        livekit_monitoring, "_build_exporter", lambda _endpoint, _key: egma
    )
    context = StubJobContext()

    monitor_livekit(
        context,
        endpoint="https://api.egma.ai",
        api_key=PROJECT_KEY,
    )
    with provider.get_tracer("livekit-agents").start_as_current_span("session"):
        pass

    await context.shutdown_callbacks[0]()

    assert registered == [provider]
    assert [span.name for span in existing.get_finished_spans()] == ["session"]
    assert [span.name for span in egma.get_finished_spans()] == ["session"]
    provider.shutdown()


@pytest.mark.parametrize("other_flush_result", [None, False])
async def test_shared_telemetry_cannot_block_egmas_shutdown_flush(
    monkeypatch, caplog, other_flush_result
):
    class NoFlushResult(SpanProcessor):
        def on_start(self, span, parent_context=None):
            return None

        def on_end(self, span):
            return None

        def shutdown(self):
            return None

        def force_flush(self, timeout_millis=30_000):
            return other_flush_result

    class DeterministicBatchProcessor(SpanProcessor):
        def __init__(self, exporter):
            self.exporter = exporter
            self.pending = []

        def on_start(self, span, parent_context=None):
            return None

        def on_end(self, span):
            self.pending.append(span)

        def shutdown(self):
            self.force_flush()
            self.exporter.shutdown()

        def force_flush(self, timeout_millis=30_000):
            self.exporter.export(tuple(self.pending))
            self.pending.clear()
            return True

    provider = TracerProvider()
    provider.add_span_processor(NoFlushResult())
    install_provider(monkeypatch, provider)
    egma = InMemorySpanExporter()
    monkeypatch.setattr(
        livekit_monitoring, "BatchSpanProcessor", DeterministicBatchProcessor
    )
    monkeypatch.setattr(
        livekit_monitoring, "_build_exporter", lambda _endpoint, _key: egma
    )
    context = StubJobContext()

    monitor_livekit(
        context,
        endpoint="https://api.egma.ai",
        api_key=PROJECT_KEY,
    )
    with provider.get_tracer("livekit-agents").start_as_current_span("session"):
        pass

    await context.shutdown_callbacks[0]()

    assert [span.name for span in egma.get_finished_spans()] == ["session"]
    assert "could not flush" not in caplog.text
    provider.shutdown()


def test_repeated_setup_adds_one_exporter_and_one_job_callback(monkeypatch):
    provider = TracerProvider()
    install_provider(monkeypatch, provider)
    exporters: list[InMemorySpanExporter] = []

    def build_exporter(_endpoint: str, _key: str) -> InMemorySpanExporter:
        exporter = InMemorySpanExporter()
        exporters.append(exporter)
        return exporter

    monkeypatch.setattr(livekit_monitoring, "_build_exporter", build_exporter)
    context = StubJobContext()

    for _ in range(2):
        monitor_livekit(
            context,
            endpoint="https://api.egma.ai/v1/traces",
            api_key=PROJECT_KEY,
        )

    assert len(exporters) == 1
    assert len(context.shutdown_callbacks) == 1
    provider.shutdown()


def test_a_second_job_reuses_the_exporter_but_gets_its_own_flush(monkeypatch):
    provider = TracerProvider()
    install_provider(monkeypatch, provider)
    exporters: list[InMemorySpanExporter] = []
    monkeypatch.setattr(
        livekit_monitoring,
        "_build_exporter",
        lambda _endpoint, _key: exporters.append(InMemorySpanExporter())
        or exporters[-1],
    )
    first = StubJobContext()
    second = StubJobContext()

    for context in (first, second):
        monitor_livekit(
            context,
            endpoint="https://api.egma.ai",
            api_key=PROJECT_KEY,
        )

    assert len(exporters) == 1
    assert len(first.shutdown_callbacks) == 1
    assert len(second.shutdown_callbacks) == 1
    provider.shutdown()


def test_one_existing_provider_is_reused_by_both_telemetry_surfaces(monkeypatch):
    provider = TracerProvider()
    monkeypatch.setattr(livekit_monitoring, "_livekit_provider", lambda: provider)
    monkeypatch.setattr(
        livekit_monitoring.trace, "get_tracer_provider", lambda: provider
    )

    assert livekit_monitoring._select_compatible_provider() is provider
    provider.shutdown()


def test_livekit_noop_provider_is_treated_as_not_configured(monkeypatch):
    noop = livekit_monitoring.trace.NoOpTracerProvider()
    proxy = livekit_monitoring.trace.ProxyTracerProvider()
    monkeypatch.setattr(livekit_monitoring, "_livekit_provider", lambda: noop)
    monkeypatch.setattr(
        livekit_monitoring.trace, "get_tracer_provider", lambda: proxy
    )

    provider = livekit_monitoring._select_compatible_provider()

    assert isinstance(provider, TracerProvider)
    provider.shutdown()


def test_two_existing_providers_are_refused_instead_of_replacing_one(monkeypatch):
    livekit_provider = TracerProvider()
    global_provider = TracerProvider()
    monkeypatch.setattr(
        livekit_monitoring, "_livekit_provider", lambda: livekit_provider
    )
    monkeypatch.setattr(
        livekit_monitoring.trace,
        "get_tracer_provider",
        lambda: global_provider,
    )

    with pytest.raises(ValueError, match="different"):
        livekit_monitoring._select_compatible_provider()

    livekit_provider.shutdown()
    global_provider.shutdown()


def test_changing_configuration_requires_a_worker_restart(monkeypatch):
    provider = TracerProvider()
    install_provider(monkeypatch, provider)
    monkeypatch.setattr(
        livekit_monitoring,
        "_build_exporter",
        lambda _endpoint, _key: InMemorySpanExporter(),
    )
    context = StubJobContext()
    monitor_livekit(
        context,
        endpoint="https://api.egma.ai",
        api_key=f"egma_sk_{'a' * 43}",
    )

    with pytest.raises(ValueError) as refused:
        monitor_livekit(
            context,
            endpoint="https://api.egma.ai",
            api_key=f"egma_sk_{'b' * 43}",
        )

    assert "Restart" in str(refused.value)
    assert f"egma_sk_{'a' * 43}" not in str(refused.value)
    assert f"egma_sk_{'b' * 43}" not in str(refused.value)
    provider.shutdown()


async def test_shutdown_failure_is_safe_and_does_not_stop_the_job(caplog):
    secret = "egma_sk_do_not_repeat"

    class RefusingProcessor:
        def force_flush(self):
            raise RuntimeError(secret)

    context = StubJobContext()
    livekit_monitoring._register_shutdown_flush(context, RefusingProcessor())

    await context.shutdown_callbacks[0]()

    assert "could not flush" in caplog.text
    assert secret not in caplog.text
