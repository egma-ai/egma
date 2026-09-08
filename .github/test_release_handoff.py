import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parent
TESTS = (ROOT / "workflows" / "test.yml").read_text()
IMAGES = (ROOT / "workflows" / "build-platform-images.yml").read_text()


class ReleaseHandoffTest(unittest.TestCase):
    def test_public_release_has_one_cloud_writer_and_exact_identity_gate(self) -> None:
        self.assertNotIn("aws ssm send-command", TESTS)
        self.assertNotIn("$image:latest", TESTS)
        self.assertIn('event_type:"public-release"', TESTS)
        self.assertIn('.releaseSha == $sha', TESTS)
        self.assertLess(
            TESTS.index("Wait for this exact release identity"),
            TESTS.index("Tell Vercel to ship"),
        )

    def test_build_only_dispatch_publishes_the_requested_immutable_sha(self) -> None:
        self.assertIn("public_sha:", IMAGES)
        self.assertIn("inputs.public_sha || github.sha", IMAGES)
        self.assertIn(".displayTitle == \\\"$title\\\"", TESTS)
        self.assertIn('RELEASE_SHA: ${{ needs.authorize-publish.outputs.release_sha }}', IMAGES)
        self.assertIn('$repo:$RELEASE_SHA', IMAGES)
        self.assertNotIn('$repo:latest', IMAGES)
        self.assertIn("env.REPLACE_PRODUCTION == 'true'", TESTS)


if __name__ == "__main__":
    unittest.main()
