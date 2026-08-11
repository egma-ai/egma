"""The quarantine, enforced rather than promised.

The simulator's whole licence to be Python inside a TypeScript monorepo is
that it reaches the rest of egma through one versioned JSON contract and
nothing else: no shared code, no database, no imports from anywhere above
this directory. That is the sort of boundary a README claims and a codebase
quietly loses, so it is checked here instead — the same reasoning the
repository already applies to its data-access boundary in build-time rules
rather than in prose.

The three rules are: the dependency list stays short and known, no module
reaches for a datastore driver, and a provider library nobody configured
is never even imported.
"""

from __future__ import annotations

import ast
import json
import subprocess
import sys
import textwrap
import tomllib
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = APP_ROOT / "src" / "egma_simulator"

# Everything the simulator is allowed to depend on, and why it earns its
# place. Adding a line here is a deliberate act; growing this list quietly
# is what the test exists to prevent.
ALLOWED_DEPENDENCIES = {
    "aiohttp",  # the outbound HTTP client, and the workbench's server
    "jsonschema",  # holds every document to the contract, both directions
    "rfc3339-validator",  # so the schemas' date-time format is really checked
    # The voice pipeline: the speech legs, the recording, and the LiveKit
    # transport a phone call rides. Its three extras ride with it — the
    # two speech providers and livekit, which brings both the room client
    # and the server API that places a SIP call — so a deployment that
    # configures one already has what it needs and one that configures
    # none never imports any of them: the guards below.
    "pipecat-ai",
    "loguru",  # what pipecat logs through, gathered under one filter
    "nltk",  # pipecat's tokenizer, held to no downloads (see __init__)
    # The object store a deployment's recordings land in. Signing an S3
    # request by hand is security-adjacent code nobody should write twice,
    # and this is the client every store the seam will ever meet already
    # speaks. It is loaded only where an endpoint was named: the guard
    # below.
    "boto3",
}

SPEECH_PROVIDER_MODULES = (
    "pipecat.services.deepgram.stt",
    "pipecat.services.elevenlabs.tts",
    "pipecat.audio.vad.silero",
)
"""The stock legs a configured deployment gets, and the modules a
deployment that configured nothing must never load.

The voice activity detector is here on the same terms as the two speech
providers: Silero ships inside the pinned wheel, so choosing it downloads
nothing — but loading a model is still a cost only a deployment that
asked for it should pay, and CI reads the scripted codec instead."""

MEDIA_BACKEND_MODULES = (
    "livekit",
    "pipecat.transports.livekit.transport",
)
"""The same rule one layer down: the bridge a phone call is placed
through, and the modules a simulator that dials no phone must never load.
``livekit`` is a native wheel with a Rust runtime inside it — precisely
the sort of cost only a deployment that asked for it should pay."""

OBJECT_STORE_MODULES = ("boto3", "botocore")
"""The same rule again: the client the object-storage blob store speaks
through, and the modules a deployment that named no endpoint must never
load. The filesystem store is what a contributor's checkout, a first voice
simulation and every suite here but one run on, and botocore is a large
import to pay for a store nobody configured."""

# A datastore driver in here would mean the simulator had stopped asking
# the control plane and started reading its answers, which is the one thing
# the contract exists to prevent.
DATASTORE_DRIVERS = {
    "asyncpg",
    "psycopg",
    "psycopg2",
    "sqlalchemy",
    "clickhouse_connect",
    "clickhouse_driver",
    "redis",
    "pymongo",
}


def source_files() -> list[Path]:
    return sorted(SOURCE_ROOT.rglob("*.py"))


def imported_roots(file: Path) -> set[str]:
    """The top-level module name of every import in one file."""
    tree = ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                roots.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            # A relative import stays inside this package by definition.
            if node.level == 0 and node.module:
                roots.add(node.module.split(".")[0])
    return roots


