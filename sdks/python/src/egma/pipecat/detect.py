"""Read what a Pipecat start request told this bot, without Pipecat or a network.

egma starts a simulated conversation with a start request whose ``body``
carries ``{"egma": {"simulation_id": "<id>", "modality": "voice"}}`` beside
the test's own keys (``modality`` is ``chat`` for a chat simulation).
The starter hands that body to ``bot(runner_args)`` as ``runner_args.body``.
The simulation id is the provider reference: the name egma files the bot's
record under and the name the bot uses on every request to egma.

A client controls the body, so this marker is a claim, not a proof. egma's
server confirms the claim before the SDK acts on it.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

BODY_KEY = "egma"
"""The body key egma keeps for its own marker. Tests may not use it."""

SIMULATION_ID_KEY = "simulation_id"
"""Where the marker names the simulation."""

LONGEST_SIMULATION_ID = 512
"""The longest provider reference egma's server reads. A longer one is refused
as malformed, so it can name no simulation."""

MODALITY_KEY = "modality"
"""Where the marker names the simulation's modality: ``voice`` or ``chat``.
Absent means voice."""


def body_of(runner_args: object) -> Any:
    """The start request's body, from Pipecat's runner arguments or a mapping."""
    if isinstance(runner_args, Mapping):
        return runner_args.get("body")
    return getattr(runner_args, "body", None)


def provider_reference_in(runner_args: object) -> str | None:
    """The simulation id egma's marker names, or None when there is no marker.

    None for no body, a body without the ``egma`` key, and a marker egma's
    server would refuse to read (not text, blank, or longer than 512
    characters): such a marker names no simulation, so the bot runs as
    production. Reading it costs nothing: no network and no Pipecat.
    """
    body = body_of(runner_args)
    if not isinstance(body, Mapping):
        return None
    marker = body.get(BODY_KEY)
    if not isinstance(marker, Mapping):
        return None
    simulation_id = marker.get(SIMULATION_ID_KEY)
    if (
        not isinstance(simulation_id, str)
        or not simulation_id.strip()
        or len(simulation_id) > LONGEST_SIMULATION_ID
    ):
        return None
    return simulation_id


def modality_in(runner_args: object) -> str:
    """``chat`` when egma's marker says so, else ``voice``."""
    body = body_of(runner_args)
    marker = body.get(BODY_KEY) if isinstance(body, Mapping) else None
    if isinstance(marker, Mapping) and marker.get(MODALITY_KEY) == "chat":
        return "chat"
    return "voice"


def session_id_of(runner_args: object) -> str:
    """The runner's session id (Pipecat Cloud's ``sessionId``), or ``""``."""
    if isinstance(runner_args, Mapping):
        value = runner_args.get("session_id")
    else:
        value = getattr(runner_args, "session_id", None)
    return value if isinstance(value, str) else ""


_TRANSPORT_NAMES = {"smallwebrtc": "webrtc"}


def transport_of(runner_args: object) -> str:
    """The transport this bot was started for, named by its runner arguments.

    ``DailyRunnerArguments`` is ``daily``, ``LiveKitRunnerArguments`` is
    ``livekit``, and so on. ``""`` when the arguments do not say.
    """
    if isinstance(runner_args, Mapping):
        value = runner_args.get("transport")
        return value if isinstance(value, str) else ""
    name = type(runner_args).__name__
    for suffix in ("RunnerArguments", "SessionArguments", "Arguments"):
        if name.endswith(suffix) and len(name) > len(suffix):
            base = name[: -len(suffix)].lower()
            return _TRANSPORT_NAMES.get(base, base)
    return ""
