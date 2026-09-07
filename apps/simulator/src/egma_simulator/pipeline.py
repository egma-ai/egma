"""Build one pipeline per simulation without opening its connection.
Chat uses the conversation loop, ConnectionPlug, and persona. Voice uses
VoiceConductor with a Pipecat transport and speech services. Both share
the persona logic; constructors validate before any connection starts.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from .blob import BlobStore
from .conductor import DEFAULT_CONDUCT, ConductParameters, VoiceConductor
from .config import MediaSettings
from .mock_tools import MockToolSeam, ReportedToolCall
from .plugs import ConnectionPlug, PlugError, VoiceConnection, plug_for
from .recording import RECORDING_NAME, AudioFacts
from .spec import SimulationSpec
from .speech import SpeechProviders, voice_from_models

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Assembled:
    """One simulation's pipeline: who conducts it, and what it recorded.

    Exactly one of the two is filled in. ``plug`` is what the conversation loop drives,
    which is a chat platform and only ever that. ``conductor`` is the
    voice conductor, which owns the plug's Pipecat transport.
    """

    plug: ConnectionPlug | None = None
    """Text in, text out — the conversation loop's whole view of a platform."""

    conductor: VoiceConductor | None = None
    """The Pipecat pipeline conducting a full-duplex voice simulation."""

    mock_tools: MockToolSeam = field(default_factory=MockToolSeam)
    """egma's side of the mock-tool exchange, for whichever plug can offer
    it. Always here and never ``None``: a plug that cannot offer it simply
    never puts it in front of the agent, and the record then carries no
    call egma answered, because there was none."""

    @property
    def recording(self) -> AudioFacts | None:
        """The stored recording and its trace-clock origin, once available."""
        return None if self.conductor is None else self.conductor.audio

    def tool_calls(self) -> list[ReportedToolCall]:
        """Every call a platform has reported since this was last asked."""
        return self.mock_tools.exchanged()

    @property
    def audio(self) -> dict | None:
        """The contract's audio block once the exchange is over, else ``None``."""
        measured = self.recording
        return None if measured is None else measured.as_report()


def assemble(
    spec: SimulationSpec,
    *,
    blobs: BlobStore,
    speech: SpeechProviders,
    media: MediaSettings | None = None,
    parameters: ConductParameters | None = None,
    on_provider_reference: Callable[[str], Awaitable[None]] | None = None,
) -> Assembled:
    """Validate and assemble one simulation without dialing or starting its pipeline.
    speech contains the pinned persona STT/TTS selection, required even for chat.
    media contains the resolved deployment bridge and carrier; a phone adapter
    rejects None, while non-phone simulations do not need it.
    """
    factory = plug_for(spec.connection_type)
    if factory is None:
        raise PlugError(
            f"no adapter for connection type {spec.connection_type!r}"
        )
    # Built for every simulation, and handed to every plug: which of them
    # can put egma in front of the agent's tools is the plug's own answer,
    # not a list kept here of the ones that can. A plug that cannot takes
    # it and drops it, and the seam then says there is nothing to claim.
    mock_tools = MockToolSeam(spec.mock_tools)
    registration = (
        {"on_provider_reference": on_provider_reference}
        if spec.connection_type == "livekit_room"
        else {}
    )
    plug = factory(
        modality=spec.modality,
        access_variant=spec.access_variant,
        config=spec.connection_config,
        credentials=spec.credentials,
        simulation_id=spec.simulation_id,
        # Handed over exactly as the spec carried them, to every plug, for
        # the same reason the mock-tool seam is: which of them reaches a
        # platform that keeps versions, renders variables or dispatches a
        # worker is the plug's own answer, not a list kept here of the ones
        # that do.
        agent_version=spec.agent_version,
        dynamic_variables=spec.dynamic_variables,
        job_dispatch_metadata=spec.job_dispatch_metadata,
        mock_tools=mock_tools,
        media=media,
        **registration,
    )
    if spec.modality != "voice":
        return Assembled(plug=plug, mock_tools=mock_tools)

    if not isinstance(plug, VoiceConnection):
        # Unreachable through the shipped registry, and kept because the
        # alternative is a voice simulation with nobody to conduct it,
        # discovered somewhere far away from the plug that was wrong.
        raise PlugError(
            f"the adapter for connection type {spec.connection_type!r} speaks "
            "voice but is not a Pipecat voice connection, so nothing can conduct it"
        )
    return Assembled(
        conductor=VoiceConductor(
            connection=plug,
            voice=voice_from_models(spec.models),
            speech=speech,
            blobs=blobs,
            recording_key=f"{spec.simulation_id}/{RECORDING_NAME}",
            parameters=parameters or DEFAULT_CONDUCT,
        ),
        mock_tools=mock_tools,
    )
