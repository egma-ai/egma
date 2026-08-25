"""The model-client seam: where the persona's words come from.

The persona brain decides *when* to speak and what it knows; a model client
turns the composed messages into the persona's next words.

- ``ScriptedModel`` is the deterministic test implementation. The persona's turns
  are the spec's scenario instructions, sentence by sentence, and a fixed
  goodbye that concludes the exchange when the script runs dry. The same
  messages always produce the same reply, so nothing in the suite can flake
  on a model.
- ``OpenAICompatibleModel`` is the shipped adapter. The pinned persona version
  selects it, and the claim carries the direct provider key.

Both answer one question — "given this conversation so far, what does the
persona say next, and are they done?" — expressed as ``PersonaReply``. The
shipped adapter learns that second fact only from the structured ``end_call``
tool. No string in the persona's spoken text has control meaning.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol, cast

import aiohttp
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.adapters.services.open_ai_adapter import OpenAILLMAdapter, is_given
from pipecat.processors.aggregators.llm_context import LLMContext

from .client import UNREACHABLE
from .redaction import REDACTED

if TYPE_CHECKING:
    from .spec import SimulationSpec

END_CALL_TOOL_NAME = "end_call"
END_CALL_TOOL = FunctionSchema(
    name=END_CALL_TOOL_NAME,
    description=(
        "use to end the call once you have determined that the objective of "
        "the current simulation has been met."
    ),
    properties={},
    required=[],
)
PERSONA_TOOLS = ToolsSchema(standard_tools=[END_CALL_TOOL])
"""The control primitive every persona model receives, in Pipecat's schema."""

_OPENAI_ADAPTER = OpenAILLMAdapter()

GOODBYE = "That covers everything I needed. Thank you, goodbye."
"""The scripted persona's concluding turn, once its scenario runs dry."""

MODEL_TIMEOUT_SECONDS = 60.0
"""How long one model call may take before it is a failure, not a wait."""

OPENAI_API_BASE_URL = "https://api.openai.com/v1"
"""The shipped OpenAI route. It is code, not deployment configuration."""

_SHORT_SECRET_CHARS = r"A-Za-z0-9_-"
"""Characters that make a short API key part of a larger ordinary token."""


@dataclass(frozen=True)
class PersonaToolCall:
    """One provider tool call, decoded at the adapter boundary.

    The adapter validates provider JSON. The Pipecat LLM service owns executing
    the resulting call; this type carries no control decision by itself.
    """

    tool_call_id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class PersonaReply:
    """One answer from the model: the persona's next words, and whether
    the persona has decided the exchange is concluded."""

    text: str
    concluded: bool
    tool_calls: tuple[PersonaToolCall, ...] = ()

    @property
    def requests_end_call(self) -> bool:
        """Whether a non-Pipecat modality must honor the structured request."""
        return any(call.name == END_CALL_TOOL_NAME for call in self.tool_calls)


class ModelFailure(Exception):
    """A model call did not produce words the persona can speak."""


class ModelClient(Protocol):
    """The seam. ``reply`` takes chat-shaped messages — a system prompt
    followed by the conversation so far, persona turns as ``assistant`` and
    the agent's as ``user`` — and returns the persona's next turn.
    ``close`` releases whatever the client holds; always called once the
    simulation is over."""

    @property
    def model_name(self) -> str: ...

    async def reply(self, context: LLMContext) -> PersonaReply: ...

    async def close(self) -> None: ...


_SENTENCES = re.compile(r"[^.!?]+[.!?]*")


def split_sentences(text: str) -> list[str]:
    """The text, sentence by sentence — the scripted model's whole script."""
    sentences = [sentence.strip() for sentence in _SENTENCES.findall(text)]
    return [sentence for sentence in sentences if sentence] or [text.strip()]


class ScriptedModel:
    """Deterministic persona turns derived from the scenario instructions.

    Which sentence comes next is read off the messages themselves — the
    count of ``assistant`` turns already spoken — so the reply is a pure
    function of its input and identical across resends, restarts, and
    reruns. When the script is spent, the persona says a fixed goodbye and
    concludes.
    """

    def __init__(self, scenario_instructions: str) -> None:
        self._script = split_sentences(scenario_instructions)

    @property
    def model_name(self) -> str:
        return "scripted"

    async def reply(self, context: LLMContext) -> PersonaReply:
        messages = cast(list[dict[str, str]], context.get_messages())
        spoken = sum(1 for message in messages if message["role"] == "assistant")
        if spoken < len(self._script):
            return PersonaReply(text=self._script[spoken], concluded=False)
        return PersonaReply(text=GOODBYE, concluded=True)

    async def close(self) -> None:
        return None


