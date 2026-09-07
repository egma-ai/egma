"""Disable NLTK runtime downloads before importing simulator modules.
The image supplies the tokenizer corpus used for sentence alignment.
Missing data must raise the normal NLTK error instead of using a stub.
"""

from __future__ import annotations

from typing import Any

import nltk


def _never_download(*_args: Any, **_kwargs: Any) -> bool:
    """Stand in for NLTK's downloader: answers "no", reaches nothing."""
    return False


nltk.download = _never_download
