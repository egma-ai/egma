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

from dataclasses import dataclass, field
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
class AuthoredPersona:
    """Who talks on the human side of the transcript, as the author wrote them.

    Three values, and the contract requires all three, so nothing below has
    to decide what an absent one would have meant — deciding that would be
    deciding who the agent heard.

    The name is the persona's own, the one they give the agent when asked.
    It is not the team's label for the library row, which never crosses this
    wire, and it is not the model's invention: the prompt states it, so the
    same test hears the same person on every run.
    """

    name: str
    personality: str
    language: str

    @classmethod
    def from_document(cls, written: Any) -> AuthoredPersona:
        """Read the required, already validated persona block."""
        return cls(
            name=written["name"],
            personality=written["personality"],
            language=written["language"],
        )


@dataclass(frozen=True)
class PlatformCarrier:
    """The SIP trunk a deployment uses for phone simulations.

    The media backend is deployment configuration. It cannot ride this
    block and cannot be selected by a work order. A phone work order carries
    all four values; the optional types let non-phone work omit the block.
    """

    trunk_address: str | None = None
    trunk_number: str | None = None
    trunk_username: str | None = None
    trunk_password: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class WorkOrderPlatform:
    """The carrier part of deployment configuration on this work order."""

    carrier: PlatformCarrier = field(default_factory=PlatformCarrier)

    @property
    def secrets(self) -> tuple[str, ...]:
        """Every secret this work-order block holds, for redaction.

        One place to ask, exactly as the configuration's own secrets have
        one, so a fourth key arriving cannot fall out of the scrubbing.
        """
        password = self.carrier.trunk_password
        return () if password is None else (password,)

    @classmethod
    def from_document(cls, written: Any) -> WorkOrderPlatform:
        """The platform block of a validated spec, or an empty block.

        The schema has already refused a field nobody writes, so the reads
        below take what is there at face value — the same bargain the rest
        of this module makes.
        """
        block = written or {}
        carrier = block.get("carrier") or {}
        return cls(
            carrier=PlatformCarrier(
                trunk_address=carrier.get("trunk_address"),
                trunk_number=carrier.get("trunk_number"),
                trunk_username=carrier.get("trunk_username"),
                trunk_password=carrier.get("trunk_password"),
            ),
        )


@dataclass(frozen=True)
class ModelSelection:
    """One pinned catalog selection and its direct credential, when used."""

    provider: str
    model: str
    adapter: str
    """The simulator implementation named by the catalog entry."""

    reasoning_effort: str | None = None
    """The selected LLM reasoning primitive, absent where it does not apply."""

    key: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class SpeechSelection(ModelSelection):
    """The TTS selection and the technical voice it owns."""

    voice_id: str = ""
    speed: float = 1.0


@dataclass(frozen=True)
class SelectedModels:
    """The complete model selection from the pinned persona version."""

    llm: ModelSelection
    stt: ModelSelection
    tts: SpeechSelection

    @property
    def secrets(self) -> tuple[str, ...]:
        """Every direct provider credential carried by this work order."""
        return tuple(key for key in (self.llm.key, self.stt.key, self.tts.key) if key)

    @classmethod
    def from_document(cls, written: Any) -> SelectedModels:
        """Read the required, already validated model block."""
        tts = written["tts"]
        return cls(
            llm=_selection(written["llm"]),
            stt=_selection(written["stt"]),
            tts=SpeechSelection(
                provider=tts["provider"],
                model=tts["model"],
                adapter=tts["adapter"],
                key=tts.get("key"),
                voice_id=tts["voice_id"],
                speed=float(tts["speed"]),
            ),
        )


def _selection(written: Any) -> ModelSelection:
    return ModelSelection(
        provider=written["provider"],
        model=written["model"],
        adapter=written["adapter"],
        reasoning_effort=written.get("reasoning_effort"),
        key=written.get("key"),
    )


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

    persona: AuthoredPersona
    """Who the pinned persona version says is calling, whole."""

    agent_platform: str | None
    """What runs the agent. Provenance only; never adapter dispatch."""

    connection_type: str
    """Which adapter reaches the agent. An open vocabulary, not an enum."""

    access_variant: str
    """Which explicit authority and config path the adapter uses."""

    connection_config: dict[str, Any]
    """The non-secret reach configuration; its keys belong to the plug."""

    credentials: Any
    """Secret material, or None. Held in memory, handed only to the plug."""

    models: SelectedModels
    """The only source for LLM, STT, TTS, and technical voice choices."""

    mock_tools: tuple[MockTool, ...] = ()
    """What egma answers for while this simulation runs, already resolved.

    Empty is the ordinary case and means egma answers for nothing: every
    tool the agent has runs its own implementation, untouched and
    unobserved.
    """

    platform: WorkOrderPlatform = field(default_factory=WorkOrderPlatform)
    """The optional SIP carrier block. It owns no model or voice choice."""

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
            platform=WorkOrderPlatform.from_document(document.get("platform")),
            models=SelectedModels.from_document(document["models"]),
            simulation_id=document["simulation_id"],
            modality=document["modality"],
            scenario_instructions=document["scenario"]["instructions"],
            limits=Limits(
                max_duration_seconds=limits["max_duration_seconds"],
                max_turns=limits["max_turns"],
            ),
            persona=AuthoredPersona.from_document(document["persona"]),
            agent_platform=connection["agent_platform"],
            connection_type=connection["connection_type"],
            access_variant=connection["access_variant"],
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
