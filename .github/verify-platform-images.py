#!/usr/bin/env python3
"""Verify published native images and the simulator's SOCI v2 indexes."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys

OCI_INDEX = "application/vnd.oci.image.index.v1+json"
OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
DOCKER_INDEX = "application/vnd.docker.distribution.manifest.list.v2+json"
DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json"
OCI_CONFIG = "application/vnd.oci.image.config.v1+json"
SOCI_V2 = "application/vnd.amazon.soci.index.v2+json"
INDEX_DIGEST = "com.amazon.soci.index-digest"
IMAGE_DIGEST = "com.amazon.soci.image-manifest-digest"
PLATFORMS = {"linux/amd64", "linux/arm64"}
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")


def fail(message: str) -> None:
    raise ValueError(message)


def platform(descriptor: dict) -> str:
    value = descriptor.get("platform")
    if not isinstance(value, dict):
        fail("descriptor has no platform")
    os_name = value.get("os")
    architecture = value.get("architecture")
    if not isinstance(os_name, str) or not isinstance(architecture, str):
        fail("descriptor has an incomplete platform")
    return f"{os_name}/{architecture}"


def descriptor_digest(descriptor: dict) -> str:
    value = descriptor.get("digest")
    if not isinstance(value, str) or not DIGEST.fullmatch(value):
        fail("descriptor has an invalid digest")
    return value


def parse_manifest(raw: str, expected_digest: str | None = None) -> dict:
    if expected_digest is not None:
        actual = "sha256:" + hashlib.sha256(raw.encode()).hexdigest()
        if actual != expected_digest:
            fail(f"manifest digest mismatch: expected {expected_digest}, got {actual}")
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get("schemaVersion") != 2:
        fail("manifest is not schema version 2")
    return value


def native_descriptors(index: dict) -> dict[str, dict]:
    index_type = index.get("mediaType")
    child_type = {
        OCI_INDEX: OCI_MANIFEST,
        DOCKER_INDEX: DOCKER_MANIFEST,
    }.get(index_type)
    if child_type is None:
        fail("tag does not contain a supported multi-platform image index")
    descriptors = index.get("manifests")
    if not isinstance(descriptors, list):
        fail("image index has no descriptor list")
    result: dict[str, dict] = {}
    for descriptor in descriptors:
        if not isinstance(descriptor, dict):
            fail("image index contains a non-object descriptor")
        name = platform(descriptor)
        if name in result:
            fail(f"duplicate descriptor for {name}")
        if descriptor.get("mediaType") != child_type:
            fail(f"unexpected descriptor media type for {name}")
        descriptor_digest(descriptor)
        result[name] = descriptor
    return result


def verify_native_index(index: dict) -> None:
    descriptors = native_descriptors(index)
    if set(descriptors) != PLATFORMS:
        fail("native image index must contain exactly linux/amd64 and linux/arm64")


def verify_child(
    raw: str, digest: str, expected_config: str, index_digest: str | None
) -> None:
    child = parse_manifest(raw, digest)
    if child.get("mediaType") != OCI_MANIFEST:
        fail("child is not an OCI image manifest")
    config = child.get("config")
    if not isinstance(config, dict) or config.get("mediaType") != expected_config:
        fail(f"child has the wrong config media type for {digest}")
    annotations = child.get("annotations") or {}
    if not isinstance(annotations, dict):
        fail("child annotations are not an object")
    if index_digest is not None and annotations.get(INDEX_DIGEST) != index_digest:
        fail("native child does not point to its SOCI index")


def verify_simulator_index(index: dict, fetch_child) -> None:
    if index.get("mediaType") != OCI_INDEX:
        fail("tag does not contain an OCI image index")
    descriptors = index.get("manifests")
    if not isinstance(descriptors, list) or len(descriptors) != 4:
        fail("simulator index must contain exactly four descriptors")

    images: dict[str, dict] = {}
    soci: dict[str, dict] = {}
    for descriptor in descriptors:
        if not isinstance(descriptor, dict):
            fail("simulator index contains a non-object descriptor")
        name = platform(descriptor)
        if descriptor.get("mediaType") != OCI_MANIFEST:
            fail(f"unexpected descriptor media type for {name}")
        descriptor_digest(descriptor)
        annotations = descriptor.get("annotations")
        if not isinstance(annotations, dict):
            fail(f"simulator descriptor for {name} has invalid annotations")
        has_index = INDEX_DIGEST in annotations
        has_image = IMAGE_DIGEST in annotations
        if has_index == has_image:
            fail(
                f"simulator descriptor for {name} must have exactly one SOCI cross-link"
            )
        if has_index:
            target = images
            linked = annotations[INDEX_DIGEST]
        elif IMAGE_DIGEST in annotations:
            target = soci
            linked = annotations[IMAGE_DIGEST]
        else:
            fail(f"simulator descriptor for {name} has no SOCI cross-link")
        if name in target:
            fail(f"duplicate simulator descriptor for {name}")
        if not isinstance(linked, str) or not DIGEST.fullmatch(linked):
            fail(f"simulator descriptor for {name} has an invalid cross-link")
        target[name] = descriptor

    if set(images) != PLATFORMS or set(soci) != PLATFORMS:
        fail("simulator must contain one image and one SOCI index for each platform")
    for name in PLATFORMS:
        image_digest = descriptor_digest(images[name])
        soci_digest = descriptor_digest(soci[name])
        if images[name]["annotations"][INDEX_DIGEST] != soci_digest:
            fail(f"image-to-SOCI cross-link is wrong for {name}")
        if soci[name]["annotations"][IMAGE_DIGEST] != image_digest:
            fail(f"SOCI-to-image cross-link is wrong for {name}")
        verify_child(fetch_child(image_digest), image_digest, OCI_CONFIG, soci_digest)
        verify_child(fetch_child(soci_digest), soci_digest, SOCI_V2, None)


def ecr_manifest(repository: str, image_id: str) -> tuple[str, str]:
    key = "imageDigest" if image_id.startswith("sha256:") else "imageTag"
    command = [
        "aws", "ecr", "batch-get-image", "--repository-name", repository,
        "--image-ids", f"{key}={image_id}", "--output", "json",
    ]
    response = json.loads(subprocess.check_output(command, text=True))
    images = response.get("images")
    failures = response.get("failures")
    if not isinstance(images, list) or len(images) != 1 or failures != []:
        fail(f"ECR returned an ambiguous result for {repository}:{image_id}")
    image = images[0]
    raw = image.get("imageManifest")
    digest = (image.get("imageId") or {}).get("imageDigest")
    if not isinstance(raw, str) or not isinstance(digest, str):
        fail(f"ECR omitted manifest data for {repository}:{image_id}")
    return raw, digest


def main() -> int:
    if len(sys.argv) != 2 or not re.fullmatch(r"[0-9a-f]{40}", sys.argv[1]):
        print(
            "usage: verify-platform-images.py <40-character release SHA>",
            file=sys.stderr,
        )
        return 2
    release_sha = sys.argv[1]
    try:
        for app in ("api", "grader", "simulator"):
            repository = f"egma/{app}"
            raw, digest = ecr_manifest(repository, release_sha)
            index = parse_manifest(raw, digest)
            if app == "simulator":
                verify_simulator_index(
                    index,
                    lambda child, repository=repository: ecr_manifest(
                        repository, child
                    )[0],
                )
            else:
                verify_native_index(index)
            print(f"{app}:{release_sha} digest {digest} passed manifest verification.")
        print(f"simulator:{release_sha} contains two cross-linked SOCI v2 indexes.")
    except (json.JSONDecodeError, subprocess.CalledProcessError, ValueError) as error:
        print(f"Platform image verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
