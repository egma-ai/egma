"""The phone plug: the simulator dials a number and holds the line.

The first plug that reaches an agent the way its customers do. It is
deliberately **provider-blind**: the public telephone network neither
knows nor cares what answers, so a Retell agent behind a number, a Vapi
agent behind a number, and a human behind a number are all one plug and
one connection block. What a spec names is a number.

The call itself is a media backend's job — see
:mod:`egma_simulator.media`, whose docstring is the whole brief for one.
This module owns the lifecycle above that seam: dial, hear the answer,
notice the far end hanging up, end deliberately, and offer the backend's
own identifier for the call as the provider reference.

Its config keys, like every plug's, are its own:

- ``phoneNumber`` (string, required) — what to dial, in E.164. The only
  field a spec author has to know.
- ``callerId`` (string, optional) — the number the call appears to come
  from, where the backend can choose one. Absent: the trunk's own.
- one optional block per backend, named for it (``scripted``) — that
  backend's own config, handed to it whole. A block for a backend this
  deployment does not use is refused: a script nobody reads was written
  by mistake.

Which media backend places the call is the deployment's and is checked at
startup. The complete carrier route arrives on each phone simulation's work
order. The v2 contract has already checked its two-value source-IP or four-value
SIP-credential shape before this plug receives it. A spec that names a number
on a simulator configured to place no calls is refused with the variable to set.

Credentials are refused outright. A phone connection carries no secret of
its own.

## Media

The stock Pipecat LiveKit transport owns call input, output, conversion,
and pacing. Egma does not select or expose a processing rate.

## Where a turn begins and ends

Nowhere in here. A phone line carries no end-of-turn signal. The one
running Pipecat pipeline reads turns from the transport's frames.
"""

from __future__ import annotations

from typing import Any

from ..config import MediaSettings
from ..media import BACKENDS, MediaBackendError, VoiceMedia, backend_for
from . import PlugError

BACKEND_VARIABLE = "EGMA_SIMULATOR_MEDIA_BACKEND"
"""Where a deployment says which media backend places its calls. Named in the
refusal a simulator that cannot place one gives."""

RINGING_SECONDS = 60.0
"""How long a call may ring before nobody answering is the answer. Longer
than a voicemail box takes to pick up, and short of a simulation's
duration limit doing the job instead."""


_KNOWN_KEYS = {"phoneNumber", "callerId"} | set(BACKENDS)


class PhoneCall:
    """One outbound phone call, dialled and conducted and ended."""

    def __init__(
        self,
        *,
        modality: str,
        access_variant: str,
        config: dict[str, Any],
        credentials: object,
        simulation_id: str | None = None,
        mock_tools: object = None,
        media: MediaSettings | None = None,
    ) -> None:
        # A phone call is reached over the public telephone network, which
        # has never carried anything but a number, so this plug has
        # nothing to tell the far end about the simulation and no way to
        # stand in front of its tools.
        del simulation_id, mock_tools

        if access_variant != "phone_number.public_e164":
            raise PlugError(
                "the phone-number adapter does not support access variant "
                f"{access_variant!r}"
            )

        # Which media backend and trunk this call goes over, resolved by
        # assembly from this container's own configuration and the
        # platform's carrier on the work order. Read here rather than
        # worked out here: a plug that reached for an environment variable
        # would be a second answer to a question the deployment already
        # answered, and the two could disagree.
        settings = media

        if modality != "voice":
            raise PlugError(
                f"the phone plug speaks voice only; a {modality!r} simulation "
                "over a phone line is not a thing that exists"
            )

        unknown = set(config) - _KNOWN_KEYS
        if unknown:
            raise PlugError(
                f"the phone plug does not know config key(s) {sorted(unknown)}; "
                f"it knows {sorted(_KNOWN_KEYS)}"
            )

        number = config.get("phoneNumber")
        if not isinstance(number, str) or not number.strip():
            raise PlugError("phone config: phoneNumber must be a non-empty string")

        if settings is None:
            raise PlugError(
                "this deployment places no phone calls: set "
                f"{BACKEND_VARIABLE} on this container to one of "
                f"{sorted(BACKENDS)}"
            )
        # **The moment a carrier's own refusals belong.** Contract v3 already
        # proved that this phone work order carries a complete route. Here a
        # call is about to be placed, so backend-specific value checks belong
        # here and a refusal names why this simulation cannot dial.
        try:
            settings = settings.checked()
        except ValueError as cannot_dial:
            raise PlugError(str(cannot_dial)) from cannot_dial

        backend_name = settings.backend
        factory = backend_for(backend_name)
        if factory is None:
            raise PlugError(
                f"no media backend named {backend_name!r}; this simulator "
                f"places calls through {sorted(BACKENDS)}"
            )

        stray = {name for name in BACKENDS if name != backend_name} & set(config)
        if stray:
            raise PlugError(
                f"this simulator places calls through {backend_name!r}, so "
                f"the config block(s) {sorted(stray)} are read by nobody"
            )

        script = config.get(backend_name, {})
        if not isinstance(script, dict):
            raise PlugError(
                f"phone config: the {backend_name!r} block is that backend's "
                "own config, so it has to be an object"
            )

        caller_id = config.get("callerId")
        if caller_id is not None and not isinstance(caller_id, str):
            raise PlugError("phone config: callerId must be a string")

        if credentials is not None:
            raise PlugError(
                "a phone connection carries no credentials: the platform's "
                "carrier arrives on the claimed phone work order, while the "
                "media bridge belongs to the deployment; anything sealed "
                "onto this connection is read by nobody"
            )

        self._number = number.strip()
        # Building the backend here, before any pipeline starts, is what
        # makes config the driver cannot use an honest refusal rather than
        # a failure part-way through a call.
        self._backend = _built(
            factory,
            settings=settings,
            config=script,
            caller_id=caller_id,
        )
        self._media: VoiceMedia | None = None
        self._reference: str | None = None

    @property
    def provider_reference(self) -> str | None:
        """The backend's own identifier for this call, once there is one."""
        return self._reference

    @property
    def far_end_left(self) -> bool:
        """Whether the far end has hung up. On a call that is the whole of
        what "the agent ended the exchange" means."""
        return self._media is not None and self._media.ended.is_set()

    @property
    def backend(self) -> object:
        """The media backend placing this call.

        Here for the tests, honestly: the plug seam takes a spec and
        nothing else, so a test cannot hand in a backend to watch and this
        is the only way to ask what the call was really placed through.
        """
        return self._backend

    async def prepare(self) -> VoiceMedia:
        """Build the media transport before the Pipecat pipeline starts."""
        try:
            self._media = await self._backend.create_transport()
            return self._media
        except MediaBackendError as refused:
            raise PlugError(str(refused), ending=refused.ending) from refused

    async def open(self) -> None:
        """Place the call and wait for somebody to pick it up.

        Nothing is heard here. The line is open the moment somebody
        answers. The running Pipecat transport then carries both sides,
        including a greeting from the far end.
        """
        try:
            await self._backend.dial(self._number)
            self._reference = await self._backend.wait_answered(RINGING_SECONDS)
        except MediaBackendError as refused:
            raise PlugError(str(refused), ending=refused.ending) from refused

    async def close(self) -> None:
        """Hang up. Safe from every state, including never having dialled."""
        self._media = None
        await self._backend.teardown()


def _built(factory, **arguments) -> Any:
    """One media backend, or the plug's own refusal in its words."""
    try:
        return factory(**arguments)
    except MediaBackendError as refused:
        raise PlugError(str(refused), ending=refused.ending) from refused
