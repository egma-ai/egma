"""The blob seam's second implementation, against a real object store.

`test_blob.py` pins what a reference *is* — resolvable, confined, readable
when it was already plain — against the filesystem store. This file holds
the same rules against the store a deployment actually runs, because the
rules are the seam's and not one implementation's, and because everything
that goes wrong between a client and an object store goes wrong on the
wire: a signature, an addressing style, a bucket that is not there.

So there is no fake here. A stand-in would agree with whatever this code
believed about all three. What runs is MinIO, in a container, and where
one cannot be started the tests skip and say so — see the `object_storage`
fixture in `conftest.py`.
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
    assert_one_speaker_to_a_channel,
    has_terminal,
    load_fixture_spec,
    loopback_spec,
    object_client,
    terminal_event_for,
    turns_for,
)

from egma_simulator.blob import S3BlobStore, confined_key
from egma_simulator.config import DEFAULT_S3_REGION

OBJECT_STORAGE_TIMEOUT_SECONDS = (
    OBJECT_STORAGE_START_SECONDS + OBJECT_STORAGE_READY_SECONDS + 120
)
"""How long one test here may take, fixture included.

pytest's own timeout — 120 seconds, in `pyproject.toml` — covers a
fixture's setup as well as a test's body, and this file's fixture is
allowed longer than that on purpose: the first run on a machine fetches a
175 MB image. Left alone, a contributor with docker and no cached image
would get `Failed: Timeout >120.0s` where this suite promises a skip,
which is the one outcome it is written never to produce.

So the marker below is the fixture's whole budget with room for the
conversation a test then conducts. What runs out first is the fixture's
own budget, which skips and says why.
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


async def test_a_reference_resolves_to_what_was_written(object_storage):
    """The one thing the seam promises, over a real network round trip.

    Read back through a client of the tests' own rather than through the
    store that wrote it: what has to be true is that *some other reader*
    finds the bytes where the reference says they are, which is the whole
    reason the recording left the simulator's disk.
    """
    store = store_for(object_storage)

    reference = await store.write("sim_01ABC/dual-channel.wav", b"RIFF....")

    assert reference == "sim_01ABC/dual-channel.wav"
    answer = object_client(object_storage.env).get_object(
        Bucket=object_storage.bucket, Key=reference
    )
    assert answer["Body"].read() == b"RIFF...."


async def test_writing_twice_replaces_rather_than_grows(object_storage):
    """The same promise the filesystem store makes: one key, one blob."""
    store = store_for(object_storage)

    await store.write("sim-twice/recording.wav", b"first")
    reference = await store.write("sim-twice/recording.wav", b"second")

    answer = object_client(object_storage.env).get_object(
        Bucket=object_storage.bucket, Key=reference
    )
    assert answer["Body"].read() == b"second"


