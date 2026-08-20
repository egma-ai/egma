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
persona say next, and are they done?" — expressed as ``PersonaReply``.
A model signals *done* by ending its reply with the conclude marker, which
the client strips before anyone else sees the text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

import aiohttp

from .client import UNREACHABLE
from .redaction import REDACTED

if TYPE_CHECKING:
    from .spec import SimulationSpec

CONCLUDE_MARKER = "[CONCLUDED]"
"""How a model says the persona is done, per the system prompt's instruction.

Stripped from the reported text: the marker is seam machinery, never part
of the transcript.
"""

GOODBYE = "That covers everything I needed. Thank you, goodbye."
"""The scripted persona's concluding turn, once its scenario runs dry."""

MODEL_TIMEOUT_SECONDS = 60.0
"""How long one model call may take before it is a failure, not a wait."""

OPENAI_API_BASE_URL = "https://api.openai.com/v1"
"""The shipped OpenAI route. It is code, not deployment configuration."""

_SHORT_SECRET_CHARS = r"A-Za-z0-9_-"
"""Characters that make a short API key part of a larger ordinary token."""


@dataclass(frozen=True)
class PersonaReply:
    """One answer from the model: the persona's next words, and whether
    the persona has decided the exchange is concluded."""

    text: str
    concluded: bool


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

    async def reply(self, messages: list[dict[str, str]]) -> PersonaReply: ...

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

    async def reply(self, messages: list[dict[str, str]]) -> PersonaReply:
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
        timeout_seconds: float = MODEL_TIMEOUT_SECONDS,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model_name = model_name
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

    async def reply(self, messages: list[dict[str, str]]) -> PersonaReply:
        asked = {"model": self._model_name, "messages": messages}
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
            content = body["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as unexpected:
            raise ModelFailure(
                "the model's answer had no message content: "
                f"{self._provider_detail(body)}"
            ) from unexpected
        if not isinstance(content, str):
            raise ModelFailure(
                f"the model's content was not text: {self._provider_detail(content)}"
            )

        content = self._without_api_key(content)
        concluded = CONCLUDE_MARKER in content
        text = content.replace(CONCLUDE_MARKER, "").strip()
        if not text:
            raise ModelFailure("the model's answer had no words to speak")
        return PersonaReply(text=text, concluded=concluded)

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
    if selected.provider != "openai" or selected.model != "gpt-4o-mini":
        raise ModelFailure(
            "the claimed persona selected an LLM this simulator does not ship: "
            f"{selected.provider}/{selected.model}"
        )
    if selected.key is None:
        raise ModelFailure("the claimed persona's LLM selection has no direct key")
    return OpenAICompatibleModel(
        base_url=_base_url,
        api_key=selected.key,
        model_name=selected.model,
    )
