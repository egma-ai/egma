import pathlib
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
CERTIFICATE = ROOT / "certificates" / "supabase-root-2021-ca.crt"
BUILD_WORKFLOW = ROOT / ".github" / "workflows" / "build-platform-images.yml"
TEST_WORKFLOW = ROOT / ".github" / "workflows" / "test.yml"
EXPECTED_CERT_SHA256 = (
    "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7"
)


class PlatformImageContract(unittest.TestCase):
    def test_supabase_root_is_pinned_and_images_do_not_enable_it(self) -> None:
        digest = subprocess.check_output(
            ["shasum", "-a", "256", str(CERTIFICATE)], text=True
        ).split()[0]
        self.assertEqual(digest, EXPECTED_CERT_SHA256)
        for app in ("api", "grader"):
            dockerfile = (ROOT / "apps" / app / "Dockerfile").read_text()
            self.assertIn("COPY certificates/supabase-root-2021-ca.crt", dockerfile)
            self.assertNotIn("ENV NODE_EXTRA_CA_CERTS", dockerfile)

    def test_platform_images_are_main_only_exact_sha_amd64_builds(self) -> None:
        workflow = BUILD_WORKFLOW.read_text()
        self.assertIn("workflow_dispatch:", workflow)
        self.assertNotIn("pull_request:", workflow)
        self.assertIn("matrix:\n        app: [api, grader, simulator]", workflow)
        self.assertIn("--platform linux/amd64", workflow)
        self.assertNotIn("linux/arm64", workflow)
        self.assertNotIn("soci", workflow.lower())
        self.assertIn('image="$REGISTRY/egma/$APP:$RELEASE_SHA"', workflow)

    def test_release_waits_for_snapshot_and_dispatches_its_identity(self) -> None:
        build = BUILD_WORKFLOW.read_text()
        release = TEST_WORKFLOW.read_text()
        self.assertIn("node apps/api/scripts/create-daytona-snapshot.mjs", build)
        self.assertIn("Read the Daytona control token", build)
        self.assertNotIn("secrets.DAYTONA_API_KEY", build)
        self.assertIn("daytona_snapshot_id:$daytona_snapshot_id", release)
        self.assertIn("source_run_id:$run_id", release)


if __name__ == "__main__":
    unittest.main()
