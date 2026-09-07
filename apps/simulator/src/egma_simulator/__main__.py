"""Simulator entrypoint: load environment settings, redact credentials, and claim work.
The first SIGTERM or SIGINT stops claims and drains active simulations.
A second signal cancels them; the control plane sweeps unreported work.
Compose stop_grace_period bounds draining before Docker forces termination.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys

from .config import SimulatorConfig
from .platform_logging import json_log_formatter
from .redaction import RedactingFilter, SecretRegistry


def _configure_logging(level: str, registry: SecretRegistry) -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(json_log_formatter(registry))
    handler.addFilter(RedactingFilter(registry))
    root = logging.getLogger()
    root.setLevel(level.upper())
    root.addHandler(handler)
    _gather_loguru(level)


def _gather_loguru(level: str) -> None:
    """Route Pipecat loguru records through standard logging and credential redaction.
    Preserve exception information for safe class and frame fields; omit runtime
    messages and source lines from emitted exception details.
    """
    from loguru import logger as loguru_logger

    def hand_over(message) -> None:
        record = message.record
        failure = record["exception"]
        exc_info = (
            (failure.type, failure.value, failure.traceback)
            if failure is not None
            else None
        )
        logging.getLogger(record["name"]).log(
            record["level"].no,
            record["message"],
            exc_info=exc_info,
        )

    loguru_logger.remove()
    loguru_logger.add(hand_over, level=level.upper())


def secrets_of(config: SimulatorConfig) -> SecretRegistry:
    """Register deployment secrets for redaction: media, storage, and service token.
    The service registers provider credentials received with each claim.
    """
    registry = SecretRegistry()
    for secret in (
        config.service_token,
        *config.media_secrets,
        *config.object_store_secrets,
    ):
        if secret is not None:
            registry.register(secret)
    return registry


async def _run(config: SimulatorConfig) -> None:
    registry = secrets_of(config)
    _configure_logging(config.log_level, registry)

    # Pipecat writes a Loguru banner while the service module is imported.
    # Import only after Loguru is gathered so that record uses the same JSON
    # and redaction path as every later third-party record.
    from .service import SimulatorService

    service = SimulatorService(config, secrets=registry)
    task = asyncio.ensure_future(service.run())

    loop = asyncio.get_running_loop()

    def on_stop_signal() -> None:
        # The first signal drains; the second is the hard stop an operator
        # still deserves when a drain is not what they meant.
        if service.stop_requested:
            task.cancel()
        else:
            service.request_stop()

    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, on_stop_signal)

    try:
        await task
    except asyncio.CancelledError:
        pass


def main() -> None:
    try:
        config = SimulatorConfig.from_env()
    except ValueError as misconfigured:
        # A container that cannot start says one thing, and it is the
        # sentence naming the variable to fix. A traceback down through
        # the standard library would bury it under frames nobody deploying
        # this can act on — and this is written before logging is
        # configured, because configuring it is one of the things that
        # could have gone wrong.
        print(f"egma-simulator cannot start: {misconfigured}", file=sys.stderr)
        raise SystemExit(1) from None
    asyncio.run(_run(config))


if __name__ == "__main__":
    main()
