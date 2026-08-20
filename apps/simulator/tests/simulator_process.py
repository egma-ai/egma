"""Run the real simulator service with explicit test-only model seams.

The production module has no scripted fallback. Black-box tests still need
deterministic persona replies and, unless a live speech test asks otherwise,
deterministic audio legs. This child-process entry point injects those test
implementations before it starts the same service loop used in production.
"""

from __future__ import annotations

import sys

from egma_simulator import service
from egma_simulator.__main__ import main
from egma_simulator.model import ScriptedModel
from egma_simulator.speech import SCRIPTED_PAIR


def _scripted_model(_config, spec):
    return ScriptedModel(spec.scenario_instructions)


if "--direct-model" not in sys.argv:
    service.build_model_client = _scripted_model

if "--direct-speech" not in sys.argv:
    service.SpeechProviders.from_models = classmethod(
        lambda _cls, _models, *, vad: SCRIPTED_PAIR
    )

main()
