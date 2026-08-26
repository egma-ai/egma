"""The persona brain: one component, shared by every modality forever.

It composes the authored persona — the name they answer to, how they behave,
the language they speak — and the test's scenario into a system prompt, takes
turns — the transcript's ``human`` side — and decides when the exchange is
concluded. What it does not know is deliberate: it never sees a platform
(that is the plug's business) and never produces its own words (that is the
model client's), so the same brain conducts a chat today and speaks through
voice legs when those arrive.

The name is stated in the frame rather than left among the details the model
may invent. A prompt that licensed one produced a different person on every
run of the same test, which made a name-keyed mock world impossible and an
old transcript unanswerable about who the agent actually heard.

Role mapping is from the persona's own seat at the table: the persona is
the ``assistant`` the model plays, and the agent under test is the
``user`` it is answering.
"""

# The prompt is product copy. Its long lines stay intact so source and runtime match.
# ruff: noqa: E501

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from pipecat.processors.aggregators.llm_context import LLMContext

from .model import PERSONA_TOOLS, ModelClient, PersonaReply
from .spec import AuthoredPersona

OPENING_NUDGE = (
    "(The conversation is open and the agent is listening. Speak your first turn.)"
)
"""Stands in for the silence when the persona goes first: chat-shaped
models answer a user message, and an empty history has none to answer."""

_PROMPT_FRAME = """\
# Background

Here's the bigger picture - you are part of a broader voice agent testing platform where you perform the role of a simulated human that is calling a **voice agent** to test that voice agent under a particular scenario.

You have certain quirks of your own behavior and your own personality and how you do things in certain situations. Your job is to emulate a given scenario with your specific personality traits and emulate the scenario so that we can look at the conversation between you (the simulated human persona) and the voice agent to evaluate at scale how the voice agent behaves under the given scenario.

# Who you are

Your name is {name}. Give that name when the agent asks who is calling, and use it whenever you introduce yourself.

# Your personality

{personality}

# The situation you are trying to roleplay with the agent

{scenario}

# Important Rules

- Stay in character’s personality for the whole exchange. Never mention being a simulator, or an AI.
- The roleplay language is {language}
- You are allowed to make up details in order to fulfill the scenario unless explicitly stated otherwise. Examples include appointment details, or other details that someone in your situation might have handy. Your name is not one of them: it is given above, and you never answer to another.
- Pursue what you came for until it is concluded to your satisfaction, and let your personality decide how patiently.
- When your goal is concluded and nothing further is needed, say a brief goodbye and end your reply with the `end_call` tool
"""


def compose_system_prompt(
    authored: AuthoredPersona, scenario_instructions: str
) -> str:
    """The exact platform prompt, filled from the claimed persona and test."""
    return _PROMPT_FRAME.format(
        name=authored.name,
        personality=authored.personality,
        scenario=scenario_instructions,
        language=authored.language,
    )


@dataclass(frozen=True)
class Turn:
    """One transcript turn: who spoke (``human`` or ``agent``), and what."""

    speaker: str
    text: str


def messages_for(system_prompt: str, history: Sequence[Turn]) -> list[dict[str, str]]:
    """The conversation so far, in chat shape, from the persona's seat."""
    messages = [{"role": "system", "content": system_prompt}]
    for turn in history:
        role = "assistant" if turn.speaker == "human" else "user"
        messages.append({"role": role, "content": turn.text})
    if not history:
        messages.append({"role": "user", "content": OPENING_NUDGE})
    return messages


class Persona:
    """The synthetic person on the human side of the transcript."""

    def __init__(
        self,
        *,
        authored: AuthoredPersona,
        scenario_instructions: str,
        model: ModelClient,
    ) -> None:
        self._system_prompt = compose_system_prompt(authored, scenario_instructions)
        self._model = model

    @property
    def model_name(self) -> str:
        """The provider model label Pipecat records on its native span."""
        return self._model.model_name

    def messages(self, history: Sequence[Turn]) -> list[dict[str, str]]:
        """The exact provider input for this point in the conversation."""
        return messages_for(self._system_prompt, history)

    def context(self, history: Sequence[Turn]) -> LLMContext:
        """The provider-neutral messages and tools for one persona turn."""
        return LLMContext(
            messages=self.messages(history),
            tools=PERSONA_TOOLS,
            tool_choice="auto",
        )

    async def reply_to(self, context: LLMContext) -> PersonaReply:
        """Ask the configured model without changing its provider contract."""
        return await self._model.reply(context)

    async def next_turn(self, history: Sequence[Turn]) -> PersonaReply:
        """What the persona says next, given everything said so far —
        and whether, having said it, they consider the exchange concluded."""
        return await self.reply_to(self.context(history))
