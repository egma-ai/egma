"""Read the identity of a hosted one-shot simulator from local ECS metadata."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlparse

import aiohttp

METADATA_TIMEOUT_SECONDS = 2.0
ECS_METADATA_HOST = "169.254.170.2"
TASK_ARN = re.compile(
    r"^arn:(?P<partition>[^:]+):ecs:(?P<region>[^:]+):(?P<account>[0-9]{12}):task/.+$"
)
FAMILY = re.compile(r"^[A-Za-z0-9_-]+$")


class FleetMetadataFailure(RuntimeError):
    """The hosted task could not establish the identity used for retirement."""


@dataclass(frozen=True)
class FleetIdentity:
    task_arn: str
    task_definition: str

    def document(self) -> dict[str, str]:
        return {"taskArn": self.task_arn, "taskDefinition": self.task_definition}


async def discover_fleet_identity(metadata_uri: str) -> FleetIdentity:
    """Fetch one task document from the link-local ECS metadata endpoint."""
    parsed = urlparse(metadata_uri)
    try:
        port = parsed.port
    except ValueError as error:
        raise FleetMetadataFailure(
            "ECS task metadata URI is not the local ECS endpoint"
        ) from error
    if (
        parsed.scheme != "http"
        or parsed.hostname != ECS_METADATA_HOST
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise FleetMetadataFailure(
            "ECS task metadata URI is not the local ECS endpoint"
        )

    url = metadata_uri.rstrip("/") + "/task"
    try:
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=METADATA_TIMEOUT_SECONDS)
        ) as session:
            async with session.get(url, allow_redirects=False) as response:
                if response.status != 200:
                    raise FleetMetadataFailure(
                        f"ECS task metadata answered HTTP {response.status}"
                    )
                body = await response.json()
    except FleetMetadataFailure:
        raise
    except (aiohttp.ClientError, TimeoutError, ValueError) as error:
        raise FleetMetadataFailure(
            f"ECS task metadata could not be read: {type(error).__name__}"
        ) from error

    return fleet_identity_from_document(body)


async def fleet_identity_for(
    mode: str, metadata_uri: str | None
) -> FleetIdentity | None:
    """Discover identity only for hosted processes that claim one voice job."""
    if mode not in ("one-shot", "standby") or metadata_uri is None:
        return None
    return await discover_fleet_identity(metadata_uri)


def fleet_identity_from_document(body: object) -> FleetIdentity:
    """Validate the task identity returned by ECS metadata."""
    if not isinstance(body, dict):
        raise FleetMetadataFailure("ECS task metadata was not an object")
    task_arn = body.get("TaskARN")
    family = body.get("Family")
    raw_revision = body.get("Revision")
    if (
        isinstance(raw_revision, str)
        and raw_revision.isascii()
        and raw_revision.isdigit()
    ):
        revision = int(raw_revision)
    elif isinstance(raw_revision, int) and not isinstance(raw_revision, bool):
        revision = raw_revision
    else:
        revision = None
    match = TASK_ARN.fullmatch(task_arn) if isinstance(task_arn, str) else None
    if (
        match is None
        or not isinstance(family, str)
        or FAMILY.fullmatch(family) is None
        or revision is None
        or revision < 1
    ):
        raise FleetMetadataFailure("ECS task metadata has no valid task identity")

    task_definition = (
        f"arn:{match['partition']}:ecs:{match['region']}:{match['account']}:"
        f"task-definition/{family}:{revision}"
    )
    return FleetIdentity(task_arn=task_arn, task_definition=task_definition)
