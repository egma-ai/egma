"""Check packaged SDKs against LiveKit versions in parallel, within one CI job."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import time
import tomllib
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
PYTHON_SDK = ROOT / "sdks/python"
# Minimum support, minor boundaries, the customer pin, and the highest
# reviewed release.
JS_VERSIONS = ("1.5.5", "1.6.0", "1.6.4", "1.7.0", "1.7.1")
# Keep the previously locked version and the releases between the floor and lock.
PYTHON_INTERMEDIATE_VERSIONS = ("1.6.9", "1.7.0", "1.7.1")
LIVE_TESTS = ("test_live_room_detection.py", "test_live_mockable.py")


def python_versions():
    project = tomllib.loads((PYTHON_SDK / "pyproject.toml").read_text())
    dependency = next(
        item
        for item in project["project"]["dependencies"]
        if item.startswith("livekit-agents")
    )
    floor = re.search(r">=(\d+\.\d+\.\d+)", dependency)
    if floor is None:
        raise ValueError("livekit-agents must declare an exact minimum version")
    lock = tomllib.loads((PYTHON_SDK / "uv.lock").read_text())
    locked = next(
        item["version"] for item in lock["package"] if item["name"] == "livekit-agents"
    )
    versions = tuple(dict.fromkeys((floor[1], *PYTHON_INTERMEDIATE_VERSIONS, locked)))
    return versions, project["dependency-groups"]["dev"]


def run(command, log, *, cwd=ROOT):
    subprocess.run(
        command,
        cwd=cwd,
        stdout=log,
        stderr=subprocess.STDOUT,
        check=True,
        timeout=600,
        env={**os.environ, "PYTHONPATH": ""},
    )


def check_python(wheel, version, dev_dependencies, directory, log):
    python = directory / "venv/bin/python"
    run(["uv", "venv", "--python", "3.11", str(directory / "venv")], log)
    run(
        [
            "uv",
            "pip",
            "install",
            "--python",
            str(python),
            str(wheel),
            f"livekit-agents=={version}",
            f"livekit-plugins-openai=={version}",
            *dev_dependencies,
        ],
        log,
    )
    # Ensure pytest will exercise the installed wheel, never an editable checkout.
    run(
        [
            str(python),
            "-c",
            "import egma, sys; from pathlib import Path; "
            "from importlib.metadata import version; "
            "assert Path(egma.__file__).is_relative_to(sys.prefix); "
            "assert version('livekit-agents') == sys.argv[1]",
            version,
        ],
        log,
        cwd=directory,
    )
    run(
        [
            str(python),
            "-m",
            "pytest",
            "-c",
            str(PYTHON_SDK / "pyproject.toml"),
            str(PYTHON_SDK / "tests"),
            "-q",
            "-o",
            f"cache_dir={directory / 'pytest-cache'}",
            *(f"--ignore={PYTHON_SDK / 'tests' / name}" for name in LIVE_TESTS),
        ],
        log,
        cwd=directory,
    )


def parallel_checks(versions, check, directory):
    """Wait for every result, retain readable logs, and fail on any failed version."""
    results = {}
    started = time.monotonic()

    def worker(version):
        version_dir = directory / version
        version_dir.mkdir()
        with (version_dir / "check.log").open("w") as log:
            try:
                check(version, version_dir, log)
            except Exception as error:
                print(f"{type(error).__name__}: {error}", file=log)
                return False
        return True

    print(f"Checking LiveKit {', '.join(versions)} in parallel", flush=True)
    with ThreadPoolExecutor(max_workers=len(versions)) as executor:
        pending = {executor.submit(worker, version): version for version in versions}
        for future in as_completed(pending):
            version = pending[future]
            passed = future.result()
            results[version] = passed
            label = f"LiveKit {version}: {'PASS' if passed else 'FAIL'}"
            print(f"::group::{label}")
            print((directory / version / "check.log").read_text())
            print("::endgroup::")
            if not passed:
                print(f"::error::{label}")
            print(label, flush=True)
    print(f"Compatibility checks completed in {time.monotonic() - started:.1f}s")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as output:
            output.write("| LiveKit | Result |\n|---|---|\n")
            for version in versions:
                output.write(
                    f"| {version} | {'PASS' if results[version] else 'FAIL'} |\n"
                )
    return all(results.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("language", choices=("javascript", "python"))
    parser.add_argument("package", type=Path)
    args = parser.parse_args()
    package = args.package.resolve(strict=True)
    with TemporaryDirectory(prefix="egma-compatibility-") as temporary:
        directory = Path(temporary)
        if args.language == "javascript":
            versions = JS_VERSIONS

            def check(version, version_dir, log):
                run(
                    [
                        "node",
                        str(
                            ROOT
                            / "sdks/livekit-js/test/verify-packed-compatibility.mjs"
                        ),
                        str(package),
                        version,
                    ],
                    log,
                )
        else:
            versions, dev_dependencies = python_versions()

            def check(version, version_dir, log):
                check_python(package, version, dev_dependencies, version_dir, log)

        if not parallel_checks(versions, check, directory):
            return 1
        if args.language == "python":
            # The real-room fixture owns one fixed server port, so test the
            # versions sequentially after their core suites.
            for version in versions:
                print(f"Running Python live tests on LiveKit {version}", flush=True)
                version_dir = directory / version
                run(
                    [
                        str(version_dir / "venv/bin/python"),
                        "-m",
                        "pytest",
                        "-c",
                        str(PYTHON_SDK / "pyproject.toml"),
                        "-q",
                        "-o",
                        f"cache_dir={version_dir / 'pytest-cache'}",
                        *(str(PYTHON_SDK / "tests" / name) for name in LIVE_TESTS),
                    ],
                    None,
                    cwd=version_dir,
                )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
