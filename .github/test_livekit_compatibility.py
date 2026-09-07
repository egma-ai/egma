"""A concurrent version failure must fail the job without losing other results."""

import contextlib
import io
import os
import sys
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from livekit_compatibility import parallel_checks, run


class CompatibilityTests(unittest.TestCase):
    def test_all_versions_finish_and_any_failed_process_fails_the_job(self):
        versions = ("1.5.5", "1.6.4", "1.7.1")
        for failing in (None, "1.6.4"):
            with self.subTest(failing=failing), TemporaryDirectory() as temporary:
                directory = Path(temporary)
                barrier = threading.Barrier(len(versions), timeout=5)

                def check(version, version_dir, log, barrier=barrier, failing=failing):
                    # No version can proceed until all have started. A serial
                    # runner breaks the barrier and cannot pass this test.
                    barrier.wait()
                    run(
                        [
                            sys.executable,
                            "-c",
                            "import sys; print(sys.argv[1]); "
                            "sys.exit(int(sys.argv[2]))",
                            version,
                            str(int(version == failing)),
                        ],
                        log,
                    )

                summary = directory / "summary.md"
                with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}):
                    with contextlib.redirect_stdout(io.StringIO()):
                        passed = parallel_checks(versions, check, directory)
                self.assertEqual(passed, failing is None)
                for version in versions:
                    self.assertIn(
                        version, (directory / version / "check.log").read_text()
                    )
                    status = "FAIL" if version == failing else "PASS"
                    self.assertIn(f"| {version} | {status} |", summary.read_text())


if __name__ == "__main__":
    unittest.main()
