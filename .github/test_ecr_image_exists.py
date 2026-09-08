import json
import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("ecr-image-exists.sh")


class EcrImageExistenceTest(unittest.TestCase):
    def probe(self, response, status=0):
        with tempfile.TemporaryDirectory() as directory:
            aws = pathlib.Path(directory) / "aws"
            aws.write_text(
                '#!/bin/sh\nprintf "%s\\n" "$FAKE_ECR_RESPONSE"\n'
                'exit "$FAKE_ECR_STATUS"\n'
            )
            aws.chmod(0o755)
            return subprocess.run(
                ["bash", str(SCRIPT), "egma/simulator", "release"],
                env={
                    **os.environ,
                    "PATH": f"{directory}:{os.environ['PATH']}",
                    "FAKE_ECR_RESPONSE": json.dumps(response),
                    "FAKE_ECR_STATUS": str(status),
                },
                capture_output=True,
                text=True,
            ).returncode

    def test_reuses_an_existing_image(self):
        self.assertEqual(self.probe({"images": [{}], "failures": []}), 0)

    def test_only_a_missing_tag_allows_publication(self):
        self.assertEqual(
            self.probe(
                {"images": [], "failures": [{"failureCode": "ImageNotFound"}]}
            ),
            1,
        )

    def test_registry_and_authentication_errors_stop_publication(self):
        self.assertEqual(self.probe({}, status=42), 42)
        self.assertEqual(self.probe({}), 2)
        self.assertEqual(
            self.probe({"images": [], "failures": [{"failureCode": "Denied"}]}),
            2,
        )


if __name__ == "__main__":
    unittest.main()