def test_the_dependency_list_stays_short_and_declared():
    with open(APP_ROOT / "pyproject.toml", "rb") as handle:
        declared = tomllib.load(handle)["project"]["dependencies"]

    named = {
        requirement.split(">")[0].split("=")[0].split("[")[0].strip()
        for requirement in declared
    }
    assert named == ALLOWED_DEPENDENCIES, (
        "the simulator's dependencies changed; if that is deliberate, say so "
        "in ALLOWED_DEPENDENCIES and explain what the new one earns"
    )


def test_no_module_imports_anything_from_outside_the_app():
    """Third-party imports are the declared ones; everything else is stdlib."""
    # The distribution names above are not always the module names, and
    # `livekit` arrives inside pipecat-ai's own extra rather than as a
    # dependency of its own.
    allowed_modules = {
        "aiohttp",
        "jsonschema",
        "pipecat",
        "loguru",
        "nltk",
        "livekit",
        "boto3",
        "botocore",
    }
    permitted = allowed_modules | set(sys.stdlib_module_names) | {"egma_simulator"}

    offenders: dict[str, set[str]] = {}
    for file in source_files():
        strangers = imported_roots(file) - permitted
        if strangers:
            offenders[str(file.relative_to(APP_ROOT))] = strangers

    assert not offenders, (
        f"the simulator imported something outside its quarantine: {offenders}. "
        "It reaches the rest of egma through the simulation contract only."
    )


def test_no_module_reaches_for_a_datastore():
    """The simulator asks the control plane; it never reads its database."""
    offenders: dict[str, set[str]] = {}
    for file in source_files():
        drivers = imported_roots(file) & DATASTORE_DRIVERS
        if drivers:
            offenders[str(file.relative_to(APP_ROOT))] = drivers

    assert not offenders, (
        f"a datastore driver reached the simulator: {offenders}. Everything it "
        "needs arrives in the claimed spec; there is nothing to look up."
    )


def test_a_provider_library_is_never_imported_at_module_scope():
    """Choosing a provider is what loads its library, and nothing else.

    A stock client is somebody else's code running at import time — the
    tokenizer corpus this package already disarms was exactly that — so
    the simulator only ever imports one after configuration has asked for
    it. Written as a rule rather than as care: an import moved to the top
    of a file for tidiness would undo it silently.

    The object store's client is held to the same rule as the speech legs
    and the bridge, and for the same reason: naming an endpoint is what
    selects it, so a deployment that named none must not load it.
    """
    deferred = (
        set(SPEECH_PROVIDER_MODULES)
        | set(MEDIA_BACKEND_MODULES)
        | set(OBJECT_STORE_MODULES)
    )
    offenders: dict[str, set[str]] = {}
    for file in source_files():
        tree = ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
        at_module_scope = {
            node.module
            for node in tree.body
            if isinstance(node, ast.ImportFrom) and node.module
        } | {
            alias.name
            for node in tree.body
            if isinstance(node, ast.Import)
            for alias in node.names
        }
        eager = {
            module
            for module in at_module_scope
            if module in deferred or module.split(".")[0] in deferred
        }
        if eager:
            offenders[str(file.relative_to(APP_ROOT))] = eager

    assert not offenders, (
        f"a library a deployment chooses is imported eagerly: {offenders}. It "
        "is imported where that choice is read, so an unconfigured simulator "
        "never loads it at all."
    )


