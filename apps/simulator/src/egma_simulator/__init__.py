"""The simulator: one promise made before anything else is imported.

Nothing in this process reaches the network unasked. The speech legs are
built on Pipecat, whose sentence aggregation is built on NLTK, and NLTK's
module fetches a tokenizer corpus from the internet the moment it is
imported without one already on disk. The simulator never splits
sentences — the persona speaks one whole turn at a time, and the speaking
leg is told to pass text straight through — so that corpus is never
opened, and fetching it would be an unasked-for download inside a suite
that is supposed to need no network at all.

So the fetch is taken away here, in the one place Python guarantees runs
before every module below it. The corpus is not faked in its place: code
that does start splitting sentences must fail loudly with the library's
own missing-data error rather than quietly read a stub.
"""

from __future__ import annotations

from typing import Any

import nltk


def _never_download(*_args: Any, **_kwargs: Any) -> bool:
    """Stand in for NLTK's downloader: answers "no", reaches nothing."""
    return False


nltk.download = _never_download