class OpenAICompatibleModel:
    """The direct OpenAI adapter behind the model-client seam.

    The pinned persona version supplies the model and the claim supplies the
    current key. CI never selects this client.
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model_name: str,
        reasoning_effort: str | None = None,
        timeout_seconds: float = MODEL_TIMEOUT_SECONDS,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model_name = model_name
        self._reasoning_effort = reasoning_effort
        self._timeout = aiohttp.ClientTimeout(total=timeout_seconds)
        self._session: aiohttp.ClientSession | None = None

    @property
    def model_name(self) -> str:
        return self._model_name

    def _live_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            self._session = aiohttp.ClientSession()
        return self._session

    def _provider_detail(self, value: object) -> str:
        """A bounded provider detail with this client's credential removed.

        Model failures cross Pipecat's traced service seam. Pipecat records
        exception messages on its native span, before the simulation lifecycle
        applies its process-wide redactor, so the client must remove the key at
        the source.
        """
        rendered = value if isinstance(value, str) else repr(value)
        return self._without_api_key(rendered)[:200]

    def _without_api_key(self, text: str) -> str:
        """Remove this client's bearer key from provider-authored text.

        A one-character development key such as ``k`` must not rewrite every
        word containing that letter. Short keys are therefore removed when
        they appear as their own token, which still covers an echoed bearer,
        JSON value, URL parameter, or provider sentence. Real provider keys are
        long enough to replace exactly wherever they occur.
        """
        if not self._api_key:
            return text
        if len(self._api_key) >= 8:
            return text.replace(self._api_key, REDACTED)
        return re.sub(
            rf"(?<![{_SHORT_SECRET_CHARS}]){re.escape(self._api_key)}"
            rf"(?![{_SHORT_SECRET_CHARS}])",
            REDACTED,
            text,
        )

    async def reply(self, context: LLMContext) -> PersonaReply:
        invocation = _OPENAI_ADAPTER.get_llm_invocation_params(
            context,
            system_instruction=None,
            convert_developer_to_user=False,
        )
        asked: dict[str, Any] = {"model": self._model_name}
        asked.update(
            (name, value)
            for name, value in invocation.items()
            if is_given(value)
        )
        if self._reasoning_effort is not None:
            asked["reasoning_effort"] = self._reasoning_effort
        try:
            async with self._live_session().post(
                f"{self._base_url}/chat/completions",
                json=asked,
                headers={"Authorization": f"Bearer {self._api_key}"},
                timeout=self._timeout,
            ) as response:
                if response.status != 200:
                    raise ModelFailure(
                        f"the model answered {response.status}: "
                        f"{self._provider_detail(await response.text())}"
                    )
                body = await response.json()
        except UNREACHABLE as error:
            raise ModelFailure(
                f"the model was unreachable: {self._provider_detail(error)}"
            ) from None

        try:
            message = body["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as unexpected:
            raise ModelFailure(
                "the model's answer had no assistant message: "
                f"{self._provider_detail(body)}"
            ) from unexpected
        if not isinstance(message, dict):
            raise ModelFailure(
                "the model's assistant message was not an object: "
                f"{self._provider_detail(message)}"
            )

        tool_calls = self._tool_calls_from(message.get("tool_calls"))
        content = message.get("content")
        if content is None and tool_calls:
            # Chat-completions providers commonly return null content for a
            # function call. The call must still have audible words before the
            # pipeline ends, so use the same bounded goodbye as the scripted
            # model when the provider omits them.
            content = GOODBYE
        if not isinstance(content, str):
            raise ModelFailure(
                f"the model's content was not text: {self._provider_detail(content)}"
            )

        content = self._without_api_key(content)
        text = content.strip()
        if not text and tool_calls:
            text = GOODBYE
        if not text:
            raise ModelFailure("the model's answer had no words to speak")
        return PersonaReply(text=text, concluded=False, tool_calls=tool_calls)

    def _tool_calls_from(self, written: object) -> tuple[PersonaToolCall, ...]:
        """Decode provider tool JSON; Pipecat executes the typed call later."""
        if written is None:
            return ()
        if not isinstance(written, list):
            raise ModelFailure("the model's tool_calls value was not a list")
        if len(written) > 1:
            raise ModelFailure(
                "the persona model called more than one tool in one turn"
            )
        if not written:
            return ()

        call = written[0]
        if (
            not isinstance(call, dict)
            or call.get("type") != "function"
            or not isinstance(call.get("id"), str)
            or not call["id"].strip()
            or not isinstance(call.get("function"), dict)
        ):
            raise ModelFailure("the persona model returned a malformed tool call")
        function = call["function"]
        name = function.get("name")
        if name != END_CALL_TOOL_NAME:
            raise ModelFailure(
                f"the persona model called an unavailable tool: {name!r}"
            )

        arguments = function.get("arguments")
        if not isinstance(arguments, str):
            raise ModelFailure("the persona model's end_call arguments were not JSON")
        try:
            decoded = json.loads(arguments)
        except json.JSONDecodeError as unexpected:
            raise ModelFailure(
                "the persona model's end_call arguments were not valid JSON"
            ) from unexpected
        if decoded != {}:
            raise ModelFailure("the persona model's end_call tool takes no arguments")
        return (
            PersonaToolCall(
                tool_call_id=call["id"],
                name=END_CALL_TOOL_NAME,
                arguments=decoded,
            ),
        )

    async def close(self) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None


def build_model_client(
    spec: SimulationSpec,
    *,
    _base_url: str = OPENAI_API_BASE_URL,
) -> ModelClient:
    """Build the pinned persona version's direct LLM adapter.

    Provider, model, and key come from one required selection. The adapter's
    provider endpoint is fixed here. ``_base_url`` is only the local protocol
    test seam; no deployment input reaches it.
    """
    selected = spec.models.llm
    if selected.adapter != "openai_chat_completions":
        raise ModelFailure(
            "the claimed persona selected an LLM adapter this simulator does not "
            f"ship: {selected.adapter!r}"
        )
    if selected.key is None:
        raise ModelFailure("the claimed persona's LLM selection has no direct key")
    return OpenAICompatibleModel(
        base_url=_base_url,
        api_key=selected.key,
        model_name=selected.model,
        reasoning_effort=selected.reasoning_effort,
    )
