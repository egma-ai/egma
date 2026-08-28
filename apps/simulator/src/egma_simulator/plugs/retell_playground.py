"""Retell playground: a Retell **voice** agent, conducted in text.

The fourth plug that reaches an agent where it lives, and the one that
gives a Retell voice agent a chat door at all. It speaks Retell's
agent-playground-completion API over outbound HTTPS: egma sends the whole
conversation so far and Retell answers with the agent's new messages. No
call is created, no number is dialled, no speech is synthesised, and no
audio exists anywhere on this lane — which is the whole point. The same
test run here and over a voice connection is the diagnostic that separates
a broken prompt from a broken speech stack.

**The exchange is stateless, and egma owns it.** Retell keeps nothing
between requests, so every request carries the whole history, the version
to conduct, this simulation's dynamic variables, the native tool mocks,
and where the engine had got to. Every reply carries only what is new. Egma
threads the rest forward turn by turn:

- **the history** — the platform's own message objects, kept **verbatim**,
  with the persona's turns added as they are spoken. Verbatim because a
  stateless engine reconstructs its own context from what it wrote, and a
  message egma tidied is a message the agent never wrote. The one thing
  not kept is the platform's echo of the persona's own turn, where it
  makes one: egma wrote that turn and it is in the history already;
- **the resume state** — the current node (and the component where a flow
  names one) for a conversation flow, the current state for a Retell LLM.
  Carried under the platform's own names, never read and never invented;
- **the dynamic variables** — as the last reply left them, so a variable
  the agent set in turn three is set in turn four.

Its config keys, like every plug's, are its own:

- ``retellAgentId`` (string, required) — the voice agent conducted, exactly
  as the control plane stores it.
- ``baseUrl`` (string, optional) — where the API answers, defaulting to
  Retell itself. What lets a test converse with a playground-shaped server
  on loopback, and a proxy stand in front of the platform for a deployment
  that needs one.

**The version is named on every request.** Retell's own default is the
newest version, which is a moving target: a concurrent edit between one
turn and the next would move the agent under test mid-conversation. A
chat result has to speak for the agent real traffic reaches, so the run
resolves the version once and this plug asks for it by name, every time.

**Mock tools ride the request — and this plug is the one that uses them.**
Retell matches them by tool name and serves them itself, so egma never
stands between the agent and its backend here and there is no draft, no
platform write and nothing to sweep. What egma does have is the answers,
and it hands them over: one per tool, matched by name with the
match-anything rule, arguments never read. A tool the run's snapshot does
not cover runs its real implementation — and on this lane it is observed,
because Retell reports every call it made.

**Mock-tool delays are deliberately not applied here.** The answer is
served inside Retell's own execution, and a declared delay is speech-world
fidelity — the layer chat deliberately excludes. Delays keep their whole
meaning on the voice lanes.

**Which tools may be answered at all is decided before this plug runs**,
and that is why nothing here names a tool type. The run reads the agent's
configuration once, classes each tool, and resolves an answer only for the
ones it means to cover; this plug hands over exactly what it is given and
marks a call ``mocked`` on exactly that basis. So the safe default for a
kind nobody has proved yet — an MCP tool today, which Retell's own mocks
do not match — is simply an answer that never arrives here, and the call
lands on the record as the real one it was. A plug that guessed instead
would be the one place a coverage stamp could start claiming isolation
nobody had.

**No provider reference exists, and the record says so.** The playground
stores nothing: there is no chat, no call and no id for either side to
look this exchange up by. The report carries ``null`` rather than a
synthetic id egma invented, because an id nobody else holds is not a join.

**Roles the record does not know are preserved, never dropped.** Egma
reads four: the agent's words, the persona's own turns echoed back, a tool
being called, and what that call was given. Anything else — a node
transition Retell announces, an SMS leg, whatever a newer platform grows —
is kept **verbatim as agent-side content** on the turn it arrived in. That
is also how a transition lands on the record: the platform says it, and
egma writes down what it said rather than a word of its own.

Credentials are shaped ``{"apiKey": ...}`` — the shape the control plane
seals — and are read for the ``Authorization`` header and nothing else.
They are never logged, never returned, and never put into an exception
message: a refusal names the status the platform answered with and the URL
it answered from, which is what a person needs, and neither is a secret.
Everything quoted from the platform is scrubbed of the key first, here,
where the key is known.

## The wire, and which parts of it are still a guess

Every name below marked **(guess)** was designed from the effort's
description of this API rather than read off a request that really
happened, because no agent may probe the live platform. One live run by
the developer corrects any of them, and the stub in
``tests/playground_stub.py`` is wrong in exactly the same places — so a
correction is one edit here and one there, with the whole suite still
proving the behaviour.

Out, to ``POST {base}/agent-playground-completion/{agent_id}`` (guess: the
path, named in the planning record's earlier onboarding spec):

- ``agent_version`` — the version to conduct. Retell's own name for it on
  every other endpoint, so this one is not much of a guess.
- ``messages`` (guess) — the whole history, oldest first.
- ``retell_llm_dynamic_variables`` — Retell's own name on every other
  endpoint.
- ``tool_mocks`` (guess: that this endpoint takes them at all) — the same
  shape Retell's test-case definitions take: ``tool_name``,
  ``input_match_rule`` of ``"any"``, ``output`` as a string, and ``result``
  saying whether the call succeeded.
- ``current_node_id`` / ``current_component_id`` (guess) / ``current_state``
  — the resume state. The first and last are Retell's own names on
  ``create-web-call``; the component is the guess of the three.

Back:

- ``messages`` (guess) — the agent's **new** messages only.
- ``agent_ended`` (guess) — the flag that ends the exchange from the
  agent's side. An end-tool invocation among the messages is honoured too,
  which is the same fact said the other way.
- ``retell_llm_dynamic_variables`` or ``dynamic_variables`` (guess) — the
  variables as they now stand.
- the same three resume keys.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import quote

import aiohttp

from ..client import UNREACHABLE
from ..mock_tools import MockToolSeam
from . import (
    AgentReply,
    PlugError,
    named_version,
    quotable,
    rendered_variables,
)
from .retell import CREDENTIAL_KEYS, DEFAULT_BASE_URL, END_TOOL_NAMES

COMPLETION_PATH = "/agent-playground-completion"
"""Where the completion answers, before the agent's own id. Named here so a
refusal can say it, and so one live correction is one edit."""

MATCH_ANYTHING = "any"
"""How a native mock is matched: by tool name, whatever the arguments were.

