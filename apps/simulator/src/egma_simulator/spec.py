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
class PlatformModel:
    """What the persona thinks with, as the platform has it configured.

    Every field is optional, because a platform mid-setup holds some of
    them and not others, and one that holds none is every platform before
    anybody set it up. ``None`` here always means *the platform said
    nothing about this*, never *the platform said nothing* — so a reader
    leaves its own value standing rather than clearing it.
    """

    provider: str | None = None
    model: str | None = None
    key: str | None = field(default=None, repr=False)
    """Kept out of the dataclass repr, like every other key in this
    process: a log line carrying one is a log line that should not have."""

    reasoning_effort: str | None = None
    """How hard the model thinks before the persona speaks, in the
    provider's own vocabulary, or ``None`` to send nothing at all.

    A persona is a caller in a hurry: the reasoning under test is the
    agent's, and time the persona spends thinking is silence on a live
    line. Carried verbatim, because the accepted values are the
    provider's and change on their schedule, not egma's."""


@dataclass(frozen=True)
class PlatformSpeech:
    """What the persona speaks and hears with, as the platform has it.

    A key per leg rather than one per provider, which is the shape the
    contract carries and the shape :class:`~egma_simulator.speech.SpeechProviders`
    holds: the two legs are two accounts as often as they are one, and a
    shape that could not say so would make the second one unreachable.
    """

    stt_provider: str | None = None
    stt_key: str | None = field(default=None, repr=False)
    stt_model: str | None = None
    """Which model the listening leg asks for, where its provider has more
    than one.

    Here beside ``tts_model`` rather than left in each simulator's
    environment, which is where it used to be alone. That asymmetry was
    the one setting a deployment could not change centrally: an operator
    could move the mouth from a settings page and had to edit a container
    and restart it to move the ears."""

    tts_provider: str | None = None
    tts_key: str | None = field(default=None, repr=False)
    tts_model: str | None = None
    tts_voice: str | None = None
    vad_provider: str | None = None


@dataclass(frozen=True)
class PlatformCarrier:
    """How a call reaches the telephone network, as the platform has it.

    The media server's own key and secret are deliberately not here: they
    are read by a third-party container when it is created and cannot come
    from the platform's store, so they stay in each simulator's
    environment. What is here is the choice of bridge and the trunk the
    carrier authenticates — the paperwork somebody did once with Twilio,
    which is exactly the thing this effort exists to stop losing.
    """

    media_backend: str | None = None
    trunk_address: str | None = None
    trunk_number: str | None = None
    trunk_username: str | None = None
    trunk_password: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class PlatformSettings:
    """What the deployment has been configured with, off the work order.

    **These arrive per simulation and replace this container's own.** They
    used to be each simulator's environment, which meant a second
    simulator on another machine needed a file copied to it, and a
    container started without one dialled nothing while reporting itself
    healthy. They belong to the whole deployment, so the deployment holds
    them and hands them down with the work.

    Three groups, because the groups are what can be absent: a deployment
    with no carrier is the ordinary deployment, and the whole phone half
    then simply is not here. Absent everywhere is also ordinary and is
    what every spec written before these existed carries — which is why
    every field is optional and every reader treats ``None`` as *say
    nothing*.
    """

    model: PlatformModel = field(default_factory=PlatformModel)
    speech: PlatformSpeech = field(default_factory=PlatformSpeech)
    carrier: PlatformCarrier = field(default_factory=PlatformCarrier)

    @property
    def secrets(self) -> tuple[str, ...]:
        """Every secret these settings hold, for redaction.

        One place to ask, exactly as the configuration's own secrets have
        one, so a fourth key arriving cannot fall out of the scrubbing.
        """
        return tuple(
            secret
            for secret in (
                self.model.key,
                self.speech.stt_key,
                self.speech.tts_key,
                self.carrier.trunk_password,
            )
            if secret is not None
        )

    @classmethod
    def from_document(cls, written: Any) -> PlatformSettings:
        """The platform block of a validated spec, or the empty settings.

        The schema has already refused a field nobody writes, so the reads
        below take what is there at face value — the same bargain the rest
        of this module makes.
        """
        block = written or {}
        model = block.get("model") or {}
        speech = block.get("speech") or {}
        carrier = block.get("carrier") or {}
        return cls(
            model=PlatformModel(
                provider=model.get("provider"),
                model=model.get("model"),
                key=model.get("key"),
                reasoning_effort=model.get("reasoning_effort"),
            ),
            speech=PlatformSpeech(
                stt_provider=speech.get("stt_provider"),
                stt_key=speech.get("stt_key"),
                stt_model=speech.get("stt_model"),
                tts_provider=speech.get("tts_provider"),
                tts_key=speech.get("tts_key"),
                tts_model=speech.get("tts_model"),
                tts_voice=speech.get("tts_voice"),
                vad_provider=speech.get("vad_provider"),
            ),
            carrier=PlatformCarrier(
                media_backend=carrier.get("media_backend"),
                trunk_address=carrier.get("trunk_address"),
                trunk_number=carrier.get("trunk_number"),
                trunk_username=carrier.get("trunk_username"),
                trunk_password=carrier.get("trunk_password"),
            ),
        )


