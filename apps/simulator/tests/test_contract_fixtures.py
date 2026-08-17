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
    SUPPORTED_SPEC_VERSIONS,
    ContractViolation,
    contract_dir,
    report_validator,
    spec_validator,
    validate_report,
    validate_spec,
)

# `spec` is the version-1 spec direction and `spec-v2` the version-2 one. They
# are two folders because they are two closed documents: a version-2 document
# is not a version-1 document with an extra field, it is a different contract,
# and a folder mixing them would be checked against whichever schema the loop
# happened to be holding.
DIRECTIONS = ["spec", "spec-v2", "report"]

VALIDATORS = {
    "spec": lambda: spec_validator(1),
    "spec-v2": lambda: spec_validator(2),
    "report": report_validator,
}
VALIDATE = {
    "spec": validate_spec,
    "spec-v2": validate_spec,
    "report": validate_report,
}


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
    "spec/limits-missing.json": ("", "required", "limits"),
    "spec/mock-tool-answering-two-ways.json": (
        "/mock_tools/0/answer",
        "additionalProperties",
        "error",
    ),
    "spec/modality-unknown.json": ("/modality", "enum", None),
    "spec/unknown-field.json": ("", "additionalProperties", "agent_id"),
    # The platform's own settings are a closed list on both sides — the
    # catalog the control plane stores them under, and the block this
    # process reads. A field nobody writes is a setting nobody reads.
    "spec/platform-setting-unknown.json": (
        "/platform/model",
        "additionalProperties",
        "base_url",
    ),
    "spec/wrong-contract-version.json": ("/contract_version", "const", None),
    # The mixed-rollout guard, as a document. A version-1 document carrying
    # version 2's `models` block is exactly what a control plane that got the
    # negotiation wrong would emit, and the failure it would cause is the quiet
    # one: a worker that ignored the unknown block would conduct the simulation
    # with its deployment's own model settings while the control plane believed
    # it had sent the persona's. The version-1 schema closes its top level, so
    # the block is refused loudly here rather than dropped silently there.
    "spec/models-on-the-old-contract.json": ("", "additionalProperties", "models"),
    "spec-v2/models-missing.json": ("", "required", "models"),
    "spec-v2/customer-owned-without-a-key.json": ("/models/stt", "required", "key"),
    "spec-v2/models-carrying-a-credential-id.json": (
        "/models",
        "additionalProperties",
        "credential_id",
    ),
    "spec-v2/speaking-faster-than-a-voice-goes.json": (
        "/models/tts/speed",
        "maximum",
        None,
    ),
    # A chat simulation has no mouth and no ears, so a speech key on its wire
    # is a secret travelling for nothing.
    "spec-v2/chat-carrying-a-speech-key.json": ("/models/stt", "not", None),
    # Egma's provider credentials stay inside the Egma model gateway, so a
    # managed work order carrying one is refused before this worker ever holds
    # it — and managed access with no gateway is a work order with nowhere for
    # the traffic to go, which must not arrive as a leg quietly calling a
    # provider directly. Customer-owned with a gateway block is the mirror: Egma
    # is off the model traffic path there, so the address and the credential are
    # two things nothing would use and one of them is a credential.
    "spec-v2/managed-carrying-a-provider-key.json": (
        "/models/llm",
        "additionalProperties",
        "key",
    ),
    "spec-v2/managed-without-a-gateway.json": ("/models", "required", "gateway"),
    "spec-v2/customer-owned-carrying-a-gateway.json": (
        "/models",
        "additionalProperties",
        "gateway",
    ),
    # A version-2 document is one whose persona selected its own models, and
    # those selections carry the credentials that authorize every leg — so the
    # deployment's own model and speech settings beside them would be three
    # more provider keys on the wire with nothing to spend them on.
    "spec-v2/platform-carrying-model-settings.json": (
        "/platform",
        "additionalProperties",
        "model",
    ),
    "spec-v2/platform-carrying-speech-settings.json": (
        "/platform",
        "additionalProperties",
        "speech",
    ),
    "spec-v2/unknown-field.json": ("", "additionalProperties", "agent_id"),
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


def test_every_schema_pins_the_version_it_claims_to_be():
    pinned = {
        "spec": 1,
        "spec-v2": 2,
        "report": 1,
    }
    for direction, validator in VALIDATORS.items():
        compiled = validator()
        assert (
            compiled.schema["properties"]["contract_version"]["const"]
            == pinned[direction]
        ), direction

    assert spec_validator(1).schema["$id"] == "urn:egma:simulation-contract:spec:v1"
    assert spec_validator(2).schema["$id"] == "urn:egma:simulation-contract:spec:v2"
    assert (
        report_validator().schema["$id"] == "urn:egma:simulation-contract:report:v1"
    )


def test_a_version_this_simulator_does_not_implement_is_refused_by_its_version():
    """The other half of the mixed-rollout rule, from this side of the wire.

    A worker handed a document numbered higher than it implements must say
    so rather than read it against the newest contract it happens to hold.
    Reading it that way is how a block this process does not understand gets
    dropped in silence, and a simulation conducted with silently dropped
    model selections is worse than one that was refused.
    """
    ahead = read_json(
        contract_dir() / "fixtures" / "spec-v2" / "valid" / "voice-customer-owned.json"
    )
    ahead["contract_version"] = max(SUPPORTED_SPEC_VERSIONS) + 1

    with pytest.raises(ContractViolation) as refusal:
        validate_spec(ahead)

    assert refusal.value.complaints == [
        "/contract_version: must be one of "
        + ", ".join(str(known) for known in SUPPORTED_SPEC_VERSIONS)
        + f", and this document says {ahead['contract_version']!r}"
    ]


@pytest.mark.parametrize("direction", DIRECTIONS)
def test_every_valid_golden_fixture_validates(direction: str):
    fixtures = fixtures_under(direction, "valid")
    assert fixtures, f"no valid {direction} fixtures found"
    for _name, document in fixtures:
        VALIDATE[direction](document)  # raises ContractViolation on drift


@pytest.mark.parametrize("direction", DIRECTIONS)
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

        errors = flattened(
            list(VALIDATORS[direction]().iter_errors(document))
        )
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
    for direction in ("spec", "spec-v2"):
        modalities = {
            document["modality"] for _, document in fixtures_under(direction, "valid")
        }
        assert modalities == {"chat", "voice"}, direction

    # Both access modes are golden documents, so the shape managed access will
    # arrive in is pinned before anything emits one.
    assert {
        document["models"]["access"]
        for _, document in fixtures_under("spec-v2", "valid")
    } == {"managed", "customer-owned"}

    events = [
        event
        for _, document in fixtures_under("report", "valid")
        for event in document["events"]
    ]
    # One kind, and this is the assertion that says so: the report direction
    # carries the lifecycle and nothing else, because a conversation's record
    # is the spans it arrived as.
    assert {event["kind"] for event in events} == {"status"}
    assert {
        event["status"] for event in events if event["kind"] == "status"
    } == {"running", "completed", "failed", "canceled"}
