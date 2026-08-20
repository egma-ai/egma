"""The simulator's side of the wire: four outbound calls, nothing inbound.

The simulator pulls its own work rather than being sent it. It claims
simulations with a capacity declaration, on a request the control plane may
hold open until there is something to give; it heartbeats each running
simulation and receives any directive on the answer; it posts report
documents as events happen; and it posts the conversation itself as OTLP
span batches, at the same ingest door a customer's agent exports to. Every
arrow points out, so the simulator needs no inbound network surface at all
— which is what makes it one more container that only dials out.

All four reach the same deployment, so there is one address to configure
and the telemetry path is derived from it rather than named separately: a
simulator that can claim work can always file the evidence of it.

In development and test the other end is the workbench. Nothing here knows
the difference, and nothing here changes when the real control plane
answers instead: both ends speak the contract, not each other.
"""

from __future__ import annotations

import json
import logging

import aiohttp

from .contract import spec_contract_version

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


class DocumentRejected(Exception):
    """The control plane refused a document; resending cannot help.

    Either kind the ordered sender carries: a report the control plane
    will not apply, or a span batch the ingest door will not file. Both
    are terminal for that document and neither is terminal for the
    simulation."""


class TransientDeliveryFailure(Exception):
    """A document did not get through this time; the same bytes may next time."""


# The OTLP/HTTP path, which is the specification's and not egma's: an
# exporter posts here, and so does the simulator, because a simulation
# arriving the way a customer's agent arrives is the point.
OTLP_TRACES_PATH = "/v1/traces"


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
        # Sent on every claim as ``wait_seconds`` and enforced locally as the
        # timeout below: the control plane holds an empty-queue claim open no
        # longer than the client says it will wait, so the two ends agree and
        # a quiet queue can never read as a client-side timeout.
        self._claim_wait_seconds = claim_wait_seconds
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
        """Ask for compatible specs; an empty list is a quiet queue."""
        try:
            async with self._live_session().post(
                f"{self._base_url}/v1/claims",
                json={
                    "claimant": claimant,
                    "capacity": capacity,
                    "wait_seconds": self._claim_wait_seconds,
                    "contract_versions": [spec_contract_version()],
                },
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
        await self._post_document(
            f"{self._base_url}/v1/simulations/{simulation_id}/reports", serialized
        )

    async def spans(self, simulation_id: str, serialized: bytes) -> None:
        """Post one already-serialized OTLP span batch, byte-identically.

        The specification's own path, JSON encoding, the service token as
        bearer — an ordinary OTLP export, refused and retried on exactly
        the terms a report is. A 400 is the door saying the batch names no
        simulation it can file under, which resending cannot fix.

        A 200 may still carry a partial success, which is how the
        specification says an ingest reports data it will not store.
        Nothing is retried on it — the specification is explicit that
        rejected data must not be. It is still a final rejection to the
        ordered reporter, because a terminal simulation may not claim that
        incomplete evidence landed.
        """
        body = await self._post_document(
            f"{self._base_url}{OTLP_TRACES_PATH}",
            serialized,
            accepted_statuses=(200, 204),
        )
        rejected, why = _partial_success(body)
        if rejected:
            raise DocumentRejected(
                f"the ingest refused {rejected} of {simulation_id}'s spans "
                "and will refuse them again, so they are not resent: "
                f"{why or 'it gave no reason'}"
            )

    async def _post_document(
        self,
        url: str,
        serialized: bytes,
        *,
        accepted_statuses: tuple[int, ...] = (200, 202, 204),
    ) -> str:
        """One document, posted as the bytes it already is.

        Both directions the ordered sender carries come through here, so
        what counts as refused and what counts as try-again is decided
        once. A 4xx says the document is wrong and the same bytes will be
        wrong next time — except for the two that say "not now": a timeout
        and a rate limit both mean try again.
        """
        try:
            async with self._live_session().post(
                url,
                data=serialized,
                headers={"content-type": "application/json"},
                timeout=self._brisk_timeout,
            ) as response:
                if response.status in accepted_statuses:
                    return await response.text()
                text = await response.text()
                if response.status in (408, 429):
                    raise TransientDeliveryFailure(f"{response.status}: {text}")
                if 400 <= response.status < 500:
                    raise DocumentRejected(f"{response.status}: {text}")
                raise TransientDeliveryFailure(f"{response.status}: {text}")
        except UNREACHABLE as error:
            raise TransientDeliveryFailure(f"{error!r}") from error


def _partial_success(body: str) -> tuple[int, str]:
    """What an OTLP answer says it refused, if it says anything at all.

    An empty body is the whole batch landed, which is the ordinary case
    and the one worth staying quiet about. A non-empty body must be a readable
    OTLP response: terminal delivery needs proof that its rejected count is
    zero, not a guess from bytes the client could not understand.
    """
    if not body.strip():
        return 0, ""
    try:
        document = json.loads(body)
    except ValueError as error:
        raise TransientDeliveryFailure(
            "the ingest returned an unreadable OTLP success response"
        ) from error
    if not isinstance(document, dict):
        raise TransientDeliveryFailure(
            "the ingest returned an unreadable OTLP success response"
        )
    if "partialSuccess" not in document:
        return 0, ""
    partial = document["partialSuccess"]
    if not isinstance(partial, dict):
        raise TransientDeliveryFailure(
            "the ingest returned an unreadable OTLP partial-success response"
        )
    raw_rejected = partial.get("rejectedSpans", 0)
    if isinstance(raw_rejected, bool):
        raise TransientDeliveryFailure(
            "the ingest returned an unreadable OTLP rejected-span count"
        )
    if isinstance(raw_rejected, int):
        rejected = raw_rejected
    elif (
        isinstance(raw_rejected, str)
        and raw_rejected.isascii()
        and raw_rejected.isdigit()
    ):
        rejected = int(raw_rejected)
    else:
        raise TransientDeliveryFailure(
            "the ingest returned an unreadable OTLP rejected-span count"
        )
    if rejected < 0:
        raise TransientDeliveryFailure(
            "the ingest returned an unreadable negative OTLP rejected-span count"
        )
    message = partial.get("errorMessage")
    return rejected, message if isinstance(message, str) else ""
