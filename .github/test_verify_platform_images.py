import importlib.util
import hashlib
import json
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("verify-platform-images.py")
SPEC = importlib.util.spec_from_file_location("verify_platform_images", MODULE_PATH)
assert SPEC and SPEC.loader
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)
FIXTURES = pathlib.Path(__file__).with_name("fixtures")


class PlatformImageVerifierTest(unittest.TestCase):
    def setUp(self) -> None:
        self.index = json.loads((FIXTURES / "simulator-soci-manifest.json").read_text())
        responses = json.loads((FIXTURES / "simulator-soci-children-response.json").read_text())
        responses["images"] += json.loads(
            (FIXTURES / "simulator-image-children-response.json").read_text()
        )["images"]
        self.children = {
            image["imageId"]["imageDigest"]: image["imageManifest"]
            for image in responses["images"]
        }

    def verify(self, index=None, children=None) -> None:
        VERIFY.verify_simulator_index(
            self.index if index is None else index,
            (self.children if children is None else children).__getitem__,
        )

    def test_accepts_actual_soci_v2_manifest_shape(self) -> None:
        self.verify()

    def test_rejects_missing_extra_and_duplicate_descriptors(self) -> None:
        for manifests in (
            self.index["manifests"][:-1],
            self.index["manifests"] + [self.index["manifests"][0]],
            self.index["manifests"][:-1] + [self.index["manifests"][0]],
        ):
            with self.subTest(count=len(manifests)), self.assertRaises(ValueError):
                self.verify({**self.index, "manifests": manifests})

    def test_rejects_wrong_platform_and_cross_links(self) -> None:
        wrong_platform = json.loads(json.dumps(self.index))
        wrong_platform["manifests"][0]["platform"]["architecture"] = "s390x"
        with self.assertRaises(ValueError):
            self.verify(wrong_platform)
        wrong_link = json.loads(json.dumps(self.index))
        wrong_link["manifests"][0]["annotations"][VERIFY.INDEX_DIGEST] = "sha256:" + "0" * 64
        with self.assertRaises(ValueError):
            self.verify(wrong_link)

    def test_rejects_wrong_child_type_and_digest(self) -> None:
        soci_digest = self.index["manifests"][2]["digest"]
        wrong_type = json.loads(self.children[soci_digest])
        wrong_type["config"]["mediaType"] = VERIFY.OCI_CONFIG
        raw = json.dumps(wrong_type, separators=(",", ":"))
        digest = "sha256:" + hashlib.sha256(raw.encode()).hexdigest()
        with self.assertRaisesRegex(ValueError, "wrong config media type"):
            VERIFY.verify_child(raw, digest, VERIFY.SOCI_V2, None)
        children = {**self.children, soci_digest: self.children[soci_digest] + " "}
        with self.assertRaises(ValueError):
            self.verify(children=children)

    def test_plain_images_require_exact_native_platforms(self) -> None:
        plain = {
            "schemaVersion": 2,
            "mediaType": VERIFY.OCI_INDEX,
            "manifests": [
                {"mediaType": VERIFY.OCI_MANIFEST, "digest": "sha256:" + str(i) * 64,
                 "platform": {"os": "linux", "architecture": arch}}
                for i, arch in ((1, "amd64"), (2, "arm64"))
            ],
        }
        VERIFY.verify_native_index(plain)
        plain["manifests"].append(plain["manifests"][0])
        with self.assertRaises(ValueError):
            VERIFY.verify_native_index(plain)

    def test_accepts_actual_docker_manifest_lists(self) -> None:
        for name in ("api-ecr-response.json", "grader-ecr-response.json"):
            response = json.loads((FIXTURES / name).read_text())
            VERIFY.verify_native_index(json.loads(response["images"][0]["imageManifest"]))


if __name__ == "__main__":
    unittest.main()