def test_an_unconfigured_simulator_loads_no_provider_library():
    """The same rule, proved by running rather than by reading.

    A fresh process conducts two whole voice simulations with nothing
    configured — one against the loopback counterpart and one that dials
    a number through the scripted media backend — and then says which
    provider, bridge and object-storage libraries it loaded. It has to be
    a fresh one: this suite configures the providers elsewhere, so by the
    time it asks, its own modules are already loaded.

    Both simulations write their recording through the filesystem store,
    which is what a deployment that named no endpoint gets — so a client
    loaded here would be a client every checkout pays for.
    """
    proof = textwrap.dedent(
        """
        import asyncio, json, os, sys, tempfile
        from pathlib import Path

        # A deployment that dials through the scripted bridge — which is
        # still a deployment that never wants LiveKit's library.
        os.environ["EGMA_SIMULATOR_MEDIA_BACKEND"] = "scripted"

        from egma_simulator.blob import FilesystemBlobStore
        from egma_simulator.model import ScriptedModel
        from egma_simulator.persona import Persona
        from egma_simulator.pipeline import assemble
        from egma_simulator.spec import SimulationSpec
        from egma_simulator.walk import WalkControls

        def spec_for(connection):
            return SimulationSpec.from_document({
                "contract_version": 1,
                "simulation_id": "sim-unconfigured",
                "modality": "voice",
                "connection": connection,
                "persona": {"traits": {"personality": "Terse."}},
                "scenario": {"instructions": "One point."},
                "limits": {"max_duration_seconds": 30, "max_turns": 8},
            })

        LOOPBACK = spec_for({
            "type": "loopback",
            "config": {"replies": ["Noted."]},
            "credentials": None,
        })
        PHONE = spec_for({
            "type": "phone",
            "config": {
                "phoneNumber": "+15551234567",
                "scripted": {"replies": ["Noted."]},
            },
            "credentials": None,
        })

        def persona_for(spec):
            return Persona(
                traits=spec.persona_traits,
                scenario_instructions=spec.scenario_instructions,
                model=ScriptedModel(spec.scenario_instructions),
            )

        async def conduct(spec):
            with tempfile.TemporaryDirectory() as blobs:
                assembled = assemble(spec, blobs=FilesystemBlobStore(Path(blobs)))
                heard = []
                if assembled.conductor is not None:
                    async def on_utterance(speaker, text, began, ended):
                        heard.append((speaker, text))
                    async def on_measured(measure, began, ended):
                        pass
                    await assembled.conductor.conduct(
                        persona=persona_for(spec),
                        max_turns=spec.limits.max_turns,
                        max_duration_seconds=spec.limits.max_duration_seconds,
                        controls=WalkControls(),
                        name="sim:unconfigured",
                        on_utterance=on_utterance,
                        on_measured=on_measured,
                    )
                else:
                    plug = assembled.plug
                    await plug.open()
                    try:
                        answer = await plug.deliver("One point.")
                    finally:
                        await plug.close()
                    heard.append(("agent", answer.text))
                assert ("agent", "Noted.") in heard, heard
                assert assembled.audio is not None

        async def conduct_both():
            await conduct(LOOPBACK)
            await conduct(PHONE)

        asyncio.run(conduct_both())
        print(json.dumps(sorted(
            name for name in sys.modules
            if name.split(".")[0] in (
                "deepgram", "elevenlabs", "livekit", "boto3", "botocore"
            )
            or name.startswith("pipecat.services.deepgram")
            or name.startswith("pipecat.services.elevenlabs")
            or name.startswith("pipecat.transports.livekit")
            or name == "pipecat.audio.vad.silero"
        )))
        """
    )
    finished = subprocess.run(
        [sys.executable, "-c", proof],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=APP_ROOT,
    )
    assert finished.returncode == 0, finished.stderr
    loaded = json.loads(finished.stdout.strip().splitlines()[-1])
    assert loaded == [], (
        f"an unconfigured voice simulation loaded {loaded}; a provider "
        "library, a media bridge or an object-storage client is a cost only "
        "a deployment that asked for it should pay"
    )


def test_the_contract_is_read_from_the_shared_package_not_copied():
    """One artifact, two readers — a vendored copy could drift silently."""
    from egma_simulator.contract import contract_dir

    shared = contract_dir()
    assert shared.name == "simulation-contract"
    assert (shared / "schemas").is_dir()
    # Nothing schema-shaped lives inside the app itself.
    assert not list(APP_ROOT.rglob("*.schema.json"))
