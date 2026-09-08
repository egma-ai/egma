import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("deploy_vercel.py")
SPEC = importlib.util.spec_from_file_location("deploy_vercel", SCRIPT)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class VercelDeploymentTest(unittest.TestCase):
    @patch.object(module.time, "sleep")
    def test_waits_for_exact_production_commit(self, _sleep):
        calls = []
        responses = iter([
            {"id": "project"},
            {"id": "dpl_1"},
            {"id": "dpl_1", "readyState": "BUILDING"},
            {"id": "dpl_1", "readyState": "READY", "target": "production", "gitSource": {"sha": "a" * 40}},
        ])

        def fetch(*args):
            calls.append(args)
            return next(responses)

        self.assertEqual(module.deploy("token", "team", "project", "123", "a" * 40, fetch), "dpl_1")
        self.assertEqual(calls[0][0], "GET")
        self.assertEqual(calls[1][3]["gitSource"]["sha"], "a" * 40)

    @patch.object(module.time, "sleep")
    def test_rejects_failed_or_wrong_commit(self, _sleep):
        for final, message in [({"readyState": "ERROR"}, "ERROR"), ({"readyState": "READY", "target": "production", "gitSource": {"sha": "b" * 40}}, "another")]:
            with self.subTest(final=final):
                responses = iter([{"id": "project"}, {"id": "dpl_1"}, final])
                with self.assertRaisesRegex(ValueError, message):
                    module.deploy("token", "team", "project", "123", "a" * 40, lambda *_: next(responses))


if __name__ == "__main__":
    unittest.main()
