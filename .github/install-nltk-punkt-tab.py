"""Install the pinned English sentence-tokenizer data used by voice tests."""

from __future__ import annotations

import hashlib
import io
import urllib.request
import zipfile
from pathlib import Path

import nltk

_CORPUS_URL = (
    "https://raw.githubusercontent.com/nltk/nltk_data/"
    "550b6625bcef1f2abff2ff770a5a0d272c9c6b2a/"
    "packages/tokenizers/punkt_tab.zip"
)
_CORPUS_SHA256 = "e57f64187974277726a3417ca6f181ec5403676c717672eef6a748a7b20e0106"


def main() -> None:
    with urllib.request.urlopen(_CORPUS_URL, timeout=30) as response:
        archive = response.read()
    if hashlib.sha256(archive).hexdigest() != _CORPUS_SHA256:
        raise RuntimeError("punkt_tab archive checksum does not match")

    target = Path.home() / "nltk_data" / "tokenizers"
    with zipfile.ZipFile(io.BytesIO(archive)) as corpus:
        corpus.extractall(
            target,
            members=(
                name
                for name in corpus.namelist()
                if name.startswith("punkt_tab/english/")
            ),
        )
    nltk.data.find("tokenizers/punkt_tab/english")


if __name__ == "__main__":
    main()