Egma's own rule, said in Retell's word for it. A mock tool never reads a
call's arguments — wrong arguments are caught by grading, not by matching,
because the arguments are on the record either way — so any other rule
would be egma answering for a tool sometimes, which is not a thing the
coverage stamp could honestly say."""

TIMEOUT_SECONDS = 60.0
"""The most one completion may take. Generous because it waits on the
agent's own model and on any real tool the agent called, and anything past
it is a platform that has stopped answering rather than one thinking."""

TOO_MANY_REQUESTS = 429
PAYMENT_REQUIRED = 402

RATE_LIMIT_RETRIES = 3
"""How many times a throttled request is tried again before the simulation
fails. Bounded on purpose: a run that quietly waited out a throttle would
report a shorter exchange than the test asked for, and nothing on the
record would say why."""

FIRST_BACKOFF_SECONDS = 1.0
"""How long the first retry waits; each one after it waits twice as long.
Read at the moment it is spent, so a suite can collapse the waiting without
changing the attempt sequence."""

RESUME_KEYS = ("current_node_id", "current_component_id", "current_state")
"""Where the engine had got to, in the platform's own names. Threaded and
never read: which of them a given agent uses is the agent's business, and a
plug that decided would be a plug with an opinion about somebody else's
engine."""

VARIABLE_KEYS = ("retell_llm_dynamic_variables", "dynamic_variables")
"""What a reply may call the variables as they now stand. Two names because
the outbound one is well attested and the inbound one is not; the first
present wins, and a live run settles which it is."""

AGENT_ROLE = "agent"
USER_ROLE = "user"
INVOCATION_ROLE = "tool_call_invocation"
RESULT_ROLE = "tool_call_result"
KNOWN_ROLES = frozenset({AGENT_ROLE, USER_ROLE, INVOCATION_ROLE, RESULT_ROLE})
"""The four the record knows how to read. Everything else is preserved
verbatim as agent-side content rather than dropped, because a platform
growing a fifth must not cost a simulation part of its transcript."""

_KNOWN_KEYS = {"retellAgentId", "baseUrl"}


class RetellPlayground:
    """One Retell voice agent, conducted in text, per instance."""

    def __init__(
        self,
        *,
        modality: str,
        access_variant: str,
        config: dict[str, Any],
        credentials: object,
        simulation_id: str | None = None,
        agent_version: object = None,
        dynamic_variables: object = None,
        mock_tools: object = None,
        media: object = None,
    ) -> None:
        # The playground stores nothing, so there is no record on Retell's
        # side for this plug to tell which simulation it is. And no audio
        # exists on this lane at all, so the deployment's carrier is
        # nothing to it either.
        del simulation_id, media

        if access_variant != "retell_playground.api_key":
            raise PlugError(
                "the retell playground adapter does not support access variant "
                f"{access_variant!r}"
            )

        if modality != "chat":
            raise PlugError(
                f"the retell playground plug speaks chat only; a {modality!r} "
                "simulation over retell needs the plug carrying the speech legs"
            )

        unknown = set(config) - _KNOWN_KEYS
        if unknown:
            raise PlugError(
                f"the retell playground plug does not know config key(s) "
                f"{sorted(unknown)}; it knows {sorted(_KNOWN_KEYS)}"
            )

        agent_id = config.get("retellAgentId")
        if not isinstance(agent_id, str) or not agent_id.strip():
            raise PlugError(
                "retell playground config: retellAgentId must be a non-empty string"
            )

        base_url = config.get("baseUrl", DEFAULT_BASE_URL)
        if not isinstance(base_url, str) or not base_url.strip():
            raise PlugError(
                "retell playground config: baseUrl must be a non-empty string"
            )

        if not isinstance(credentials, dict):
            raise PlugError(
                "a retell playground connection needs credentials shaped {apiKey}"
            )
        stray = set(credentials) - CREDENTIAL_KEYS
        if stray:
            raise PlugError(
                f"retell playground credentials hold no key(s) {sorted(stray)}; "
                "they are shaped {apiKey}"
            )
        api_key = credentials.get("apiKey")
        if not isinstance(api_key, str) or not api_key.strip():
            raise PlugError(
                "retell playground credentials: apiKey must be a non-empty string"
            )

        self._agent_id = agent_id.strip()
        self._base_url = base_url.strip().rstrip("/")
        self._api_key = api_key.strip()
        self._agent_version = named_version(agent_version)
        # The spec's own variables, held to the spec's own rule. What comes
        # back from Retell replaces them and is *not* held to it: those are
        # the platform's values, and a plug that refused one would be
        # refusing the agent's own state.
        self._variables: dict[str, Any] = dict(rendered_variables(dynamic_variables))
        # Always a seam, even where nobody handed one over: which lane can
        # put egma in the agent's tool path is the plug's answer to give,
        # and this one can, so it always has somewhere to say what it saw.
        self._mock_tools = (
            mock_tools if isinstance(mock_tools, MockToolSeam) else MockToolSeam()
        )
        answers = self._mock_tools.answers()
        self._mocks = [
            {
                "tool_name": answer.tool_name,
                "input_match_rule": MATCH_ANYTHING,
                "output": answer.served,
                # Retell serves the answer either way; this is how it is
                # told to hand the agent a failure rather than a value.
                # Egma's own tag never travels — the platform is the one
                # doing the serving, so it says which branch in its words.
                "result": not answer.fails,
            }
            for answer in answers
        ]
        self._timeout = aiohttp.ClientTimeout(total=TIMEOUT_SECONDS)
        self._session: aiohttp.ClientSession | None = None
        self._history: list[Any] = []
        self._resume: dict[str, Any] = {}
        self._ended = False

    @property
    def base_url(self) -> str:
        """Where this exchange is conducted — the URL every refusal names."""
        return self._base_url

    @property
    def completion_path(self) -> str:
        """Where one exchange is asked for, this agent's id included."""
        return f"{COMPLETION_PATH}/{quote(self._agent_id, safe='')}"

    @property
    def provider_reference(self) -> str | None:
        """Nothing, always — and that is the honest answer here.

        The playground keeps no record of its own: no chat is opened, no
        call is created, and Retell hands back no id for either side to
        look this exchange up by. A reference exists to join egma's record
        to the platform's telemetry, and there is no telemetry to join to,
        so the report says ``null`` rather than carrying an id only egma
        has ever seen.
        """
        return None

    async def open(self) -> str | None:
        """Ask for the agent's opening line, with nothing said yet.

        One bounded exchange against an empty history. An agent configured
        to speak first has spoken by the time this answers; one that waits
        for the caller answers with nothing, and the persona opens instead.
        """
        self._session = aiohttp.ClientSession()
        return self._read(await self._exchange()).text

    async def deliver(self, text: str) -> AgentReply:
        if self._session is None:
            raise PlugError(
                "a turn reached the retell playground plug before the exchange "
                "opened"
            )
        if self._ended:
            # The agent ended the exchange with its opening line — rare,
            # and real: "we are closed today" and a goodbye. Retell would
            # answer a request continuing an ended exchange with a refusal,
            # so the ending is reported rather than argued with.
            return AgentReply(text=None, ended=True)
        self._history.append({"role": USER_ROLE, "content": text})
        return self._read(await self._exchange())

    async def close(self) -> None:
        """Let go of the connection. Safe from every state.

        There is nothing to tear down: no chat was opened, no call was
        created, and the playground stored nothing that could be left
        behind. Closing is closing the socket.
        """
        session, self._session = self._session, None
        if session is not None:
            await session.close()

    # -- The one request this plug makes, and how it is read ------------------

    def _asked(self) -> dict[str, Any]:
        """What one exchange is asked for.

        Everything the agent needs to answer this turn, because Retell
        keeps none of it: the whole history, the version by name, this
        simulation's variables as they now stand, the answers egma wants
        served, and where the engine had got to. Absent stays absent — a
        version Retell was not asked for is a version it chooses itself,
        and an empty variable block is not the same as none, because
        Retell renders what it is given.
        """
        asked: dict[str, Any] = {"messages": list(self._history)}
        if self._agent_version is not None:
            asked["agent_version"] = self._agent_version
        if self._variables:
            asked["retell_llm_dynamic_variables"] = self._variables
        if self._mocks:
            asked["tool_mocks"] = self._mocks
        asked.update(self._resume)
        return asked

    async def _exchange(self) -> dict:
        """One completion, and egma's answers into Retell's hands with it."""
        answered = await self._call(self._asked())
        # Said once the platform has really taken them, and not before: a
        # request that never landed put egma in nobody's tool path, and a
        # coverage stamp claiming otherwise is the one thing the stamp
        # exists to make impossible.
        self._mock_tools.handed_over()
        return answered

    def _read(self, answered: dict) -> AgentReply:
        """The agent's new messages, become one turn on the record.

        The messages join the history verbatim first, because they are
        what the next request replays. Then they are read: the agent's
        words are the turn, its tool calls go to the seam that stamps
        them, and anything in a role this record does not know is kept as
        agent-side content rather than quietly lost.
        """
        messages = answered.get("messages")
        if not isinstance(messages, list):
            raise PlugError(
                "retell answered a playground completion with no messages list"
            )
        # Everything the platform said, verbatim — except its echo of the
        # persona's own turn, which egma wrote into the history before
        # sending it. Egma owns that side of the conversation; keeping an
        # echo would have the caller say everything twice from the next
        # request onward, and this is the one place that could happen.
        self._history.extend(
            message
            for message in messages
            if not (isinstance(message, dict) and message.get("role") == USER_ROLE)
        )

        said: list[str] = []
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in KNOWN_ROLES:
                # A role nobody here understands, or something that is not
                # a message at all. Preserved as the agent's own content,
                # exactly as it arrived: a platform that grows a fifth role
                # must not cost this simulation part of its transcript.
                kept = _preserved(message)
                if kept:
                    said.append(kept)
                continue
            role = message.get("role")
            if role == AGENT_ROLE:
                spoken = message.get("content")
                if isinstance(spoken, str) and spoken.strip():
                    said.append(spoken.strip())
            elif role == INVOCATION_ROLE:
                self._observed(message)

        self._resume_from(answered)
        self._variables_from(answered)
        self._ended = _ended(answered, messages)
        return AgentReply(
            text="\n".join(said) or None,
            ended=self._ended,
            # Deliberately empty: every tool fact this lane sees goes to
            # the mock-tool seam, which is the only writer that can stamp
            # a call `mocked` and say what it was given. Reporting them
            # here as well would put each call on the record twice.
            tool_calls=(),
        )

    def _observed(self, message: dict) -> None:
        """One tool call Retell reported, handed to the seam that stamps it.

        Marked ``mocked`` exactly where the run's snapshot covers the
        name, and that is sound rather than optimistic: a covered name
        rode this request as a native mock matched by name alone, so
        Retell answered it from egma's own answer and the real tool never
        ran. A name the snapshot does not cover ran for real, and lands as
        the observation it is.

        What the call was *given* is not read off the reply, even though
        the reply reports it. For a covered call it is egma's own answer
        coming back, and the seam holds a better copy — one that still
        says which branch it was. For an uncovered one it is the
        customer's real backend answering, which is neither egma's to
        vouch for nor something the record has an honest stamp for.
        """
        name = message.get("name")
        if not isinstance(name, str) or not name.strip():
            return
        arguments = message.get("arguments")
        self._mock_tools.reported(
            name,
            arguments=arguments if isinstance(arguments, str) and arguments else None,
        )

    def _resume_from(self, answered: dict) -> None:
        """Where the engine got to, carried to the next request untouched.

        A key the reply names is set to what it says, and a key it names
        as nothing is dropped — an engine that left a component is not an
        engine still in one, and sending the emptiness back would be egma
        arguing with it.
        """
        for key in RESUME_KEYS:
            if key not in answered:
                continue
            moved = answered[key]
            if moved is None:
                self._resume.pop(key, None)
            else:
                self._resume[key] = moved

    def _variables_from(self, answered: dict) -> None:
        """The variables as the reply left them, carried forward as they came.

        Not held to the contract's rule about what a rendered variable
        may be. That rule guards the values *egma* sends, and is the last
        place a mistake in a claimed spec can be named; these are the
        platform's own values coming back, and a plug that refused one
        would be refusing the agent's own state.
        """
        for key in VARIABLE_KEYS:
            carried = answered.get(key)
            if isinstance(carried, dict):
                self._variables = dict(carried)
                return

    # -- Reaching the platform, without ever saying the key -------------------

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}"}

    async def _call(self, payload: dict) -> dict:
        """One completion, or a refusal saying what happened without the key.

        A throttled reply is tried again a bounded number of times, waiting
        twice as long each time, and then fails the simulation naming the
        throttle: a run that waited one out would report a shorter exchange
        than the test asked for with nothing on the record to say why.
        """
        session = self._session
        if session is None:
            raise PlugError("the retell playground plug was used outside its lifecycle")

        url = f"{self._base_url}{self.completion_path}"
        attempts = 0
        while True:
            status, body = await self._answered(session, url, payload)
            if status != TOO_MANY_REQUESTS or attempts >= RATE_LIMIT_RETRIES:
                break
            await asyncio.sleep(FIRST_BACKOFF_SECONDS * (2**attempts))
            attempts += 1

        if status == TOO_MANY_REQUESTS:
            raise PlugError(
                f"retell throttled this simulation: it answered {status} to "
                f"{self.completion_path} at {self._base_url}, on the first try "
                f"and on {attempts} retries after it. Retell said: "
                f"{quotable(body, self._api_key)}. Run fewer simulations at once, "
                "or raise the rate limit on the Retell account — a simulation "
                "that waited this out would be a shorter exchange than the test "
                "asked for"
            )
        if status == PAYMENT_REQUIRED:
            raise PlugError(
                f"retell answered {status} to {self.completion_path} at "
                f"{self._base_url}: this Retell account cannot be billed for the "
                f"exchange. Retell said: {quotable(body, self._api_key)}. Settle "
                "the billing on the Retell account and run the test again — "
                "nothing about the agent under test is wrong"
            )
        if status // 100 != 2:
            raise PlugError(
                f"retell answered {status} to {self.completion_path} at "
                f"{self._base_url}: {quotable(body, self._api_key)}"
            )

        try:
            document = json.loads(body)
        except ValueError as unreadable:
            raise PlugError(
                f"retell answered {self.completion_path} with something that is "
                "not JSON"
            ) from unreadable
        if not isinstance(document, dict):
            raise PlugError(
                f"retell answered {self.completion_path} with "
                f"{type(document).__name__}, not an object"
            )
        return document

    async def _answered(
        self, session: aiohttp.ClientSession, url: str, payload: dict
    ) -> tuple[int, str]:
        """One attempt: the status it came back with and what it said."""
        try:
            async with session.post(
                url,
                json=payload,
                headers=self._headers(),
                timeout=self._timeout,
            ) as response:
                return response.status, await response.text()
        except UNREACHABLE as unreachable:
            raise PlugError(
                f"retell was unreachable at {url}: "
                f"{quotable(repr(unreachable), self._api_key)}"
            ) from unreachable


def _preserved(message: object) -> str:
    """One message in a role the record does not know, kept as it arrived.

    Its own content where it has one, because that is what a reader wants
    to see; the whole message otherwise, because the alternative is
    dropping something a platform meant to tell egma. Never trimmed:
    verbatim means verbatim, and a transition or an SMS leg is not this
    plug's prose to tidy.
    """
    if isinstance(message, dict):
        carried = message.get("content")
        if isinstance(carried, str):
            return carried
    return _compact(message)


def _compact(value: object) -> str:
    """One JSON document, in the compact shape the rest of egma writes."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str)


def _ended(answered: dict, messages: list) -> bool:
    """Whether the agent ended the exchange with this answer.

    Two ways of saying one thing, and either counts. The platform's own
    flag is the direct statement. An end-tool invocation among the
    messages is the agent saying it in the way a Retell agent ends any
    exchange, and a reply carrying one without the flag still ended.
    """
    if answered.get("agent_ended") is True:
        return True
    return any(
        isinstance(message, dict)
        and message.get("role") == INVOCATION_ROLE
        and message.get("name") in END_TOOL_NAMES
        for message in messages
    )
