"""The livekit-chat plug: the simulator types to the agent in its own room.

The same agent, the same room, the same project, the same key pair — and
not one byte of audio. A LiveKit agent session already listens for text on
the ``lk.chat`` topic and already publishes its own words back on
``lk.transcription``, so egma can hold a whole exchange with it by
joining the room as a participant that publishes nothing. Everything about
the room is the driver's — see
:mod:`egma_simulator.media.livekit_room`, whose lifecycle this plug shares
with the voice one line for line. What is here is the chat half of the
walk's three verbs: open, deliver, close.

Its config keys and its credentials are the voice plug's, read by the same
driver, and its ``agentName`` is required for the same reason: egma
dispatches explicitly, because dispatch metadata is the only channel that
carries the modality and the address of egma's mock-tool seam.

**No speech runs anywhere.** There is no text-to-speech leg, no
speech-to-text leg, no Pipecat pipeline and no recording. A chat
simulation grades the agent's prompt, its reasoning and its tools; it
grades nothing about its ears or its mouth, which is exactly why running
the same test suite over chat and over voice tells a customer which of the
two is broken.

## What it refuses

- **A voice simulation.** The plug carrying the speech legs is the one
  next door, and this one has no transport to give a pipeline.
- **A connection that names a token endpoint.** Egma holds no key pair
  there, so it can neither dispatch the worker nor tell it to go
  text-only — and a chat run against an agent that was never told is the
  slow, expensive path this lane exists to remove.
- **An agent that is speaking.** The wire says which of the two states an
  agent is in, and it says it at the agent's first output: a speaking
  agent publishes an audio track and its words carry LiveKit's
  transcribed-track mark, and an integrated one produces neither. Either
  one ends the simulation at once, with a reason naming the setup that is
  missing. At most one utterance of the customer's speech budget is ever
  spent finding out.

## Where a turn ends

Here, and it is the one real design question chat has. The wire gives one
text stream per utterance and closes it when the utterance is done, and
that close is a real end-of-utterance marker. It is not an end-of-*turn*
marker: an agent that says a filler, calls a tool and then answers sends
three streams for one turn. So the turn ends after
:data:`TURN_QUIET_SECONDS` of quiet past the last close — long enough for
a tool call to come back, and the number is written down with its
reasoning below rather than tuned in silence.

Which turn an utterance belongs to is the same question asked backwards,
and the wire answers it once: a stream is stamped with the turn that was
outstanding when it **opened**, so one that opens promptly and finishes
late still belongs to the question it began answering. What the wire
cannot answer is a stream that has not opened at all by the time the next
question goes out — nothing distinguishes a late answer to this question
from a prompt answer to the next. So a delivered turn that hears nothing
inside :data:`REPLY_SECONDS` ends the exchange rather than asking again.
The greeting is exempt, because nothing has been asked yet.

## Answering for the agent's tools

Exactly as the room does for voice, and by construction rather than by a
second implementation: the mock-tool exchange knows nothing about rooms
and nothing about modality, so the same two methods go on egma's own
participant the moment the room is joined, and the coverage stamp lands on
a chat record the way it lands on a voice one.

The reply's tool-call list, on the other hand, stays empty. The seam
records the calls it answers as spans of their own, and this plug can see
nothing else the agent's tools did — so it claims nothing, which is what
an empty list has always meant here.
"""

from __future__ import annotations

from typing import Any

from ..media import MediaBackendError
from ..media.livekit_room import AgentTurn, LiveKitChatRoomBackend
from ..mock_tools import MockToolSeam
from . import AgentReply, PlugError
from .livekit import AGENT_JOIN_SECONDS, build_driver, read_connection

# The join wait is the voice plug's, imported rather than declared again.
# It is the same question with the same answer — how long a room may stand
# empty before nobody coming is the answer — and a second budget beside it
# would be a second thing to keep true.

GREETING_SECONDS = 8.0
"""How long the agent has to open the exchange before the persona does.

A greeting is a whole model round trip taken the moment a session starts,
which is why it gets its own budget rather than the quiet period's: the
quiet period measures the gap between two things already being said, and
this measures a silence that may never end, because plenty of agents wait
to be spoken to. Well short of a simulation's duration limit, so an agent
that greets nobody lands the persona's opening rather than
``limit_reached`` on a record whose real story is that the persona went
first.
"""

REPLY_SECONDS = 30.0
"""How long the agent has to begin answering a persona turn.

Separate from the quiet period below, and much larger, because the two
measure different things: this is a whole model round trip and whatever
the agent does inside it, where the quiet period is only the gap between
two utterances of a turn already under way. An agent that thinks for eight
seconds before its first word is thinking, not silent, and a budget that
called it silent would file its answer against the persona's *next*
question.

Thirty seconds because a tool call can sit inside that round trip, and a
mock tool's delay is the customer's to declare: a test that makes a
backend take three seconds is exactly the kind this lane exists to run,
and the budget has to clear the slowest declared delay plus the model on
either side of it. It matches the join wait for the same reason that one
is what it is — long enough that reaching it means something is wrong,
rather than something is slow.

Reaching it ends the exchange rather than asking again, so the number is
also how long egma waits before calling an agent unanswering. Both costs
are real and they are not equal: too long makes a customer wait to be told
their agent never replied, and too short ends a simulation the agent was
about to answer. This errs long, because the first wastes seconds and the
second wastes the run.
"""

