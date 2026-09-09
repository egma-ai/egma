"""Validate claimed JSON against the shared schema, then build frozen typed records.
Readers can use nested fields without repeating schema checks.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

from .contract import ContractViolation, validate_spec


@dataclass(frozen=True)
class MockTool:
    """One tool name, and what egma answers when the agent calls it.

    Already resolved when it arrives: the answer is the test's own, one
    per name, so a simulation mocks exactly the tools its test names and
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

    @property
    def fails(self) -> bool:
        """Whether this answer is the failure branch."""
        return "error" in self.answer


@dataclass(frozen=True)
class AuthoredPersona:
    """Authored persona identity, behavior, and language.
    The name is what the persona gives the agent, not a library label or model
    invention.
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
    funding_receipt: str | None = field(default=None, repr=False)


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
                key=_provider_key(tts),
                funding_receipt=tts.get("funding_receipt"),
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
        key=_provider_key(written),
        funding_receipt=written.get("funding_receipt"),
    )


_PROVIDER_SECRET_ENVIRONMENT = {
    "openai": "EGMA_OPENAI_API_KEY",
    "deepgram": "EGMA_DEEPGRAM_API_KEY",
    "cartesia": "EGMA_CARTESIA_API_KEY",
}


def _provider_key(written: Any) -> str | None:
    """Resolve only the deployment provider references the API may issue."""
    key = written.get("key")
    if not isinstance(key, str) or not key.startswith("env:"):
        return key
    variable = _PROVIDER_SECRET_ENVIRONMENT.get(written.get("provider"))
    if variable is None or key != f"env:{variable}":
        raise ValueError(
            "the work order names an unsupported provider secret reference"
        )
    value = os.environ.get(variable, "").strip()
    if not value:
        raise ValueError(
            f"the work order needs {variable}, but the sandbox has no value"
        )
    return value


@dataclass(frozen=True)
class Limits:
    """The walls around one simulation, from the spec that claimed it.

    A limit tripping ends the simulation deliberately — reported as
    ``limit_reached``, which is never the agent failing.
    """

    max_duration_seconds: int
    max_turns: int


@dataclass(frozen=True)
class RuntimeMedia:
    """Temporary LiveKit authority issued for this claimed simulation."""

    livekit_url: str
    livekit_room_name: str
    livekit_room_token: str = field(repr=False)
    livekit_api_token: str = field(repr=False)

    @property
    def secrets(self) -> tuple[str, ...]:
        return (self.livekit_room_token, self.livekit_api_token)


@dataclass(frozen=True)
class RuntimeStorage:
    """Temporary S3 write authority issued for this claimed simulation."""

    endpoint: str
    bucket: str
    region: str
    access_key_id: str = field(repr=False)
    secret_access_key: str = field(repr=False)
    session_token: str = field(repr=False)

    @property
    def secrets(self) -> tuple[str, ...]:
        return (
            self.access_key_id,
            self.secret_access_key,
            self.session_token,
        )


@dataclass(frozen=True)
class ClaimRuntime:
    """Per-claim hosted runtime settings, absent for ordinary workers."""

    media: RuntimeMedia
    storage: RuntimeStorage

    @property
    def secrets(self) -> tuple[str, ...]:
        return self.media.secrets + self.storage.secrets

    @classmethod
    def from_document(cls, written: Any) -> ClaimRuntime | None:
        if written is None:
            return None
        media = written["media"]
        storage = written["storage"]
        return cls(
            media=RuntimeMedia(
                livekit_url=media["livekit_url"],
                livekit_room_name=media["livekit_room_name"],
                livekit_room_token=media["livekit_room_token"],
                livekit_api_token=media["livekit_api_token"],
            ),
            storage=RuntimeStorage(
                endpoint=storage["endpoint"],
                bucket=storage["bucket"],
                region=storage["region"],
                access_key_id=storage["access_key_id"],
                secret_access_key=storage["secret_access_key"],
                session_token=storage["session_token"],
            ),
        )


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

    agent_version: int | str | None = None
    """Which version of the agent under test this simulation is conducted
    against, exactly as the platform names its versions.

    ``None`` is the ordinary case and means the platform's own default. The
    simulator neither invents a version nor reinterprets one: a number stays
    a number and a name stays a name, because the platform is the only thing
    that knows what either means. A plug reaching a platform with no such
    idea takes it and drops it.
    """

    dynamic_variables: dict[str, str] = field(default_factory=dict)
    """The variables this one simulation is conducted with, for the agent's
    own platform to render.

    Empty is the ordinary case. Nothing here reads them — egma's own
    attribution variable included, which is what a tool call the platform
    makes rides back to this simulation on. They are carried to the plug and
    handed on byte for byte, because a value the simulator tidied would be a
    value the agent under test never saw.
    """

    job_dispatch_metadata: dict[str, Any] | None = None
    """Test-owned dispatch metadata, or None. Preserve values when forwarding to
    LiveKit dispatch or the token endpoint's room_config.
    """

    mock_tools: tuple[MockTool, ...] = ()
    """What egma answers for while this simulation runs, already resolved.

    Empty is the ordinary case and means egma answers for nothing: every
    tool the agent has runs its own implementation, untouched and
    unobserved.
    """

    platform: WorkOrderPlatform = field(default_factory=WorkOrderPlatform)
    """The optional SIP carrier block. It owns no model or voice choice."""

    runtime: ClaimRuntime | None = None
    """Temporary hosted authority for this claim, absent elsewhere."""

    @property
    def secrets(self) -> tuple[Any, ...]:
        """Every secret carried by this work order, in one redaction list."""
        runtime = () if self.runtime is None else self.runtime.secrets
        return (
            *((self.credentials,) if self.credentials is not None else ()),
            *self.platform.secrets,
            *self.models.secrets,
            *runtime,
        )

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
            agent_version=document.get("agent_version"),
            dynamic_variables=dict(document.get("dynamic_variables") or {}),
            job_dispatch_metadata=document.get("job_dispatch_metadata"),
            mock_tools=_mock_tools(document.get("mock_tools") or []),
            platform=WorkOrderPlatform.from_document(document.get("platform")),
            runtime=ClaimRuntime.from_document(document.get("runtime")),
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
        )
    return tuple(named.values())