@dataclass(frozen=True)
class ModelSelection:
    """One model job's pinned selection, off the work order.

    Provider and model come from the persona version the run pinned, so two
    simulations of one version ask the same provider for the same model
    however the organization's credentials have moved since. The key is
    resolved when the claim is prepared, so a replaced one reaches the
    next simulation with nothing restarted.
    """

    provider: str
    model: str
    key: str | None = field(default=None, repr=False)
    """The provider key, or ``None`` under managed access — where Egma's
    own credential never leaves the Egma model gateway and this process is
    never handed one.

    Kept out of the dataclass repr, like every other key in this process:
    a log line carrying one is a log line that should not have."""


@dataclass(frozen=True)
class SpeechSelection(ModelSelection):
    """The speaking job's selection, which carries two more facts.

    Which of the provider's voices, and how fast the persona talks. Both
    are the persona version's own, so the same persona sounds identical on
    every simulation of that version — where a described speed would have
    to be interpreted and two runs could interpret it differently.
    """

    voice_id: str = ""
    speed: float = 1.0


@dataclass(frozen=True)
class GatewayAccess:
    """Where managed model traffic goes, and what authorizes it there.

    **Present only under managed access, and it is the whole of what
    managed access adds to a work order.** No provider key travels at
    all — Egma's own credentials stay inside the Egma model gateway and
    this process is never handed one — so what arrives instead is one
    address and one credential for the gateway's own door.

    Each leg composes its own provider path onto the address; see
    :data:`GATEWAY_ROUTE`. The credential goes in the slot the shipped
    provider adapter already puts a key in, which is why a managed leg
    is the same Pipecat service told a different base address and handed
    a different secret, and not a second adapter.
    """

    address: str
    credential: str = field(default="", repr=False)
    """Kept out of the dataclass repr, like every other credential in
    this process: a log line carrying one is a log line that should not
    have."""

    def base_for(self, provider: str, job: str) -> str | None:
        """Where one leg reaches its provider through the gateway, or
        ``None`` where this release carries no route for that pair.

        ``None`` is a refusal to guess. Answering the gateway's bare
        address would send the leg to a path the gateway turns away, and
        whoever read the failure would see the provider being wrong.
        """
        suffix = GATEWAY_ROUTE.get(provider, {}).get(job)
        return None if suffix is None else f"{self.address.rstrip('/')}{suffix}"


