"""The persona brain: one component, shared by every modality forever.

It composes the persona's authored personality and the test's scenario into a
system prompt, takes turns — the transcript's ``human`` side — and decides
when the exchange is concluded. What it does not know is deliberate: it
never sees a platform (that is the plug's business) and never produces its
own words (that is the model client's), so the same brain conducts a chat
today and speaks through voice legs when those arrive.

Role mapping is from the persona's own seat at the table: the persona is
the ``assistant`` the model plays, and the agent under test is the
``user`` it is answering.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .model import CONCLUDE_MARKER, ModelClient, PersonaReply

OPENING_NUDGE = (
    "(The conversation is open and the agent is listening. "
    "Speak your first turn.)"
)
"""Stands in for the silence when the persona goes first: chat-shaped
models answer a user message, and an empty history has none to answer."""

_PROMPT_FRAME = """\
You are playing a person in a live conversation with a customer service \
agent. You are the person; the agent is who you are talking to.

Your personality, exactly as authored:

{personality}

Why you are here today:

{scenario}

How to conduct yourself:
- Stay in character as this person for the whole exchange. Never mention \
being simulated, tested, or an AI.
- Speak one conversational turn at a time, in plain spoken words — no \
lists, no headings, no stage directions.
- Pursue what you came for until it is concluded to your satisfaction. Let \
your personality decide how you respond when progress is slow or the agent \
gets something wrong.
- When your goal is concluded and nothing further is needed, say a brief \
goodbye and end your reply with {marker}.
"""


def compose_system_prompt(traits: dict[str, Any], scenario_instructions: str) -> str:
    """Personality and scenario, composed into the persona's instructions.

    Personality is the one customer-authored behavior field. Speech settings
    may still ride in the private traits document for the voice pipeline, but
    they must not become model instructions by accident.
    """
    personality = traits.get("personality")
    authored = (
        personality.strip()
        if isinstance(personality, str) and personality.strip() != ""
        else "No additional personality was specified."
    )
    return _PROMPT_FRAME.format(
        personality=authored,
        scenario=scenario_instructions,
        marker=CONCLUDE_MARKER,
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
        traits: dict[str, Any],
        scenario_instructions: str,
        model: ModelClient,
    ) -> None:
        self._system_prompt = compose_system_prompt(traits, scenario_instructions)
        self._model = model

    @property
    def model_name(self) -> str:
        """The provider model label Pipecat records on its native span."""
        return self._model.model_name

    def messages(self, history: Sequence[Turn]) -> list[dict[str, str]]:
        """The exact provider input for this point in the conversation."""
        return messages_for(self._system_prompt, history)

    async def reply_to(self, messages: list[dict[str, str]]) -> PersonaReply:
        """Ask the configured model without changing its provider contract."""
        return await self._model.reply(messages)

    async def next_turn(self, history: Sequence[Turn]) -> PersonaReply:
        """What the persona says next, given everything said so far —
        and whether, having said it, they consider the exchange concluded."""
        return await self.reply_to(self.messages(history))
