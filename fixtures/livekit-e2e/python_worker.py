"""Packaged Python SDK worker used by the LiveKit end-to-end lane."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Literal

from egma import simulation
from livekit import agents
from livekit.agents import Agent, AgentSession, function_tool, room_io
from livekit.plugins import openai, silero


class AppointmentAgent(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You schedule dental appointments. Always call "
                "check_availability exactly once, with day Tuesday, before you "
                "say whether Tuesday is free. Never check a different day. "
                "Then call record_request with day Tuesday and kind reschedule "
                "exactly once before answering. "
                "Keep each reply short."
            )
        )

    @function_tool
    async def check_availability(self, day: str) -> str:
        """Check whether the dental office has an appointment on one day.

        Args:
            day: The day the caller asks about.
        """
        sentinel = os.environ.get("EGMA_E2E_REAL_TOOL_SENTINEL", "")
        if sentinel:
            await asyncio.to_thread(Path(sentinel).write_text, day, encoding="utf-8")
        return "The real calendar has a Tuesday appointment at 9:40."

    @function_tool
    async def record_request(self, day: str, kind: Literal["reschedule"]) -> str:
        """Record an appointment request after availability was checked.

        Args:
            day: The requested appointment day.
            kind: The kind of appointment request.
        """
        sentinel = os.environ.get("EGMA_E2E_RECORD_REQUEST_SENTINEL", "")
        if sentinel:
            await asyncio.to_thread(
                Path(sentinel).write_text,
                json.dumps({"day": day, "kind": kind}),
                encoding="utf-8",
            )
        return json.dumps(
            {
                "recorded": True,
                "reference": "fixture-request-1",
                "day": day,
                "kind": kind,
            }
        )


async def entrypoint(ctx: agents.JobContext) -> None:
    await ctx.connect()
    delay_ms = int(os.environ.get("EGMA_E2E_SETUP_DELAY_MS", "0"))
    if delay_ms:
        await asyncio.sleep(delay_ms / 1000)

    agent = AppointmentAgent()
    chat = ctx.job.room.name.startswith("egma-sim-chat-")
    session = (
        AgentSession(llm=openai.LLM(model="gpt-4o-mini"))
        if chat
        else AgentSession(
            vad=ctx.proc.userdata["vad"],
            stt=openai.STT(model="gpt-4o-mini-transcribe"),
            llm=openai.LLM(model="gpt-4o-mini"),
            tts=openai.TTS(model="gpt-4o-mini-tts", voice="ash"),
        )
    )
    await simulation(agent, ctx, session)

    production_marker = os.environ.get("EGMA_E2E_PRODUCTION_INERT_MARKER", "")
    if production_marker:
        answer = await agent.check_availability(day="Tuesday")
        await asyncio.to_thread(
            Path(production_marker).write_text, answer, encoding="utf-8"
        )
        return

    session_delay_ms = int(os.environ.get("EGMA_E2E_SESSION_DELAY_MS", "0"))
    if session_delay_ms:
        await asyncio.sleep(session_delay_ms / 1000)

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
    if os.environ.get("EGMA_E2E_SILENT_START") != "1":
        await session.generate_reply(
            instructions="Greet the caller and ask which appointment day they need."
        )


def prewarm(proc: agents.JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


if __name__ == "__main__":
    agents.cli.run_app(
        agents.WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
            agent_name=os.environ.get("EGMA_E2E_AGENT_NAME", "egma-python-e2e"),
            load_fnc=lambda: 0.0,
        )
    )
