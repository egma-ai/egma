"""Exercise release decisions against committed manifests and a real tag remote."""

import contextlib
import io
import json
import os
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import unquote, urlparse

import package_release


class RepositoryTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "checkout"
        self.origin = Path(temporary.name) / "origin.git"
        self.root.mkdir()
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "Release test")
        self.git("config", "user.email", "release-test@example.invalid")
        subprocess.run(
            ["git", "init", "--bare", str(self.origin)],
            check=True,
            capture_output=True,
            text=True,
        )
        self.git("remote", "add", "origin", str(self.origin))
        for package in ("cli", "livekit-js", "python"):
            self.write_version(package, "0.3.9")
        self.before = self.commit("Initial package versions")

    def git(self, *arguments):
        return subprocess.run(
            ["git", *arguments],
            cwd=self.root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def write_json(self, relative_path, contents):
        target = self.root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(contents) + "\n")

    def write_version(self, package, version):
        if package == "cli":
            self.write_json(
                "apps/cli/package.json", {"name": "egma-cli", "version": version}
            )
        elif package == "livekit-js":
            self.write_json(
                "sdks/livekit-js/package.json",
                {"name": "@egma/livekit", "version": version},
            )
        else:
            self.write_json(
                "sdks/python/package.json",
                {"name": "@egma/sdk-python", "version": version},
            )
            (self.root / "sdks/python/pyproject.toml").write_text(
                f'[project]\nname = "egma"\nversion = "{version}"\n'
            )

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", message)
        return self.git("rev-parse", "HEAD")

    def push_event(self, after):
        return {
            "ref": "refs/heads/main",
            "before": self.before,
            "after": after,
        }

    def remote_tag_target(self, tag):
        return subprocess.run(
            ["git", "--git-dir", str(self.origin), "rev-parse", f"{tag}^{{commit}}"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def prepare(self, event):
        event_path = self.root.parent / "event.json"
        output_path = self.root.parent / "output"
        event_path.write_text(json.dumps(event))
        output_path.write_text("")
        with patch.dict(
            os.environ,
            {"GITHUB_EVENT_PATH": str(event_path), "GITHUB_OUTPUT": str(output_path)},
            clear=True,
        ), contextlib.redirect_stdout(io.StringIO()):
            package_release.prepare("cli", self.root)
        return dict(line.split("=", 1) for line in output_path.read_text().splitlines())

    def test_reads_requested_commit_instead_of_working_tree(self):
        self.write_version("cli", "9.0.0")
        self.assertEqual(
            package_release.version_at("cli", self.before, self.root), "0.3.9"
        )

    def test_releases_each_package_when_numeric_version_increases(self):
        for package in ("cli", "livekit-js", "python"):
            self.write_version(package, "0.3.10")
        after = self.commit("Bump all packages")
        for package in ("cli", "livekit-js", "python"):
            with self.subTest(package=package):
                self.assertEqual(
                    package_release.planned_version(
                        package, self.push_event(after), self.root
                    ),
                    "0.3.10",
                )

    def test_compares_entire_push_when_final_commit_does_not_change_version(self):
        self.write_version("cli", "0.3.10")
        self.commit("Bump CLI")
        (self.root / "README.md").write_text("Unrelated change after the bump.\n")
        after = self.commit("Update README")
        self.assertEqual(
            package_release.planned_version("cli", self.push_event(after), self.root),
            "0.3.10",
        )
        self.assertIsNone(
            package_release.planned_version(
                "livekit-js", self.push_event(after), self.root
            )
        )

    def test_unchanged_versions_do_not_release(self):
        (self.root / "README.md").write_text("No version change.\n")
        after = self.commit("Update README")
        for package in ("cli", "livekit-js", "python"):
            with self.subTest(package=package):
                self.assertIsNone(
                    package_release.planned_version(
                        package, self.push_event(after), self.root
                    )
                )

    def test_lower_versions_fail_instead_of_publishing(self):
        for package in ("cli", "livekit-js", "python"):
            self.write_version(package, "0.3.8")
        after = self.commit("Lower package versions")
        for package in ("cli", "livekit-js", "python"):
            with self.subTest(package=package), self.assertRaises(ValueError):
                package_release.planned_version(
                    package, self.push_event(after), self.root
                )

    def test_invalid_and_prerelease_versions_fail(self):
        for version in ("0.3", "v0.3.10", "0.3.10-rc.1", "0.3.10+build", "0.03.10"):
            with self.subTest(version=version):
                self.write_version("cli", version)
                after = self.commit(f"Version {version}")
                with self.assertRaises(ValueError):
                    package_release.planned_version(
                        "cli", self.push_event(after), self.root
                    )

    def test_rejects_wrong_package_name(self):
        self.write_json(
            "apps/cli/package.json", {"name": "another-package", "version": "0.3.10"}
        )
        after = self.commit("Wrong package identity")
        with self.assertRaises(ValueError):
            package_release.version_at("cli", after, self.root)

    def test_python_manifests_must_have_matching_versions(self):
        self.write_json(
            "sdks/python/package.json",
            {"name": "@egma/sdk-python", "version": "0.3.10"},
        )
        after = self.commit("Bump only the Python workspace manifest")
        with self.assertRaises(ValueError):
            package_release.planned_version("python", self.push_event(after), self.root)

    def test_matching_manual_tags_still_release_each_package(self):
        for package, tag in (
            ("cli", "cli-v0.3.9"),
            ("livekit-js", "livekit-js-sdk-v0.3.9"),
            ("python", "python-sdk-v0.3.9"),
        ):
            with self.subTest(package=package):
                self.assertEqual(
                    package_release.planned_version(
                        package,
                        {"ref": f"refs/tags/{tag}", "after": self.before},
                        self.root,
                    ),
                    "0.3.9",
                )

    def test_manual_tag_must_match_the_committed_version(self):
        with self.assertRaises(ValueError):
            package_release.planned_version(
                "cli",
                {"ref": "refs/tags/cli-v0.3.10", "after": self.before},
                self.root,
            )

    def test_creates_remote_tag_and_rerun_keeps_the_same_target(self):
        package_release.ensure_tag("cli-v0.3.9", self.before, self.root)
        self.assertEqual(self.remote_tag_target("cli-v0.3.9"), self.before)
        package_release.ensure_tag("cli-v0.3.9", self.before, self.root)
        self.assertEqual(self.remote_tag_target("cli-v0.3.9"), self.before)

    def test_existing_annotated_tag_is_compared_by_commit(self):
        self.git("tag", "-a", "cli-v0.3.9", self.before, "-m", "CLI release")
        self.git("push", "origin", "refs/tags/cli-v0.3.9")
        package_release.ensure_tag("cli-v0.3.9", self.before, self.root)
        self.assertEqual(self.remote_tag_target("cli-v0.3.9"), self.before)

    def test_tag_collision_never_moves_the_existing_release(self):
        self.git("tag", "cli-v0.3.9", self.before)
        self.git("push", "origin", "refs/tags/cli-v0.3.9")
        self.write_version("cli", "0.3.10")
        after = self.commit("A different release commit")
        with self.assertRaises(ValueError):
            package_release.ensure_tag("cli-v0.3.9", after, self.root)
        self.assertEqual(self.remote_tag_target("cli-v0.3.9"), self.before)

    def test_prepare_without_bump_does_not_access_registry_or_create_tags(self):
        (self.root / "README.md").write_text("No version change.\n")
        after = self.commit("Update README")
        with patch.object(package_release, "read_json") as read_json:
            outputs = self.prepare(self.push_event(after))
        self.assertEqual(outputs["should_publish"], "false")
        self.assertEqual(outputs["version"], "")
        read_json.assert_not_called()
        self.assertEqual(self.git("ls-remote", "--tags", "origin"), "")

    def test_prepare_retry_skips_upload_after_same_release_is_published(self):
        self.write_version("cli", "0.3.10")
        after = self.commit("Bump CLI")
        event = self.push_event(after)
        with patch.object(
            package_release,
            "read_json",
            side_effect=[None, None, {"name": "egma-cli", "version": "0.3.10"}],
        ) as read_json:
            first = self.prepare(event)
            retry = self.prepare(event)
        self.assertEqual(first["should_publish"], "true")
        self.assertEqual(first["npm_tag"], "latest")
        self.assertEqual(retry["should_publish"], "false")
        self.assertEqual(retry["version"], "0.3.10")
        self.assertEqual(read_json.call_count, 3)
        self.assertEqual(self.remote_tag_target("cli-v0.3.10"), after)
        self.assertEqual(len(self.git("ls-remote", "--tags", "origin").splitlines()), 1)

    def test_prepare_accepts_annotated_tag_event_object_sha(self):
        self.git("tag", "-a", "cli-v0.3.9", self.before, "-m", "CLI release")
        self.git("push", "origin", "refs/tags/cli-v0.3.9")
        event = {
            "ref": "refs/tags/cli-v0.3.9",
            "after": self.git("rev-parse", "refs/tags/cli-v0.3.9"),
        }
        with patch.object(
            package_release,
            "read_json",
            return_value={"name": "egma-cli", "version": "0.3.9"},
        ):
            outputs = self.prepare(event)
        self.assertEqual(outputs["should_publish"], "false")
        self.assertEqual(self.remote_tag_target("cli-v0.3.9"), self.before)

    def test_prepare_rejects_checkout_of_a_different_commit_before_creating_tag(self):
        self.write_version("cli", "0.3.10")
        after = self.commit("Bump CLI")
        (self.root / "README.md").write_text("A later commit.\n")
        self.commit("Advance checkout")
        with self.assertRaises(ValueError):
            self.prepare(self.push_event(after))
        self.assertEqual(self.git("ls-remote", "--tags", "origin"), "")

    def test_publish_job_retry_refreshes_latest_after_prepare_finished(self):
        self.write_version("cli", "0.3.10")
        after = self.commit("Bump CLI")
        tarball = self.root.parent / "egma-cli-0.3.10.tgz"
        with patch.object(
            package_release,
            "read_json",
            side_effect=[None, {"version": "0.3.9"}, None, {"version": "0.3.11"}],
        ):
            prepared = self.prepare(self.push_event(after))
            self.assertEqual(prepared["npm_tag"], "latest")
            with patch.object(
                package_release, "version_at", return_value="0.3.10"
            ), patch.object(package_release.subprocess, "run") as run:
                package_release.publish_npm("cli", tarball, self.root)
        run.assert_called_once_with(
            ["npm", "publish", "--tag", "previous", str(tarball)],
            cwd=self.root,
            check=True,
            timeout=300,
        )


class RegistryTests(unittest.TestCase):
    def test_publish_job_retry_skips_an_already_published_package(self):
        for package, name in (("cli", "egma-cli"), ("livekit-js", "@egma/livekit")):
            with self.subTest(package=package), patch.object(
                package_release, "version_at", return_value="0.3.10"
            ), patch.object(
                package_release,
                "read_json",
                return_value={"name": name, "version": "0.3.10"},
            ), patch.object(
                package_release.subprocess, "run"
            ) as run, contextlib.redirect_stdout(io.StringIO()):
                package_release.publish_npm(package, Path("package.tgz"))
            run.assert_not_called()

    def test_publish_job_does_not_upload_when_either_registry_check_fails(self):
        failure = HTTPError("https://registry.invalid", 503, "Unavailable", {}, None)
        for responses in ([failure], [None, failure]):
            with self.subTest(responses=responses), patch.object(
                package_release, "version_at", return_value="0.3.10"
            ), patch.object(
                package_release, "read_json", side_effect=responses
            ), patch.object(
                package_release.subprocess, "run"
            ) as run, self.assertRaises(HTTPError):
                package_release.publish_npm("cli", Path("package.tgz"))
            run.assert_not_called()

    def test_npm_queries_the_exact_package_version(self):
        for package, name in (("cli", "egma-cli"), ("livekit-js", "@egma/livekit")):
            with self.subTest(package=package), patch.object(
                package_release,
                "read_json",
                return_value={"name": name, "version": "0.3.10"},
            ) as read_json:
                self.assertTrue(package_release.published(package, "0.3.10"))
                url = urlparse(read_json.call_args.args[0])
                self.assertEqual(url.netloc, "registry.npmjs.org")
                self.assertEqual(unquote(url.path), f"/{name}/0.3.10")

    def test_absent_registry_version_is_not_published(self):
        for package in ("cli", "livekit-js", "python"):
            with self.subTest(package=package), patch.object(
                package_release, "read_json", return_value=None
            ):
                self.assertFalse(package_release.published(package, "0.3.10"))

    def test_python_is_complete_only_after_both_distributions_exist(self):
        wheel = {"filename": "egma-0.3.10-py3-none-any.whl"}
        source = {"filename": "egma-0.3.10.tar.gz"}
        other = {"filename": "egma-0.3.9.tar.gz"}
        for files, expected in (
            ([], False),
            ([wheel], False),
            ([source], False),
            ([wheel, other], False),
            ([wheel, source], True),
        ):
            with self.subTest(files=files), patch.object(
                package_release,
                "read_json",
                return_value={"info": {"version": "0.3.10"}, "urls": files},
            ) as read_json:
                self.assertEqual(
                    package_release.published("python", "0.3.10"), expected
                )
                read_json.assert_called_once_with("https://pypi.org/pypi/egma/0.3.10/json")

    def test_registry_failures_do_not_become_permission_to_publish(self):
        for package in ("cli", "livekit-js", "python"):
            failure = HTTPError(
                "https://registry.invalid", 503, "Unavailable", {}, None
            )
            with self.subTest(package=package), patch.object(
                package_release, "read_json", side_effect=failure
            ), self.assertRaises(HTTPError):
                package_release.published(package, "0.3.10")

    def test_delayed_npm_release_does_not_replace_a_newer_latest_version(self):
        for latest, expected in (
            (None, "latest"),
            ({"version": "0.3.9"}, "latest"),
            ({"version": "0.3.10"}, "latest"),
            ({"version": "0.3.11"}, "previous"),
            ({"version": "0.4.0"}, "previous"),
        ):
            with self.subTest(latest=latest), patch.object(
                package_release, "read_json", return_value=latest
            ):
                self.assertEqual(package_release.npm_tag("cli", "0.3.10"), expected)

    def test_read_json_returns_none_only_for_missing_registry_metadata(self):
        for status in (404, 401, 429, 500, 503):
            failure = HTTPError("https://registry.invalid", status, "Failure", {}, None)
            with self.subTest(status=status), patch.object(
                package_release, "urlopen", side_effect=failure
            ):
                if status == 404:
                    self.assertIsNone(
                        package_release.read_json("https://registry.invalid")
                    )
                else:
                    with self.assertRaises(HTTPError):
                        package_release.read_json("https://registry.invalid")

    def test_read_json_rejects_invalid_registry_response_shape(self):
        with patch.object(
            package_release, "urlopen", return_value=io.BytesIO(b"[]")
        ), self.assertRaises(ValueError):
            package_release.read_json("https://registry.invalid")


if __name__ == "__main__":
    unittest.main()
