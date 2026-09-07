"""Register credential values and redact them before log output.
Do not log claimed specs. Acceptance tests inject sentinel secrets and scan output.
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
    """Filter handlers so standard-library logs also receive credential redaction.
    Render messages before clearing args; otherwise lazy formatting could expose
    secrets.
    Scrub structured strings and safe exception fields through the same registry.
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
