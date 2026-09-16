from types import SimpleNamespace

import pytest
from pipecat.audio.turn.base_turn_analyzer import (
    BaseTurnAnalyzer,
    BaseTurnParams,
    EndOfTurnState,
)
from pipecat.frames.frames import (
    STTMetadataFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.tests.utils import SleepFrame, run_test
from pipecat.turns.user_start import VADUserTurnStartStrategy
from pipecat.turns.user_stop import (
    SpeechTimeoutUserTurnStopStrategy,
    TurnAnalyzerUserTurnStopStrategy,
)
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from egma_simulator.conductor import _AgentTurnProcessor, _PersonaBrain


class CompleteTurn(BaseTurnAnalyzer):
    @property
    def speech_triggered(self):
        return True

    @property
    def params(self):
        return BaseTurnParams()

    def append_audio(self, buffer, is_speech):
        return EndOfTurnState.INCOMPLETE

    async def analyze_end_of_turn(self):
        return EndOfTurnState.COMPLETE, None

    def clear(self):
        pass


@pytest.mark.parametrize("delay", [0.005, 0.05])
@pytest.mark.parametrize("strategy", ["speech_timeout", "turn_analyzer"])
async def test_transcript_arriving_after_stop_wait_reaches_the_persona(delay, strategy):
    heard = []

    async def finished(said, heard_a_turn):
        heard.append(said)
        return None

    def failed(error):
        raise error

    conductor = SimpleNamespace(
        deliberate_response_owned=False,
        the_agent_finished=finished,
        the_brain_failed=failed,
    )
    turns = _AgentTurnProcessor(
        user_turn_strategies=UserTurnStrategies(
            start=[VADUserTurnStartStrategy(enable_interruptions=False)],
            stop=[
                SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.01)
                if strategy == "speech_timeout"
                else TurnAnalyzerUserTurnStopStrategy(turn_analyzer=CompleteTurn())
            ],
        ),
    )
    brain = _PersonaBrain(
        persona=None,
        conductor=conductor,
        replies=SimpleNamespace(busy=False),
    )
    await run_test(
        Pipeline([turns, brain]),
        frames_to_send=[
            STTMetadataFrame(service_name="diagnosis", ttfs_p99_latency=0.03),
            VADUserStartedSpeakingFrame(),
            SleepFrame(sleep=0.02),
            VADUserStoppedSpeakingFrame(stop_secs=0.01),
            SleepFrame(sleep=delay),
            TranscriptionFrame(
                "Saturday is unavailable.", "agent", "2026-09-16T17:43:36Z"
            ),
            SleepFrame(sleep=0.05),
        ],
    )
    assert heard == ["Saturday is unavailable."]
