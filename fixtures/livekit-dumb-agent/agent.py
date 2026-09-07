"""LiveKit receptionist fixture for chat, voice, monitoring, and mock-tool tests.
check_availability and opening_hours return fixed values without backend access.
Keeping both lets tests mock one tool while the other runs its implementation.

Call simulation() after creating agent and session, before session.start().
It configures mock tools and agent POV export in simulation rooms and does nothing
in production rooms. Failed simulation setup propagates and prevents startup.

The egma-sim-chat- prefix disables audio and transcription pacing for chat.
Dispatch metadata supplies optional tenant context, logged without speaking it.
monitor() runs when either export setting is present; simulations require
EGMA_URL and EGMA_API_KEY too.

Set EGMA_DUMB_AGENT_NAME for explicit dispatch and OPENAI_API_KEY for all models.
See README.md for environment setup, then run: uv run agent.py dev
"""

import json
import logging
import os

from egma import monitor, simulation
from livekit import agents
from livekit.agents import Agent, AgentSession, function_tool, room_io
from livekit.plugins import openai, silero

INSTRUCTIONS = (
    "You are the front-desk receptionist at Maple Street Dental. "
    "You can discuss appointments: booking, moving, or cancelling them. "
    "Always call check_availability before you say anything about free "
    "slots, and never guess at the calendar. "
    "If the day the caller asks for has nothing free, say so plainly and "
    "offer them another day. "
    "Keep every reply to one or two short sentences. "
    "When the caller is done, say goodbye politely."
)

logger = logging.getLogger("dumb-agent")

TENANT_KEY = "tenant"
"""Customer-owned metadata key used to verify test context reaches the worker."""


def dispatched_world(metadata: str) -> dict:
    """Read optional dispatch metadata, returning an empty mapping for invalid JSON."""
    try:
        world = json.loads(metadata or "{}")
    except ValueError:
        return {}
    return world if isinstance(world, dict) else {}


MORNING_SLOT = "9:40"
AFTERNOON_SLOT = "2:15"
"""Fixed calendar values; no backend, network, or clock dependency."""


class FrontDesk(Agent):
    """Concrete agent class because LiveKit mock substitution is keyed by agent type."""

    def __init__(self) -> None:
        super().__init__(instructions=INSTRUCTIONS)

    @function_tool
    async def check_availability(self, day: str) -> str:
        """Look up the free appointment slots on one day.

        Args:
            day: The day the caller asked about, in their own words.
        """
        return (
            f"{day} has two slots free: {MORNING_SLOT} in the morning and "
            f"{AFTERNOON_SLOT} in the afternoon."
        )

    @function_tool
    async def opening_hours(self) -> str:
        """Read out the hours the practice is open."""
        return (
            "Maple Street Dental is open 8am to 6pm on weekdays and 9am to "
            "1pm on Saturday."
        )


def prewarm(proc: agents.JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


async def entrypoint(ctx: agents.JobContext) -> None:
    # Monitoring is optional for standalone production runs. If either export setting
    # is present, validate the pair; simulation() requires both for simulation rooms.
    if os.environ.get("EGMA_URL") or os.environ.get("EGMA_API_KEY"):
        monitor(ctx)
    # Log the test-owned tenant value so the live test can verify dispatch delivery.
    world = dispatched_world(ctx.job.metadata)
    logger.info("dispatched %s=%r", TENANT_KEY, world.get(TENANT_KEY))
    await ctx.connect()
    agent = FrontDesk()
    session = AgentSession(
        vad=ctx.proc.userdata["vad"],
        stt=openai.STT(model="gpt-4o-mini-transcribe"),
        llm=openai.LLM(model="gpt-4o-mini"),
        tts=openai.TTS(model="gpt-4o-mini-tts", voice="ash"),
    )
    # Attach mocks after tools exist and before the session starts.
    await simulation(agent, ctx, session)
    # Only chat simulation rooms disable speech and transcription pacing.
    chat = ctx.job.room.name.startswith("egma-sim-chat-")
    options = (
        room_io.RoomOptions(
            audio_input=False,
            audio_output=False,
            text_output=room_io.TextOutputOptions(sync_transcription=False),
        )
        if chat
        else room_io.RoomOptions()
    )
    await session.start(agent=agent, room=ctx.room, room_options=options)
    await session.generate_reply(
        instructions="Greet the caller with the practice name and ask how you can help."
    )


if __name__ == "__main__":
    agents.cli.run_app(
        agents.WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
            agent_name=os.environ.get("EGMA_DUMB_AGENT_NAME", "").strip(),
        )
    )
