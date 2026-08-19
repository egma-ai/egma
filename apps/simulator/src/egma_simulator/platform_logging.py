"""Structured platform logs for the simulator.

``structlog`` does the standard-library integration, context binding,
exception handling, and JSON rendering. This module supplies only Egma's
OpenTelemetry field names, scalar allowlist, limits, and redaction policy.
"""

from __future__ import annotations

import json
import logging
import math
import traceback
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any, Protocol

import structlog

LOG_SCHEMA_VERSION = 1
LOG_ATTRIBUTES = "_egma_log_attributes"
EVENT_NAME = "otel.event.name"

_DEFAULT_EVENT_NAME = "egma.log"
_RESERVED_FIELDS = {
    "timestamp",
    "severity_text",
    "severity_number",
    EVENT_NAME,
    "body",
    "egma.log_schema_version",
}
_BODY_LIMIT = 4 * 1024
_ATTRIBUTE_LIMIT = 1024
_STACKTRACE_LIMIT = 16 * 1024


class Redactor(Protocol):
    def redact(self, text: str) -> str: ...


def _severity(level: int) -> tuple[str, int]:
    if level >= logging.CRITICAL:
        return "FATAL", 21
    if level >= logging.ERROR:
        return "ERROR", 17
    if level >= logging.WARNING:
        return "WARN", 13
    if level >= logging.INFO:
        return "INFO", 9
    if level >= logging.DEBUG:
        return "DEBUG", 5
    return "TRACE", 1


def _safe_scalar(value: object) -> bool:
    return (
        isinstance(value, (str, bool, int))
        or isinstance(value, float)
        and math.isfinite(value)
    )


def _safe_attributes(attributes: Mapping[str, object] | None) -> dict[str, object]:
    if attributes is None:
        return {}
    return {
        key: value
        for key, value in attributes.items()
        if isinstance(key, str)
        and key
        and key not in _RESERVED_FIELDS
        and value is not None
        and _safe_scalar(value)
    }


def _bounded(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit], True


def _exception_fields(exc_info: tuple[type, BaseException, Any]) -> dict[str, str]:
    """Keep the exception class and frame locations, never runtime text."""
    exception = exc_info[1]
    exception_type = type(exception)
    qualified_type = exception_type.__qualname__
    if exception_type.__module__ != "builtins":
        qualified_type = f"{exception_type.__module__}.{qualified_type}"
    fields = {"exception.type": qualified_type}
    frames = [
        f"{frame.f_code.co_filename}:{line_number} in {frame.f_code.co_name}"
        for frame, line_number in traceback.walk_tb(exc_info[2])
    ]
    if frames:
        fields["exception.stacktrace"] = "\n".join(frames)
    return fields


class _RedactSecrets:
    """Redact every string that can pass the scalar allowlist."""

    def __init__(self, redactor: Redactor) -> None:
        self._redactor = redactor

    def __call__(
        self, logger: object, method_name: str, event_dict: dict[str, Any]
    ) -> dict[str, Any]:
        del logger, method_name
        for key, value in event_dict.items():
            if isinstance(value, str):
                event_dict[key] = self._redactor.redact(value)
            elif key == "exception" and isinstance(value, dict):
                event_dict[key] = {
                    nested_key: self._redactor.redact(nested_value)
                    if isinstance(nested_value, str)
                    else nested_value
                    for nested_key, nested_value in value.items()
                }
        return event_dict


def _otel_record(
    logger: object, method_name: str, event_dict: dict[str, Any]
) -> dict[str, object]:
    """Allowlist and name the raw fields that the collector promotes."""
    del logger, method_name
    record = event_dict.get("_record")
    if not isinstance(record, logging.LogRecord):
        raise TypeError("structured log processing requires a LogRecord")

    severity_text, severity_number = _severity(record.levelno)
    event_name = getattr(record, EVENT_NAME, None)
    deliberate = isinstance(event_name, str) and event_name.startswith("egma.")
    if deliberate:
        body, body_truncated = _bounded(
            str(event_dict.get("event", "")), _BODY_LIMIT
        )
    else:
        # Third-party and legacy messages can contain provider payloads,
        # transcript text, or an invalid value repeated by a validator. Keep
        # their severity, logger, and safe exception fields, but never copy the
        # message itself into the platform log.
        event_name = _DEFAULT_EVENT_NAME
        body = "unstructured service log emitted"
        body_truncated = False
    if not isinstance(event_name, str) or not event_name:
        event_name = _DEFAULT_EVENT_NAME

    document: dict[str, object] = {
        "timestamp": datetime.fromtimestamp(record.created, UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "severity_text": severity_text,
        "severity_number": severity_number,
        EVENT_NAME: event_name,
        "body": body,
        "egma.log_schema_version": LOG_SCHEMA_VERSION,
        "logger.name": record.name,
    }

    attributes = _safe_attributes(getattr(record, LOG_ATTRIBUTES, None))
    context_simulation_id = event_dict.get("egma.simulation_id")
    if isinstance(context_simulation_id, str):
        attributes["egma.simulation_id"] = context_simulation_id
    exception = event_dict.get("exception")
    if isinstance(exception, dict):
        attributes.update(_safe_attributes(exception))

    truncated = body_truncated
    for key, value in attributes.items():
        if isinstance(value, str):
            limit = (
                _STACKTRACE_LIMIT
                if key == "exception.stacktrace"
                else _ATTRIBUTE_LIMIT
            )
            value, value_truncated = _bounded(value, limit)
            truncated = truncated or value_truncated
        document[key] = value
    if truncated:
        document["egma.log_truncated"] = True

    return document


def json_log_formatter(redactor: Redactor) -> logging.Formatter:
    """Build the structlog bridge for first-party and third-party records."""
    return structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.ExceptionRenderer(_exception_fields),
            _RedactSecrets(redactor),
            _otel_record,
        ],
        processors=[
            structlog.processors.JSONRenderer(
                serializer=json.dumps,
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        ],
    )


@contextmanager
def simulation_log_context(simulation_id: str) -> Iterator[None]:
    """Bind one simulation ID to this task and all tasks it creates."""
    with structlog.contextvars.bound_contextvars(
        **{"egma.simulation_id": simulation_id}
    ):
        yield


def log_event(
    logger: logging.Logger,
    level: int,
    event_name: str,
    body: str,
    *args: object,
    attributes: Mapping[str, object] | None = None,
    exc_info: object = None,
) -> None:
    """Name one stdlib event and pass safe attributes to structlog."""
    logger.log(
        level,
        body,
        *args,
        extra={
            EVENT_NAME: event_name,
            LOG_ATTRIBUTES: _safe_attributes(attributes),
        },
        exc_info=exc_info,
    )
