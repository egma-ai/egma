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
dispatches explicitly, so the record names the agent it graded. The
modality itself needs no dispatch to travel — it is the name of the room
this plug's driver mints, ``egma-sim-chat-`` against the voice lane's bare
``egma-sim-``, read by the worker before it connects to anything. No key
the customer configures can collide with a room's name.

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
  there, so it neither makes the room nor dispatches the worker — and
  those are the two powers that tell an agent it is in a chat: the
  telling is the room's name, and on that variant the name is a request
  to the customer's endpoint rather than a fact egma controls. A chat
  run against an agent that was never told is the slow, expensive path
  this lane exists to remove.
- **An agent that is speaking.** The wire says which of the two states an
  agent is in, and it says it at the agent's first output: a speaking
  agent publishes an audio track and its words carry LiveKit's
  transcribed-track mark, and an integrated one produces neither. Either
  one ends the simulation at once, with a reason naming the setup that is
  missing. At most one utterance of the customer's speech budget is ever
  spent finding out.

## Where a turn ends

Here, and it is the one real design question chat has. Two things have to
hold together, and either one on its own gets a turn wrong.

**The agent has to be finished.** It says so itself. A LiveKit session
publishes its own state — ``lk.agent.state`` — as a participant
attribute, and its return to ``listening`` or ``idle`` is the end of the
whole turn, the tool call inside it included. Egma keys on that arrival.
Where it never arrives, because the agent is not a LiveKit session or
because two quick transitions collapsed into a publish that changed
nothing, :data:`TURN_QUIET_SECONDS` of quiet past the last stream to
close ends the turn instead, and the agent leaving the room ends it for
good. The quiet period is the fallback and no longer the rule, which is
why it is smaller than the one this plug shipped with: an agent that says
when it has finished does not pay it at all.

**And every stream this turn opened has to have closed.** The wire gives
one text stream per utterance and closes it when that utterance is done,
and a stream is stamped with the turn that was outstanding when it
**opened** — so one that opens promptly and finishes late still belongs
to the question it began answering. Nothing ends a turn while a stream
stamped with it is still open: not a finished state, not a spent quiet
period. Egma waits for it, bounded by :data:`TURN_DRAIN_SECONDS` so one
stalled stream cannot hold a whole simulation, and says in the log when
that bound is what ended the wait. This half is a fix, not a nicety: the
turn used to end on what had already arrived, the next turn refused those
words for being older, and a customer read an agent turn that began
part-way through a sentence with nothing to say a word had gone.

The turn's utterances are joined in the order their streams *opened*,
which is the order the agent said them and not the order they finished.

What no rule can answer is a stream that has not opened at all by the time
the next question goes out — nothing distinguishes a late answer to this
question from a prompt answer to the next. So a delivered turn that hears
nothing inside :data:`REPLY_SECONDS` ends the exchange rather than asking
again. The greeting is exempt, because nothing has been asked yet.

Nor can the state signal end a turn that has heard nothing, greeting or
not: it answers whether there is *more* to come, and a turn with no first
word yet is asking a different question, on a different budget. That is
what keeps the greeting whole, because a session publishes ``listening``
the moment it starts — which is before it has greeted anybody.

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

TURN_QUIET_SECONDS = 3.0
"""How long the room stays quiet before the agent's turn is over.

**The fallback, not the rule.** The rule is the agent's own
``lk.agent.state``, and this number is what stands in where that never
arrives: an agent that is not a LiveKit session and publishes no state at
all, or a turn whose state changes were quick enough to collapse into a
publish that said nothing new. It still has to be long enough for the
slowest honest thing an agent does inside one turn — call a tool and
answer out of what came back — because on those agents it is the whole of
the rule, exactly as it was before.

Measured against the tool-calling fixture agent in a real room, on
2026-08-28, with ``check_availability`` answered by a mock tool declaring
the 1.5-second delay the live mock-tool run declares. The gap between the
filler utterance closing and the answer's stream opening was **1.52
seconds**, of which the declared delay was 1.50 — so everything the wire
itself costs, the tool round trip over LiveKit's own RPC included, is
about **0.02 seconds**. A turn with no tool call in it arrived in 0.03.

Five seconds was that measurement plus a budget for the one part it could
not include — the agent's model, because the account it ran on had no
credit and a scripted one stood in. Three is the same measurement with a
smaller budget for the same unmeasured part, and what pays for the cut is
the state signal taking the common case away from this number entirely.
The remaining budget is about one and a half seconds over the measured
gap, which covers a small model on either side of a declared delay and
not a slow one on both.

The trade is written down rather than hidden, because it is a real one and
it has a shape worth recognising on a future record: a turn cut short here
is an agent that publishes no state *and* leaves more than three seconds
between two utterances of one turn — a declared mock-tool delay plus the
model on either side of it. Half of that shape is the customer's own
configuration, which is why the driver names the room, the turn and the
length of what it dropped every time it drops anything.

The cost of the old number was measured too. On the founder's run of
2026-08-28 the agent's turns landed between five and eight seconds after
the persona's, against about 1.3 seconds for the persona to answer: seven
quiet periods, thirty-five seconds, on a fifty-four second run. Two thirds
of a chat simulation was this plug waiting to find out something the
platform had already published.

It is deliberately a plain number and not a wait that stretches while a
mock-tool exchange is in flight. Egma answers only the tools this
simulation has answers for; the agent's other tools run their own
implementations with egma nowhere near them, and a rule that shortened the
turn whenever egma happened not to be in the path would cut exactly those
turns off. This plug claims nothing it cannot see, and it cannot see them.
"""

TURN_DRAIN_SECONDS = 15.0
"""How long a turn waits for a stream it opened and has not seen close.

Paid only where a turn would otherwise end owing itself an utterance: the
room is quiet, or the agent has said it is finished, and a stream stamped
with this turn is still open. Then the words are already on their way and
ending the turn without them puts them on no turn at all — which is the
defect this bound exists to make rare rather than silent.

Bounded because the alternative is not bounded. A stream whose close never
arrives — a trailer the wire lost, an agent process that died mid-sentence
— would otherwise hold the turn, and behind it the simulation, for as long
as the run's own duration limit. Better a named number and a line in the
log than a simulation that ends as ``limit_reached`` with no idea why.

Fifteen seconds, which is half the reply budget, and the halving is the
reasoning: :data:`REPLY_SECONDS` covers a whole model round trip with a
tool call inside it, and a stream that has *opened* has already paid that
round trip. What is left is the writing of one utterance the agent has
already begun. Erring long, because erring short costs a word off the
record — the failure this whole rule exists to end — while erring long
only costs seconds on an exchange that is already going wrong.

It is not the greeting's, the reply's or the quiet period's business and
so it is not folded into any of them: those three measure how long egma
waits for an agent to *start*, and this measures how long it waits for one
that has started to finish.
"""

CHAT_SETUP_MISSING = (
    "the agent answered in speech rather than in text — audio published in "
    "the room, or words carrying LiveKit's transcribed-track mark — so it has "
    "not taken Egma's chat setup. A chat simulation needs the worker to read "
    "the modality off its room's name and start its session with audio input "
    "and output off and its transcription unsynchronised; Egma's LiveKit "
    "integration instructions carry the lines that do it"
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
                "pair, so Egma neither makes the room whose name would tell "
                "the agent it is in a chat, nor dispatches the worker that "
                "must read it; chat is offered on the project-credential "
                "access variant, where Egma holds both powers"
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
