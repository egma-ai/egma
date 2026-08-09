"""The simulator: one promise made before anything else is imported.

Nothing in this process reaches the network unasked. The speech legs are
built on Pipecat, whose sentence handling is built on NLTK, and NLTK's
module fetches a tokenizer corpus from the internet the moment it is
asked for one that is not on disk. That fetch is taken away here, in the
one place Python guarantees runs before every module below it.

The corpus itself is genuinely needed, and ships with the image rather
than being fetched: the speaking leg regroups a turn into sentences to
line spoken words up with the transcript, so any turn holding more than
one sentence reaches for it. An earlier version of this note claimed the
simulator never splits sentences and therefore never opens the corpus.
That was wrong in a way worth remembering — it was true only of turns a
scripted persona writes, which are one sentence each, so nothing ever
asked for a sentence boundary and the missing corpus stayed invisible
until a real persona brain spoke two sentences in a row.

The corpus is not faked in place of the download. Code that reaches for
one this image does not carry must fail loudly with the library's own
missing-data error rather than quietly read a stub.
"""

from __future__ import annotations

from typing import Any

import nltk


def _never_download(*_args: Any, **_kwargs: Any) -> bool:
    """Stand in for NLTK's downloader: answers "no", reaches nothing."""
    return False


nltk.download = _never_download
