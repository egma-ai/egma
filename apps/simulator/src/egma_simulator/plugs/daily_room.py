"""Pipecat connections: a start request, then a Daily room.

Voice hears the bot through Pipecat's Daily transport in the conductor's
pipeline. Chat types to the bot over RTVI send-text and reads its answers from
RTVI events; the bot needs nothing beyond the Egma SDK line. Both start the bot
the same way and wait for the same readiness facts (media/daily_room.py).

The provider reference is the simulation id, registered before the start
request. The Egma SDK in the bot answers mocked tools through Egma's server,
so this plug serves no mock-tool exchange and reports no tool calls.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from ..background import BackgroundSound, soundfile_mixer
from ..media import MediaBackendError, VoiceMedia
from ..media.daily_room import (
    AgentReportProbe,
    PipecatChatBackend,
    PipecatVoiceBackend,
    StartSettings,
)
from . import AgentReply, ConnectionPlug, PlugError, VoiceConnection

GREETING_SECONDS = 8.0
"""Time allowed for an optional greeting after readiness; none lets the persona
speak first."""

REPLY_SECONDS = 30.0
"""Time allowed for the first model run of an answer to start."""


def _plug_error(refused: MediaBackendError) -> PlugError:
    return PlugError(str(refused), ending=refused.ending)


def read_connection(
    access_variant: str, config: Mapping[str, Any], credentials: object
) -> StartSettings:
    """The connection, read before anything is reached, or the plug's refusal."""
    try:
        return StartSettings.from_connection(access_variant, config, credentials)
    except MediaBackendError as refused:
        raise _plug_error(refused) from refused


def _body_params(pipecat_body_params: object) -> dict[str, Any] | None:
    if pipecat_body_params is None:
        return None
    if not isinstance(pipecat_body_params, dict):
        raise PlugError("pipecat_body_params must be a JSON object")
    return dict(pipecat_body_params)


def _duration(max_duration_seconds: object) -> float:
    if isinstance(max_duration_seconds, bool) or not isinstance(
        max_duration_seconds, int | float
    ):
        raise PlugError(
            "a Pipecat simulation needs its duration limit to set the room expiry"
        )
    return float(max_duration_seconds)


class DailyRoomVoice:
    """One voice exchange with a Pipecat bot in the Daily room its starter made."""

    def __init__(
        self,
        *,
        modality: str,
        access_variant: str,
        config: dict[str, Any],
        credentials: object,
        simulation_id: str,
        max_duration_seconds: object = None,
        pipecat_body_params: object = None,
        agent_version: object = None,
        dynamic_variables: object = None,
        job_dispatch_metadata: object = None,
        mock_tools: object = None,
        media: object = None,
        driver: Any = None,
        on_provider_reference: Callable[[str], Awaitable[None]] | None = None,
        agent_report: AgentReportProbe | None = None,
        background: BackgroundSound | None = None,
    ) -> None:
        # A Pipecat bot keeps no platform versions, renders no variables and
        # takes no dispatch metadata. Its SDK answers mocked tools itself.
        del agent_version, dynamic_variables, job_dispatch_metadata
        del mock_tools, media
        if modality != "voice":
            raise PlugError(
                f"the Pipecat voice plug speaks voice only; got {modality!r}"
            )
        self._backend = (driver or PipecatVoiceBackend)(
            settings=read_connection(access_variant, config, credentials),
            simulation_id=simulation_id,
            max_duration_seconds=_duration(max_duration_seconds),
            body_params=_body_params(pipecat_body_params),
            on_provider_reference=on_provider_reference,
            agent_report=agent_report,
        )
        self._background = background
        self._media: VoiceMedia | None = None

    @property
    def backend(self) -> Any:
        return self._backend

    @property
    def provider_reference(self) -> str | None:
        return self._backend.provider_reference

    @property
    def far_end_left(self) -> bool:
        return self._media is not None and self._media.ended.is_set()

    async def prepare(self) -> VoiceMedia:
        """Start the bot and build the transport for its room."""
        try:
            mixer = (
                None if self._background is None else soundfile_mixer(self._background)
            )
            if mixer is None:
                self._media = await self._backend.create_transport()
            else:
                self._media = await self._backend.create_transport(
                    audio_out_mixer=mixer
                )
            return self._media
        except MediaBackendError as refused:
            raise _plug_error(refused) from refused

    async def open(self) -> None:
        """Join the room and wait for the bot's hello, presence and audio."""
        try:
            await self._backend.dial()
            await self._backend.wait_started()
        except MediaBackendError as refused:
            raise _plug_error(refused) from refused

    def startup_duration_failure(self, seconds: float) -> PlugError:
        return _plug_error(self._backend.startup_duration_failure(seconds))

    async def close(self) -> None:
        """Leave the room; safe from every state."""
        self._media = None
        await self._backend.teardown()


