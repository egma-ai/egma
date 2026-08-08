"""The phone plug: the simulator dials a number and holds the line.

The first plug that reaches an agent the way its customers do. It is
deliberately **provider-blind**: the public telephone network neither
knows nor cares what answers, so a Retell agent behind a number, a Vapi
agent behind a number, and a human behind a number are all one plug and
one connection block. What a spec names is a number.

The call itself is a media backend's job — see
:mod:`egma_simulator.media`, whose docstring is the whole brief for one.
This module owns the *lifecycle* above that seam: dial, hear the answer,
carry the persona's speech out and the far end's speech back, notice the
far end hanging up, end deliberately, and offer the bridge's own
identifier for the call as the provider reference, the way the chat plug
offers Retell's chat id.

Its config keys, like every plug's, are its own:

- ``phoneNumber`` (string, required) — what to dial, in E.164. The only
  field a spec author has to know.
- ``callerId`` (string, optional) — the number the call appears to come
  from, where the backend can choose one. Absent: the trunk's own.
- one optional block per backend, named for it (``scripted``) — that
  backend's own config, handed to it whole. A block for a backend this
  deployment does not use is refused: a script nobody reads was written
  by mistake.

Which bridge places the call is the deployment's, not the spec's, and so
is the trunk: both are checked once at startup and arrive here already
good. A spec that names a number on a simulator configured to place no
calls is refused with the variable to set.

Credentials are refused outright. A phone connection carries no secret of
its own.

## The band a call is carried at

Always :data:`TELEPHONY_BAND_HZ`, and there is no way to ask for another.
That is the band a call over the public telephone network really is, and
the bridge resamples what it receives down to it — which can only remove
what was never there rather than invent detail. So the band the recorder
measures off what flowed is a band the audio genuinely carried, and a
narrowband call can never be stamped as a wideband one.

A trunk that negotiates wideband is understated by this rather than
overstated, which is the safe direction: reading 8 kHz off a call that
was wideband costs a comparison, and reading 16 kHz off a call that was
not would make a score mean something it does not.

## Where a turn begins and ends

Out of the audio itself, because a phone line carries no end-of-turn
signal in it — see :mod:`egma_simulator.plugs.audio_turns`, which every
plug over a live line reads its turn boundaries through.
"""

from __future__ import annotations

from typing import Any

from ..config import MediaSettings
from ..media import BACKENDS, MediaBackendError, MediaSession, backend_for
from . import AgentSpeech, PlugError, Utterance
from .audio_turns import next_turn

TELEPHONY_BAND_HZ = 8000
"""The band a phone call is carried at, and the only one. See the module
docstring: a band that could be asked for would be a band declared, and
what a record stamps has to be a band the audio really carried."""

BACKEND_VARIABLE = "EGMA_SIMULATOR_MEDIA_BACKEND"
"""Where a deployment says which bridge places its calls. Named in the
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
        config: dict[str, Any],
        credentials: object,
        media: MediaSettings | None = None,
    ) -> None:
        # Which bridge and which trunk were checked at startup; this reads
        # the result rather than the environment, so nothing here can be
        # the first to discover a deployment cannot dial. The keyword is
        # for tests, which build settings rather than an environment.
        settings = media if media is not None else MediaSettings.from_env()

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
                "this simulator places no phone calls: set "
                f"{BACKEND_VARIABLE} to one of {sorted(BACKENDS)}, with the "
                "server and trunk that backend needs"
            )
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
                "a phone connection carries no credentials: the trunk belongs "
                "to the deployment and arrives from its environment, so "
                "anything sealed onto this connection is read by nobody"
            )

        self._number = number.strip()
        self._band_hz = TELEPHONY_BAND_HZ
        # Building the backend here, before any pipeline starts, is what
        # makes config the driver cannot use an honest refusal rather than
        # a failure part-way through a call.
        self._backend = _built(
            factory,
            settings=settings,
            config=script,
            band_hz=self._band_hz,
            caller_id=caller_id,
        )
        self._session: MediaSession | None = None
        self._reference: str | None = None

    @property
    def provider_reference(self) -> str | None:
        """The bridge's own identifier for this call, once there is one."""
        return self._reference

    @property
    def sample_rate_hz(self) -> int:
        return self._band_hz

    @property
    def backend(self) -> object:
        """The media backend placing this call.

        Here for the tests, honestly: the plug seam takes a spec and
        nothing else, so a test cannot hand in a backend to watch and this
        is the only way to ask what the call was really placed through.
        """
        return self._backend

    async def open(self) -> AgentSpeech | None:
        """Place the call, wait for somebody, and hear how they answer."""
        try:
            self._session = await self._backend.create_session()
            await self._backend.dial(self._number)
            self._reference = await self._backend.wait_answered(RINGING_SECONDS)
            return await self._listen()
        except MediaBackendError as refused:
            raise PlugError(str(refused), ending=refused.ending) from refused

    async def deliver(self, speech: Utterance) -> AgentSpeech:
        session = self._session
        if session is None:
            raise PlugError("a turn reached the phone plug before the call did")
        try:
            await session.send(speech.pcm)
            return await self._listen()
        except MediaBackendError as failed:
            # A line that goes wrong mid-call is the backend's to name and
            # the plug's to carry: a fault, never a phone nobody answered,
            # because somebody did answer it.
            raise PlugError(str(failed), ending=failed.ending) from failed

    async def close(self) -> None:
        """Hang up. Safe from every state, including never having dialled."""
        self._session = None
        await self._backend.teardown()

    async def _listen(self) -> AgentSpeech:
        """One turn of the far end's speech, read out of the line itself."""
        session = self._session
        if session is None:
            raise PlugError("the phone plug listened before the call was answered")
        return await next_turn(session, self._band_hz)


def _built(factory, **arguments) -> Any:
    """One media backend, or the plug's own refusal in its words."""
    try:
        return factory(**arguments)
    except MediaBackendError as refused:
        raise PlugError(str(refused), ending=refused.ending) from refused
