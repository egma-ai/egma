"""``python -m egma_simulator`` — the standing simulator process.

Reads its whole configuration from ``EGMA_SIMULATOR_*`` environment
variables, installs the credential-redacting log filter, and claims work
until told to stop. SIGTERM and SIGINT stop it the honest way: in-flight
exchanges are torn down and nothing terminal is invented for them — the
control plane's orphan sweep records what a disappearing simulator means.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys

from .config import SimulatorConfig
from .redaction import RedactingFilter, SecretRegistry
from .service import SimulatorService


def _configure_logging(level: str, registry: SecretRegistry) -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    handler.addFilter(RedactingFilter(registry))
    root = logging.getLogger()
    root.setLevel(level.upper())
    root.addHandler(handler)


async def _run() -> None:
    registry = SecretRegistry()
    config = SimulatorConfig.from_env()
    # The model key is configuration rather than a spec's credential, but it
    # is a secret all the same, and the same filter keeps it out of logs.
    if config.model_api_key is not None:
        registry.register(config.model_api_key)
    _configure_logging(config.log_level, registry)

    service = SimulatorService(config, secrets=registry)
    task = asyncio.ensure_future(service.run())

    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, task.cancel)

    try:
        await task
    except asyncio.CancelledError:
        pass


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
