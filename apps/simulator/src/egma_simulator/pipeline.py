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
real Pipecat pipeline on a full-duplex line, with the voice activity
detector and the turn model deciding where turns fall instead of a loop.
There is no third answer and no adapter between them: every voice
connection wears :class:`~egma_simulator.plugs.DuplexLine`, whether the
line is a fake on this machine, a phone call, or a room.

Constructing is validation and nothing else, which is what makes a spec
that cannot be conducted an honest failure before anything is dialled.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from .blob import BlobStore
from .conductor import DEFAULT_CONDUCT, ConductParameters, VoiceConductor
from .plugs import DuplexLine, PlatformPlug, PlugError, plug_for
from .recording import RECORDING_NAME
from .spec import SimulationSpec
from .speech import SCRIPTED_PAIR, SpeechProviders, voice_from_traits

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Assembled:
    """One simulation's pipeline: who conducts it, and what it measured.

    Exactly one of the two is filled in. ``plug`` is what the walk drives,
    which is a chat platform and only ever that. ``conductor`` is the
    voice conductor, which needs no plug of its own because it holds the
    line.
    """

    plug: PlatformPlug | None = None
    """Text in, text out — the walk's whole view of a platform."""

    conductor: VoiceConductor | None = None
    """The Pipecat pipeline conducting a full-duplex voice simulation."""

    @property
    def audio(self) -> dict | None:
        """The contract's audio block once the exchange is over, else ``None``."""
        measured = None if self.conductor is None else self.conductor.audio
        return None if measured is None else measured.as_report()


def assemble(
    spec: SimulationSpec,
    *,
    blobs: BlobStore,
    speech: SpeechProviders = SCRIPTED_PAIR,
    parameters: ConductParameters | None = None,
) -> Assembled:
    """Build one simulation's pipeline from its spec.

    Constructing is validation and nothing else — no platform is dialled
    and no pipeline is started until the exchange opens — so a spec that
    cannot be conducted fails here, honestly, before anything happens.

    ``speech`` is where a deployment's choice of real providers enters,
    and the only place: the spec says what the simulation is, the
    configuration says what carries it. Left alone it is the scripted
    pair, so a deployment with nothing to say about providers gets
    exactly the pipeline it always got.
    """
    factory = plug_for(spec.connection_type)
    if factory is None:
        raise PlugError(
            f"no platform plug for connection type {spec.connection_type!r}"
        )
    plug = factory(
        modality=spec.modality,
        config=spec.connection_config,
        credentials=spec.credentials,
        simulation_id=spec.simulation_id,
    )
    if spec.modality != "voice":
        return Assembled(plug=plug)

    if not isinstance(plug, DuplexLine):
        # Unreachable through the shipped registry, and kept because the
        # alternative is a voice simulation with nobody to conduct it,
        # discovered somewhere far away from the plug that was wrong.
        raise PlugError(
            f"the plug for connection type {spec.connection_type!r} speaks "
            "voice but is not a full-duplex line, so nothing can conduct it"
        )
    return Assembled(
        conductor=VoiceConductor(
            line=plug,
            voice=voice_from_traits(spec.persona_traits),
            speech=speech,
            blobs=blobs,
            recording_key=f"{spec.simulation_id}/{RECORDING_NAME}",
            parameters=parameters or DEFAULT_CONDUCT,
        )
    )
