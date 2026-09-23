"""HTTPS requests to an address a connection names: public addresses only.

Used by the LiveKit token endpoint and the Pipecat start request. The resolver
refuses a DNS answer holding any non-public address, and the socket factory
refuses the address actually connected to, so a DNS change between the two
cannot move a request onto a private network. Requests follow no redirect,
ignore proxy environment variables, and read at most a bounded 2xx answer.
Callers word every failure themselves.
"""

from __future__ import annotations

import contextlib
import ipaddress
import json
import socket
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


class UnsafeAddress(OSError):
    """An address Egma must not reach: not globally routable, or multicast."""


def require_public_address(raw: object) -> None:
    """Refuse every address that is not globally routable."""
    if not isinstance(raw, str):
        raise UnsafeAddress
    try:
        address = ipaddress.ip_address(raw)
    except ValueError as invalid:
        raise UnsafeAddress from invalid
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    if not address.is_global or address.is_multicast:
        raise UnsafeAddress


def refused_for_address(error: BaseException) -> bool:
    """Whether an HTTP-client error carries an address-policy refusal."""
    pending: list[BaseException] = [error]
    seen: set[int] = set()
    while pending:
        held = pending.pop()
        if id(held) in seen:
            continue
        seen.add(id(held))
        if isinstance(held, UnsafeAddress):
            return True
        for nested in (
            getattr(held, "os_error", None),
            held.__cause__,
            held.__context__,
        ):
            if isinstance(nested, BaseException):
                pending.append(nested)
    return False


class PublicOnlyResolver:
    """Check every DNS answer before aiohttp chooses one to connect to."""

    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate

    async def resolve(
        self, host: str, port: int = 0, family: int = socket.AF_INET
    ) -> list[dict[str, Any]]:
        answers = await self._delegate.resolve(host, port, family)
        for answer in answers:
            require_public_address(answer.get("host"))
        return answers

    async def close(self) -> None:
        await self._delegate.close()


def public_only_socket(addr_info: tuple[Any, ...]) -> socket.socket:
    """Open only the exact public address the HTTP client selected.

    The check lives in the socket factory rather than in a separate DNS lookup.
    That makes the checked address and the connected address the same value,
    so changing DNS between two lookups cannot move the request onto a private
    network. The resolver check rejects a mixed answer before the connector
    chooses one; this second check protects the final address too.
    """
    family, kind, protocol, _canonical_name, sockaddr = addr_info
    require_public_address(sockaddr[0])
    return socket.socket(family=family, type=kind, proto=protocol)


def guarded_connector(aiohttp: Any, resolver: Any) -> tuple[Any, Any]:
    """The resolver to close afterwards, and a connector that guards both steps."""
    guarded = PublicOnlyResolver(resolver)
    connector = aiohttp.TCPConnector(
        resolver=guarded,
        socket_factory=public_only_socket,
        use_dns_cache=False,
    )
    return guarded, connector


async def read_bounded(answer: Any, limit: int) -> bytes:
    """Read no more than ``limit`` bytes of an answer, plus one proof byte."""
    held = bytearray()
    async for chunk in answer.content.iter_chunked(16 * 1024):
        held.extend(chunk)
        if len(held) > limit:
            return bytes(held[: limit + 1])
    return bytes(held)


@dataclass(frozen=True)
class GuardedAnswer:
    """What one guarded request got back."""

    status: int
    body: bytes
    """The answer's bytes when the status is 2xx, else empty."""
    headers: dict[str, str] = field(default_factory=dict)
    """The answer's headers, names lowercased."""


async def guarded_post(
    url: str,
    *,
    json_body: object,
    headers: dict[str, str],
    seconds: float,
    limit: int,
    resolver: Any = None,
    connector_for: Callable[[Any, Any], tuple[Any, Any]] = guarded_connector,
) -> GuardedAnswer:
    """POST JSON directly to ``url`` through the guarded connector.

    A redirect is returned as its own answer, never followed: following it
    would carry the stored headers to a host chosen by whoever answered.
    Network and address-policy errors propagate unchanged.
    """
    import aiohttp

    held_resolver = resolver or aiohttp.resolver.DefaultResolver()
    try:
        held_resolver, connector = connector_for(aiohttp, held_resolver)
        async with (
            aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=seconds),
                connector=connector,
            ) as session,
            session.post(
                url,
                json=json_body,
                headers=headers,
                allow_redirects=False,
            ) as answer,
        ):
            status = answer.status
            said = await read_bounded(answer, limit) if 200 <= status < 300 else b""
            return GuardedAnswer(
                status=status,
                body=said,
                headers={name.lower(): value for name, value in answer.headers.items()},
            )
    finally:
        with contextlib.suppress(Exception):
            await held_resolver.close()


def header_object(written: object) -> dict[str, str] | None:
    """Auth headers as stored: a JSON object (or its text) of non-empty strings.

    Returns the trimmed headers, or None when the value is anything else.
    """
    held: Any = written
    if isinstance(written, str):
        try:
            held = json.loads(written)
        except ValueError:
            return None
    if (
        not isinstance(held, dict)
        or not held
        or any(
            not isinstance(name, str)
            or not name.strip()
            or not isinstance(value, str)
            or not value.strip()
            for name, value in held.items()
        )
    ):
        return None
    return {name.strip(): value.strip() for name, value in held.items()}
