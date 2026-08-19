"""The simulator's stdout contract: JSON fields, context, and redaction."""

from __future__ import annotations

import asyncio
import io
import json
import logging
from contextlib import contextmanager

from egma_simulator.platform_logging import (
    json_log_formatter,
    log_event,
    simulation_log_context,
)
from egma_simulator.redaction import RedactingFilter, SecretRegistry


@contextmanager
def captured_logger(registry: SecretRegistry):
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.addFilter(RedactingFilter(registry))
    handler.setFormatter(json_log_formatter(registry))
    logger = logging.getLogger(f"{__name__}.{id(stream)}")
    logger.handlers = [handler]
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    try:
        yield logger, stream
    finally:
        logger.handlers = []
        handler.close()


async def test_each_async_simulation_gets_its_own_otel_json_record():
    registry = SecretRegistry()
    with captured_logger(registry) as (logger, stream):

        async def emit(simulation_id: str) -> None:
            with simulation_log_context(simulation_id):
                await asyncio.sleep(0)
                log_event(
                    logger,
                    logging.INFO,
                    "egma.simulation.started",
                    "simulation started",
                    attributes={
                        "egma.outcome": simulation_id,
                        "not.allowed": {"nested": "objects"},
                    },
                )

        await asyncio.gather(emit("sim-one"), emit("sim-two"))

    records = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert {record["egma.simulation_id"] for record in records} == {
        "sim-one",
        "sim-two",
    }
    for record in records:
        assert record["timestamp"].endswith("Z")
        assert record["severity_text"] == "INFO"
        assert record["severity_number"] == 9
        assert record["otel.event.name"] == "egma.simulation.started"
        assert record["body"] == "simulation started"
        assert record["egma.log_schema_version"] == 1
        assert record["egma.outcome"] == record["egma.simulation_id"]
        assert "not.allowed" not in record


def test_exception_keeps_safe_frames_but_drops_runtime_message():
    secret = "SENTINEL-platform-log-secret-91d7"
    registry = SecretRegistry()
    registry.register(secret)

    with captured_logger(registry) as (logger, stream):
        with simulation_log_context("sim-failed"):
            try:
                raise RuntimeError(f"provider refused {secret}")
            except RuntimeError:
                log_event(
                    logger,
                    logging.ERROR,
                    "egma.simulation.finished",
                    "simulation failed",
                    attributes={
                        "egma.outcome": "failed",
                        "error.type": "RuntimeError",
                    },
                    exc_info=True,
                )

    output = stream.getvalue()
    record = json.loads(output)
    assert secret not in output
    assert record["severity_text"] == "ERROR"
    assert record["severity_number"] == 17
    assert record["exception.type"] == "RuntimeError"
    assert "exception.message" not in record
    assert "provider refused" not in output
    assert "raise RuntimeError" not in output
    assert "test_platform_logging.py:" in record["exception.stacktrace"]
    assert "test_exception_keeps_safe_frames_but_drops_runtime_message" in record[
        "exception.stacktrace"
    ]


def test_foreign_log_message_is_not_exported():
    registry = SecretRegistry()
    with captured_logger(registry) as (logger, stream):
        logger.error("validator repeated credential %s", "private-value")

    output = stream.getvalue()
    record = json.loads(output)
    assert "private-value" not in output
    assert record["otel.event.name"] == "egma.log"
    assert record["body"] == "unstructured service log emitted"
