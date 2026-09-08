from __future__ import annotations

import pytest

from egma_simulator.fleet import (
    FleetMetadataFailure,
    discover_fleet_identity,
    fleet_identity_for,
    fleet_identity_from_document,
)


def test_ecs_task_document_forms_the_full_task_definition_arn():
    identity = fleet_identity_from_document(
        {
            "TaskARN": (
                "arn:aws:ecs:us-east-1:123456789012:task/egma-production/task-id"
            ),
            "Family": "egma-voice",
            "Revision": "17",
        }
    )

    assert identity.document() == {
        "taskArn": "arn:aws:ecs:us-east-1:123456789012:task/egma-production/task-id",
        "taskDefinition": (
            "arn:aws:ecs:us-east-1:123456789012:task-definition/egma-voice:17"
        ),
    }


@pytest.mark.parametrize(
    "document",
    [
        {},
        {"TaskARN": "not-an-arn", "Family": "egma-voice", "Revision": 1},
        {
            "TaskARN": "arn:aws:ecs:us-east-1:123456789012:task/cluster/id",
            "Family": "bad/family",
            "Revision": 1,
        },
        {
            "TaskARN": "arn:aws:ecs:us-east-1:123456789012:task/cluster/id",
            "Family": "egma-voice",
            "Revision": True,
        },
        {
            "TaskARN": "arn:aws:ecs:us-east-1:123456789012:task/cluster/id",
            "Family": "egma-voice",
            "Revision": "1.5",
        },
    ],
)
def test_malformed_ecs_identity_is_refused(document):
    with pytest.raises(FleetMetadataFailure, match="valid task identity"):
        fleet_identity_from_document(document)


@pytest.mark.parametrize(
    "uri",
    [
        "https://169.254.170.2/v4/task-id",
        "http://example.com/v4/task-id",
        "http://169.254.170.2:8080/v4/task-id",
        "http://169.254.170.2:bad/v4/task-id",
        "http://169.254.170.2/v4/task-id?redirect=http://example.com",
    ],
)
async def test_metadata_discovery_refuses_every_non_ecs_endpoint(uri):
    with pytest.raises(FleetMetadataFailure, match="local ECS endpoint"):
        await discover_fleet_identity(uri)


async def test_non_ecs_and_persistent_processes_do_not_read_metadata():
    assert await fleet_identity_for("one-shot", None) is None
    assert await fleet_identity_for("standby", None) is None
    assert await fleet_identity_for("persistent", "http://example.com/not-ecs") is None
