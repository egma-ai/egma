"""Blob storage: where bytes land that a report can only point at.

A recording is too big to travel in a report and too useful to throw away,
so the simulator writes it directly and reports only an opaque reference.
The seam here is what that write goes through: one interface, with two
implementations behind it. A deployment names an object-storage endpoint
and its recordings land somewhere every part of that deployment can
reach; it names none and a directory stands in, which is what lets the
whole test suite run with no container anywhere and what a bare
``egma-simulator`` process on somebody's laptop writes to.

``write`` is async because every implementation after the first one is a
network call, and a synchronous seam would make an upload stall every
other simulation the process is conducting.

Keys are the simulator's to compose and the store's to confine. A
``simulation_id`` is opaque — never parsed, never rewritten — but a *key*
is a different thing: an id carrying a path separator would otherwise put
a recording somewhere nobody configured. Segments that are already plain
names are kept as they are, so a reference stays readable; anything else
is flattened and given a digest of the original.

Two keys that flatten alike must never land on one blob, and a key can be
odd in two different ways. Its *segments* can be — a space, a null byte,
a ``..`` — and a digest of each segment tells those apart. Its
*separators* can be too: ``a//b``, ``/a/b``, ``a/b/`` and ``a/b`` all
carry the same segments, so per-segment digests see nothing to tell apart
and all four would name one blob, the last write quietly replacing the
rest. So a key whose separators are not already the plain ones carries a
digest of the whole original as well.
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
"""How long opening a connection to the store may take before that attempt
is over.

The store is a container on the deployment's own network and answers in
milliseconds; this is the allowance for one that is up and busy, not for
one that is not there. An endpoint that is *black-holed* — a firewall that
drops rather than refuses, which is the ordinary way a store goes missing
— never answers at all, and this number is the whole of what stops that
from becoming a wait.
"""

S3_READ_SECONDS = 30.0
"""How long one socket operation may stall before that attempt is over.

Not how long an upload may take: it is a per-operation timeout, so an
upload that is slow but *moving* resets it with every chunk and is never
cut off. What it catches is a store that accepted the connection and then
stopped talking. Wide enough for a full-length wideband recording — around
sixty megabytes — over a link that is genuinely slow rather than stuck.
"""

S3_ATTEMPTS = 3
"""How many times one recording is offered to the store, in total.

The arithmetic, because a recording is written from inside
``Conductor.close()`` and holds a capacity slot until it returns. Three
attempts at five seconds to connect is fifteen seconds against an endpoint
that answers nothing, plus botocore's standard mode waiting a growing
random moment between attempts — under a minute in all, and a slot back.

The defaults this replaces are sixty seconds each way and five attempts,
which is several minutes of one simulation's slot spent on a store that
was never going to answer. The filesystem store this seam grew out of
could not stall at all, so bounding the network one is what keeps the
seam's promise the same in both.
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
    """The store a whole deployment can reach: one bucket, one object per key.

    The implementation this seam was written for. Nothing above it moves
    — a recording is still built once when the conversation ends, still
    written through ``write``, still reported as one opaque reference —
    and what changes is only where those bytes come to rest. Out of one
    container's own disk, which nothing but that container can read, and
    into storage the control plane and every other simulator share. A
    self-hoster who starts a second simulator, which the deployment
    invites them to do, then gets recordings from both, readable from
    either; with a directory inside a container they get references that
    point at nothing and no warning that half their audio is gone.

    The reference is the confined key and nothing else — no bucket, no
    endpoint, no signature, and nothing that would go stale the day the
    deployment moved its store. Which store resolves a reference, and how
    a browser is let at it, is the reader's business.

    ``put_object`` is one request that both creates and replaces, so
    writing a key twice leaves one object exactly as writing a path twice
    leaves one file. There is no read here, and no delete: this seam is
    what a simulator does, and a simulator only ever adds.

    Every wait it can do is bounded and named — see the three constants
    at the top of this file. A store that cannot be reached must cost one
    recording and a bounded moment, never the several minutes botocore's
    own defaults would spend holding a simulation's capacity slot open.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        bucket: str,
        access_key_id: str,
        secret_access_key: str,
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
                retries={"max_attempts": S3_ATTEMPTS, "mode": "standard"},
            ),
        )

    async def write(self, key: str, content: bytes) -> str:
        """One recording into the bucket, off the event loop.

        boto3 is synchronous and this seam is not, for the reason the
        module docstring gives: an upload that blocked would stall every
        other simulation this process is conducting, and a simulator
        conducts several at once. So the call goes through a thread
        exactly as the filesystem store's write does. One client serves
        all of them — botocore's low-level clients are safe to call from
        several threads, and a client per simulation would build a fresh
        connection pool for one upload.
        """
        reference = confined_key(key)
        await asyncio.to_thread(self._write_now, reference, content)
        return reference

    def _write_now(self, reference: str, content: bytes) -> None:
        self._client.put_object(
            Bucket=self._bucket, Key=reference, Body=content
        )
