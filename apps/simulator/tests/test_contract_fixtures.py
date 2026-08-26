"""The simulation contract, held to its golden fixtures — the Python half.

The TypeScript suite beside the schemas validates the same files; this
suite is what makes the guarantee two-sided, so the control plane and the
simulator cannot drift apart silently. Every valid fixture must validate,
every deliberately invalid fixture must be rejected at the exact place it
is wrong, and the pins hold both ways: a fixture without an expectation
here fails, and so does an expectation whose fixture is gone.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema.exceptions import ValidationError

from egma_simulator.contract import (
    ContractViolation,
    contract_dir,
    report_validator,
    spec_contract_version,
    spec_validator,
    validate_report,
    validate_spec,
)
from egma_simulator.spec import SimulationSpec

VALIDATORS = {"spec": spec_validator, "report": report_validator}
VALIDATE = {"spec": validate_spec, "report": validate_report}


def fixtures_under(direction: str, expectation: str) -> list[tuple[str, dict]]:
    directory = contract_dir() / "fixtures" / direction / expectation
    fixtures = []
    for path in sorted(directory.glob("*.json")):
        with open(path, encoding="utf-8") as handle:
            fixtures.append((path.name, json.load(handle)))
    return fixtures


def read_json(path: Path) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


# Why each deliberately invalid fixture is invalid: the exact instance path
# the decisive error sits at, the schema keyword that must fail there, and
# the property it names where the keyword names one. The same pins as the
# TypeScript suite's EXPECTED_REJECTION, kept in its shape on purpose.
EXPECTED_REJECTION: dict[str, tuple[str, str, str | None]] = {
    "spec/chat-carrying-speech-key.json": ("/models/stt", "not", None),
    "spec/limits-missing.json": ("", "required", "limits"),
    "spec/adapter-missing.json": (
        "/models/stt",
        "required",
        "adapter",
    ),
    "spec/models-missing.json": ("", "required", "models"),
    "spec/mock-tool-answering-two-ways.json": (
        "/mock_tools/0/answer",
        "additionalProperties",
        "error",
    ),
    "spec/modality-unknown.json": ("/modality", "enum", None),
    "spec/unknown-field.json": ("", "additionalProperties", "agent_id"),
    # The work-order platform block may carry the carrier only. Model and speech choices
    # belong to the pinned persona version and are refused here.
    "spec/platform-block-unknown.json": (
        "/platform",
        "additionalProperties",
        "model",
    ),
    "spec/phone-carrier-missing.json": ("", "required", "platform"),
    # The three authored values move together, so each one's absence is a
    # fixture of its own rather than a case only the other side of the wire
    # exercises in a clone-and-delete test.
    "spec/persona-missing-name.json": (
        "/persona",
        "required",
        "name",
    ),
    "spec/persona-missing-language.json": (
        "/persona",
        "required",
        "language",
    ),
    "spec/persona-technical-voice.json": (
        "/persona",
        "additionalProperties",
        "voice",
    ),
    # The persona block the contract carried until v5: authored behavior in a
    # `traits` wrapper, with an accent and a background noise nobody ran. The
    # whole shape is refused at the wrapper, which is what makes the flat
    # block the only one there is rather than the one this process prefers.
    "spec/persona-traits-wrapper.json": (
        "/persona",
        "additionalProperties",
        "traits",
    ),
    # A work order in the version before this one. There is no tolerance for
    # it here: the version is a `const`, so the old number is a refusal and
    # not a branch.
    "spec/wrong-contract-version.json": ("/contract_version", "const", None),
    "spec/voice-missing-stt-key.json": (
        "/models/stt",
        "required",
        "key",
    ),
    "report/completed-claiming-never-ran.json": (
        "/events/0/facts/ending",
        "enum",
        None,
    ),
    "report/completed-without-facts.json": ("/events/0", "required", "facts"),
    "report/credentials-echoed.json": ("", "additionalProperties", "connection"),
    "report/failed-without-reason.json": ("/events/0/reason", "type", None),
    "report/running-with-facts.json": ("/events/0", "additionalProperties", "facts"),
    # The three kinds this direction used to carry. A conversation's record
    # is its spans now, so a report claiming to carry one is refused at the
    # same place any other unknown kind is — which is what makes the
    # retirement a fact of the contract rather than a habit of this process.
    "report/timing-event-retired.json": ("/events/0/kind", "const", None),
    "report/tool-call-event-retired.json": ("/events/0/kind", "const", None),
    "report/turn-event-retired.json": ("/events/0/kind", "const", None),
    "report/unknown-event-kind.json": ("/events/0/kind", "const", None),
}


def flattened(errors: list[ValidationError]) -> list[ValidationError]:
    flat: list[ValidationError] = []
    for error in errors:
        if error.context:
            flat.extend(flattened(error.context))
        else:
            flat.append(error)
    return flat


def place_of(error: ValidationError) -> str:
    return "".join(f"/{part}" for part in error.absolute_path)


def test_each_schema_compiles_and_pins_its_contract_version():
    assert spec_validator().schema["properties"]["contract_version"]["const"] == 5
    assert report_validator().schema["properties"]["contract_version"]["const"] == 1
    assert spec_validator().schema["$id"] == "urn:egma:simulation-contract:spec:v5"
    assert report_validator().schema["$id"] == "urn:egma:simulation-contract:report:v1"


def test_this_simulator_reads_one_version_and_refuses_the_one_before_it():
    """One contract version, and no tolerance for its predecessor.

    The version the claim client advertises is read out of the schema this
    process validates with, so a claim can never ask for a version the
    parser does not implement. A work order in the version before it is
    refused as a document — there is no branch that would read it.
    """
    document = read_json(
        contract_dir() / "fixtures" / "spec" / "valid" / "chat-retell.json"
    )
    assert document["contract_version"] == spec_contract_version() == 5

    with pytest.raises(ContractViolation) as refusal:
        SimulationSpec.from_document({**document, "contract_version": 4})
    assert any(
        complaint.startswith("/contract_version")
        for complaint in refusal.value.complaints
    ), refusal.value.complaints


def test_a_persona_value_of_only_whitespace_is_refused_by_this_engine_too():
    """The one keyword whose meaning could differ between the two readers.

    ``pattern`` is checked by Ajv's ECMA-262 engine where the control plane
    builds a work order, and by Python's ``re`` here. A blank name that one
    engine refused and the other accepted is exactly the silent drift these
    shared schemas exist to prevent, so the refusal is asserted on this side
    as well: such a name is present by the letter and absent by the reading,
    and it would put "Your name is  ." in the prompt.
    """
    document = read_json(
        contract_dir() / "fixtures" / "spec" / "valid" / "chat-retell.json"
    )
    persona = document["persona"]

    for field in ("name", "personality", "language"):
        for blank in (" ", "   ", "\t", "\n", " \t\n "):
            with pytest.raises(ContractViolation) as refusal:
                SimulationSpec.from_document(
                    {**document, "persona": {**persona, field: blank}}
                )
            assert any(
                complaint.startswith(f"/persona/{field}")
                for complaint in refusal.value.complaints
            ), (field, blank, refusal.value.complaints)

        # The rule stops exactly there: whitespace around real content is the
        # author's own spacing, not an empty field. The wire refuses what says
        # nothing and does not tidy what somebody wrote.
        padded = f" {persona[field]} "
        validate_spec({**document, "persona": {**persona, field: padded}})


def test_phone_connection_stays_phone_while_models_select_voice_legs():
    document = read_json(
        contract_dir()
        / "fixtures"
        / "spec"
        / "valid"
        / "voice-phone-platform-configured.json"
    )

    spec = SimulationSpec.from_document(document)

    assert spec.connection_type == "phone_number"
    assert spec.models.stt.provider == "deepgram"
    assert spec.models.tts.provider == "cartesia"
    assert spec.models.tts.voice_id == "brisk-tenor-7"


@pytest.mark.parametrize("direction", ["spec", "report"])
def test_every_valid_golden_fixture_validates(direction: str):
    fixtures = fixtures_under(direction, "valid")
    assert fixtures, f"no valid {direction} fixtures found"
    for _name, document in fixtures:
        VALIDATE[direction](document)  # raises ContractViolation on drift


@pytest.mark.parametrize("direction", ["spec", "report"])
def test_every_invalid_fixture_is_rejected_at_the_place_it_is_wrong(direction: str):
    fixtures = fixtures_under(direction, "invalid")

    # The pin holds both ways: the fixture set and the expectation map name
    # exactly the same files, so coverage cannot silently shrink.
    expected = sorted(
        name.split("/", 1)[1]
        for name in EXPECTED_REJECTION
        if name.startswith(f"{direction}/")
    )
    assert [name for name, _ in fixtures] == expected

    for name, document in fixtures:
        place, keyword, named_property = EXPECTED_REJECTION[f"{direction}/{name}"]

        errors = flattened(list(VALIDATORS[direction]().iter_errors(document)))
        assert errors, f"{name} was accepted"

        decisive = [
            error
            for error in errors
            if place_of(error) == place
            and error.validator == keyword
            and (named_property is None or f"'{named_property}'" in error.message)
        ]
        assert decisive, (
            f"{name}: no {keyword} error at {place!r}; the errors were: "
            + "; ".join(f"{place_of(error)}: {error.message}" for error in errors)
        )


def test_the_report_schema_rejects_the_specs_credentials_wherever_they_ride():
    """The structural ban, exercised from the Python side too."""
    spec = read_json(
        contract_dir() / "fixtures" / "spec" / "valid" / "chat-retell.json"
    )
    connection = spec["connection"]
    assert connection["credentials"]

    carried = read_json(
        contract_dir() / "fixtures" / "report" / "valid" / "completed-chat.json"
    )

    smuggled = [
        {**carried, "connection": connection},
        {**carried, "credentials": connection["credentials"]},
        {
            **carried,
            "events": [
                {**event, "credentials": connection["credentials"]}
                for event in carried["events"]
            ],
        },
        {
            **carried,
            "events": [
                event
                if "facts" not in event
                else {
                    **event,
                    "facts": {
                        **event["facts"],
                        "credentials": connection["credentials"],
                    },
                }
                for event in carried["events"]
            ],
        },
    ]

    for index, document in enumerate(smuggled):
        with pytest.raises(ContractViolation) as refusal:
            validate_report(document)
        assert any(
            "Additional properties are not allowed" in complaint
            for complaint in refusal.value.complaints
        ), f"variant {index}: {refusal.value.complaints}"


def test_the_golden_fixtures_cover_what_the_simulator_must_speak():
    """Both modalities inbound; the lifecycle and nothing else outbound."""
    modalities = {
        document["modality"] for _, document in fixtures_under("spec", "valid")
    }
    assert modalities == {"chat", "voice"}

    events = [
        event
        for _, document in fixtures_under("report", "valid")
        for event in document["events"]
    ]
    # One kind, and this is the assertion that says so: the report direction
    # carries the lifecycle and nothing else, because a conversation's record
    # is the spans it arrived as.
    assert {event["kind"] for event in events} == {"status"}
    assert {event["status"] for event in events if event["kind"] == "status"} == {
        "running",
        "completed",
        "failed",
        "canceled",
    }
