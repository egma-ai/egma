"""Model clients produce PersonaReply from composed messages.
ScriptedModel emits scenario sentences and a fixed goodbye for deterministic tests.
OpenAICompatibleModel uses the pinned persona selection and claim credentials.
Only its structured end_call tool ends the exchange; spoken text has no control meaning.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol, cast

import aiohttp
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.adapters.services.open_ai_adapter import (
    OpenAILLMAdapter,
    openai_is_given,
)
from pipecat.processors.aggregators.llm_context import LLMContext

from .client import UNREACHABLE
from .provider_keys import ProviderKeyUnavailable
from .redaction import REDACTED
from .usage import ProviderUsage, llm_usage

if TYPE_CHECKING:
    from openai import AsyncOpenAI

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
    the persona has decided the exchange is concluded.

    Empty text with no tool call means the persona chose to stay silent.
    """

    text: str
    concluded: bool
    tool_calls: tuple[PersonaToolCall, ...] = ()
    usage: ProviderUsage | None = None
    """What the provider says this reply consumed, where it says anything.

    It rides the reply because this is the one moment both facts exist
    together: the body that carried the words is the body that carried the
    bill, and reading one without keeping the other means measuring the call
    again later or not at all. `None` on the scripted client, which spends
    nothing.
    """

    @property
    def requests_end_call(self) -> bool:
        """Whether a non-Pipecat modality must honor the structured request."""
        return any(call.name == END_CALL_TOOL_NAME for call in self.tool_calls)


class ModelFailure(Exception):
    """A model call did not produce a usable persona reply."""

    def __init__(
        self, message: str, *, diagnostic_attributes: dict[str, object] | None = None
    ) -> None:
        super().__init__(message)
        self.diagnostic_attributes = diagnostic_attributes or {}


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


