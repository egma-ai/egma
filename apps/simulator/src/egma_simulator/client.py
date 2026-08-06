"""The simulator's side of the wire: three outbound calls, nothing inbound.

Per ADR-0005 the simulator pulls. It claims work with a capacity
declaration on a request the control plane may hold open, heartbeats each
running simulation and receives directives on the answers, and posts report
documents as events happen. In development and test the other end is the
workbench; when the real claim API lands in the control plane, nothing
here changes — that is the point of the contract.
"""

from __future__ import annotations

import logging

import aiohttp

logger = logging.getLogger(__name__)


class ClaimFailure(Exception):
    """A claim request did not produce an answer this simulator can act on."""


class HeartbeatFailure(Exception):
    """A heartbeat did not reach the control plane, or came back unreadable."""


class ReportRejected(Exception):
    """The control plane refused a report document; resending cannot help."""


class TransientReportFailure(Exception):
    """A report did not get through this time; the same bytes may next time."""


class ControlPlaneClient:
    """Claims, heartbeats, and reports over outbound HTTP."""

    def __init__(
        self,
        base_url: str,
        *,
        claim_wait_seconds: float,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        # The claim request is meant to hang while the queue is empty; its
        # timeout must outlast the server's hold, with margin. Everything
        # else answers promptly or is broken.
        self._claim_timeout = aiohttp.ClientTimeout(total=claim_wait_seconds + 15)
        self._brisk_timeout = aiohttp.ClientTimeout(total=10)
        self._session: aiohttp.ClientSession | None = None

    async def __aenter__(self) -> ControlPlaneClient:
        self._session = aiohttp.ClientSession()
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    def _live_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            raise RuntimeError("ControlPlaneClient used outside its context")
        return self._session

    async def claim(self, claimant: str, capacity: int) -> list[dict]:
        """Ask for up to ``capacity`` specs; an empty list is a quiet queue."""
        try:
            async with self._live_session().post(
                f"{self._base_url}/v1/claims",
                json={"claimant": claimant, "capacity": capacity},
                timeout=self._claim_timeout,
            ) as response:
                if response.status != 200:
                    raise ClaimFailure(
                        f"claim answered {response.status}: {await response.text()}"
                    )
                body = await response.json()
        except aiohttp.ClientError as error:
            raise ClaimFailure(f"claim did not get through: {error!r}") from error

        specs = body.get("specs") if isinstance(body, dict) else None
        if not isinstance(specs, list):
            raise ClaimFailure(f"claim answer has no specs list: {body!r}")
        return specs

    async def heartbeat(self, simulation_id: str, claimant: str) -> str | None:
        """One beat for one running simulation; the answer may carry a directive."""
        try:
            async with self._live_session().post(
                f"{self._base_url}/v1/simulations/{simulation_id}/heartbeats",
                json={"claimant": claimant},
                timeout=self._brisk_timeout,
            ) as response:
                if response.status != 200:
                    raise HeartbeatFailure(
                        f"heartbeat answered {response.status}: "
                        f"{await response.text()}"
                    )
                body = await response.json()
        except aiohttp.ClientError as error:
            raise HeartbeatFailure(
                f"heartbeat did not get through: {error!r}"
            ) from error

        directive = body.get("directive") if isinstance(body, dict) else None
        if directive is not None and not isinstance(directive, str):
            raise HeartbeatFailure(f"unreadable directive: {directive!r}")
        return directive

    async def report(self, simulation_id: str, serialized: bytes) -> None:
        """Post one already-serialized report document, byte-identically."""
        try:
            async with self._live_session().post(
                f"{self._base_url}/v1/simulations/{simulation_id}/reports",
                data=serialized,
                headers={"content-type": "application/json"},
                timeout=self._brisk_timeout,
            ) as response:
                if response.status in (200, 202, 204):
                    return
                text = await response.text()
                # A 4xx says the document is wrong, and the same bytes will
                # be wrong next time — except for the two that say "not now":
                # a timeout and a rate limit both mean try again.
                if response.status in (408, 429):
                    raise TransientReportFailure(f"{response.status}: {text}")
                if 400 <= response.status < 500:
                    raise ReportRejected(f"{response.status}: {text}")
                raise TransientReportFailure(f"{response.status}: {text}")
        except aiohttp.ClientError as error:
            raise TransientReportFailure(f"{error!r}") from error