@pytest.mark.parametrize(
    "key",
    [
        "../../etc/passwd",
        "sim/../../../outside.wav",
        "/absolute/recording.wav",
        "sim\x00id/recording.wav",
    ],
)
async def test_no_key_can_name_anything_outside_the_bucket(object_storage, key):
    """A simulation id carrying a separator names an object in this bucket
    and nothing anywhere else.

    The rule is shared rather than written twice: what this asserts is
    that the object store's implementation calls the same
    :func:`confined_key` the filesystem one does, so there is one rule to
    get right and one place it is tested. A second copy of it would be a
    second chance to get it wrong — and the two stores disagreeing about
    what a key means is a recording that cannot be found by the reference
    its own simulation reported.
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


# -- The contract seam, with the store moved ---------------------------------
#
# The whole point of the effort, proved where a person could see it: a real
# simulator process, told only through its environment that its recordings
# go to a bucket, conducts a real voice simulation — and the recording it
# reports is fetched out of that bucket and listened to. Nothing above the
# blob seam knows any of this happened, which is why the assertion below is
# the acceptance suite's own helper, called here unchanged.


async def test_a_recording_lands_in_object_storage_and_reads_back(
    workbench, start_simulator, object_storage
):
    """A reference reported by a simulation resolves in the store, and what
    it resolves to is the call.

    The same golden fixture the acceptance suite conducts, and the same
    assertion about what came out — each turn on its own speaker's channel
    and on neither other. The only difference is four environment
    variables, which is what "nothing above the blob seam moves" means when
    it is said out loud.
    """
    spec = load_fixture_spec("voice-loopback.json")
    simulation_id = spec["simulation_id"]
    await workbench.offer(spec)
    simulator = start_simulator(workbench, extra_env=object_storage.env)

    records = await workbench.wait_for(has_terminal(simulation_id))

    terminal = terminal_event_for(records, simulation_id)
    assert terminal["status"] == "completed", terminal["reason"]
    turns = turns_for(records, simulation_id)

    # Still a reference and not an address: it names an object, and what
    # resolves it is the reader's own configuration. A report that carried
    # a URL would be a report that went stale the day the store moved.
    audio = terminal["facts"]["audio"]
    assert "://" not in audio["recording"]
    assert object_storage.endpoint not in audio["recording"]
    assert object_storage.bucket not in audio["recording"]

    recording = simulator.blob(audio["recording"])
    assert_one_speaker_to_a_channel(recording, turns)


async def test_the_simulator_keeps_no_audio_of_its_own(
    workbench, start_simulator, object_storage
):
    """The recording stops living inside the container that made it.

    This is the failure the effort exists to end: a second simulator's
    recordings are unreadable by anybody, and nothing says so. Writing to
    the bucket *and* to the disk would leave that failure standing behind
    a copy that happens to be reachable, so the disk gets nothing —
    including the directory itself, which is not even made.
    """
    spec = loopback_spec(
        "sim-object-storage-only",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
    )
    await workbench.offer(spec)
    simulator = start_simulator(workbench, extra_env=object_storage.env)

    records = await workbench.wait_for(has_terminal("sim-object-storage-only"))

    terminal = terminal_event_for(records, "sim-object-storage-only")
    assert terminal["status"] == "completed", terminal["reason"]
    assert terminal["facts"]["audio"] is not None
    assert simulator.blob(terminal["facts"]["audio"]["recording"])

    assert not simulator.blob_dir.exists(), (
        "the simulator made itself a recordings directory it was told not "
        "to use"
    )
    # And the volume still carries the one thing that has to stay on it:
    # the write-ahead log, which is what stops a report being lost.
    assert list(simulator.wal_dir.glob("*.jsonl")), (
        "the write-ahead log that protects reports is not on the volume"
    )


async def test_neither_half_of_the_write_credential_leaves_the_process(
    workbench, start_simulator, object_storage
):
    """A simulator that really holds an object-storage credential emits it
    nowhere.

    Both halves the store was stood up with are sentinels, so this is the
    same scan the spec-credential tests run — over the reports, over every
    byte the child wrote, and over the write-ahead log — with the process
    at its loudest, which is both the level somebody turns on when a
    recording is not arriving and the level botocore writes request headers
    at. Both halves rather than the secret alone, because the key id is
    kept out of logs on the same terms and a claim with no scan behind it
    is worth nothing.
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
    """The other half of the scan: the credential that does not work.

    A credential that works is never mentioned by anybody. A credential
    that does not is what a client complains about, out loud, with the
    request it signed — and the complaint travels as an exception, which
    is a different path through logging than an ordinary line. So the
    simulator is given a secret the store will refuse, at DEBUG, and every
    byte it wrote is read afterwards.

    What it also documents is what a refused upload does to a simulation:
    nothing. The conversation is conducted, the transcript is reported,
    and the terminal record simply carries no audio. That is today's
    behaviour on purpose and it is not a good one — see the spec's Further
    Notes, where the gap is written down.

    The log keeps a stable failure event and exception class, but it does
    not copy the object store's runtime error text or request details.
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