class DailyRoomChat:
    """One typed exchange with a Pipecat bot over RTVI."""

    def __init__(
        self,
        *,
        modality: str,
        access_variant: str,
        config: dict[str, Any],
        credentials: object,
        simulation_id: str,
        max_duration_seconds: object = None,
        pipecat_body_params: object = None,
        agent_version: object = None,
        dynamic_variables: object = None,
        job_dispatch_metadata: object = None,
        mock_tools: object = None,
        media: object = None,
        driver: Any = None,
        on_provider_reference: Callable[[str], Awaitable[None]] | None = None,
        agent_report: AgentReportProbe | None = None,
    ) -> None:
        del agent_version, dynamic_variables, job_dispatch_metadata
        del mock_tools, media
        if modality != "chat":
            raise PlugError(f"the Pipecat chat plug speaks chat only; got {modality!r}")
        self._backend = (driver or PipecatChatBackend)(
            settings=read_connection(access_variant, config, credentials),
            simulation_id=simulation_id,
            max_duration_seconds=_duration(max_duration_seconds),
            body_params=_body_params(pipecat_body_params),
            on_provider_reference=on_provider_reference,
            agent_report=agent_report,
        )

    @property
    def backend(self) -> Any:
        return self._backend

    @property
    def provider_reference(self) -> str | None:
        return self._backend.provider_reference

    @property
    def has_ended(self) -> bool:
        return self._backend.has_ended

    def raise_if_failed(self) -> None:
        try:
            self._backend.raise_if_failed()
        except MediaBackendError as refused:
            raise _plug_error(refused) from refused

    async def open(self) -> str | AgentReply | None:
        """Start the bot, wait for readiness, and read an optional greeting."""
        try:
            await self._backend.open_room()
            await self._backend.wait_started()
            greeting = await self._backend.wait_greeting(GREETING_SECONDS)
        except MediaBackendError as refused:
            raise _plug_error(refused) from refused
        if greeting.ended:
            return AgentReply(text=greeting.text, ended=True)
        return greeting.text

    def startup_duration_failure(self, seconds: float) -> PlugError:
        return _plug_error(self._backend.startup_duration_failure(seconds))

    async def deliver(self, text: str) -> AgentReply:
        try:
            answer = await self._backend.deliver(text, reply_seconds=REPLY_SECONDS)
        except MediaBackendError as refused:
            raise _plug_error(refused) from refused
        return AgentReply(
            text=answer.text,
            ended=answer.ended,
            answered_at=answer.answer_began_at,
        )

    async def listen(self, seconds: float) -> AgentReply | None:
        try:
            answer = await self._backend.listen(seconds)
        except MediaBackendError as refused:
            raise _plug_error(refused) from refused
        if answer.text is None and not answer.ended:
            return None
        return AgentReply(text=answer.text, ended=answer.ended)

    async def finish(self, text: str) -> None:
        """Send final persona words without asking for another answer."""
        try:
            await self._backend.send(text)
        except MediaBackendError as refused:
            raise _plug_error(refused) from refused

    async def wait_ended(self) -> None:
        try:
            await self._backend.wait_ended()
        except MediaBackendError as refused:
            raise _plug_error(refused) from refused

    async def wait_failed(self) -> None:
        try:
            await self._backend.wait_failed()
        except MediaBackendError as refused:
            raise _plug_error(refused) from refused

    async def close(self) -> None:
        """Leave the room; safe from every state."""
        await self._backend.teardown()


def daily_room(*, modality: str, **rest: Any) -> ConnectionPlug | VoiceConnection:
    """Select the Pipecat adapter by modality; each constructor checks it."""
    speaking = DailyRoomChat if modality == "chat" else DailyRoomVoice
    return speaking(modality=modality, **rest)
