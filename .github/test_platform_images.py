import pathlib
import subprocess
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "build-platform-images.yml"
CERTIFICATE = ROOT / "certificates" / "supabase-root-2021-ca.crt"
EXPECTED_CERT_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7"


class PlatformImageContract(unittest.TestCase):
    def test_builds_each_image_on_native_amd64_and_arm64_runners(self) -> None:
        text = WORKFLOW.read_text()
        for app in ("api", "grader", "simulator"):
            self.assertEqual(text.count(f"- app: {app}"), 4)
        self.assertEqual(text.count("runner: ubuntu-latest"), 6)
        self.assertEqual(text.count("runner: ubuntu-24.04-arm"), 6)
        self.assertIn("docker build --pull", text)
        self.assertIn('image="$REGISTRY/egma/$APP:$GITHUB_SHA-$ARCH"', text)

    def test_pull_requests_build_without_aws_and_publication_requires_main(self) -> None:
        text = WORKFLOW.read_text()
        validate = text[text.index("  validate:") : text.index("  authorize-publish:")]
        self.assertIn("github.event_name == 'pull_request'", validate)
        self.assertIn("Build without publishing", validate)
        self.assertNotIn("configure-aws-credentials", validate)
        self.assertIn('test "$GITHUB_REF" = refs/heads/main', text)

    def test_publishes_and_checks_soci_v2_after_multi_arch_assembly(self) -> None:
        text = WORKFLOW.read_text()
        self.assertIn("soci convert --standalone", text)
        self.assertIn("application/vnd.amazon.soci.index.v2+json", text)
        self.assertIn('["linux/amd64", "linux/arm64"]', text)
        self.assertNotIn("$repo:latest", text)

    def test_supabase_root_is_pinned_and_only_cloud_opts_in(self) -> None:
        digest = subprocess.check_output(
            ["shasum", "-a", "256", str(CERTIFICATE)], text=True
        ).split()[0]
        self.assertEqual(digest, EXPECTED_CERT_SHA256)
        for app in ("api", "grader"):
            dockerfile = (ROOT / "apps" / app / "Dockerfile").read_text()
            self.assertIn("COPY certificates/supabase-root-2021-ca.crt", dockerfile)
            self.assertNotIn("ENV NODE_EXTRA_CA_CERTS", dockerfile)


if __name__ == "__main__":
    unittest.main()
