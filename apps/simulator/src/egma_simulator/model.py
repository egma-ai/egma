"""The model-client seam: where the persona's words come from.

The persona brain decides *when* to speak and what it knows; a model client
is what turns the composed messages into the persona's next words. It has
exactly two implementations on purpose:

- ``ScriptedModel`` — what CI runs on. Deterministic: the persona's turns
  are the spec's scenario instructions, sentence by sentence, and a fixed
  goodbye that concludes the exchange when the script runs dry. The same
  messages always produce the same reply, so nothing in the suite can flake
  on a model.
- ``OpenAICompatibleModel`` — the real thing, selected by configuration:
  any provider speaking the OpenAI chat-completions shape, reached over
  outbound HTTPS with the key from the environment.

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
from .config import MODEL_PROVIDERS

if TYPE_CHECKING:
    from .config import SimulatorConfig
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

    async def reply(self, messages: list[dict[str, str]]) -> PersonaReply:
        spoken = sum(1 for message in messages if message["role"] == "assistant")
        if spoken < len(self._script):
            return PersonaReply(text=self._script[spoken], concluded=False)
        return PersonaReply(text=GOODBYE, concluded=True)

    async def close(self) -> None:
        return None


class OpenAICompatibleModel:
    """A real provider behind the same seam, speaking the OpenAI
    chat-completions shape — which is also what most self-hosted gateways
    answer. Configuration decides the base URL, model name, and key; CI
    never selects this client."""

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

    def _live_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            self._session = aiohttp.ClientSession()
        return self._session

    async def reply(self, messages: list[dict[str, str]]) -> PersonaReply:
        # **The field is absent unless somebody asked for it**, rather than
        # sent with a default this file chose. Providers speaking one
        # chat-completions shape do not agree on the accepted values, and
        # some models refuse the field outright — so a request that always
        # carried it would be egma narrowing which models a deployment can
        # run to the ones egma happened to know about.
        asked = {"model": self._model_name, "messages": messages}
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
                        f"{(await response.text())[:200]}"
                    )
                body = await response.json()
        except UNREACHABLE as error:
            raise ModelFailure(f"the model was unreachable: {error!r}") from error

        try:
            content = body["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as unexpected:
            raise ModelFailure(
                f"the model's answer had no message content: {body!r}"
            ) from unexpected
        if not isinstance(content, str):
            raise ModelFailure(f"the model's content was not text: {content!r}")

        concluded = CONCLUDE_MARKER in content
        return PersonaReply(
            text=content.replace(CONCLUDE_MARKER, "").strip(), concluded=concluded
        )

    async def close(self) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None


def build_model_client(
    config: SimulatorConfig, spec: SimulationSpec
) -> ModelClient:
    """The configured client, built fresh for one simulation.

    The scripted client derives its script from the spec, which is what
    makes two different specs conduct two different exchanges with no code
    change; the OpenAI-compatible client is configuration alone.

    **The platform's own settings win over this container's.** They arrive
    on the work order, they are read afresh for every simulation, and each
    of the four replaces this container's answer on its own — so a
    deployment that has configured the persona's model centrally needs no
    model variables on any simulator, and a replaced key applies to the
    next simulation with no restart. A setting the platform does not hold
    leaves this container's own value standing, which is what makes a
    deployment that has configured nothing behave exactly as it did.
    """
    said = spec.platform.model
    provider = said.provider or config.model_provider
    if provider not in MODEL_PROVIDERS:
        # **Refused rather than quietly downgraded to the stand-in.** This
        # container's own provider name is checked when it starts, so a
        # name that gets here is one the platform holds — and a typo on a
        # settings page must not produce a completed, green simulation
        # conducted by a canned robot. That is worse than a failure,
        # because a failure tells the truth about what happened.
        raise ModelFailure(
            f"the platform's persona_model_provider is {provider!r}, which is "
            "not a model client this simulator has; it thinks with "
            f"{', '.join(MODEL_PROVIDERS)}"
        )
    if provider != "openai":
        return ScriptedModel(spec.scenario_instructions)

    model_name = said.model or config.model_name
    api_key = said.key or config.model_api_key
    if model_name is None or api_key is None:
        raise ModelFailure(
            "the openai model provider needs both a model name and a key"
        )
    return OpenAICompatibleModel(
        # The base URL stays this container's. It is not one of the
        # platform's settings: it says which address this simulator reaches
        # a provider at, which is a property of the network it is on rather
        # than of the deployment's account.
        base_url=config.model_base_url,
        api_key=api_key,
        model_name=model_name,
        reasoning_effort=(
            said.reasoning_effort or config.model_reasoning_effort
        ),
    )
