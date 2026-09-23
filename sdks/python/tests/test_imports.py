"""Which framework each import loads.

Each check runs in a fresh interpreter, because ``sys.modules`` in this
test process already holds whatever other tests imported.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap

BLOCK_LIVEKIT = textwrap.dedent(
    """
    import importlib.abc, sys

    class NoLiveKit(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path=None, target=None):
            if name == "livekit" or name.startswith("livekit."):
                raise ModuleNotFoundError(f"No module named {name!r}", name=name)
            return None

    sys.meta_path.insert(0, NoLiveKit())
    """
)


def _run(code: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code)],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def _passes(code: str) -> None:
    ran = _run(code)
    assert ran.returncode == 0, ran.stderr


def test_importing_egma_loads_no_livekit():
    _passes(
        """
        import sys
        import egma
        from egma import NotReported, seam, otlp

        assert issubclass(NotReported, RuntimeError)
        loaded = sorted(name for name in sys.modules if name.split(".")[0] == "livekit")
        assert loaded == [], loaded
        """
    )


def test_the_top_level_livekit_names_still_import_for_a_livekit_worker():
    _passes(
        """
        import egma.livekit
        import egma.monitoring
        import egma.simulation_room
        from egma import NotReported, monitor, simulation

        assert simulation is egma.simulation_room.simulation
        assert monitor is egma.monitoring.monitor
        assert simulation is egma.livekit.simulation
        assert monitor is egma.livekit.monitor
        assert NotReported is egma.livekit.NotReported
        assert NotReported is egma.simulation_room.NotReported
        """
    )


def test_the_top_level_names_are_listed_without_loading_livekit():
    _passes(
        """
        import sys
        import egma

        assert {"NotReported", "monitor", "simulation"} <= set(dir(egma))
        assert set(egma.__all__) == {"NotReported", "monitor", "simulation"}
        assert "livekit" not in sys.modules
        """
    )


def test_without_livekit_the_top_level_names_say_which_extra_to_install():
    ran = _run(
        BLOCK_LIVEKIT
        + """
import egma
from egma import NotReported

try:
    from egma import simulation
except ModuleNotFoundError as missing:
    print(missing)
else:
    raise SystemExit("imported without livekit")
"""
    )
    assert ran.returncode == 0, ran.stderr
    assert 'pip install "egma[livekit]"' in ran.stdout


def test_without_livekit_the_livekit_module_says_which_extra_to_install():
    ran = _run(
        BLOCK_LIVEKIT
        + """
try:
    import egma.livekit
except ModuleNotFoundError as missing:
    print(missing)
    print(missing.name)
else:
    raise SystemExit("imported without livekit")
"""
    )
    assert ran.returncode == 0, ran.stderr
    assert 'pip install "egma[livekit]"' in ran.stdout
    assert "livekit" in ran.stdout.splitlines()[-1]


def test_an_unknown_top_level_name_is_an_attribute_error():
    _passes(
        """
        import egma

        try:
            egma.no_such_name
        except AttributeError:
            pass
        else:
            raise SystemExit("an unknown name resolved")
        """
    )