class StreamingModelClient(ModelClient, Protocol):
    """Optional text delivery used by ordinary voice replies."""

    async def reply_streamed(
        self, context: LLMContext, on_text: Callable[[str], Awaitable[None]]
    ) -> PersonaReply: ...


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
        customer_funded: bool = False,
        use_environment_proxy: bool = False,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._customer_funded = customer_funded
        self._model_name = model_name
        self._reasoning_effort = reasoning_effort
        self._timeout = aiohttp.ClientTimeout(total=timeout_seconds)
        self._use_environment_proxy = use_environment_proxy
        self._session: aiohttp.ClientSession | None = None
        self._stream_client: AsyncOpenAI | None = None

    @property
    def model_name(self) -> str:
        return self._model_name

    def _live_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            self._session = aiohttp.ClientSession(trust_env=self._use_environment_proxy)
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

    def _request(self, context: LLMContext) -> dict[str, Any]:
        invocation = _OPENAI_ADAPTER.get_llm_invocation_params(
            context,
            system_instruction=None,
            convert_developer_to_user=False,
        )
        asked: dict[str, Any] = {"model": self._model_name}
        asked.update(
            (name, value)
            for name, value in invocation.items()
            if openai_is_given(value)
        )
        if self._reasoning_effort is not None:
            asked["reasoning_effort"] = self._reasoning_effort
        return asked

    async def reply(self, context: LLMContext) -> PersonaReply:
        asked = self._request(context)
        try:
            async with self._live_session().post(
                f"{self._base_url}/chat/completions",
                json=asked,
                headers={"Authorization": f"Bearer {self._api_key}"},
                timeout=self._timeout,
            ) as response:
                if response.status != 200:
                    if self._customer_funded and response.status in (401, 403):
                        raise ProviderKeyUnavailable("openai")
                    raise ModelFailure(
                        f"the model answered {response.status}: "
                        f"{self._provider_detail(await response.text())}"
                    )
                body = await response.json()
        except UNREACHABLE as error:
            raise ModelFailure(
                f"the model was unreachable: {self._provider_detail(error)}"
            ) from None

        return self._decode_reply(body)

    def _decode_reply(self, body: object) -> PersonaReply:
        diagnostics = _completion_diagnostics(body)
        try:
            message = body["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as unexpected:
            raise ModelFailure(
                "the model's answer had no assistant message",
                diagnostic_attributes=diagnostics,
            ) from unexpected
        if not isinstance(message, dict):
            raise ModelFailure(
                "the model's assistant message was not an object",
                diagnostic_attributes=diagnostics,
            )
        if message.get("refusal"):
            # A refusal is never a persona turn, whatever words or tools came
            # with it.
            raise ModelFailure(
                "the model refused to answer",
                diagnostic_attributes=diagnostics,
            )

        try:
            tool_calls = self._tool_calls_from(message.get("tool_calls"))
        except ModelFailure as failure:
            failure.diagnostic_attributes = diagnostics
            raise
        content = message.get("content")
        if content is None:
            content = ""
        if not isinstance(content, str):
            raise ModelFailure(
                "the model's content was not text",
                diagnostic_attributes=diagnostics,
            )

        content = self._without_api_key(content)
        text = content.strip()
        if not text and not tool_calls:
            # No words and no end_call after a normal stop is the persona
            # staying silent. Any other finish reason, or none, is a failure.
            finish_reason = body["choices"][0].get("finish_reason")
            if finish_reason != "stop":
                raise ModelFailure(
                    "the model's answer had no words to speak (finish reason: "
                    f"{self._provider_detail(finish_reason)})",
                    diagnostic_attributes=diagnostics,
                )
        return PersonaReply(
            text=text,
            concluded=False,
            tool_calls=tool_calls,
            # Kept from the body Egma already has in hand. The pinned catalog
            # model names it rather than the dated variant the provider says it
            # served, because the rate card is keyed by the catalog.
            usage=llm_usage(body, selection_model=self._model_name),
        )

    async def reply_streamed(
        self, context: LLMContext, on_text: Callable[[str], Awaitable[None]]
    ) -> PersonaReply:
        """Release safe text while accumulating tool arguments and usage."""
        import httpx
        from openai import APIError, APIStatusError, AsyncOpenAI

        if self._stream_client is None:
            self._stream_client = AsyncOpenAI(
                api_key=self._api_key,
                base_url=self._base_url,
                timeout=self._timeout.total,
                max_retries=0,
                http_client=httpx.AsyncClient(trust_env=self._use_environment_proxy),
            )
        delivered = ""
        try:
            async with asyncio.timeout(self._timeout.total):
                text = ""
                refusal = ""
                calls: dict[int, dict[str, Any]] = {}
                body: dict[str, Any] = {}
                finish_reason: str | None = None
                async with await self._stream_client.chat.completions.create(
                    **self._request(context),
                    stream=True,
                    stream_options={"include_usage": True},
                ) as stream:
                    async for chunk in stream:
                        body["id"] = chunk.id
                        body["model"] = chunk.model
                        if chunk.usage is not None:
                            body["usage"] = chunk.usage.model_dump()
                        if not chunk.choices:
                            continue
                        choice = chunk.choices[0]
                        if choice.finish_reason is not None:
                            if choice.finish_reason not in ("stop", "tool_calls"):
                                raise ModelFailure(
                                    "the model's streamed reply was incomplete"
                                )
                            finish_reason = choice.finish_reason
                        delta = choice.delta
                        if delta.refusal:
                            refusal += delta.refusal
                        if delta.content:
                            text += delta.content
                        # No text is released once a refusal starts; decoding
                        # then reports the refusal as a model failure.
                        if delta.content and not refusal:
                            safe = self._stream_prefix(text)
                            if safe != delivered:
                                await on_text(safe[len(delivered) :])
                                delivered = safe
                        for part in delta.tool_calls or ():
                            if part.type is not None and part.type != "function":
                                raise ModelFailure(
                                    "the model returned an unsupported tool type"
                                )
                            call = calls.setdefault(
                                part.index,
                                {
                                    "id": "",
                                    "type": "function",
                                    "function": {"name": "", "arguments": ""},
                                },
                            )
                            call["id"] += part.id or ""
                            if part.function:
                                call["function"]["name"] += part.function.name or ""
                                call["function"]["arguments"] += (
                                    part.function.arguments or ""
                                )
                if finish_reason is None:
                    raise ModelFailure(
                        "the model's stream ended before its reply completed"
                    )
                body["choices"] = [
                    {
                        "finish_reason": finish_reason,
                        "message": {
                            "content": text,
                            "refusal": refusal or None,
                            "tool_calls": list(calls.values()),
                        },
                    }
                ]
            reply = self._decode_reply(body)
        except APIStatusError as error:
            if self._customer_funded and error.status_code in (401, 403):
                raise ProviderKeyUnavailable("openai") from None
            raise ModelFailure(
                f"the model answered {error.status_code}: "
                f"{self._provider_detail(error)}"
            ) from None
        except (APIError, TimeoutError) as error:
            raise ModelFailure(
                f"the model was unreachable: {self._provider_detail(error)}"
            ) from None
        if not reply.text.startswith(delivered.rstrip()):
            raise ModelFailure("the model's streamed text changed after delivery")
        if len(reply.text) > len(delivered):
            await on_text(reply.text[len(delivered) :])
        return reply

    def _stream_prefix(self, text: str) -> str:
        """Hold incomplete credential matches before text reaches telemetry."""
        key = self._api_key
        if key and len(key) < 8:
            # A short development key needs the next token boundary to be safe.
            text = re.sub(r"[A-Za-z0-9_-]+$", "", text)
        elif key:
            text = self._without_api_key(text)
            for size in range(min(len(key) - 1, len(text)), 0, -1):
                if text.endswith(key[:size]):
                    text = text[:-size]
                    break
        return self._without_api_key(text).lstrip()

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
        if self._stream_client is not None:
            await self._stream_client.close()
            self._stream_client = None
        if self._session is not None:
            await self._session.close()
            self._session = None


def _completion_diagnostics(body: object) -> dict[str, object]:
    """Safe facts from one unusable completion, without response content."""
    if not isinstance(body, dict):
        return {}
    kept: dict[str, object] = {}
    response_id = body.get("id")
    if isinstance(response_id, str) and response_id:
        kept["gen_ai.response.id"] = response_id[:200]
    served_model = body.get("model")
    if isinstance(served_model, str) and served_model:
        kept["gen_ai.response.model"] = served_model[:200]
    choices = body.get("choices")
    choice = choices[0] if isinstance(choices, list) and choices else None
    if isinstance(choice, dict):
        finish_reason = choice.get("finish_reason")
        if isinstance(finish_reason, str) and finish_reason:
            kept["gen_ai.response.finish_reason"] = finish_reason[:100]
        message = choice.get("message")
        if isinstance(message, dict):
            kept["gen_ai.response.refusal_present"] = bool(message.get("refusal"))
    usage = body.get("usage")
    if isinstance(usage, dict):
        for source, target in (
            ("prompt_tokens", "gen_ai.usage.input_tokens"),
            ("completion_tokens", "gen_ai.usage.output_tokens"),
            ("total_tokens", "gen_ai.usage.total_tokens"),
        ):
            value = usage.get(source)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                kept[target] = value
    return kept


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
        customer_funded=selected.funding_receipt is not None,
        use_environment_proxy=getattr(spec, "runtime", None) is not None,
    )