TURN_QUIET_SECONDS = 5.0
"""How long the room stays quiet before the agent's turn is over.

The wire has no end-of-turn marker — one stream per utterance, closed when
that utterance is done — so this is the whole of the rule, and it has to
be long enough for the slowest honest thing an agent does inside one turn:
call a tool and answer out of what came back.

Measured against the tool-calling fixture agent in a real room, on
2026-08-28, with ``check_availability`` answered by a mock tool declaring
the 1.5-second delay the live mock-tool run declares. The gap between the
filler utterance closing and the answer's stream opening was **1.52
seconds**, of which the declared delay was 1.50 — so everything the wire
itself costs, the tool round trip over LiveKit's own RPC included, is
about **0.02 seconds**. A turn with no tool call in it arrived in 0.03.

What that measurement could not include is the agent's model, because the
account it ran on had no credit and a scripted one stood in. So the number
is the measured parts plus a budget for the unmeasured one: the worst
honest shape is a turn where the model emits no filler at all, and this
one budget then has to cover a round trip, the declared delay, and a
second round trip on the answer. Five seconds leaves about three and a
half for the two round trips of a small model, which is comfortable for
one and survives a slow one.

It is deliberately a plain number and not a wait that stretches while a
mock-tool exchange is in flight. Egma answers only the tools this
simulation has answers for; the agent's other tools run their own
implementations with egma nowhere near them, and a rule that shortened the
turn whenever egma happened not to be in the path would cut exactly those
turns off. This plug claims nothing it cannot see, and it cannot see them.

Paid once per turn, which is the cost of the rule and is why the number is
as small as the fixture allows rather than as large as would be safe. It
is the smallest of this plug's three waits for that reason alone.
"""

CHAT_SETUP_MISSING = (
    "the agent answered in speech rather than in text — audio published in "
    "the room, or words carrying LiveKit's transcribed-track mark — so it has "
    "not taken Egma's chat setup. A chat simulation needs the worker to read "
    "the modality out of its dispatch metadata and start its session with "
    "audio input and output off and its transcription unsynchronised; Egma's "
    "LiveKit integration instructions carry the lines that do it"
)
"""Why a simulation stops at the agent's first output.

Worded for the person who has to go and change the worker, and it names
the setup rather than a file: what the instructions are called is the
product's to decide and this file's to stay out of. Nothing about the
run's own configuration is in here, because nothing about the run is what
went wrong.
"""


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
        mock_tools: MockToolSeam | None = None,
        media: object = None,
        driver: Any = None,
    ) -> None:
        # A room is reached with this connection's URL and authority, and a
        # typed one reaches the telephone network not at all.
        del media

        if modality != "chat":
            raise PlugError(
                f"the livekit chat plug speaks chat only; a {modality!r} "
                "simulation in a room needs the plug carrying the speech legs"
            )

        if access_variant == "livekit_room.customer_token_endpoint":
            raise PlugError(
                "a livekit connection that names a tokenEndpoint holds no key "
                "pair, so Egma can neither dispatch the agent nor tell it to "
                "go text-only; chat is offered on the project-credential "
                "access variant, where Egma dispatches"
            )

        # Read here, before anything is reached, so a connection the driver
        # cannot use is an honest refusal rather than a failure part-way
        # through an exchange. Which driver holds the room is not the
        # spec's to choose: the keyword is for tests, which put a
        # room-shaped fake behind the same seam.
        self._backend = build_driver(
            driver or LiveKitChatRoomBackend,
            settings=read_connection(access_variant, config, credentials),
            simulation_id=simulation_id,
            mock_tools=mock_tools,
        )
        self._reference: str | None = None

    @property
    def provider_reference(self) -> str | None:
        """The room this exchange was conducted in, once there is one."""
        return self._reference

    @property
    def backend(self) -> object:
        """The driver holding the room.

        Here for the tests, honestly, exactly as the voice plug's is: a
        plug built from a spec alone builds its own driver, and this is the
        only way to ask which room the exchange was really held in before
        there is a reference.
        """
        return self._backend

    async def open(self) -> str | None:
        """Make the room, get the agent in, and hear it out if it speaks first.

        ``None`` where it does not, which is an ordinary answer rather
        than a fault: the walk then has the persona open.
        """
        try:
            await self._backend.open_room()
            await self._backend.dial()
            self._reference = await self._backend.wait_arrived(AGENT_JOIN_SECONDS)
            greeting = await self._backend.wait_greeting(
                GREETING_SECONDS, quiet_seconds=TURN_QUIET_SECONDS
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
            )
        except MediaBackendError as refused:
            raise PlugError(str(refused), ending=refused.ending) from refused
        _typing_or_nothing(answer)
        # The tool calls stay empty on purpose: what egma answered for is
        # already a span of its own, and what it did not answer for it
        # never saw.
        return AgentReply(text=answer.text, ended=answer.ended, tool_calls=())

    async def close(self) -> None:
        """Leave, and delete the room. Safe from every state."""
        await self._backend.teardown()


def _typing_or_nothing(turn: AgentTurn) -> None:
    """Stop the simulation where the wire says the agent is speaking.

    Raised rather than recorded, and raised at the first output rather than
    at the end: a speech-paced exchange graded as if it were a chat is a
    record of the wrong kind of run, and every further persona turn spends
    more of the customer's speech budget proving the same thing twice.
    """
    if turn.speaking:
        raise PlugError(CHAT_SETUP_MISSING)
