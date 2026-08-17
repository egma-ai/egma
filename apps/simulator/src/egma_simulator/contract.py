"""The simulation contract, as the simulator sees it.

The two JSON Schemas under ``packages/simulation-contract`` are the one
meeting point between the TypeScript control plane and this service. This
module locates that package, compiles both schemas once, and offers the two
validation directions: a claimed spec is refused if it does not speak the
contract, and every outgoing report is held to the report schema before a
byte of it leaves the process.

The schemas are read from the contract package rather than vendored here,
deliberately: one shared artifact, two readers. Inside the repository the
package sits a fixed walk up from this file; a deployment that lays files
out differently points ``EGMA_SIMULATION_CONTRACT_DIR`` at a directory
holding ``schemas/`` and ``fixtures/``.
"""

from __future__ import annotations

import json
import os
from functools import cache
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

CONTRACT_DIR_ENV = "EGMA_SIMULATION_CONTRACT_DIR"

SPEC_SCHEMA_FILENAME = "simulation-spec.v1.schema.json"
REPORT_SCHEMA_FILENAME = "simulation-report.v1.schema.json"

SPEC_SCHEMA_FILENAMES = {
    1: "simulation-spec.v1.schema.json",
    2: "simulation-spec.v2.schema.json",
}
"""The spec schema for each contract version this simulator implements."""

SUPPORTED_SPEC_VERSIONS = tuple(sorted(SPEC_SCHEMA_FILENAMES))
"""Which spec versions this simulator will conduct, oldest first.

**Advertised on every claim**, so the control plane hands this process the
newest document both sides speak and never one it cannot read. That is what
makes a mixed rollout safe without a drain step: an old simulator says ``1``
and keeps receiving version-1 work while a new one beside it says ``1, 2``
and receives version 2.

A version outside this tuple is refused **by its version**, before any
schema is consulted. Refusing loudly is the whole point: a document read
against a contract it never claimed to speak would have its unknown blocks
quietly dropped, and this process would conduct a simulation with its own
model settings while the control plane believed it had sent the persona's.
"""

# The endings a failed simulation may carry, spelled here because this is
# where the contract's vocabulary lives — the schema is the authority and
# this module is the one that reads it. Naming them once means the code
# that decides which one a failure deserves and the code that writes it
# onto a report cannot drift into two different spellings.
ERROR = "error"
"""The simulator hit a fault it could not conduct through."""

AGENT_NEVER_JOINED = "agent_never_joined"
"""The way in opened and no agent turned up, so nothing was tested."""

NOT_ANSWERED = "not_answered"
"""The simulator reached out and nothing picked up, so nothing was tested."""


class ContractViolation(Exception):
    """A document does not speak the simulation contract.

    Carries which direction refused it and every complaint the schema had,
    so a log line names the exact place a document went wrong.
    """

    def __init__(self, direction: str, complaints: list[str]):
        self.direction = direction
        self.complaints = complaints
        super().__init__(f"{direction} document violates the contract: {complaints}")


def contract_dir() -> Path:
    """Where the contract package lives.

    ``EGMA_SIMULATION_CONTRACT_DIR`` wins when set; otherwise walk up from
    this file looking for ``packages/simulation-contract``, which finds the
    package from anywhere inside the repository checkout.
    """
    named = os.environ.get(CONTRACT_DIR_ENV)
    if named:
        directory = Path(named)
        if not (directory / "schemas").is_dir():
            raise FileNotFoundError(
                f"{CONTRACT_DIR_ENV}={named} has no schemas/ directory"
            )
        return directory

    for ancestor in Path(__file__).resolve().parents:
        candidate = ancestor / "packages" / "simulation-contract"
        if (candidate / "schemas").is_dir():
            return candidate

    raise FileNotFoundError(
        "packages/simulation-contract not found above "
        f"{Path(__file__).resolve()}; set {CONTRACT_DIR_ENV}"
    )


def _load_schema(filename: str) -> dict:
    with open(contract_dir() / "schemas" / filename, encoding="utf-8") as handle:
        return json.load(handle)


SCHEMA_OF = {
    "spec": SPEC_SCHEMA_FILENAME,
    "report": REPORT_SCHEMA_FILENAME,
}


@cache
def validator(direction: str) -> Draft202012Validator:
    """The compiled validator for one direction, built once per process.

    Compiling is part of the guarantee: a schema that is not valid
    2020-12 fails here, at import of the first document, rather than
    quietly accepting everything.

    ``spec`` names version 1, which is what every reader that predates a
    second version means by it. ``spec_validator`` below takes the version
    it wants.
    """
    schema = _load_schema(SCHEMA_OF[direction])
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


@cache
def _spec_validator_for(version: int) -> Draft202012Validator:
    schema = _load_schema(SPEC_SCHEMA_FILENAMES[version])
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def spec_validator(version: int = 1) -> Draft202012Validator:
    """The compiled spec validator for one contract version."""
    if version not in SPEC_SCHEMA_FILENAMES:
        raise ContractViolation(
            "spec",
            [
                f"/contract_version: must be one of "
                f"{', '.join(str(known) for known in SUPPORTED_SPEC_VERSIONS)}, "
                f"and this document says {version!r}"
            ],
        )
    return _spec_validator_for(version)


def report_validator() -> Draft202012Validator:
    return validator("report")


def _flatten_complaints(errors) -> list[str]:
    flat: list[str] = []
    for error in errors:
        if error.context:
            flat.extend(_flatten_complaints(error.context))
        else:
            place = "".join(f"/{part}" for part in error.absolute_path)
            flat.append(f"{place}: {error.message}")
    return flat


def _complaints(direction: str, document: object) -> list[str]:
    def flatten(errors) -> list[str]:
        flat: list[str] = []
        for error in errors:
            if error.context:
                flat.extend(flatten(error.context))
            else:
                place = "".join(f"/{part}" for part in error.absolute_path)
                flat.append(f"{place}: {error.message}")
        return flat

    return flatten(validator(direction).iter_errors(document))


def validate(direction: str, document: object) -> None:
    """Refuse a document that does not speak the contract in its direction."""
    complaints = _complaints(direction, document)
    if complaints:
        raise ContractViolation(direction, complaints)


def spec_version_of(document: object) -> object:
    """The version a claimed document says it speaks, whatever else is wrong."""
    if not isinstance(document, dict):
        return None
    return document.get("contract_version")


def validate_spec(document: object) -> None:
    """Refuse a claimed spec that does not speak the contract.

    The version is read first and refused on its own terms. A document
    whose version this simulator does not implement is refused **by that
    version**, before any schema sees it: checking it against a contract it
    never claimed to speak would drop every block this process does not
    know about, and conducting a simulation with silently dropped model
    selections is worse than refusing to conduct it at all.
    """
    version = spec_version_of(document)
    if version not in SPEC_SCHEMA_FILENAMES:
        raise ContractViolation(
            "spec",
            [
                f"/contract_version: must be one of "
                f"{', '.join(str(known) for known in SUPPORTED_SPEC_VERSIONS)}, "
                f"and this document says {version!r}"
            ],
        )

    complaints = _flatten_complaints(
        spec_validator(version).iter_errors(document)
    )
    if complaints:
        raise ContractViolation("spec", complaints)


def validate_report(document: object) -> None:
    """Refuse an outgoing report that does not speak the contract."""
    validate("report", document)
