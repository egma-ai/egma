"""Connection plugs: the one place that knows how to reach an agent.

A **plug** is the component behind a connection type. It alone knows how
to open that connection, deliver the persona's turns, hear
the agent's answers, and end the exchange. Everything else in the
simulator is plug-blind: the persona brain, the conversation loop, the claim loop, and
the reporting never learn how they reached the agent. Adding a connection
kind therefore touches exactly two things — a new module in this
package, and one line in the registry below.

This docstring is the plug author's whole brief. If writing a new plug
requires reading anything beyond this file, that is a bug in this file.

## What a plug receives

A plug is constructed once per simulation, from the claimed spec, with
ten keyword arguments:

- ``modality`` — ``"chat"`` or ``"voice"``. A plug that cannot speak the
  requested modality must refuse at construction (raise ``PlugError``).
- ``access_variant`` — which authority and configuration path inside the
  connection type this spec means. It is always spelled out and is never
  inferred from which config keys turned up, so a plug that holds one
  variant refuses every other at construction, and a plug that holds two
  reads the connection the way the named one says to.
- ``config`` — the connection's non-secret reach configuration, exactly as
  authored. **Its keys belong to the plug**: nothing else reads them, no
  schema constrains them, and each plug documents and validates its own.
  Refuse keys you do not know (raise ``PlugError``) — a silently ignored
  typo would change behavior nobody asked for.
- ``credentials`` — the resolved secret material, or ``None``. Use it to
  open the connection and for nothing else: **never log it, never persist
  it, never let it into an exception message or a returned value.** The
  report schema structurally rejects credential-shaped fields, and the
  acceptance suite plants sentinel credentials and scans every byte the
  process emits.
- ``simulation_id`` — which simulation this plug is conducting, opaque as
  everywhere else: never parsed, never minted, never rewritten. Only a
  plug that has to *tell the platform* which simulation it is in has any
  use for it, and most have none — a plug that does not need it takes it
  and drops it.
- ``agent_version`` — which version of the agent under test to conduct
  against, exactly as its platform names its versions, or ``None`` for the
  platform's own default. Only a plug reaching a platform that keeps
  versions has any use for it, and such a plug asks for it **by name every
  time**: a platform whose default is "the newest one" can be pointed at a
  version nobody meant between one simulation and the next. It is never
  parsed, never renumbered and never turned into words — a number stays a
  number and a name stays a name, because the platform is the only thing
  that knows what either means. The one thing dropped is space around it,
  which is nobody's version: the wire accepts ``"  latest  "`` because the
  contract only asks a name to say something, and what goes to the platform
  is ``"latest"``. Every other plug takes it and drops it, and its record
  claims nothing about versions.
- ``dynamic_variables`` — the variables this one simulation is conducted
  with, for the agent's platform to render into the world the agent under
  test sees. A mapping of names to strings, empty in the ordinary case, and
  **passed on byte for byte**: a plug neither reads them, adds to them, nor
  tidies a value, because a value the simulator changed is a value the agent
  never saw. Egma's own attribution variable is among them where the run put
  one there, and it is what a tool call the platform makes rides back to
  this simulation on. A plug whose platform renders no such thing takes them
  and drops them.
- ``job_dispatch_metadata`` — the other half of the world a test starts its
  agent in: the JSON object the test wrote, or ``None``. It is not rendered
  by anybody's platform and it is not read here; it is written, whole, onto
  the one channel that carries a per-session object to a worker — the
  LiveKit agent dispatch. So exactly one plug has a use for it, and every
  other plug takes it and drops it. Like the variables beside it, it is
  **passed on byte for byte**: a worker doing
  ``json.loads(ctx.job.metadata)["tenant"]`` reads what its test wrote, and
  a value the simulator tidied would be a value the agent never saw.
- ``mock_tools`` — egma's side of the mock-tool exchange for this
  simulation (:class:`egma_simulator.mock_tools.MockToolSeam`), already
  holding the answers the run resolved. Only a plug that can **put egma in
  the agent's tool path** has any use for it, and there are two ways to be
  in it. A plug can *stand* in the path — the room does: it offers the
  exchange to whoever is in the room with it and says so. Or it can *hand
  the answers over* to a platform that serves them itself — text mode
  does: they ride every request, and the platform matches them by name. In
  both cases every tool call the plug learns of goes to the seam, which is
  the only writer that can stamp one ``mocked``. Every other plug takes the
  seam and drops it, and its record honestly claims nothing about tools,
  because egma was never in the path to learn anything.
- ``media`` — how a call reaches the telephone network for this
  simulation (:class:`egma_simulator.config.MediaSettings`), or ``None``
  on a deployment that places no calls. Already resolved: this
  container's bridge with the platform's own carrier laid over it, worked
  out once by assembly so that no plug reaches for an environment
  variable of its own. Only a plug that dials has any use for it, which
  today is the phone; every other plug takes it and drops it.

Constructors validate and hold; they never do I/O. A constructor that
raises means the simulation fails with an honest reason before the
connection is ever opened. Two of the ten are read for you where a plug
uses them — :func:`named_version` and :func:`rendered_variables` below —
so that two plugs reaching one platform cannot disagree about what a
version reference is or what a variable may hold.

## Chat or voice: same job, different currency

A chat plug exchanges text. A voice plug prepares one Pipecat transport.
The running Pipecat pipeline owns incoming audio, speech processing,
persona output, conversion, pacing, and recording. The plug owns only the
connection lifecycle and provider reference.

There are two seams: :class:`ConnectionPlug` for chat and
:class:`VoiceConnection` for voice. A plug implements the one for its
modality and refuses the other at construction.

## The lifecycle a conductor drives

A chat plug's is three steps, for one simulation, in order, always:

1. ``await open()`` — reach the platform and start the exchange. Returns
   the agent's greeting when the platform opens with one, else ``None``
   (the persona will then speak first). A plug whose platform says more
   about the opening than words may return a whole ``AgentReply`` instead,
   and the walk reads all three of its facts — ``text``,
   ``platform_notes``, and ``ended``. An agent that ends the exchange with
   its own greeting ends the walk there, reported as the agent's doing;
   ``deliver`` is then never called at all.
2. ``await deliver(text)`` — hand the persona's turn to the platform and
   return the agent's answer as an ``AgentReply``:
   - ``text`` — what the agent said, or ``None`` for an answer that
     carried no words.
   - ``ended=True`` — the agent (or the platform) ended the exchange with
     this answer. The conversation loop records any final words and reports the ending
     as the agent's doing. Once returned, ``deliver`` is never called
     again.
   - ``platform_notes`` — what the platform said about the answer that the
     agent did not say. Kept on the record beside the turn and never in
     it, and never shown to the persona.
   ``deliver`` is called once per persona turn, sequentially — a plug
   never sees two deliveries in flight.
3. ``await close()`` — tear the exchange down. Called exactly once,
   whatever happened: after a natural end, after a limit tripped, after a
   cancel directive, and after a fault. Make it safe to call in every one
   of those states.

A voice connection also has three steps. ``prepare`` returns the transport
processors without opening the platform. ``open`` connects or dials.
``close`` tears it down. It exposes no PCM exchange and no processing rate.

``provider_reference`` is the platform's own identifier for the exchange —
a chat id, a telephony leg id — reported with the terminal facts as the
one join between egma's record and the platform's telemetry. Offer it as
soon as it is known; ``None`` when the platform has none.

## Failure

Raise when the platform cannot be reached or stops making sense —
``PlugError`` for the failures you can name, anything for the rest.
Conducting turns an exception into a simulation that reports ``failed``
with the exception's message as the reason, so word messages for the
person who reads the record — and keep credentials out of them.

A ``PlugError`` also carries **which of the contract's failed endings**
the refusal deserves. They are named in :mod:`egma_simulator.contract`,
where the contract's vocabulary lives, and the default is the right
answer nearly always:

- ``ERROR`` (the default) — the simulator hit a fault it could not
  conduct through: config it cannot use, a platform refusing, a way in
  that is not there.
- ``NOT_ANSWERED`` — the simulator reached out and nothing came on the
  line. A phone that rang out or was engaged; never a fault, and never
  the agent's doing.
- ``AGENT_NEVER_JOINED`` — the way in opened and no agent turned up.

None of the three is ever graded as the agent failing: each of them
means the exchange did not happen, so there is nothing to grade.

A cancel directive or a tripped limit stops the exchange at whatever call
is in flight — ``prepare``, ``open``, or ``deliver`` — as an
``asyncio.CancelledError`` inside the plug: let it propagate, and rely on
``close()`` for teardown.

## Pacing

A real platform takes real time to answer. For chat, that time is inside
``deliver``. For voice, the running Pipecat transport carries media while
the persona model and speech services work.

## Registration

The registry lives in :func:`plug_for` below: one entry per connection
kind, the connection-type string exactly as specs will name it. A simulator holding
no plug for a claimed spec's kind refuses the claim out loud and reports
nothing — the row is the control plane's to sweep.

A connection type may answer in both modalities, and one does. Its entry
is then a small factory that reads the ``modality`` keyword, picks the
plug for it, and passes every keyword straight on — never a rule written
into whoever calls the registry, which must stay modality-blind for the
same reason everything else here is.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from ..contract import ERROR
from ..media import VoiceMedia
from ..redaction import REDACTED

QUOTED_REFUSAL_CHARS = 200
"""How much of a refusal's body is quoted into a reason: enough to carry
the platform's own words about what was wrong, short of pasting a page."""


