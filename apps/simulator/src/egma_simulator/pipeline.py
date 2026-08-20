"""Pipeline assembly: what one simulation is conducted through.

One pipeline is built from one claimed spec and torn down when the
exchange is over, so nothing from one simulation can reach the next. What
the spec selects is only which legs are in it: a chat simulation is the
plug and the persona brain, and a voice simulation is the same plug and
the same brain with speech legs between them. The brain is one component
for every modality, forever — it never learns which of these it is in.

**Who conducts is what a spec selects here, and there are two answers.**
A chat simulation is walked a turn at a time by :mod:`egma_simulator.walk`.
A voice simulation is conducted by :mod:`egma_simulator.conductor` — a
real Pipecat pipeline on a full-duplex transport, with the voice activity
detector and the turn model deciding where turns fall instead of a loop.
There is no third answer and no byte adapter between them: every voice
connection gives the conductor one Pipecat transport, whether it is a
local fixture, a phone call, or a room.

Constructing is validation and nothing else, which is what makes a spec
that cannot be conducted an honest failure before anything is dialled.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .blob import BlobStore
from .conductor import DEFAULT_CONDUCT, ConductParameters, VoiceConductor
from .config import MediaSettings
from .mock_tools import ExchangedToolCall, MockToolSeam
from .plugs import PlatformPlug, PlugError, VoiceConnection, plug_for
from .recording import RECORDING_NAME
from .spec import SimulationSpec
from .speech import SpeechProviders, voice_from_models

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Assembled:
    """One simulation's pipeline: who conducts it, and what it recorded.

    Exactly one of the two is filled in. ``plug`` is what the walk drives,
    which is a chat platform and only ever that. ``conductor`` is the
    voice conductor, which owns the plug's Pipecat transport.
    """

    plug: PlatformPlug | None = None
    """Text in, text out — the walk's whole view of a platform."""

    conductor: VoiceConductor | None = None
    """The Pipecat pipeline conducting a full-duplex voice simulation."""

    mock_tools: MockToolSeam = field(default_factory=MockToolSeam)
    """egma's side of the mock-tool exchange, for whichever plug can offer
    it. Always here and never ``None``, because whether egma really stood
    in the agent's tool path is the seam's own answer to give — a plug
    that cannot offer it simply never says it is standing ready, and the
    record then claims nothing about tools."""

    @property
    def audio(self) -> dict | None:
        """The contract's audio block once the exchange is over, else ``None``."""
        measured = None if self.conductor is None else self.conductor.audio
        return None if measured is None else measured.as_report()

    @property
    def mock_tool_coverage(self) -> dict | None:
        """The contract's coverage stamp, or ``None`` where nothing is claimed."""
        return self.mock_tools.coverage()

    def tool_calls(self) -> list[ExchangedToolCall]:
        """Every mock-tool call since this was last asked, and then none."""
        return self.mock_tools.exchanged()


def assemble(
    spec: SimulationSpec,
    *,
    blobs: BlobStore,
    speech: SpeechProviders,
    media: MediaSettings | None = None,
    parameters: ConductParameters | None = None,
) -> Assembled:
    """Build one simulation's pipeline from its spec.

    Constructing is validation and nothing else — no platform is dialled
    and no pipeline is started until the exchange opens — so a spec that
    cannot be conducted fails here, honestly, before anything happens.

    ``speech`` is the pinned persona version's direct STT and TTS selection.
    It is required even for chat, where no speech legs are built, so callers
    cannot grow a second fallback assembly path.

    ``media`` is the same for the telephone network — this container's
    bridge with the platform's own carrier already laid over it, resolved
    once by whoever built these arguments and handed whole to the plug.
    ``None`` is a deployment that places no calls, and a spec that then
    names a phone number is refused by the plug with a sentence saying so.
    """
    factory = plug_for(spec.connection_type)
    if factory is None:
        raise PlugError(
            f"no platform plug for connection type {spec.connection_type!r}"
        )
    # Built for every simulation, and handed to every plug: which of them
    # can put egma in front of the agent's tools is the plug's own answer,
    # not a list kept here of the ones that can. A plug that cannot takes
    # it and drops it, and the seam then says there is nothing to claim.
    mock_tools = MockToolSeam(spec.mock_tools)
    plug = factory(
        modality=spec.modality,
        config=spec.connection_config,
        credentials=spec.credentials,
        simulation_id=spec.simulation_id,
        mock_tools=mock_tools,
        media=media,
    )
    if spec.modality != "voice":
        return Assembled(plug=plug, mock_tools=mock_tools)

    if not isinstance(plug, VoiceConnection):
        # Unreachable through the shipped registry, and kept because the
        # alternative is a voice simulation with nobody to conduct it,
        # discovered somewhere far away from the plug that was wrong.
        raise PlugError(
            f"the plug for connection type {spec.connection_type!r} speaks "
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
