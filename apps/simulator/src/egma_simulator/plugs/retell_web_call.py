"""Retell web calls use v3 creation and the gateway WebRTC audio transport.
Preserve the agent version, dynamic variables, and Retell call ID. Mock tools
route through Egma's HTTP endpoint independently of this audio connection.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any
from urllib.parse import quote

import aiohttp

from ..background import BackgroundSound, soundfile_mixer
from ..client import UNREACHABLE
from ..media import MediaBackendError, VoiceMedia
from ..media.retell_gateway import RetellGatewayBackend, RetellGatewaySettings
from ..platform_logging import log_event
from . import PlugError, named_version, quotable, rendered_variables
from .retell_common import CREDENTIAL_KEYS, DEFAULT_BASE_URL

logger = logging.getLogger(__name__)

CREATE_PATH = "/v3/create-web-call"

TIMEOUT_SECONDS = 30.0
FINAL_STATUS_SECONDS = 3.0
AGENT_JOIN_SECONDS = 30.0

_KNOWN_KEYS = {"retellAgentId", "baseUrl"}


class RetellWebCall:
    """One Retell web call, created and joined and left, per instance."""

    def __init__(
        self,
        *,
        modality: str,
        access_variant: str,
        config: dict[str, Any],
        credentials: object,
        simulation_id: str,
        agent_version: object = None,
        dynamic_variables: object = None,
        job_dispatch_metadata: object = None,
        mock_tools: object = None,
        media: object = None,
        driver: Any = None,
        background: BackgroundSound | None = None,
    ) -> None:
        # Tool mocks use the HTTP endpoint; this connection carries only audio.
        del media, mock_tools, job_dispatch_metadata

        if access_variant != "retell_web_call.api_key":
            raise PlugError(
                "the retell web-call adapter does not support access variant "
                f"{access_variant!r}"
            )

        if modality != "voice":
            raise PlugError(
                f"the retell web-call plug speaks voice only; a {modality!r} "
                "simulation over retell is the chat plug's job"
            )

        unknown = set(config) - _KNOWN_KEYS
        if unknown:
            raise PlugError(
                f"the retell web-call plug does not know config key(s) "
                f"{sorted(unknown)}; it knows {sorted(_KNOWN_KEYS)}"
            )

        agent_id = config.get("retellAgentId")
        if not isinstance(agent_id, str) or not agent_id.strip():
            raise PlugError(
                "retell web-call config: retellAgentId must be a non-empty string"
            )

        base_url = config.get("baseUrl", DEFAULT_BASE_URL)
        if not isinstance(base_url, str) or not base_url.strip():
            raise PlugError(
                "retell web-call config: baseUrl must be a non-empty string"
            )

        if not isinstance(credentials, dict):
            raise PlugError(
                "a retell web-call connection needs credentials shaped {apiKey}"
            )
        stray = set(credentials) - CREDENTIAL_KEYS
        if stray:
            raise PlugError(
                f"retell web-call credentials hold no key(s) {sorted(stray)}; "
                "they are shaped {apiKey}"
            )
        api_key = credentials.get("apiKey")
        if not isinstance(api_key, str) or not api_key.strip():
            raise PlugError(
                "retell web-call credentials: apiKey must be a non-empty string"
            )

        self._agent_id = agent_id.strip()
        self._base_url = base_url.strip().rstrip("/")
        self._api_key = api_key.strip()
        self._agent_version = named_version(agent_version)
        self._dynamic_variables = rendered_variables(dynamic_variables)
        self._simulation_id = simulation_id
        self._driver_factory = driver or RetellGatewayBackend
        self._secrets = (self._api_key,)
        self._timeout = aiohttp.ClientTimeout(total=TIMEOUT_SECONDS)
        self._call_id: str | None = None
        self._conducted = False
        self._gateway: Any = None
        self._media: VoiceMedia | None = None
        self._background = background

    @property
    def base_url(self) -> str:
        """Where this call is created — the URL every refusal names."""
        return self._base_url

    @property
    def provider_reference(self) -> str | None:
        """The call ID used to import Retell's transcript and tool evidence."""
        return self._call_id

    @property
    def far_end_left(self) -> bool:
        """Whether Retell confirmed the agent ended this call."""
        return self._media is not None and self._media.ended.is_set()

    async def prepare(self) -> VoiceMedia:
        """Create one call and its Pipecat gateway processors."""
        if self._conducted:
            raise PlugError(
                "this web call's connection was already spent; create a new call"
            )
        settings = await self._create_call()
        self._conducted = True
        self._gateway = self._built(
            settings=settings,
            simulation_id=self._simulation_id,
            confirm_remote_end=self._confirm_remote_end,
            poll_remote_end=self._poll_remote_end,
        )
        try:
            mixer = (
                None if self._background is None else soundfile_mixer(self._background)
            )
            if mixer is None:
                self._media = await self._gateway.create_transport()
            else:
                self._media = await self._gateway.create_transport(
                    audio_out_mixer=mixer
                )
            return self._media
        except MediaBackendError as refused:
            raise PlugError(
                self._about_gateway(refused), ending=refused.ending
            ) from None

    async def open(self) -> None:
        """Connect WebRTC and wait for the agent's first audio."""
        if self._gateway is None:
            raise PlugError("a retell web call was opened before it was created")
        try:
            await self._gateway.dial()
            await self._gateway.wait_answered(AGENT_JOIN_SECONDS)
        except MediaBackendError as refused:
            raise PlugError(
                self._about_gateway(refused), ending=refused.ending
            ) from None

    async def close(self) -> None:
        """Close this gateway session from any lifecycle state."""
        self._media = None
        gateway, self._gateway = self._gateway, None
        if gateway is not None:
            await gateway.teardown()

    async def _poll_remote_end(self) -> bool:
        """Read the call once while audio is connected."""
        async with aiohttp.ClientSession(
            headers={"Authorization": f"Bearer {self._api_key}"},
            timeout=aiohttp.ClientTimeout(total=1.0),
        ) as session:
            ended = await self._final_status(session)
            if ended is False:
                raise MediaBackendError(
                    "Retell reported an error or invalid status for this call"
                )
            return ended is True

    async def _confirm_remote_end(self) -> bool:
        """Allow final status to arrive shortly after media disconnects."""
        try:
            async with (
                asyncio.timeout(FINAL_STATUS_SECONDS),
                aiohttp.ClientSession(
                    headers={"Authorization": f"Bearer {self._api_key}"},
                    timeout=aiohttp.ClientTimeout(total=1.0),
                ) as session,
            ):
                while True:
                    ended = await self._final_status(session)
                    if ended is not None:
                        return ended
                    await asyncio.sleep(0.25)
        except TimeoutError:
            return False

    async def _final_status(self, session: aiohttp.ClientSession) -> bool | None:
        """Return normal/failed completion, or None while status is pending."""
        call_id = self._call_id
        if call_id is None:
            return False
        url = f"{self._base_url}/v2/get-call/{quote(call_id, safe='')}"
        try:
            async with session.get(url) as response:
                if response.status == 200:
                    document = await response.json()
                    if not isinstance(document, dict):
                        return False
                    if document.get("call_id") != call_id:
                        return False
                    status = document.get("call_status")
                    if status in {"ended", "error"}:
                        reason = document.get("disconnection_reason")
                        log_event(
                            logger,
                            logging.INFO,
                            "egma.retell.call_final_status",
                            "retell reported its final call status",
                            attributes={
                                "retell.call_id": call_id,
                                "retell.call_status": status,
                                "retell.disconnection_reason": (
                                    quotable(reason, *self._secrets)[:80]
                                    if isinstance(reason, str)
                                    else "unknown"
                                ),
                            },
                        )
                        return status == "ended"
                elif response.status not in {404, 408, 429} and response.status < 500:
                    return False
        except UNREACHABLE:
            pass
        except ValueError:
            return False
        return None

    # -- Creating the Retell call -------------------------------------------

    async def _create_call(self) -> RetellGatewaySettings:
        """Create a call and validate the returned gateway connection details."""
        url = f"{self._base_url}{CREATE_PATH}"
        try:
            async with (
                aiohttp.ClientSession() as session,
                session.post(
                    url,
                    json=self._creation(),
                    headers={"Authorization": f"Bearer {self._api_key}"},
                    timeout=self._timeout,
                ) as response,
            ):
                status = response.status
                body = await response.text()
        except UNREACHABLE as unreachable:
            raise PlugError(
                f"retell was unreachable at {url}: "
                f"{quotable(repr(unreachable), self._api_key)}"
            ) from unreachable

        if status // 100 != 2:
            raise PlugError(
                f"retell answered {status} to {CREATE_PATH} at {self._base_url} "
                f"and created no web call: {quotable(body, self._api_key)}"
            )
        try:
            document = json.loads(body)
        except ValueError as unreadable:
            raise PlugError(
                f"retell answered {CREATE_PATH} with something that is not JSON"
            ) from unreadable
        if not isinstance(document, dict):
            raise PlugError(
                f"retell answered {CREATE_PATH} with "
                f"{type(document).__name__}, not an object"
            )

        call_id = document.get("call_id")
        if not isinstance(call_id, str) or not call_id.strip():
            raise PlugError("retell created a web call with no call_id")
        self._call_id = call_id
        token = document.get("access_token")
        if not isinstance(token, str) or not token:
            raise PlugError(f"retell web call {call_id} has no access_token")
        self._secrets += (token,)
        if document.get("transport") != "gateway":
            raise PlugError(f"retell web call {call_id} needs the gateway transport")
        ice_servers = document.get("ice_servers")
        if not isinstance(ice_servers, list):
            raise PlugError(f"retell web call {call_id} has no valid ice_servers")
        for server in ice_servers:
            if not isinstance(server, dict):
                raise PlugError(f"retell web call {call_id} has invalid ice_servers")
            urls = server.get("urls")
            urls = [urls] if isinstance(urls, str) else urls
            if (
                not isinstance(urls, list)
                or not urls
                or any(
                    not isinstance(url, str)
                    or not url.startswith(("stun:", "stuns:", "turn:", "turns:"))
                    for url in urls
                )
            ):
                raise PlugError(f"retell web call {call_id} has invalid ICE URLs")
            for field in ("username", "credential"):
                value = server.get(field)
                if value is not None and not isinstance(value, str):
                    raise PlugError(
                        f"retell web call {call_id} has invalid ICE {field}"
                    )
                if value:
                    self._secrets += (value,)
        expires = document.get("expires_at")
        if isinstance(expires, bool) or not isinstance(expires, int):
            raise PlugError(f"retell web call {call_id} has no valid expires_at")
        if expires <= time.time() * 1000:
            raise PlugError(
                f"retell web call {call_id} returned an expired access token"
            )
        return RetellGatewaySettings(
            base_url=self._base_url,
            call_id=call_id,
            access_token=token,
            ice_servers=ice_servers,
            secrets=self._secrets,
        )

    def _creation(self) -> dict[str, Any]:
        """Forward the pinned version and rendered variables for this simulation."""
        creation: dict = {"agent_id": self._agent_id}
        if self._agent_version is not None:
            creation["agent_version"] = self._agent_version
        if self._dynamic_variables:
            creation["retell_llm_dynamic_variables"] = self._dynamic_variables
        return creation

    # -- Saying what went wrong, in this plug's own terms --------------------

    def _built(self, **arguments: Any) -> Any:
        """Build the gateway backend and scrub known platform credentials."""
        try:
            return self._driver_factory(**arguments)
        except MediaBackendError as refused:
            raise PlugError(
                quotable(str(refused), *self._secrets), ending=refused.ending
            ) from None

    def _about_gateway(self, refused: MediaBackendError) -> str:
        """Attach the call ID without exposing connection credentials."""
        told = quotable(str(refused), *self._secrets)
        where = (
            f"retell web call {self._call_id}" if self._call_id else "retell web call"
        )
        return f"{where}: {told}"
