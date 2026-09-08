import pathlib
import subprocess
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
CERTIFICATE = ROOT / "certificates" / "supabase-root-2021-ca.crt"
EXPECTED_CERT_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7"


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


if __name__ == "__main__":
    unittest.main()
