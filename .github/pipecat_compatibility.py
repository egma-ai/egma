"""Check the packaged Python SDK against each supported Pipecat minor.

For each minor, a clean virtual environment installs the built wheel with
the ``pipecat`` extra and that minor of ``pipecat-ai``, proves that no
LiveKit package came with it, and runs the Pipecat tests against the
installed wheel. Minors run in parallel.

    python3 .github/pipecat_compatibility.py dist/egma-0.4.0-py3-none-any.whl
    python3 .github/pipecat_compatibility.py <wheel> --minor 1.10
"""

from __future__ import annotations

import argparse
import re
import tomllib
from pathlib import Path
from tempfile import TemporaryDirectory

from livekit_compatibility import parallel_checks, run

ROOT = Path(__file__).resolve().parents[1]
PYTHON_SDK = ROOT / "sdks/python"
TESTS = (
    "pipecat_tests",
    "test_dependencies.py",
    "test_imports.py",
    "test_seam_bytes.py",
)
"""The suites that need no LiveKit. LiveKit's own tests skip themselves here."""


def supported_minors() -> tuple[str, ...]:
    """Every minor of the ``pipecat`` extra's range, from floor to ceiling."""
    project = tomllib.loads((PYTHON_SDK / "pyproject.toml").read_text())
    requirement = next(
        item
        for item in project["project"]["optional-dependencies"]["pipecat"]
        if item.startswith("pipecat-ai")
    )
    floor = re.search(r">=(\d+)\.(\d+)", requirement)
    ceiling = re.search(r"<(\d+)\.(\d+)", requirement)
    if floor is None or ceiling is None:
        raise ValueError("pipecat-ai must declare a >=X.Y floor and a <X.Z ceiling")
    if floor[1] != ceiling[1]:
        raise ValueError("the Pipecat range must stay inside one major version")
    major = int(floor[1])
    return tuple(f"{major}.{minor}" for minor in range(int(floor[2]), int(ceiling[2])))


def tool_dependencies() -> list[str]:
    """The dev group's test tools, without the package itself or LiveKit."""
    project = tomllib.loads((PYTHON_SDK / "pyproject.toml").read_text())
    return [
        item
        for item in project["dependency-groups"]["dev"]
        if re.match(r"(egma|livekit)", item) is None
    ]


def check(wheel: Path, minor: str, directory: Path, log) -> None:
    python = directory / "venv/bin/python"
    run(["uv", "venv", "--python", "3.11", str(directory / "venv")], log)
    run(
        [
            "uv",
            "pip",
            "install",
            "--python",
            str(python),
            f"egma[pipecat] @ {wheel.resolve().as_uri()}",
            f"pipecat-ai=={minor}.*",
            *tool_dependencies(),
        ],
        log,
    )
    # The installed wheel is what is tested, with the requested minor and no
    # LiveKit package anywhere in the environment.
    run(
        [
            str(python),
            "-c",
            "import egma, sys; from pathlib import Path; "
            "from importlib.metadata import distributions, version; "
            "assert Path(egma.__file__).is_relative_to(sys.prefix); "
            "assert version('pipecat-ai').startswith(sys.argv[1] + '.'), "
            "version('pipecat-ai'); "
            "found = sorted(d.metadata['Name'] for d in distributions() "
            "if d.metadata['Name'].lower().startswith('livekit')); "
            "assert not found, found",
            minor,
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
            *(str(PYTHON_SDK / "tests" / name) for name in TESTS),
            "-q",
            "-o",
            f"cache_dir={directory / 'pytest-cache'}",
        ],
        log,
        cwd=directory,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheel", type=Path)
    parser.add_argument(
        "--minor",
        action="append",
        help="a Pipecat minor such as 1.10; repeat for several (default: all)",
    )
    args = parser.parse_args()
    wheel = args.wheel.resolve(strict=True)
    minors = tuple(args.minor) if args.minor else supported_minors()
    unsupported = sorted(set(minors) - set(supported_minors()))
    if unsupported:
        parser.error(f"not in the supported range: {', '.join(unsupported)}")
    with TemporaryDirectory(prefix="egma-pipecat-") as temporary:

        def checked(minor, version_dir, log):
            check(wheel, minor, version_dir, log)

        passed = parallel_checks(minors, checked, Path(temporary), "Pipecat")
        return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