@dataclass(frozen=True)
class ToolCall:
    """One tool the agent called, as observed from egma's side of the wire.

    The name and the arguments exactly as the platform reported them, and
    nothing else: the simulator observes the call and not the return, so
    there is no result here. A platform that reports the invocation
    without its arguments leaves them ``None``, which is the honest record
    of what was seen.
    """

    name: str
    arguments: str | None = None


@dataclass(frozen=True)
class AgentReply:
    """The agent's answer to one delivered persona turn."""

    text: str | None
    """What the agent said, or ``None`` for an answer without words."""

    ended: bool = False
    """True when this answer ended the exchange — the agent's goodbye,
    a hang-up, or the platform closing it from its side."""

    tool_calls: tuple[ToolCall, ...] = ()
    """The tool calls this answer made, where the platform exposes them.
    Empty is the ordinary case and never a claim that none happened: most
    ways of reaching an agent say nothing about its tools, and a plug that
    cannot see them reports none rather than guessing."""

    platform_notes: tuple[str, ...] = ()
    """What the platform said about this answer that the agent did not say.

    A node transition it announced, a message in a role egma has never
    seen — content that is real, that came from the agent's side, and that
    **is not speech**. It goes on the record beside the turn and is never
    part of the turn's own words, for two reasons that are the same
    reason: the persona is handed the transcript and would read a
    transition as something said to it, and the whole point of this
    modality is that one scenario's chat transcript and voice transcript
    are comparable — which they stop being the moment one of them carries
    words nobody spoke.

    Empty for every plug that has nothing of the kind, which is most of
    them."""

    answered_at: float | None = None
    """When the agent's answer *started*, on the running loop's clock.

    The finish line of ``turn_response_latency``: its starting line is the
    moment the persona's turn went out, and this is the moment the agent
    began replying. The conversation loop measures between the two.

    **Why a plug reports it rather than the loop timing the call.** For a
    plug whose ``deliver`` is a request and its response, the two are the
    same instant and this stays ``None``: the call returns when the answer
    does, so the return *is* the finish line and the loop uses it. For a
    plug that reads a live room, they are not the same. Egma there must
    also decide the agent has no more to say before the persona may speak,
    and that decision costs a wait — up to the whole quiet period on an
    agent whose platform never publishes a finished state. That wait is
    egma's own turn-taking cost. It falls after the finish line, and a
    number that carried it reported egma's patience as the agent's speed.

    ``None`` also where a turn had no answer to start: one that only
    called a tool, or produced nothing at all. Then no sample is taken,
    because there is no wait to measure rather than a wait of zero.
    """


