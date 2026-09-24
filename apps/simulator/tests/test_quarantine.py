"""Enforce the simulator's import boundary with the rest of Egma.
Check that source modules import only declared third-party libraries.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = APP_ROOT / "src" / "egma_simulator"


def source_files() -> list[Path]:
    return sorted(SOURCE_ROOT.rglob("*.py"))


def imported_roots(file: Path) -> set[str]:
    """The top-level module name of every import in one file."""
    tree = ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                roots.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            # A relative import stays inside this package by definition.
            if node.level == 0 and node.module:
                roots.add(node.module.split(".")[0])
    return roots


def test_no_module_imports_anything_from_outside_the_app():
    """Third-party imports are the declared ones; everything else is stdlib."""
    # Distribution names are not always module names. The OTLP encoder's
    # generated protobuf types live under Google's shared namespace.
    # Deepgram and websockets are locked by the declared Pipecat Deepgram extra
    # and used directly only by its Daytona transport shim.
    allowed_modules = {
        "aiohttp",
        "openai",
        "httpx",
        "deepgram",
        "jsonschema",
        "referencing",
        "pipecat",
        "loguru",
        "structlog",
        "nltk",
        "livekit",
        "boto3",
        "botocore",
        "opentelemetry",
        "websockets",
        "google",
    }
    permitted = allowed_modules | set(sys.stdlib_module_names) | {"egma_simulator"}

    offenders: dict[str, set[str]] = {}
    for file in source_files():
        strangers = imported_roots(file) - permitted
        if strangers:
            offenders[str(file.relative_to(APP_ROOT))] = strangers

    assert not offenders, (
        f"the simulator imported something outside its quarantine: {offenders}. "
        "It reaches the rest of egma through the simulation contract only."
    )
