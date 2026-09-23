"""The Pipecat check covers every minor the extra promises, and no LiveKit."""

import unittest

from pipecat_compatibility import supported_minors, tool_dependencies


class PipecatCompatibilityTests(unittest.TestCase):
    def test_every_minor_of_the_declared_range_is_checked(self):
        self.assertEqual(supported_minors(), ("1.9", "1.10", "1.11"))

    def test_the_check_installs_neither_the_index_egma_nor_livekit(self):
        for requirement in tool_dependencies():
            self.assertFalse(requirement.startswith(("egma", "livekit")), requirement)
        self.assertTrue(any(r.startswith("pytest") for r in tool_dependencies()))


if __name__ == "__main__":
    unittest.main()
