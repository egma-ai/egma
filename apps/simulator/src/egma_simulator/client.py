"""The simulator's side of the wire: three outbound calls, nothing inbound.

The simulator pulls its own work rather than being sent it. It claims
simulations with a capacity declaration, on a request the control plane may
hold open until there is something to give; it heartbeats each running
simulation and receives any directive on the answer; and it posts report
documents as events happen. Every arrow points out, so the simulator needs
no inbound network surface at all — which is what makes it one more
container that only dials out.

In development and test the other end is the workbench. Nothing here knows
the difference, and nothing here changes when the real control plane
answers instead: both ends speak the contract, not each other.
"""

from __future__ import annotations

import logging

import aiohttp

logger = logging.getLogger(__name__)

# What "the call did not get through" is actually made of. `TimeoutError` is
# the one that surprises: aiohttp enforces `ClientTimeout(total=...)` with a
# bare `TimeoutError`, which is an `OSError` — *not* an `aiohttp.ClientError`.
# Catching only `ClientError` therefore misses the single most likely failure
# a control plane has, and lets it escape as an exception nothing above
# this module is written to expect.
UNREACHABLE = (aiohttp.ClientError, TimeoutError)

# A claim is meant to hang while the queue is empty, so its timeout has to
# outlast the hold the control plane was asked for, with room to spare.
CLAIM_TIMEOUT_MARGIN_SECONDS = 15.0

# Everything else answers promptly or is broken.
BRISK_TIMEOUT_SECONDS = 10.0


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
        service_token: str | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._claim_timeout = aiohttp.ClientTimeout(
            total=claim_wait_seconds + CLAIM_TIMEOUT_MARGIN_SECONDS
        )
        self._brisk_timeout = aiohttp.ClientTimeout(total=BRISK_TIMEOUT_SECONDS)
        # The simulator is never dialled into, so its own requests are the
        # only place it can show it is allowed to claim work. The token sits
        # on the session rather than on each call, because "every arrow out
        # carries it" is not a thing to remember three times. No token
        # means no header at all — the workbench asks for nothing, and a
        # bare `Bearer ` would be a worse answer than silence.
        self._headers = (
            {"Authorization": f"Bearer {service_token}"} if service_token else {}
        )
        self._session: aiohttp.ClientSession | None = None

    async def __aenter__(self) -> ControlPlaneClient:
        self._session = aiohttp.ClientSession(headers=self._headers)
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
        except UNREACHABLE as error:
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
        except UNREACHABLE as error:
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
        except UNREACHABLE as error:
            raise TransientReportFailure(f"{error!r}") from error
