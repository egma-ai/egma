"""LiveKit chat connection using lk.chat and lk.transcription, without audio.
The shared room driver handles credentials, dispatch, and mock-tool RPC.
The egma-sim-chat- room prefix tells an integrated worker to disable speech.
Reject audio output because it means chat setup is missing.

The driver's take_turn() owns turn completion, stream draining, and ordering.
The agent SDK reports tool-call spans; this adapter does not infer tool calls
from text streams.
"""

from __future__ import annotations

from typing import Any

from ..contract import AGENT_NEVER_JOINED
from ..media import MediaBackendError
from ..media.livekit_room import AgentTurn, LiveKitChatRoomBackend
from ..mock_tools import MockToolSeam
from . import AgentReply, PlugError
from .livekit import AGENT_JOIN_SECONDS, build_driver, read_connection

# Share the voice connection's agent-join budget.

GREETING_SECONDS = 8.0
"""Time allowed for an optional greeting. If no greeting arrives, the persona speaks
first.
"""

REPLY_SECONDS = 30.0
"""Time allowed for the first answer to a persona turn, including model and tool work.
Expiry ends the exchange so a late answer cannot be assigned to the next turn.
"""

TURN_QUIET_SECONDS = 5.0
"""Fallback quiet period when no finished lk.agent.state signal arrives.
It must allow a real tool call between an agent's filler and final answer;
Egma cannot observe unmocked tool progress.

test_a_stateless_agent_may_take_a_slow_real_tool_inside_one_turn guards
against shortening this wait enough to discard the final answer.
"""

TURN_DRAIN_SECONDS = 15.0
"""Maximum wait for an opened text stream to finish after turn completion.
A stalled stream must not consume the full simulation duration.
The driver resets the wait when another utterance from the turn arrives.
"""

CHAT_SETUP_MISSING = (
    "the agent answered in speech rather than in text — audio published in "
    "the room, or words carrying LiveKit's transcribed-track mark — so it has "
    "not taken Egma's chat setup. A chat simulation needs the worker to read "
    "the modality off its room's name and start its session with audio input "
    "and output off and its transcription unsynchronised; Egma's LiveKit "
    "integration instructions carry the lines that do it"
)
"""Setup error for unexpected audio output in a chat simulation."""


class LiveKitChat:
    """One typed exchange with an agent in its own room, per instance."""

    def __init__(
        self,
        *,
        modality: str,
        access_variant: str,
        config: dict[str, Any],
        credentials: object,
        simulation_id: str,
        agent_version: object = None,
        dynamic_variables: object = None,
        job_dispatch_metadata: dict[str, Any] | None = None,
        mock_tools: MockToolSeam | None = None,
        media: object = None,
        driver: Any = None,
    ) -> None:
        # LiveKit forwards test dispatch metadata but has no platform agent version
        # or rendered-variable interface. This chat connection uses no phone media.
        del media, agent_version, dynamic_variables

        if modality != "chat":
            raise PlugError(
                f"the livekit chat plug speaks chat only; a {modality!r} "
                "simulation in a room needs the plug carrying the speech legs"
            )

        # Validate before connecting. driver is a test injection point.
        self._backend = build_driver(
            driver or LiveKitChatRoomBackend,
            settings=read_connection(access_variant, config, credentials),
            simulation_id=simulation_id,
            mock_tools=mock_tools,
            job_dispatch_metadata=job_dispatch_metadata,
        )
        self._reference: str | None = None
        # Retain the seam to verify hello after the agent joins.
        self._mock_tools = mock_tools

    @property
    def provider_reference(self) -> str | None:
        """The room this exchange was conducted in, once there is one."""
        return self._reference

    @property
    def backend(self) -> object:
        """Expose the room driver for tests."""
        return self._backend

    async def open(self) -> str | None:
        """Open the room, require Egma hello, and collect an optional greeting.
        Return None when the agent waits for the persona to speak first.
        """
        try:
            await self._backend.open_room()
            await self._backend.dial()
            self._reference = await self._backend.wait_arrived(AGENT_JOIN_SECONDS)
            if self._mock_tools is not None and not self._mock_tools.agent_reported:
                raise PlugError(
                    self._mock_tools.why_unreported, ending=AGENT_NEVER_JOINED
                )
            greeting = await self._backend.wait_greeting(
                GREETING_SECONDS,
                quiet_seconds=TURN_QUIET_SECONDS,
                drain_seconds=TURN_DRAIN_SECONDS,
            )
        except MediaBackendError as refused:
            raise PlugError(str(refused), ending=refused.ending) from refused
        _typing_or_nothing(greeting)
        return greeting.text

    async def deliver(self, text: str) -> AgentReply:
        """Type the persona's turn in, and read the agent's answer back."""
        try:
            answer = await self._backend.deliver(
                text,
                reply_seconds=REPLY_SECONDS,
                quiet_seconds=TURN_QUIET_SECONDS,
                drain_seconds=TURN_DRAIN_SECONDS,
            )
        except MediaBackendError as refused:
            raise PlugError(str(refused), ending=refused.ending) from refused
        _typing_or_nothing(answer)
        # The agent SDK reports tool-call spans; do not duplicate them in the reply.
        return AgentReply(
            text=answer.text,
            ended=answer.ended,
            tool_calls=(),
            # Use answer start, excluding the later turn-completion and drain waits.
            answered_at=answer.answer_began_at,
        )

    async def close(self) -> None:
        """Leave and clean up the room according to token authority; safe from every
        state.
        """
        await self._backend.teardown()


def _typing_or_nothing(turn: AgentTurn) -> None:
    """Reject audio at first output so speech is not evaluated as a chat simulation."""
    if turn.speaking:
        raise PlugError(CHAT_SETUP_MISSING)
