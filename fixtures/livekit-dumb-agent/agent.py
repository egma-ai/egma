"""The dumb counterpart: a deliberately boring LiveKit agent to test against.

A real agent in every mechanical sense — registers as a worker, gets
dispatched into rooms, listens with real STT, thinks with a small model,
answers with real TTS — and dull on purpose in every other sense: it is a
dental-office receptionist with no tools, no memory, and one-sentence
answers. It exists so a simulation has something on the other side of the
room while the thing under test is egma, not the agent.

All three model steps ride one OpenAI key, the same single-provider shape
the docs recommend for local runs (`docs/livekit.md`).

Dispatch style is chosen by environment, so both of egma's paths are
testable with the same file:

- ``EGMA_DUMB_AGENT_NAME`` unset or blank — the worker registers unnamed,
  which is automatic dispatch: it walks into every new room in the
  project, egma's test rooms included.
- ``EGMA_DUMB_AGENT_NAME=front-desk`` — the worker registers under that
  name and joins only when a room's dispatch asks for it.

Run it with the project's own values in the environment (see README):

    uv run agent.py dev
"""

import os

from livekit import agents
from livekit.agents import Agent, AgentSession
from livekit.plugins import openai, silero

INSTRUCTIONS = (
    "You are the front-desk receptionist at Maple Street Dental. "
    "You can discuss appointments: booking, moving, or cancelling them. "
    "Invent plausible availability when asked; there is no real calendar. "
    "Keep every reply to one or two short sentences. "
    "When the caller is done, say goodbye politely."
)


def prewarm(proc: agents.JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


async def entrypoint(ctx: agents.JobContext) -> None:
    await ctx.connect()
    session = AgentSession(
        vad=ctx.proc.userdata["vad"],
        stt=openai.STT(model="gpt-4o-mini-transcribe"),
        llm=openai.LLM(model="gpt-4o-mini"),
        tts=openai.TTS(model="gpt-4o-mini-tts", voice="ash"),
    )
    await session.start(agent=Agent(instructions=INSTRUCTIONS), room=ctx.room)
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
