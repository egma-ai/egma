"""The persona brain: one component, shared by every modality forever.

It composes the spec's persona traits and scenario instructions into a
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

import json
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

Who you are, exactly as authored:

{traits}

Why you are here today:

{scenario}

How to conduct yourself:
- Stay in character as this person for the whole exchange. Never mention \
being simulated, tested, or an AI.
- Speak one conversational turn at a time, in plain spoken words — no \
lists, no headings, no stage directions.
- Pursue what you came for until it is concluded to your satisfaction, \
and let your persona decide how patiently.
- When your goal is concluded and nothing further is needed, say a brief \
goodbye and end your reply with {marker}.
"""


def compose_system_prompt(traits: dict[str, Any], scenario_instructions: str) -> str:
    """Traits and scenario, composed whole into the persona's instructions.

    The traits ride verbatim as authored — what a persona is made of is
    authoring's business, so the composition renders the whole block rather
    than picking keys it happens to know.
    """
    return _PROMPT_FRAME.format(
        traits=json.dumps(traits, indent=2, sort_keys=True),
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

    async def next_turn(self, history: Sequence[Turn]) -> PersonaReply:
        """What the persona says next, given everything said so far —
        and whether, having said it, they consider the exchange concluded."""
        return await self._model.reply(messages_for(self._system_prompt, history))
