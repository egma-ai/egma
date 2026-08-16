"""The dumb counterpart: a deliberately boring LiveKit agent to test against.

A real agent in every mechanical sense — registers as a worker, gets
dispatched into rooms, listens with real STT, thinks with a small model,
answers with real TTS — and dull on purpose in every other sense: it is a
dental-office receptionist with two tools, no memory, and one-sentence
answers. It exists so a simulation has something on the other side of the
room while the thing under test is egma, not the agent.

All three model steps ride one OpenAI key, the same single-provider shape
the docs recommend for local runs (`docs/integrations/livekit-telemetry.mdx`).

## The two tools, and why there are two

``check_availability`` is the booking-shaped one: the call a real practice
would answer out of a real calendar, and the reason mock tools exist at
all. Here it reaches nothing — it answers out of two invented slots
written into this file — so running this agent can neither book anything
nor fail because a backend was down. That is what makes it safe to leave
running; it is also why an *unmocked* run of it says the same two times
every day of the week.

``opening_hours`` is the second one, and it is here so a simulation has a
tool egma is **not** answering for. A mock tool covers a name or it does
not, and the interesting record is the one with both kinds in it: the
coverage stamp then names one tool as covered and one as uncovered, which
is how a reader learns a simulation was not fully isolated. With one tool
there would be nothing for that half of the stamp to say.

Both are harmless and deterministic when nobody mocks them. Neither reads
a clock, a network or a disk.

## The one line that lets egma answer

``await mockable(agent, ctx, session)`` goes after the agent and the
session exist and before the session starts. In a room egma dispatched, it
reports these two tools by name and stands egma in front of whichever ones
this simulation has answers for. **In every other room it does nothing at
all** — no wrapper, no message, the same two callables — so this file
behaves identically whether or not egma is anywhere near it, which is the
property `tests/test_outside_egma.py` holds it to.

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

from egma import mockable
from livekit import agents
from livekit.agents import Agent, AgentSession, function_tool
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

MORNING_SLOT = "9:40"
AFTERNOON_SLOT = "2:15"
"""The whole of this agent's calendar, and it is two strings in a file.

There is no backend here on purpose. A fixture that reached a real
calendar could book a real appointment on a bad day, and one that reached
a fake server would make every live run depend on that server being up.
Two constants can do neither.
"""


class FrontDesk(Agent):
    """The receptionist, as one concrete class.

    One class rather than a bare ``Agent`` because egma's substitution is
    keyed on ``type(agent)`` exactly: a stand-in registered for this class
    is consulted for calls made by an instance of this class, and nothing
    else in the process is touched.
    """

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
    await ctx.connect()
    agent = FrontDesk()
    session = AgentSession(
        vad=ctx.proc.userdata["vad"],
        stt=openai.STT(model="gpt-4o-mini-transcribe"),
        llm=openai.LLM(model="gpt-4o-mini"),
        tts=openai.TTS(model="gpt-4o-mini-tts", voice="ash"),
    )
    # Both objects exist and the session has not started: the one moment
    # the agent's tools are all attached and nothing has been said yet.
    # Outside a simulation this returns having touched nothing.
    await mockable(agent, ctx, session)
    await session.start(agent=agent, room=ctx.room)
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
