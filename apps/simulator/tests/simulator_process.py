"""Run the real simulator service with explicit test-only model seams.

The production module has no scripted fallback. Black-box tests still need
deterministic persona replies and, unless a live speech test asks otherwise,
deterministic audio legs. This child-process entry point injects those test
implementations before it starts the same service loop used in production.
"""

# ruff: noqa: E402 -- removing Loguru's sink before service imports is the test seam
from __future__ import annotations

import logging
import sys

from loguru import logger as loguru_logger

# This test entry point imports the service early so it can replace two
# explicit provider seams. Production imports it only after Loguru is gathered
# into the redacting JSON logger. Remove Loguru's default sink here so the test
# does not create an unstructured path that production does not have; main()
# installs the real gathered sink before the service starts.
loguru_logger.remove()

from egma_simulator import service
from egma_simulator.__main__ import main
from egma_simulator.model import ScriptedModel
from egma_simulator.speech import SCRIPTED_PAIR


class _DrainLogWitness(logging.Filter):
    """Expose one safe service log as a fixed test-only output marker."""

    def filter(self, record: logging.LogRecord) -> bool:
        return record.name == service.__name__ and record.getMessage().startswith(
            "stop requested; claiming nothing new"
        )


if "--observe-drain" in sys.argv:
    drain_witness = logging.StreamHandler(sys.stderr)
    drain_witness.addFilter(_DrainLogWitness())
    drain_witness.setFormatter(
        logging.Formatter('{"egma.test.event":"service_drain_started","body":"%(message)s"}')
    )
    service.logger.addHandler(drain_witness)


def _scripted_model(spec):
    return ScriptedModel(spec.scenario_instructions)


if "--direct-model" not in sys.argv:
    service.build_model_client = _scripted_model

if "--direct-speech" not in sys.argv:
    service.SpeechProviders.from_models = classmethod(
        lambda _cls, _models, *, vad: SCRIPTED_PAIR
    )

main()
