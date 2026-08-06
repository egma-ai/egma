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

from .contract import validate_spec


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

    Nothing reads these yet: today's pipe echoes rather than thinking, so
    there is no system prompt to compose them into. They are carried here
    because they are part of the spec, and the persona brain is what
    consumes them.
    """

    connection_type: str
    """Which plug reaches the agent. An open vocabulary, not an enum."""

    connection_config: dict[str, Any]
    """The non-secret reach configuration; its keys belong to the plug."""

    credentials: Any
    """Secret material, or None. Held in memory, handed only to the plug."""

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
