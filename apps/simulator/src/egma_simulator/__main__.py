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
import traceback

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
    _gather_loguru(level)


def _gather_loguru(level: str) -> None:
    """Bring the voice legs' logging under the same roof as everything else.

    Pipecat logs through loguru, which writes to stderr on its own and so
    would miss both the configured level and the credential filter — and a
    filter with a way around it is not one. Every loguru record is handed
    to the standard library instead; the level numbers already agree.

    A traceback is rendered into the message rather than handed along as
    ``exc_info``, because the filter scrubs a record's message and nothing
    else: passed the other way, a credential inside an exception would go
    out unscrubbed. This way the diagnostic survives and is scrubbed.
    """
    from loguru import logger as loguru_logger

    def hand_over(message) -> None:
        record = message.record
        text = record["message"]
        failure = record["exception"]
        if failure is not None:
            text += "\n" + "".join(
                traceback.format_exception(
                    failure.type, failure.value, failure.traceback
                )
            )
        logging.getLogger(record["name"]).log(record["level"].no, text)

    loguru_logger.remove()
    loguru_logger.add(hand_over, level=level.upper())


def secrets_of(config: SimulatorConfig) -> SecretRegistry:
    """Every secret this configuration holds, registered for redaction.

    The model key, the speech-provider keys, the telephony secrets and
    the service token are configuration rather than a spec's credentials,
    but they are secrets all the same, and the same filter keeps them out
    of logs — which matters most for the speech legs and the media
    bridge, whose libraries log plenty on their own and would happily
    print a refusal with the secret inside it.

    Written as one function so that what a running simulator registers is
    the thing a test can ask about, rather than something that happens
    once inside a process nobody can inspect.
    """
    registry = SecretRegistry()
    for secret in (
        config.model_api_key,
        config.service_token,
        *config.speech_secrets,
        *config.media_secrets,
    ):
        if secret is not None:
            registry.register(secret)
    return registry


async def _run(config: SimulatorConfig) -> None:
    registry = secrets_of(config)
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
