"""Immutable built-in background sounds for the outgoing caller track."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path

BACKGROUND_GAIN = 10 ** (-12 / 20)
"""Fixed gain for every selected background sound."""


@dataclass(frozen=True)
class BackgroundSound:
    sound_id: str

    def __post_init__(self) -> None:
        if not self.sound_id:
            raise ValueError("background sound ID is required")


def _asset_root() -> Path:
    return Path(__file__).resolve().parent / "assets" / "background"


@cache
def asset_catalog() -> dict[str, Path]:
    root = _asset_root()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    catalog: dict[str, Path] = {}
    for entry in manifest["assets"]:
        path = root / entry["file"]
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != entry["sha256"]:
            raise RuntimeError(f"background asset {entry['id']} failed its checksum")
        catalog[entry["id"]] = path
    return catalog


def soundfile_mixer(background: BackgroundSound):
    """Build the pinned Pipecat mixer for one selected immutable sound."""
    if background.sound_id == "none":
        return None
    path = asset_catalog().get(background.sound_id)
    if path is None:
        raise ValueError(f"unknown background sound {background.sound_id!r}")
    from pipecat.audio.mixers.soundfile_mixer import SoundfileMixer

    return SoundfileMixer(
        sound_files={background.sound_id: str(path)},
        default_sound=background.sound_id,
        volume=BACKGROUND_GAIN,
        mixing=True,
        loop=True,
    )
