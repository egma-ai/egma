"""Which agent frameworks this test environment has, read off installed distributions.

A folder named like a package on ``sys.path`` can make an import succeed, so
the tests ask the package metadata, which such a folder cannot fake.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, distribution

import pytest


def installed(name: str) -> bool:
    try:
        distribution(name)
    except PackageNotFoundError:
        return False
    return True


needs_livekit = pytest.mark.skipif(
    not installed("livekit-agents"), reason="LiveKit is not installed"
)
needs_pipecat = pytest.mark.skipif(
    not installed("pipecat-ai"), reason="Pipecat is not installed"
)
