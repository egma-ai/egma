"""The dumb counterpart: a deliberately boring LiveKit agent to test against.

A real agent in every mechanical sense — registers as a worker, gets
dispatched into rooms, listens with real STT, thinks with a small model,
answers with real TTS — and dull on purpose in every other sense: it is a
dental-office receptionist with two tools, no memory, and one-sentence
answers. It exists so a simulation has something on the other side of the
room while the thing under test is egma, not the agent.

All three model steps ride one OpenAI key, the same single-provider shape used
for local runs.

## The two tools, and why there are two

``check_availability`` is the booking-shaped one: the call a real practice
would answer out of a real calendar, and the reason mock tools exist at
all. Here it reaches nothing — it answers out of two invented slots
written into this file — so running this agent can neither book anything
nor fail because a backend was down. That is what makes it safe to leave
running; it is also why an *unmocked* run of it says the same two times
every day of the week.

``opening_hours`` is the second one, and it is here so a simulation has a
tool egma is **not** answering for. A test names a tool or it does not,
and the interesting run is the one with both kinds in it: one call reaches
egma and lands on the record stamped ``mocked``, and the other runs its
own implementation with egma nowhere near it and leaves no span at all.
With one tool there would be nothing to prove the second half of that.

Both are harmless and deterministic when nobody mocks them. Neither reads
a clock, a network or a disk.

## The one line that lets egma answer

``await mockable(agent, ctx, session)`` goes after the agent and the
session exist and before the session starts. In a room egma named for a
simulation, it reports these two tools by name and stands egma in front of
whichever ones this simulation has answers for. It does that on both
dispatch styles below, including the unnamed one where this worker is in
the room before egma is: the SDK reads the room's name, which arrives with
the job either way, and waits for egma's own participant. **In every other
room it does nothing at all** — no wrapper, no message, no connect, the
same two callables — so this file behaves identically whether or not egma
is anywhere near it, which is the property `tests/test_outside_egma.py`
holds it to.

## The one line that reads the test's own world

``json.loads(ctx.job.metadata)`` is the customer-side half of a test's
env. Egma writes the test's ``job_dispatch_metadata`` onto the agent
dispatch, which is the channel LiveKit's own documentation teaches an
agent to read for per-session context, so a worker that already does this
keeps working under test — and reads a different tenant, caller or
account per scenario. This fixture reads one key out of it and **logs**
it, so the live proof can read the value back off the worker's own output
and know the bytes crossed.

Logged and never spoken. What a test writes here is the *world* the agent
starts in and never the *script* it is about to be asked, so speaking it
would put a value on the transcript that the caller never said. A
production room carries whatever the practice's own dispatch carried, or
nothing at all, and both are read the same careful way: nothing is
required, nothing raises, and the agent behaves identically when the
channel is empty or is not JSON.

## The six lines that make a chat simulation a chat simulation

Egma says which kind of simulation a room conducts in the room's own
name — a chat simulation's room begins ``egma-sim-chat-`` — and these
six lines read it and answer in kind: in a chat simulation the session
takes no audio in, sends no audio out, and stops tying its transcription
to speech it is not producing. The name arrives with the job before the
worker connects to anything, and no metadata key of anybody's can
collide with it. That is the whole of the customer-side integration — no
egma package, and the same shape in Node through its own input and
output options.

Without them the agent still answers a chat simulation, because a LiveKit
session already listens for text. It answers it *aloud*: every reply is
synthesised, published, and transcribed at the speed of the mouth
producing it, so a fourteen-word answer takes nearly five seconds and the
customer pays for speech nobody hears. Egma sees that on the wire and
stops the simulation rather than grading it.

**A production room carries the customer's own name**, never egma's
marked one, so ``chat`` is false there and the options are the stock
ones. The voice path is untouched by
construction rather than by care — which is the property
``tests/test_outside_egma.py`` already holds this file to.

## The export that makes this agent visible in Egma

``monitor_livekit(ctx)`` is the public SDK setup. This fixture calls it when
``EGMA_URL`` or ``EGMA_API_KEY`` is present, so its simulation-only smoke test
can still run without a Monitoring setup. A real monitored worker calls the
function directly and treats missing configuration as an error.

``EGMA_DUMB_AGENT_NAME`` is the name this worker registers under, and it
is the one prerequisite of the whole arrangement. Egma dispatches by name,
always, so its record names the agent it graded — where LiveKit's
automatic dispatch, which is what a worker registered without a name
gets, would hand egma's rooms to whichever workers were listening.
Naming a worker that was previously
unnamed turns automatic dispatch off for it: it then joins only the rooms
whose dispatch asks for it.

Run it with the project's own values in the environment (see README):

    uv run agent.py dev
"""

import json
import logging
import os

from egma import mockable, monitor_livekit
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
"""The one key this fixture reads out of its job's dispatch metadata.

An ordinary customer key and deliberately not an egma one: what the live
proof watches for is a *test's* value arriving on the channel LiveKit
teaches agents to read, and a key of egma's own would prove the wrong
thing.
"""


def dispatched_world(metadata: str) -> dict:
    """The job's dispatch metadata, read the way a real worker reads it.

    Forgiving on purpose, and this is the shape a customer's own worker
    should copy: outside a simulation this channel carries whatever the
    practice's own dispatch carried — nothing at all, quite often, and
    something that is not JSON now and then — and neither may stop the
    agent from answering the phone.
    """
    try:
        world = json.loads(metadata or "{}")
    except ValueError:
        return {}
    return world if isinstance(world, dict) else {}


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
    # This fixture serves two proofs. Its simulation smoke test supplies no
    # Monitoring settings; the production-monitoring proof supplies both.
    # A partial setup still calls the helper and gets its direct setup error.
    if os.environ.get("EGMA_URL") or os.environ.get("EGMA_API_KEY"):
        monitor_livekit(ctx)
    # The test's own world, off the channel LiveKit teaches agents to read.
    # Logged rather than said: the live proof reads the value back here, and
    # a value spoken aloud would be a word on the transcript nobody said.
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
    # Both objects exist and the session has not started: the one moment
    # the agent's tools are all attached and nothing has been said yet.
    # Outside a simulation this returns having touched nothing.
    await mockable(agent, ctx, session)
    # The six lines. A production room is named by the customer's own
    # system, never with egma's mark, so `chat` is false there and these
    # are the stock options.
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