class PlugError(Exception):
    """A plug refusing config it does not understand, a modality it cannot
    speak, or a platform interaction that failed in a way it can name.

    ``ending`` is which failed ending the record should carry. It is
    :data:`ERROR` unless a plug says otherwise, because a plug that has
    nothing to say about the difference has hit a fault.
    """

    def __init__(self, message: str, *, ending: str = ERROR) -> None:
        super().__init__(message)
        self.ending = ending


def quotable(told: str, *secrets: str) -> str:
    """Somebody else's words, minus this connection's own, short enough to
    read.

    A refusal is worth far more with the platform's own sentence in it, and
    those words are not the quoter's to trust: a platform careless enough
    to echo a key back would otherwise put it in a failure reason and in
    the traceback logged beneath it. So the scrubbing happens here, where
    the secret is known — and here rather than in each plug, because two
    plugs reaching one platform must not scrub it two different ways.
    """
    for secret in secrets:
        if secret:
            told = told.replace(secret, REDACTED)
    return told[:QUOTED_REFUSAL_CHARS]


def named_version(agent_version: object) -> int | str | None:
    """The version a plug will ask its platform for, read once.

    Here rather than in each plug that uses it, because it is a fact of the
    claimed spec and not of any one platform: two plugs reaching the same
    platform must not disagree about what a version reference is.

    What comes out is what went in — a number stays a number, a name stays a
    name, and neither is renumbered, trimmed into meaning, or turned into the
    other. Surrounding space is the one thing dropped, because it is nobody's
    version; a reference of nothing but space is refused rather than sent,
    since a platform asked for the version named ``"   "`` fails in its own
    words, far from the spec that said it.
    """
    if agent_version is None:
        return None
    if isinstance(agent_version, bool) or not isinstance(agent_version, int | str):
        raise PlugError(
            "an agent version is how the platform names its versions — a "
            f"number or a name; got {type(agent_version).__name__}"
        )
    if isinstance(agent_version, int):
        if agent_version < 0:
            raise PlugError(f"an agent version cannot be {agent_version}")
        return agent_version
    if not agent_version.strip():
        raise PlugError("an agent version must say which version, not nothing")
    return agent_version.strip()


