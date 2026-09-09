"""Async recording storage; reports carry opaque references instead of audio bytes.
Use shared object storage when configured, otherwise a local directory.

Confine keys without changing simulation IDs. Digest altered segments to avoid
collisions. Also digest the full key when separators are noncanonical:
a//b, /a/b, a/b/, and a/b must not resolve to the same object.
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

S3_CONNECT_SECONDS = 5.0
"""Per-attempt connection timeout, including endpoints that silently drop requests."""

S3_READ_SECONDS = 30.0
"""How long one socket operation may stall before that attempt is over.

Not how long an upload may take: it is a per-operation timeout, so an
upload that is slow but *moving* resets it with every chunk and is never
cut off. What it catches is a store that accepted the connection and then
stopped talking. Wide enough for a full-length wideband recording — around
sixty megabytes — over a link that is genuinely slow rather than stuck.
"""

S3_ATTEMPTS = 3
"""Total upload attempts, including the first request.
Use botocore total_max_attempts: max_attempts counts retries instead.
Bound retries because recording upload holds a simulation capacity slot.
"""


class BlobStore(Protocol):
    """Somewhere to put bytes and get back a reference to them.

    The reference is what a report carries: opaque, never a URL, and never
    carrying how to fetch it. Resolving it is the reader's business.
    """

    async def write(self, key: str, content: bytes) -> str: ...


def confined_key(key: str) -> str:
    """One key, flattened until it can only name a blob inside the store.

    A key that was already plain comes back byte for byte, so an ordinary
    reference stays readable. Everything else is flattened *and* marked,
    per the module docstring: oddness in a segment is answered by that
    segment's digest, and oddness in the separators — the only kind that
    survives being split apart — by a digest of the whole key.
    """
    segments = [segment for segment in key.split("/") if segment]
    if not segments:
        raise ValueError("a blob key needs at least one segment")

    confined = [_confined_segment(segment) for segment in segments]
    if "/".join(segments) != key:
        confined[-1] = f"{confined[-1]}-{_digest(key)}"
    return "/".join(confined)


def _confined_segment(segment: str) -> str:
    if PLAIN_SEGMENT.match(segment):
        return segment
    readable = _UNSAFE_IN_A_SEGMENT.sub("_", segment)[:_READABLE_PREFIX_CHARS]
    return f"{readable}-{_digest(segment)}"


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


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


class S3BlobStore:
    """Shared recording bucket with one object per confined key.
    References contain only keys, without endpoints or credentials.
    Writing the same key replaces its object. Connection, read, and retry
    limits bound how long upload holds a simulation capacity slot.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        bucket: str,
        access_key_id: str,
        secret_access_key: str,
        session_token: str | None = None,
        region: str,
    ) -> None:
        # The client is imported here rather than at the top of this file,
        # on the rule this package already holds every provider library to:
        # choosing the thing is what loads its client. A deployment that
        # named no endpoint — a contributor's checkout, a first voice
        # simulation, every suite here but one — never builds this store,
        # and so never pays botocore's import to reach a directory.
        import boto3
        from botocore.config import Config as BotoConfig

        self._bucket = bucket
        # Path addressing, not the virtual-host style AWS defaults to.
        # A MinIO answering at `http://minio:9000` has one name on the
        # deployment's network and no per-bucket name at all, so a client
        # that asked for `http://egma-recordings.minio:9000` would resolve
        # nothing — and the error it raises names DNS rather than the
        # addressing style that caused it. AWS itself serves both, so this
        # costs a deployment pointed at real S3 nothing.
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            aws_session_token=session_token,
            region_name=region,
            config=BotoConfig(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                # Named rather than defaulted, and the reason is above
                # each one: a write happens inside `Conductor.close()`,
                # so whatever this waits for, one simulation's capacity
                # slot waits for too.
                connect_timeout=S3_CONNECT_SECONDS,
                read_timeout=S3_READ_SECONDS,
                retries={"total_max_attempts": S3_ATTEMPTS, "mode": "standard"},
            ),
        )

    async def write(self, key: str, content: bytes) -> str:
        """Run synchronous boto3 upload in a thread so other simulations can proceed.
        Reuse the low-level client and its connection pool across uploads.
        """
        reference = confined_key(key)
        await asyncio.to_thread(self._write_now, reference, content)
        return reference

    def _write_now(self, reference: str, content: bytes) -> None:
        self._client.put_object(
            Bucket=self._bucket, Key=reference, Body=content
        )