GATEWAY_ROUTE: dict[str, dict[str, str]] = {
    "openai": {
        "llm": "/openai/v1",
        "stt": "/openai/v1/realtime",
        "tts": "/openai/v1",
    },
    "deepgram": {"stt": "/deepgram"},
    "cartesia": {"tts": "/cartesia/tts/websocket"},
}
"""Where each provider-job pair is reached through the Egma model gateway.

**The Python half of one list that three things have to agree about**:
this, the control plane's own copy beside the provider catalog, and the
gateway's route table, which is the authority. The suffix stops where
the shipped adapter starts appending — Pipecat's Deepgram service adds
``/v1/listen`` to whatever base it is given, the OpenAI chat and speech
clients add ``/chat/completions`` and ``/audio/speech``, and Cartesia's
service and OpenAI's realtime transcription service are each handed a
whole socket address — so each entry ends exactly where its adapter
takes over.

One provider may do several jobs and reach a different address for each,
which is why this is a map of maps rather than a map of addresses.
"""


@dataclass(frozen=True)
class SelectedModels:
    """What this simulation's persona thinks, listens and speaks with.

    **Present only on a version-2 work order**, and its presence is what
    says the persona chose for itself. A simulation whose persona has made
    no selections arrives on version 1 with no block at all, and the
    deployment's own settings decide exactly as they always did — which is
    how every persona authored before the model catalog existed keeps
    running.

    ``access`` says who supplies the credentials. It rides here because it
    is what says where the keys came from; nothing in this process chooses
    it, and a simulator never sees the organization that did.
    """

    access: str
    llm: ModelSelection
    stt: ModelSelection
    tts: SpeechSelection
    gateway: GatewayAccess | None = None
    """Present under managed access and absent under customer-owned, and
    the two are exclusive by the contract's own shape rather than by
    anything read here."""

    @property
    def secrets(self) -> tuple[str, ...]:
        """Every credential this block holds, for redaction.

        One place to ask, exactly as the platform settings' own has, so a
        fourth secret arriving cannot fall out of the scrubbing — which
        is why the gateway credential is here beside the provider keys.
        Only one of the two kinds is ever present.
        """
        held = (self.llm.key, self.stt.key, self.tts.key)
        if self.gateway is not None:
            held = (*held, self.gateway.credential)
        return tuple(secret for secret in held if secret)

    @classmethod
    def from_document(cls, written: Any) -> SelectedModels | None:
        """The models block of a validated spec, or ``None`` where it has none.

        The schema has already refused a block that is not this shape, so
        the reads below take what is there at face value — the same bargain
        the rest of this module makes.
        """
        if not written:
            return None
        tts = written["tts"]
        gateway = written.get("gateway")
        return cls(
            access=written["access"],
            gateway=(
                None
                if gateway is None
                else GatewayAccess(
                    address=gateway["address"], credential=gateway["credential"]
                )
            ),
            llm=_selection(written["llm"]),
            stt=_selection(written["stt"]),
            tts=SpeechSelection(
                provider=tts["provider"],
                model=tts["model"],
                key=tts.get("key"),
                voice_id=tts["voice_id"],
                speed=float(tts["speed"]),
            ),
        )


def _selection(written: Any) -> ModelSelection:
    return ModelSelection(
        provider=written["provider"],
        model=written["model"],
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

    models: SelectedModels | None = None
    """What this simulation's persona thinks, listens and speaks with.

    ``None`` is an ordinary state and means the persona made no selections
    — every one authored before the model catalog existed, arriving on a
    version-1 work order. The deployment's own settings then decide,
    exactly as they always did.

    **Where it is present it wins outright**, over the platform's settings
    and over this container's alike. It is what the run pinned, and a
    deployment setting quietly overriding a pinned selection would make a
    simulation's models depend on which machine conducted it.
    """

    platform: PlatformSettings = field(default_factory=PlatformSettings)
    """What the deployment has been configured with — its persona's model,
    its speech legs, its carrier — read afresh for this simulation.

    Empty is an ordinary state and means the platform said nothing, so
    this container's own configuration stands exactly as it did. It is
    never *this simulation asked for nothing*: the settings belong to the
    deployment, and a simulation has no opinion about them.
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
            platform=PlatformSettings.from_document(document.get("platform")),
            models=SelectedModels.from_document(document.get("models")),
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
