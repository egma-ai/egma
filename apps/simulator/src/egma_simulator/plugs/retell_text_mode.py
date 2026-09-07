"""Retell voice-agent testing through the text playground API, without audio.
Config requires retellAgentId; baseUrl optionally selects a proxy or test server.
Credentials contain apiKey; redact it from platform errors.

Each request carries the full history, supplied agent version, current variables,
resume state, and test-owned mock tools. Preserve platform messages, excluding
duplicate persona echoes. Merge returned variables and carry resume state forward.
There is no platform call ID, so provider_reference is None.

Retell serves the submitted tool mocks. Uncovered tools run their real
implementations. Match observed calls to mock answers by tool name; this adapter
does not compare returned values to the submitted answer. Keep non-speech
platform messages in platform_notes, outside the persona's transcript.

Wire assumptions require live validation; the local stub cannot prove them:
- POST /agent-playground-completion/{agent_id} and its messages field.
- Acceptance of tool_mocks and current_component_id.
- New-messages-only replies and agent_ended.
- Returned variable names and whether they contain a delta or the full set.
See the opt-in live text-mode tests before relying on these assumptions.
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
record could honestly say."""

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

LONGEST_BACKOFF_SECONDS = 8.0
"""The longest one retry ever waits, whatever the platform asked for.

A ``Retry-After`` of ten minutes is a platform describing its own day, and
a simulation that slept through it would report a shorter exchange than the
test asked for — the very thing the bounded retry exists to prevent. Past
this the honest answer is to fail naming the throttle."""

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


