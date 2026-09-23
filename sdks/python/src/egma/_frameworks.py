"""What the LiveKit and Pipecat integrations share.

Each integration imports its framework through ``require``, which names the
extra that installs it when the framework is missing, and calls
``warn_outside_range`` once, which reads the tested range from this
package's own metadata (the ``[livekit]`` and ``[pipecat]`` extras in
``pyproject.toml``), so the range is written in one place.
"""

from __future__ import annotations

import importlib
import logging
import re
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, requires, version

logger = logging.getLogger("egma")


def installed_version(distribution: str) -> str:
    """The installed version of a distribution, or ``"unknown"``."""
    try:
        return version(distribution)
    except PackageNotFoundError:
        return "unknown"


def require(module: str, *, label: str, distribution: str, extra: str) -> None:
    """Import a framework, or say which egma extra installs it."""
    try:
        importlib.import_module(module)
    except ModuleNotFoundError as missing:
        if (missing.name or "").split(".")[0] != module.split(".")[0]:
            raise
        raise ModuleNotFoundError(
            f"egma's {label} integration needs {distribution}, and it is not "
            f'installed here. Install the {label} extra: pip install "egma[{extra}]".',
            name=missing.name,
        ) from missing


def release(text: str) -> tuple[int, int, int] | None:
    """The numeric release of a version string, or None if unreadable."""
    matched = re.match(r"(\d+)\.(\d+)(?:\.(\d+))?", text)
    if matched is None:
        return None
    major, minor, patch = matched.groups()
    return int(major), int(minor), int(patch or 0)


@dataclass(frozen=True)
class SupportedRange:
    """A ``>=floor,<ceiling`` range this package declares for a framework."""

    floor: str
    ceiling: str

    @property
    def text(self) -> str:
        return f">={self.floor},<{self.ceiling}"

    def holds(self, installed: str) -> bool | None:
        """Whether a version is in the range; None when it cannot be read."""
        found = release(installed)
        floor, ceiling = release(self.floor), release(self.ceiling)
        if found is None or floor is None or ceiling is None:
            return None
        return floor <= found < ceiling


def _canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def supported_range(distribution: str, extra: str) -> SupportedRange | None:
    """The range the ``extra`` declares for ``distribution``, from egma's metadata."""
    try:
        declared = requires("egma") or []
    except PackageNotFoundError:
        return None
    for requirement in declared:
        spec, _, marker = requirement.partition(";")
        named = re.match(r"\s*([A-Za-z0-9_.-]+)", spec)
        if named is None or _canonical(named[1]) != _canonical(distribution):
            continue
        if not re.search(rf"extra\s*==\s*['\"]{re.escape(extra)}['\"]", marker):
            continue
        floor = re.search(r">=\s*([0-9][0-9.]*)", spec)
        ceiling = re.search(r"<\s*([0-9][0-9.]*)", spec)
        if floor is None or ceiling is None:
            return None
        return SupportedRange(floor=floor[1], ceiling=ceiling[1])
    return None


def warn_outside_range(distribution: str, extra: str) -> None:
    """Log once when the installed framework is outside the tested range."""
    tested = supported_range(distribution, extra)
    installed = installed_version(distribution)
    if tested is None or tested.holds(installed) is not False:
        return
    logger.warning(
        "egma supports %s %s, and this process runs %s. Mock tools and the "
        "agent's record may not work. Install a supported version with "
        'pip install "egma[%s]".',
        distribution,
        tested.text,
        installed,
        extra,
    )
