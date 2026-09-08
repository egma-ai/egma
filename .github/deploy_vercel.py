#!/usr/bin/env python3
"""Deploy one reviewed Git commit to Vercel production and wait for it."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request

TERMINAL_FAILURES = {"ERROR", "CANCELED"}


def request(method: str, url: str, token: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    call = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(call, timeout=30) as response:
        return json.load(response)


def source_sha(deployment: dict) -> str | None:
    source = deployment.get("gitSource") or {}
    metadata = deployment.get("meta") or {}
    source_value = source.get("sha") if isinstance(source, dict) else None
    metadata_value = (
        metadata.get("githubCommitSha") if isinstance(metadata, dict) else None
    )
    return source_value or metadata_value


def deploy(
    token: str, team: str, project: str, repository: str, sha: str, fetch=request
) -> str:
    project_details = fetch(
        "GET",
        f"https://api.vercel.com/v9/projects/{urllib.parse.quote(project)}?teamId={urllib.parse.quote(team)}",
        token,
    )
    if project_details.get("id") != project:
        raise ValueError("Vercel token cannot access the configured project")
    query = urllib.parse.urlencode({"teamId": team, "forceNew": "1"})
    created = fetch(
        "POST",
        f"https://api.vercel.com/v13/deployments?{query}",
        token,
        {
            "name": "egma-web",
            "project": project,
            "gitSource": {
                "type": "github",
                "repoId": int(repository),
                "ref": sha,
                "sha": sha,
            },
            "target": "production",
        },
    )
    deployment_id = created.get("id")
    if not isinstance(deployment_id, str) or not deployment_id:
        raise ValueError("Vercel did not return a deployment ID")
    for _ in range(180):
        current = fetch(
            "GET",
            f"https://api.vercel.com/v13/deployments/{deployment_id}?teamId={urllib.parse.quote(team)}",
            token,
        )
        state = current.get("readyState")
        if state == "READY":
            if current.get("target") != "production" or source_sha(current) != sha:
                raise ValueError(
                    "Vercel completed a deployment for another target or commit"
                )
            return deployment_id
        if state in TERMINAL_FAILURES:
            raise ValueError(f"Vercel deployment ended in {state}")
        time.sleep(10)
    raise TimeoutError("Vercel deployment did not finish within 30 minutes")


def main() -> int:
    required = (
        "VERCEL_TOKEN",
        "VERCEL_ORG_ID",
        "VERCEL_PROJECT_ID",
        "VERCEL_GITHUB_REPO_ID",
        "GITHUB_SHA",
    )
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        print(
            f"Missing Vercel deployment settings: {' '.join(missing)}", file=sys.stderr
        )
        return 2
    try:
        deployment_id = deploy(*(os.environ[name] for name in required))
    except (OSError, TimeoutError, ValueError) as error:
        print(f"Vercel production deployment failed: {error}", file=sys.stderr)
        return 1
    sha = os.environ["GITHUB_SHA"]
    print(f"Vercel production deployment {deployment_id} is READY for {sha}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
