"""The quarantine, enforced rather than promised.

The simulator's whole licence to be Python inside a TypeScript monorepo is
that it reaches the rest of egma through one versioned JSON contract and
nothing else: no shared code, no database, no imports from anywhere above
this directory. That is the sort of boundary a README claims and a codebase
quietly loses, so it is checked here instead — the same reasoning the
repository already applies to its data-access boundary in build-time rules
rather than in prose.

The two rules are: the dependency list stays short and known, and no module
reaches for a datastore driver.
"""

from __future__ import annotations

import ast
import sys
import tomllib
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = APP_ROOT / "src" / "egma_simulator"

# Everything the simulator is allowed to depend on, and why it earns its
# place. Adding a line here is a deliberate act; growing this list quietly
# is what the test exists to prevent.
ALLOWED_DEPENDENCIES = {
    "aiohttp",  # the outbound HTTP client, and the workbench's server
    "jsonschema",  # holds every document to the contract, both directions
    "rfc3339-validator",  # so the schemas' date-time format is really checked
    "pipecat-ai",  # the voice pipeline: the speech legs and the recording
    "loguru",  # what pipecat logs through, gathered under one filter
    "nltk",  # pipecat's tokenizer, held to no downloads (see __init__)
}

# A datastore driver in here would mean the simulator had stopped asking
# the control plane and started reading its answers, which is the one thing
# the contract exists to prevent.
DATASTORE_DRIVERS = {
    "asyncpg",
    "psycopg",
    "psycopg2",
    "sqlalchemy",
    "clickhouse_connect",
    "clickhouse_driver",
    "redis",
    "pymongo",
}


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


def test_the_dependency_list_stays_short_and_declared():
    with open(APP_ROOT / "pyproject.toml", "rb") as handle:
        declared = tomllib.load(handle)["project"]["dependencies"]

    named = {
        requirement.split(">")[0].split("=")[0].split("[")[0].strip()
        for requirement in declared
    }
    assert named == ALLOWED_DEPENDENCIES, (
        "the simulator's dependencies changed; if that is deliberate, say so "
        "in ALLOWED_DEPENDENCIES and explain what the new one earns"
    )


def test_no_module_imports_anything_from_outside_the_app():
    """Third-party imports are the declared ones; everything else is stdlib."""
    # The distribution names above are not always the module names.
    allowed_modules = {"aiohttp", "jsonschema", "pipecat", "loguru", "nltk"}
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


def test_no_module_reaches_for_a_datastore():
    """The simulator asks the control plane; it never reads its database."""
    offenders: dict[str, set[str]] = {}
    for file in source_files():
        drivers = imported_roots(file) & DATASTORE_DRIVERS
        if drivers:
            offenders[str(file.relative_to(APP_ROOT))] = drivers

    assert not offenders, (
        f"a datastore driver reached the simulator: {offenders}. Everything it "
        "needs arrives in the claimed spec; there is nothing to look up."
    )


def test_the_contract_is_read_from_the_shared_package_not_copied():
    """One artifact, two readers — a vendored copy could drift silently."""
    from egma_simulator.contract import contract_dir

    shared = contract_dir()
    assert shared.name == "simulation-contract"
    assert (shared / "schemas").is_dir()
    # Nothing schema-shaped lives inside the app itself.
    assert not list(APP_ROOT.rglob("*.schema.json"))
