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
- ``backend`` (string, optional) — which media backend places the call.
  Defaults to the deployment's ``EGMA_SIMULATOR_MEDIA_BACKEND``, and to
  ``livekit`` where that says nothing.
- ``callerId`` (string, optional) — the number the call appears to come
  from, where the backend can choose one. Absent: the trunk's own.
- ``sample_rate_hz`` (integer, optional, default 8000) — the band the
  connection asks for. The plug carries the nearest band it supports at
  or below it, exactly as a real line negotiates down to what it can
  do, and the simulation stamps the band that actually flowed.
- one optional block per backend, named for it (``scripted``) — that
  backend's own config, handed to it whole. A block for a backend this
  call is not using is refused: a script nobody reads was written by
  mistake.

Credentials are refused outright. A phone connection carries no secret
of its own: the trunk belongs to the deployment, arrives from its
environment, and is the media backend's to hold.

## Where a turn begins and ends

The plug seam is turn-shaped and a live call is not — nobody hands over
a whole utterance on a phone line, and there is no end-of-turn signal in
the audio. So the plug reads turn boundaries out of the audio itself:
the far end is speaking while the samples carry speech, and its turn is
over once the line has been quiet for :data:`END_OF_TURN_QUIET_SECONDS`.
A far end that says nothing at all for :data:`NOTHING_SAID_SECONDS` has
answered without words, which the walk records as a turn that carried
none rather than waiting out the simulation's duration limit — hold
music, a line left open, and an agent that simply did not speak all end
up honest and cheap.

**Every one of those budgets is spent in audio, not on a clock.** Quiet
counts when quiet arrives, so a real call spends twelve seconds waiting
out a silent far end and CI spends none, through the same code.

The quiet before the far end's first word is handed up as true quiet of
the same length. That is what it was — nobody was speaking — and it is
where time-to-first-word is read from; a line's own comfort noise would
otherwise read as speech that started immediately.
"""

from __future__ import annotations

import os
import sys
from array import array
from typing import Any

from ..media import BACKENDS, MediaBackendError, MediaSession, backend_for
from ..speech import SAMPLE_WIDTH_BYTES, silence
from . import AgentSpeech, PlugError, Utterance

SUPPORTED_BANDS_HZ = (8000, 16000)
"""What a phone call can be carried at: narrowband, which is what the
PSTN gives, and the wideband a trunk that negotiates G.722 can give."""

DEFAULT_BAND_HZ = 8000
"""What a connection that says nothing gets — the band a phone call is,
unless somebody has arranged otherwise."""

DEFAULT_BACKEND = "livekit"
"""The bridge a deployment that names none places its calls through."""

BACKEND_VARIABLE = "EGMA_SIMULATOR_MEDIA_BACKEND"
"""Where a deployment names its default bridge, so that a spec does not
have to know which one this deployment runs."""

RINGING_SECONDS = 60.0
"""How long a call may ring before nobody answering is the answer. Longer
than a voicemail box takes to pick up, and short of a simulation's
duration limit doing the job instead."""

FAR_END_SLICE_SECONDS = 0.2
"""How long one read waits for audio from the far end. Only ever a bound
on waiting: what is measured is the audio that arrives."""

END_OF_TURN_QUIET_SECONDS = 0.8
"""How much quiet ends the far end's turn. Long enough to sit through the
pause inside a sentence, short enough that the persona does not talk over
somebody who has finished."""

NOTHING_SAID_SECONDS = 12.0
"""How much quiet means the far end answered this turn without words."""

SPEECH_LEVEL = 500
"""The sample level, out of 32767, above which audio is somebody talking.

