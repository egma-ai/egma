"""``python -m egma_simulator.workbench`` — the fake control plane, standing.

Point it at spec fixtures and start a simulator against it; every claim,
heartbeat, report, arriving span and refusal prints as a JSON line the
moment it happens, which is how you watch a simulation go queued →
claimed → running → completed, conversation and all, without a database
anywhere.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from aiohttp import web

from ..contract import contract_dir
from .app import WorkbenchState, build_app, load_spec_documents


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="egma-workbench",
        description=(
            "A dev/test-only fake control plane speaking the simulation "
            "contract from fixture files and recording everything reported."
        ),
    )
    parser.add_argument(
        "--specs",
        type=Path,
        default=None,
        help=(
            "A spec JSON file, or a directory of them. Defaults to the "
            "contract package's valid spec fixtures."
        ),
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8085)
    parser.add_argument(
        "--hold-seconds",
        type=float,
        default=25.0,
        help="How long a claim request is held open while the queue is dry.",
    )
    return parser.parse_args()


async def _serve() -> None:
    arguments = _arguments()
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s workbench %(message)s"
    )

    specs_path = arguments.specs or contract_dir() / "fixtures" / "spec" / "valid"
    state = WorkbenchState(hold_seconds=arguments.hold_seconds)
    documents = load_spec_documents(specs_path)
    for document in documents:
        await state.offer(document)

    runner = web.AppRunner(build_app(state))
    await runner.setup()
    site = web.TCPSite(runner, arguments.host, arguments.port)
    await site.start()
    print(
        f"workbench holding {len(documents)} spec(s) at "
        f"http://{arguments.host}:{arguments.port}",
        file=sys.stderr,
    )
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


def main() -> None:
    try:
        asyncio.run(_serve())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
