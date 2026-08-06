"""The blob seam: what a reported reference is, and where it can reach.

A recording is written here and reported as a reference — never as bytes,
never as a URL. Two things are worth pinning: a reference resolves to the
blob that was written, and a key composed out of an opaque simulation id
can never name anything outside the store.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from egma_simulator.blob import FilesystemBlobStore, confined_key


async def test_a_reference_resolves_to_what_was_written(tmp_path: Path):
    store = FilesystemBlobStore(tmp_path)
    reference = await store.write("sim_01ABC/dual-channel.wav", b"RIFF....")
    assert reference == "sim_01ABC/dual-channel.wav"
    assert (tmp_path / reference).read_bytes() == b"RIFF...."


async def test_writing_twice_replaces_rather_than_grows(tmp_path: Path):
    store = FilesystemBlobStore(tmp_path)
    await store.write("sim/recording.wav", b"first")
    reference = await store.write("sim/recording.wav", b"second")
    assert (tmp_path / reference).read_bytes() == b"second"


@pytest.mark.parametrize(
    "key",
    [
        "../../etc/passwd",
        "sim/../../../outside.wav",
        "/absolute/recording.wav",
        "sim\x00id/recording.wav",
    ],
)
async def test_no_key_can_name_anything_outside_the_store(
    tmp_path: Path, key: str
):
    """A simulation id is opaque and never parsed; a filename made from one
    is a different thing, and it is flattened until it can only land here."""
    root = tmp_path / "blobs"
    store = FilesystemBlobStore(root)
    reference = await store.write(key, b"contained")
    written = (root / reference).resolve()
    assert written.is_relative_to(root.resolve())
    assert written.read_bytes() == b"contained"


def test_two_keys_that_flatten_alike_stay_apart():
    """The digest is what stops one blob from becoming two simulations'."""
    assert confined_key("a/b") != confined_key("a b")
    assert confined_key("../x.wav") != confined_key("..\\x.wav")


def test_a_key_with_nothing_in_it_is_refused():
    with pytest.raises(ValueError, match="segment"):
        confined_key("///")
