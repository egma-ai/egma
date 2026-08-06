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


@cache
def spec_validator() -> Draft202012Validator:
    """The compiled spec-direction validator, built once per process."""
    schema = _load_schema(SPEC_SCHEMA_FILENAME)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


@cache
def report_validator() -> Draft202012Validator:
    """The compiled report-direction validator, built once per process."""
    schema = _load_schema(REPORT_SCHEMA_FILENAME)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def _complaints(validator: Draft202012Validator, document: object) -> list[str]:
    def flatten(errors) -> list[str]:
        flat: list[str] = []
        for error in errors:
            if error.context:
                flat.extend(flatten(error.context))
            else:
                place = "/" + "/".join(str(part) for part in error.absolute_path)
                flat.append(f"{place}: {error.message}")
        return flat

    return flatten(validator.iter_errors(document))


def validate_spec(document: object) -> None:
    """Refuse a claimed spec that does not speak the contract."""
    complaints = _complaints(spec_validator(), document)
    if complaints:
        raise ContractViolation("spec", complaints)


def validate_report(document: object) -> None:
    """Refuse an outgoing report that does not speak the contract."""
    complaints = _complaints(report_validator(), document)
    if complaints:
        raise ContractViolation("report", complaints)
