"""A claimed spec, as a thing with parts rather than a bag of keys.

A spec arrives as JSON and is held to the contract's schema before anything
is done with it. Past that gate it becomes this: a small frozen record whose
fields say what they hold, so the code that conducts a simulation asks for
``spec.limits.max_turns`` instead of walking three dictionaries deep and
trusting that each step is there.

The gate and the type are deliberately the same step. Nothing builds one of
these without validating first, which is what lets every reader below take
the fields at face value.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .contract import ContractViolation, validate_spec


@dataclass(frozen=True)
class MockTool:
    """One tool name, and what egma answers when the agent calls it.

    Already resolved when it arrives: the control plane worked the
    project's defaults and the test's overrides into one answer per name
    at run creation, so every simulation in one run sees one world and
    there is nothing left here to merge.
    """

    tool_name: str
    """The agent's own name for the tool, verbatim — the whole of how a
    call is matched, and never parsed or folded."""

    answer: dict[str, Any]
    """What is served, in the shape it was authored in: ``{"answer": …}``
    with the value the tool returns, or ``{"error": …}`` with the failure
    it raises. Held whole rather than unpacked, so the bytes that go on
    the wire are the bytes that were authored."""

    delay_milliseconds: int
    """How long egma holds the answer back, so a mocked backend takes as
    long as the real one would."""

    @property
    def fails(self) -> bool:
        """Whether this answer is the failure branch."""
        return "error" in self.answer


@dataclass(frozen=True)
class Limits:
    """The walls around one simulation, from the spec that claimed it.

    A limit tripping ends the simulation deliberately — reported as
    ``limit_reached``, which is never the agent failing.
    """

    max_duration_seconds: int
    max_turns: int


@dataclass(frozen=True)
class SimulationSpec:
    """One claimable simulation, fully flattened — nothing left to resolve."""

    simulation_id: str
    """Opaque to the simulator: never parsed, never minted, never rewritten."""

    modality: str
    """``chat`` or ``voice``. Selects the pipeline legs, not the persona."""

    scenario_instructions: str
    """What the persona wants on this occasion, from the test's own content."""

    limits: Limits

    persona_traits: dict[str, Any]
    """The persona's authored traits, passed through opaquely.

    What a persona is made of is authoring's business: the persona brain
    composes the whole block into its system prompt verbatim, and nothing
    in the simulator picks favourites among the keys.
    """

    connection_type: str
    """Which plug reaches the agent. An open vocabulary, not an enum."""

    connection_config: dict[str, Any]
    """The non-secret reach configuration; its keys belong to the plug."""

    credentials: Any
    """Secret material, or None. Held in memory, handed only to the plug."""

    mock_tools: tuple[MockTool, ...] = ()
    """What egma answers for while this simulation runs, already resolved.

    Empty is the ordinary case and means egma answers for nothing: every
    tool the agent has runs its own implementation, untouched and
    unobserved.
    """

    @classmethod
    def from_document(cls, document: Any) -> SimulationSpec:
        """Hold a claimed document to the contract, then read it.

        Raises ``ContractViolation`` if the document does not speak the
        contract — which is a refusal to conduct, not a simulation that
        went wrong.
        """
        validate_spec(document)
        connection = document["connection"]
        limits = document["limits"]
        return cls(
            mock_tools=_mock_tools(document.get("mock_tools") or []),
            simulation_id=document["simulation_id"],
            modality=document["modality"],
            scenario_instructions=document["scenario"]["instructions"],
            limits=Limits(
                max_duration_seconds=limits["max_duration_seconds"],
                max_turns=limits["max_turns"],
            ),
            persona_traits=document["persona"]["traits"],
            connection_type=connection["type"],
            connection_config=connection["config"],
            credentials=connection["credentials"],
        )


def _mock_tools(written: list[Any]) -> tuple[MockTool, ...]:
    """The resolved answers, one per tool name.

    The one thing the schema cannot say is that two entries must not name
    the same tool — matching is by name and nothing else, so two answers
    for one name are two answers with no rule to choose between them. It
    is refused rather than resolved here: taking either one silently would
    make the record's answer a matter of which the control plane happened
    to write first.
    """
    named: dict[str, MockTool] = {}
    for entry in written:
        tool_name = entry["tool_name"]
        if tool_name in named:
            raise ContractViolation(
                "spec",
                [
                    f"/mock_tools: {tool_name!r} is answered twice, and "
                    "matching is by name alone — there is no rule that would "
                    "choose between them"
                ],
            )
        named[tool_name] = MockTool(
            tool_name=tool_name,
            answer=entry["answer"],
            delay_milliseconds=entry["delay_milliseconds"],
        )
    return tuple(named.values())
