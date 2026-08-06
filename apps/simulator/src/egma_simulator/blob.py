"""Blob storage: where bytes land that a report can only point at.

A recording is too big to travel in a report and too useful to throw away,
so the simulator writes it directly and reports only an opaque reference.
The seam here is what that write goes through: one interface, with a
filesystem-backed default, so a self-hoster reaches their first voice
simulation with no object-storage container running and configures S3 or
MinIO later without anything above this file noticing.

``write`` is async because every implementation after the first one is a
network call, and a synchronous seam would make an upload stall every
other simulation the process is conducting.

Keys are the simulator's to compose and the store's to confine. A
``simulation_id`` is opaque — never parsed, never rewritten — but a *key*
is a different thing: an id carrying a path separator would otherwise put
a recording somewhere nobody configured. Segments that are already plain
names are kept as they are, so a reference stays readable; anything else
is flattened and given a digest of the original, so two keys that flatten
alike cannot land on one blob.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from pathlib import Path
from typing import Protocol

PLAIN_SEGMENT = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]*\Z")
_UNSAFE_IN_A_SEGMENT = re.compile(r"[^A-Za-z0-9._-]")
_READABLE_PREFIX_CHARS = 64


class BlobStore(Protocol):
    """Somewhere to put bytes and get back a reference to them.

    The reference is what a report carries: opaque, never a URL, and never
    carrying how to fetch it. Resolving it is the reader's business.
    """

    async def write(self, key: str, content: bytes) -> str: ...


def confined_key(key: str) -> str:
    """One key, flattened until it can only name a blob inside the store."""
    segments = [segment for segment in key.split("/") if segment]
    if not segments:
        raise ValueError("a blob key needs at least one segment")
    return "/".join(_confined_segment(segment) for segment in segments)


def _confined_segment(segment: str) -> str:
    if PLAIN_SEGMENT.match(segment):
        return segment
    digest = hashlib.sha256(segment.encode()).hexdigest()[:16]
    readable = _UNSAFE_IN_A_SEGMENT.sub("_", segment)[:_READABLE_PREFIX_CHARS]
    return f"{readable}-{digest}"


class FilesystemBlobStore:
    """The default store: a directory, one file per key.

    Enough for a self-hoster and for CI, and honest about what it is — a
    reference resolves to ``root / key`` and nothing else can be reached
    from it.
    """

    def __init__(self, root: Path) -> None:
        self._root = root

    @property
    def root(self) -> Path:
        return self._root

    async def write(self, key: str, content: bytes) -> str:
        reference = confined_key(key)
        await asyncio.to_thread(self._write_now, reference, content)
        return reference

    def _write_now(self, reference: str, content: bytes) -> None:
        path = self._root / reference
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
