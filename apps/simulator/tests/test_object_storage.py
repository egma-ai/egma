"""Verify recording-reference behavior against the real MinIO fixture.
Check confinement, addressing, signatures, and readable objects.
Skip with a reason if the fixture cannot start its container.
"""

from __future__ import annotations

import json

import pytest
from conftest import (
    OBJECT_STORAGE_ACCESS_KEY_ID,
    OBJECT_STORAGE_READY_SECONDS,
    OBJECT_STORAGE_SECRET_ACCESS_KEY,
    OBJECT_STORAGE_START_SECONDS,
    WRONG_OBJECT_STORAGE_SECRET_ACCESS_KEY,
    ObjectStorage,
    assert_kept_secret,
    has_terminal,
    loopback_spec,
    object_client,
    terminal_event_for,
)

from egma_simulator.blob import S3BlobStore, confined_key
from egma_simulator.config import DEFAULT_S3_REGION

OBJECT_STORAGE_TIMEOUT_SECONDS = (
    OBJECT_STORAGE_START_SECONDS + OBJECT_STORAGE_READY_SECONDS + 120
)
"""Include image-pull and fixture-start budgets in the pytest timeout, plus test time.
The fixture must reach its own skip before pytest terminates setup.
"""

pytestmark = pytest.mark.timeout(OBJECT_STORAGE_TIMEOUT_SECONDS)


def store_for(storage: ObjectStorage) -> S3BlobStore:
    """The simulator's own store, pointed at the running MinIO."""
    return S3BlobStore(
        endpoint=storage.env["EGMA_SIMULATOR_S3_ENDPOINT"],
        bucket=storage.bucket,
        access_key_id=storage.env["EGMA_SIMULATOR_S3_ACCESS_KEY_ID"],
        secret_access_key=storage.env["EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY"],
        region=DEFAULT_S3_REGION,
    )


@pytest.mark.parametrize(
    "key",
    [
        "../../etc/passwd",
    ],
)
async def test_no_key_can_name_anything_outside_the_bucket(object_storage, key):
    """Object storage must use the same confined key as filesystem storage
    when a simulation ID contains path separators.
    """
    store = store_for(object_storage)

    reference = await store.write(key, b"contained")

    assert reference == confined_key(key)
    assert not reference.startswith("/")
    assert ".." not in reference.split("/")
    answer = object_client(object_storage.env).get_object(
        Bucket=object_storage.bucket, Key=reference
    )
    assert answer["Body"].read() == b"contained"


async def test_neither_half_of_the_write_credential_leaves_the_process(
    workbench, start_simulator, object_storage
):
    """At DEBUG level, scan reports, process output, and the write-ahead log
    for both sentinel storage credential values.
    """
    spec = loopback_spec(
        "sim-object-storage-secret",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
    )
    await workbench.offer(spec)
    simulator = start_simulator(
        workbench, log_level="DEBUG", extra_env=object_storage.env
    )

    records = await workbench.wait_for(has_terminal("sim-object-storage-secret"))
    terminal = terminal_event_for(records, "sim-object-storage-secret")
    assert terminal["status"] == "completed", terminal["reason"]

    simulator.stop()
    for half in (OBJECT_STORAGE_ACCESS_KEY_ID, OBJECT_STORAGE_SECRET_ACCESS_KEY):
        assert_kept_secret(half, records=records, simulator=simulator)


async def test_a_refused_credential_leaves_nothing_behind_either(
    workbench, start_simulator, object_storage
):
    """Scan DEBUG output when the store rejects the upload credentials.
    The simulation currently completes without audio; logs retain the failure event
    and exception class without provider error text or request details.
    """
    spec = loopback_spec(
        "sim-object-storage-refused",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
    )
    await workbench.offer(spec)
    simulator = start_simulator(
        workbench,
        log_level="DEBUG",
        extra_env=object_storage.env
        | {
            "EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY": (
                WRONG_OBJECT_STORAGE_SECRET_ACCESS_KEY
            )
        },
    )

    records = await workbench.wait_for(has_terminal("sim-object-storage-refused"))
    terminal = terminal_event_for(records, "sim-object-storage-refused")
    assert terminal["status"] == "completed", terminal["reason"]
    assert terminal["facts"]["audio"] is None, (
        "the store refused the write, so there is no recording to point at"
    )

    simulator.stop()
    output = simulator.output()
    platform_logs = [json.loads(line) for line in output.splitlines()]
    recording_failure = next(
        record
        for record in platform_logs
        if record["otel.event.name"] == "egma.simulation.recording_failed"
    )
    assert recording_failure["body"] == "simulation recording upload failed"
    assert recording_failure["error.type"] == "ClientError"
    assert recording_failure["exception.type"] == "botocore.exceptions.ClientError"
    assert "SignatureDoesNotMatch" not in output
    for half in (
        OBJECT_STORAGE_ACCESS_KEY_ID,
        WRONG_OBJECT_STORAGE_SECRET_ACCESS_KEY,
    ):
        assert_kept_secret(half, records=records, simulator=simulator)
