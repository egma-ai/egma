"""Credential redaction for everything this process logs.

A claimed spec can hold connection credentials, the selected model-provider
keys, and a phone route's SIP password. The discipline is to never log a spec
at all — but a discipline is not a guarantee, so every secret value that enters
the process is also registered here. A logging filter rewrites any record that
carries one before a handler can emit it. The acceptance suite closes the loop
from outside: it plants sentinel secrets and scans every byte the process
writes.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable

from .platform_logging import LOG_ATTRIBUTES

REDACTED = "[redacted]"


def credential_values(credentials: object) -> Iterable[str]:
    """Every string leaf inside one registered secret-bearing value."""
    if isinstance(credentials, str):
        if credentials:
            yield credentials
    elif isinstance(credentials, dict):
        for value in credentials.values():
            yield from credential_values(value)
    elif isinstance(credentials, list):
        for value in credentials:
            yield from credential_values(value)


class SecretRegistry:
    """The credential values currently held anywhere in the process.

    Values are registered when a spec is claimed and never unregistered:
    a secret does not stop being one when its simulation ends, and the set
    stays small for the life of a process.
    """

    def __init__(self) -> None:
        self._values: set[str] = set()

    def register(self, credentials: object) -> None:
        self._values.update(credential_values(credentials))

    def redact(self, text: str) -> str:
        for value in self._values:
            if value in text:
                text = text.replace(value, REDACTED)
        return text


class RedactingFilter(logging.Filter):
    """Rewrites any log record that carries a registered credential value.

    Installed on handlers, not loggers, so records from every library that
    logs through the stdlib pass through it. The record's message is
    rendered early and its args dropped: a lazy ``%s`` argument holding a
    secret would otherwise be formatted after filtering. Structured string
    attributes take the same path. The structlog processor applies this same
    registry after it extracts the safe exception class and frame locations,
    so those fields are also scrubbed before output.
    """

    def __init__(self, registry: SecretRegistry) -> None:
        super().__init__()
        self._registry = registry

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = self._registry.redact(record.getMessage())
        record.args = ()

        attributes = dict(getattr(record, LOG_ATTRIBUTES, {}))
        for key, value in attributes.items():
            if isinstance(value, str):
                attributes[key] = self._registry.redact(value)

        setattr(record, LOG_ATTRIBUTES, attributes)
        return True