A line is never digitally silent — it carries comfort noise, and a
threshold is what tells that apart from speech. Set low enough to hear a
quiet talker and high enough to ignore a line's own hiss.
"""


def negotiated_band(asked_for: int) -> int:
    """The band a phone call will actually be carried at."""
    supported = [band for band in SUPPORTED_BANDS_HZ if band <= asked_for]
    return max(supported) if supported else min(SUPPORTED_BANDS_HZ)


def carries_speech(pcm: bytes) -> bool:
    """Whether somebody is talking in this stretch of audio."""
    return peak_level(pcm) >= SPEECH_LEVEL


def peak_level(pcm: bytes) -> int:
    """The loudest sample in one stretch of audio.

    PCM is always little-endian and ``array`` holds samples in this
    machine's byte order, so the two agree only on a little-endian
    machine and a swap is what makes them agree anywhere else.
    """
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) // SAMPLE_WIDTH_BYTES * SAMPLE_WIDTH_BYTES])
    if sys.byteorder != "little":
        samples.byteswap()
    return max((abs(sample) for sample in samples), default=0)


_KNOWN_KEYS = {
    "phoneNumber",
    "backend",
    "callerId",
    "sample_rate_hz",
} | set(BACKENDS)


class PhoneCall:
    """One outbound phone call, dialled and conducted and ended."""

    def __init__(
        self, *, modality: str, config: dict[str, Any], credentials: object
    ) -> None:
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

        backend_name = config.get(
            "backend", os.environ.get(BACKEND_VARIABLE, "").strip() or DEFAULT_BACKEND
        )
        if not isinstance(backend_name, str):
            raise PlugError("phone config: backend must be a string")
        factory = backend_for(backend_name)
        if factory is None:
            raise PlugError(
                f"no media backend named {backend_name!r}; this simulator "
                f"places calls through {sorted(BACKENDS)}"
            )

        stray = {name for name in BACKENDS if name != backend_name} & set(config)
        if stray:
            raise PlugError(
                f"this call is placed through {backend_name!r}, so the "
                f"config block(s) {sorted(stray)} are read by nobody"
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

        asked_for = config.get("sample_rate_hz", DEFAULT_BAND_HZ)
        if isinstance(asked_for, bool) or not isinstance(asked_for, int):
            raise PlugError("phone config: sample_rate_hz must be an integer")
        if asked_for < 1:
            raise PlugError("phone config: sample_rate_hz must be more than zero")

        if credentials is not None:
            raise PlugError(
                "a phone connection carries no credentials: the trunk belongs "
                "to the deployment and arrives from its environment, so "
                "anything sealed onto this connection is read by nobody"
            )

        self._number = number.strip()
        self._band_hz = negotiated_band(asked_for)
        # Building the backend here is what makes a deployment that cannot
        # place calls — no server, no trunk, credentials that are not
        # usable — a refusal before any pipeline starts, rather than one
        # failed simulation after another.
        self._backend = _built(
            factory, config=script, band_hz=self._band_hz, caller_id=caller_id
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
        """The media backend placing this call — what a test listens to."""
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
        """One turn of the far end's speech, as the line delivered it.

        Speech is kept, and so is any pause inside it; the quiet before
        the first word is counted rather than kept, and handed back as
        quiet of the same length; the quiet after the last word is
        dropped, because it belongs to the next turn rather than to this
        one's measured duration.
        """
        session = self._session
        if session is None:
            raise PlugError("the phone plug listened before the call was answered")

        spoken = bytearray()
        pause = bytearray()
        before_first_word = 0.0
        quiet_seconds = 0.0
        heard_speech = False

        while True:
            arrived = await session.receive(FAR_END_SLICE_SECONDS)
            if not arrived:
                # Nothing arrived, or a frame with nothing in it — which
                # are the same thing to a listener, and reading them the
                # same way is what stops an empty frame from being a loop
                # that makes no progress and never ends.
                if session.far_end_left:
                    # The far end is off the line and nothing more is
                    # coming. Whatever was said before that is the turn,
                    # and the exchange is over — see the module docstring.
                    return self._turn(before_first_word, spoken, ended=True)
                quiet_seconds += FAR_END_SLICE_SECONDS
                if not heard_speech:
                    before_first_word += FAR_END_SLICE_SECONDS
            elif carries_speech(arrived):
                heard_speech = True
                quiet_seconds = 0.0
                spoken += pause + arrived
                pause.clear()
            else:
                seconds = len(arrived) / SAMPLE_WIDTH_BYTES / self._band_hz
                quiet_seconds += seconds
                if heard_speech:
                    pause += arrived
                else:
                    before_first_word += seconds

            if heard_speech and quiet_seconds >= END_OF_TURN_QUIET_SECONDS:
                return self._turn(before_first_word, spoken)
            if not heard_speech and before_first_word >= NOTHING_SAID_SECONDS:
                return AgentSpeech(audio=None, ended=session.far_end_left)

    def _turn(
        self, before_first_word: float, spoken: bytearray, *, ended: bool = False
    ) -> AgentSpeech:
        if not spoken:
            return AgentSpeech(audio=None, ended=ended)
        return AgentSpeech(
            audio=Utterance(
                pcm=silence(before_first_word, self._band_hz) + bytes(spoken),
                sample_rate_hz=self._band_hz,
            ),
            ended=ended,
        )


def _built(factory, **arguments) -> Any:
    """One media backend, or the plug's own refusal in its words."""
    try:
        return factory(**arguments)
    except MediaBackendError as refused:
        raise PlugError(str(refused), ending=refused.ending) from refused
