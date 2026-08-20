"""``python -m egma_simulator`` — the standing simulator process.

Reads its whole configuration from ``EGMA_SIMULATOR_*`` environment
variables, installs the credential-redacting log filter, and claims work
until told to stop. The first SIGTERM or SIGINT is the drain: claiming
ends, the exchanges in flight finish and report, and the process exits
when the last one has — so replacing this container drops nobody's call.
A second signal is the hard stop of old: in-flight exchanges are torn
down and nothing terminal is invented for them — the control plane's
orphan sweep records what a disappearing simulator means. The compose
file's ``stop_grace_period`` is the drain's ceiling; past it, Docker
kills the container and the sweep speaks for whatever remained.
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
    """Bring the voice legs' logging under the same roof as everything else.

    Pipecat logs through loguru, which writes to stderr on its own and so
    would miss both the configured level and the credential filter — and a
    filter with a way around it is not one. Every loguru record is handed
    to the standard library instead; the level numbers already agree.

    Exceptions stay as exception information so the JSON formatter can emit
    the class and safe frame locations. Runtime messages and source lines do
    not leave the process. The shared filter also scrubs the retained fields.
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
    """Every secret this configuration holds, registered for redaction.

    Provider keys arrive on each claim and are registered by the service.
    This function covers the standing deployment credentials: media,
    object storage, and the control-plane service token.

    Written as one function so that what a running simulator registers is
    the thing a test can ask about, rather than something that happens
    once inside a process nobody can inspect.
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