def rendered_variables(dynamic_variables: object) -> dict[str, str]:
    """The variables one simulation is conducted with, read once.

    Shared for the reason above, and strict for one of its own: these travel
    to the agent under test unread, so the last place a mistake in them can
    be named is here. Every value is a string because a rendered variable is
    a string, and an empty one is kept — a variable set to nothing renders as
    nothing, which is not what a variable nobody set does.

    A refusal names the variable and never its value: what a simulation
    carries can be a caller's own details, and a sentence about a mistake
    should not go on to repeat them.
    """
    if dynamic_variables is None:
        return {}
    if not isinstance(dynamic_variables, dict):
        raise PlugError(
            "dynamic variables are names against strings; got "
            f"{type(dynamic_variables).__name__}"
        )
    unnamed = [name for name in dynamic_variables if not str(name).strip()]
    if unnamed:
        raise PlugError("a dynamic variable with no name is set by nobody")
    unrendered = sorted(
        str(name)
        for name, value in dynamic_variables.items()
        if not isinstance(value, str)
    )
    if unrendered:
        raise PlugError(
            f"dynamic variable(s) {unrendered} carry something that is not a "
            "string, and a rendered variable is a string"
        )
    return {str(name): value for name, value in dynamic_variables.items()}


def failed_ending(fault: BaseException) -> str:
    """Which of the contract's failed endings one fault deserves.

    The one place the question is answered, so that a plug naming an
    honest ending and a fault nobody named go through the same door.
    """
    return fault.ending if isinstance(fault, PlugError) else ERROR


class ConnectionPlug(Protocol):
    """The seam the conversation loop drives: text in, text out, whatever the modality.

    A chat plug implements it directly; a voice plug is reached through it,
    with the speech legs assembled in between. See the module docstring for
    the full brief.
    """

    @property
    def provider_reference(self) -> str | None: ...

    async def open(self) -> str | AgentReply | None: ...

    async def deliver(self, text: str) -> AgentReply: ...

    async def close(self) -> None: ...


@runtime_checkable
class VoiceConnection(Protocol):
    """The seam a voice conductor gives to its one Pipecat pipeline.

    ``prepare`` constructs the transport processors before the pipeline
    starts. ``open`` waits until that already-running transport reaches the
    far end. No PCM exchange, processing rate, or second media clock crosses
    this seam.
    """

    @property
    def provider_reference(self) -> str | None: ...

    @property
    def far_end_left(self) -> bool: ...

    async def prepare(self) -> VoiceMedia: ...

    async def open(self) -> None: ...

    async def close(self) -> None: ...


PlugFactory = Callable[..., ConnectionPlug | VoiceConnection]
"""What the registry hands back: called with ``modality=``,
``access_variant=``, ``config=``, ``credentials=``, ``simulation_id=``,
``agent_version=``, ``dynamic_variables=``, ``job_dispatch_metadata=``,
``mock_tools=`` and ``media=`` keywords, it returns one plug for one
simulation — in practice, the plug class itself."""


def _livekit_room(*, modality: str, **rest: object) -> ConnectionPlug | VoiceConnection:
    """One room, in whichever currency the simulation is conducted in.

    The one connection type that answers in both modalities: the same
    project, the same room and the same worker, reached with speech or
    with typing. Which plug that is cannot be a class in the table above,
    so it is decided here — and only here, because a caller that had to
    know would be a caller that had stopped being plug-blind. A modality
    neither plug speaks reaches the voice one and is refused by name,
    which is where every other bad modality is already refused.
    """
    from .livekit import LiveKitRoom
    from .livekit_chat import LiveKitChat

    speaking = LiveKitChat if modality == "chat" else LiveKitRoom
    return speaking(modality=modality, **rest)


def plug_for(connection_type: str) -> PlugFactory | None:
    """The plug factory registered for one connection type, or ``None``.

    The registry is deliberately a literal here: adding a connection type is one
    import and one line, and the diff that adds it touches nothing else.
    """
    from .loopback import LoopbackCounterpart
    from .phone import PhoneCall
    from .retell import RetellChat
    from .retell_text_mode import RetellTextMode
    from .retell_web_call import RetellWebCall
    from .scripted import ScriptedCounterpart

    return {
        "livekit_room": _livekit_room,
        "loopback": LoopbackCounterpart,
        "phone_number": PhoneCall,
        "retell_chat_api": RetellChat,
        "retell_text_mode": RetellTextMode,
        "retell_web_call": RetellWebCall,
        "scripted": ScriptedCounterpart,
    }.get(connection_type)