class RetellTextMode:
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
        job_dispatch_metadata: object = None,
        mock_tools: object = None,
        media: object = None,
    ) -> None:
        # Text mode stores nothing, so there is no record on Retell's
        # side for this plug to tell which simulation it is. And no audio
        # exists on this lane at all, so the deployment's carrier is
        # nothing to it either. It dispatches no worker, so the half of
        # the test's env that rides a job dispatch has nowhere to go.
        del simulation_id, media, job_dispatch_metadata

        if access_variant != "retell_text_mode.api_key":
            raise PlugError(
                "the retell text-mode adapter does not support access variant "
                f"{access_variant!r}"
            )

        if modality != "chat":
            raise PlugError(
                f"the retell text-mode plug speaks chat only; a {modality!r} "
                "simulation over retell needs the plug carrying the speech legs"
            )

        unknown = set(config) - _KNOWN_KEYS
        if unknown:
            raise PlugError(
                f"the retell text-mode plug does not know config key(s) "
                f"{sorted(unknown)}; it knows {sorted(_KNOWN_KEYS)}"
            )

        agent_id = config.get("retellAgentId")
        if not isinstance(agent_id, str) or not agent_id.strip():
            raise PlugError(
                "retell text mode config: retellAgentId must be a non-empty string"
            )

        base_url = config.get("baseUrl", DEFAULT_BASE_URL)
        if not isinstance(base_url, str) or not base_url.strip():
            raise PlugError(
                "retell text mode config: baseUrl must be a non-empty string"
            )

        if not isinstance(credentials, dict):
            raise PlugError(
                "a retell text-mode connection needs credentials shaped {apiKey}"
            )
        stray = set(credentials) - CREDENTIAL_KEYS
        if stray:
            raise PlugError(
                f"retell text mode credentials hold no key(s) {sorted(stray)}; "
                "they are shaped {apiKey}"
            )
        api_key = credentials.get("apiKey")
        if not isinstance(api_key, str) or not api_key.strip():
            raise PlugError(
                "retell text mode credentials: apiKey must be a non-empty string"
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

        Text mode keeps no record of its own: no chat is opened, no
        call is created, and Retell hands back no id for either side to
        look this exchange up by. A reference exists to join egma's record
        to the platform's telemetry, and there is no telemetry to join to,
        so the report says ``null`` rather than carrying an id only egma
        has ever seen.
        """
        return None

    async def open(self) -> AgentReply:
        """Request an optional greeting with empty history. Return the full AgentReply
        so opening platform notes and an immediate agent ending are preserved.
        """
        self._session = aiohttp.ClientSession()
        return self._read(await self._exchange())

    async def deliver(self, text: str) -> AgentReply:
        if self._session is None:
            raise PlugError(
                "a turn reached the retell text-mode plug before the exchange "
                "opened"
            )
        if self._ended:
            # The exchange is already over — the agent ended it with its
            # opening line, say. The walk stops at the opening for exactly
            # that case and never gets here, so this is for anything else
            # that drives a plug: a request continuing an ended exchange
            # is a refusal from Retell rather than a turn, and reporting
            # the ending again is the honest answer to a question already
            # answered.
            return AgentReply(text=None, ended=True)
        self._history.append({"role": USER_ROLE, "content": text})
        return self._read(await self._exchange())

    async def close(self) -> None:
        """Let go of the connection. Safe from every state.

        There is nothing to tear down: no chat was opened, no call was
        created, and text mode stored nothing that could be left
        behind. Closing is closing the socket.
        """
        session, self._session = self._session, None
        if session is not None:
            await session.close()

    # -- The one request this plug makes, and how it is read ------------------

    def _asked(self) -> dict[str, Any]:
        """Build a request with history, supplied version, current variables, mock
        tools,
        and resume state. Omit absent values rather than sending empty placeholders.
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
        return await self._call(self._asked())

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
                "retell answered a text-mode completion with no messages list"
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
        noted: list[str] = []
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in KNOWN_ROLES:
                # A role nobody here understands, or something that is not
                # a message at all. Kept as agent-side content — beside the
                # turn, never in it — because a platform that grows a fifth
                # role must not cost this simulation part of its record,
                # and must not put words in the agent's mouth either.
                kept = _preserved(message)
                if kept:
                    noted.append(kept)
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
            # the mock-tool seam, which is the one writer of this lane's
            # tool record. Reporting them here as well would put each call
            # on the record twice.
            tool_calls=(),
            platform_notes=tuple(noted),
        )

    def _observed(self, message: dict) -> None:
        """Record a reported tool call through MockToolSeam. Covered names use the
                authored answer; uncovered calls retain the name and arguments without
                an answer.
        """
        name = message.get("name")
        if not isinstance(name, str) or not name.strip():
            return
        called = name.strip()
        arguments = message.get("arguments")
        self._mock_tools.reported(
            called,
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
        """Merge returned variables because the reply may contain only changed values.
        Preserve platform values without applying the input contract's string
        validation.
        """
        for key in VARIABLE_KEYS:
            carried = answered.get(key)
            if isinstance(carried, dict):
                self._variables = {**self._variables, **carried}
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
            raise PlugError("the retell text-mode plug was used outside its lifecycle")

        url = f"{self._base_url}{self.completion_path}"
        attempts = 0
        while True:
            status, body, asked_for = await self._attempt(session, url, payload)
            if status != TOO_MANY_REQUESTS or attempts >= RATE_LIMIT_RETRIES:
                break
            await asyncio.sleep(
                _waiting(asked_for, FIRST_BACKOFF_SECONDS * (2**attempts))
            )
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

    async def _attempt(
        self, session: aiohttp.ClientSession, url: str, payload: dict
    ) -> tuple[int, str, str | None]:
        """One attempt: the status, what it said, and when to come back.

        The third is the platform's ``Retry-After`` where it sent one. A
        throttled platform saying how long it wants is worth more than any
        number egma could pick, and it is read here rather than guessed
        at — bounded, because a header is not a promise this process has
        to keep for minutes.
        """
        try:
            async with session.post(
                url,
                json=payload,
                headers=self._headers(),
                timeout=self._timeout,
            ) as response:
                return (
                    response.status,
                    await response.text(),
                    response.headers.get("Retry-After"),
                )
        except UNREACHABLE as unreachable:
            raise PlugError(
                f"retell was unreachable at {url}: "
                f"{quotable(repr(unreachable), self._api_key)}"
            ) from unreachable


def _waiting(asked_for: str | None, backing_off: float) -> float:
    """Use the longer of numeric Retry-After and local backoff, capped at
    LONGEST_BACKOFF_SECONDS. Missing or invalid headers use local backoff.
    """
    if asked_for is None:
        return backing_off
    try:
        # Seconds only. `Retry-After` may also be an HTTP date, which is
        # not read: parsing one would mean trusting two clocks to agree,
        # and the backoff below is a perfectly good answer without it.
        wanted = float(asked_for.strip())
    except ValueError:
        return backing_off
    if wanted <= 0:
        return backing_off
    return min(max(wanted, backing_off), LONGEST_BACKOFF_SECONDS)


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
