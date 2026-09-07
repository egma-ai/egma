"""Release a package when a main push increases its committed version."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tomllib
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = {
    "cli": {
        "manifest": "apps/cli/package.json",
        "name": "egma-cli",
        "prefix": "cli-v",
    },
    "livekit-js": {
        "manifest": "sdks/livekit-js/package.json",
        "name": "@egma/livekit",
        "prefix": "livekit-js-sdk-v",
    },
    "python": {
        "manifest": "sdks/python/package.json",
        "name": "@egma/sdk-python",
        "prefix": "python-sdk-v",
    },
}


def git(*arguments: str, root: Path = ROOT) -> str:
    return subprocess.check_output(
        ["git", *arguments], cwd=root, text=True, timeout=60
    ).strip()


def stable_version(version: str) -> tuple[int, int, int]:
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version):
        raise ValueError(f"Release version must be major.minor.patch: {version!r}")
    major, minor, patch = map(int, version.split("."))
    return major, minor, patch


def version_at(package_id: str, revision: str, root: Path = ROOT) -> str:
    package = PACKAGES[package_id]
    manifest = json.loads(git("show", f"{revision}:{package['manifest']}", root=root))
    if manifest["name"] != package["name"]:
        raise ValueError(f"Unexpected package name in {package['manifest']}")
    version = manifest["version"]
    stable_version(version)
    if package_id == "python":
        project = tomllib.loads(
            git("show", f"{revision}:sdks/python/pyproject.toml", root=root)
        )["project"]
        if project["name"] != "egma" or project["version"] != version:
            raise ValueError("Python package.json and pyproject.toml must agree")
    return version


def commit_sha(value: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", value) or value == "0" * 40:
        raise ValueError("Release comparison requires an existing commit SHA")
    return value


def planned_version(package_id: str, event: dict, root: Path = ROOT) -> str | None:
    after = commit_sha(event["after"])
    current = version_at(package_id, after, root)
    ref = event["ref"]
    if ref.startswith("refs/tags/"):
        expected = f"refs/tags/{PACKAGES[package_id]['prefix']}{current}"
        if ref != expected:
            raise ValueError(f"Tag {ref} does not match package version {current}")
        return current
    if ref != "refs/heads/main":
        raise ValueError("Automatic package releases only run from main")
    before = commit_sha(event["before"])
    git("merge-base", "--is-ancestor", before, after, root=root)
    previous = version_at(package_id, before, root)
    if stable_version(current) < stable_version(previous):
        raise ValueError(f"{package_id} version decreased from {previous} to {current}")
    return current if current != previous else None


def ensure_tag(tag: str, sha: str, root: Path = ROOT) -> None:
    """Keep a release tag on its original commit, including annotated tags."""
    reference = f"refs/tags/{tag}"

    def remote_commit() -> str | None:
        rows = git("ls-remote", "origin", reference, f"{reference}^{{}}", root=root)
        refs = dict(line.split()[::-1] for line in rows.splitlines())
        return refs.get(f"{reference}^{{}}", refs.get(reference))

    existing = remote_commit()
    if existing is None:
        try:
            git("push", "origin", f"{sha}:{reference}", root=root)
        except subprocess.CalledProcessError:
            # A simultaneous manual tag is acceptable only on this same commit.
            if remote_commit() != sha:
                raise
    elif existing != sha:
        raise ValueError(f"Release tag {tag} already points to {existing}, not {sha}")


def read_json(url: str) -> dict | None:
    try:
        with urlopen(url, timeout=30) as response:
            value = json.load(response)
    except HTTPError as error:
        if error.code == 404:
            return None
        raise
    if not isinstance(value, dict):
        raise ValueError(f"Registry returned invalid metadata: {url}")
    return value


def npm_url(package_id: str, version: str) -> str:
    name = quote(PACKAGES[package_id]["name"], safe="")
    return f"https://registry.npmjs.org/{name}/{quote(version, safe='')}"


def published(package_id: str, version: str) -> bool:
    if package_id == "python":
        metadata = read_json(f"https://pypi.org/pypi/egma/{version}/json")
        if metadata is None:
            return False
        filenames = {entry["filename"] for entry in metadata["urls"]}
        return {
            f"egma-{version}-py3-none-any.whl",
            f"egma-{version}.tar.gz",
        }.issubset(filenames)
    metadata = read_json(npm_url(package_id, version))
    if metadata is None:
        return False
    if (
        metadata["name"] != PACKAGES[package_id]["name"]
        or metadata["version"] != version
    ):
        raise ValueError("Registry returned a different package or version")
    return True


def npm_tag(package_id: str, version: str) -> str:
    """A delayed older release must not move npm's latest tag backwards."""
    latest = read_json(npm_url(package_id, "latest"))
    if (
        latest is not None
        and stable_version(latest["version"]) > stable_version(version)
    ):
        return "previous"
    return "latest"


def prepare(package_id: str, root: Path = ROOT) -> None:
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    version = planned_version(package_id, event, root)
    outputs = {"should_publish": "false", "version": version or "", "npm_tag": ""}
    if version is None:
        summary = f"{package_id}: version unchanged; no release."
    else:
        sha = git("rev-parse", "HEAD", root=root)
        event_commit = git(
            "rev-parse", f"{commit_sha(event['after'])}^{{commit}}", root=root
        )
        if sha != event_commit:
            raise ValueError("Checkout does not match the release event commit")
        tag = f"{PACKAGES[package_id]['prefix']}{version}"
        ensure_tag(tag, sha, root)
        complete = published(package_id, version)
        outputs["should_publish"] = str(not complete).lower()
        if package_id != "python" and not complete:
            outputs["npm_tag"] = npm_tag(package_id, version)
        summary = (
            f"{tag} at {sha}: already published; no duplicate upload."
            if complete
            else f"{tag} at {sha}: package checks and publication will run."
        )
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        for key, value in outputs.items():
            print(f"{key}={value}", file=output)
    print(summary)
    if "GITHUB_STEP_SUMMARY" in os.environ:
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as output:
            print(summary, file=output)


def publish_npm(package_id: str, tarball: Path, root: Path = ROOT) -> None:
    """Refresh registry state even when GitHub reruns only the failed publish job."""
    if package_id == "python":
        raise ValueError("The Python SDK is published to PyPI")
    version = version_at(package_id, "HEAD", root)
    if published(package_id, version):
        print(f"{PACKAGES[package_id]['name']}@{version} is already published")
        return
    subprocess.run(
        ["npm", "publish", "--tag", npm_tag(package_id, version), str(tarball)],
        cwd=root,
        check=True,
        timeout=300,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "publish-npm"])
    parser.add_argument("package", choices=PACKAGES)
    parser.add_argument("tarball", nargs="?", type=Path)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.package)
    elif args.tarball is None:
        parser.error("publish-npm requires a tarball")
    else:
        publish_npm(args.package, args.tarball)
