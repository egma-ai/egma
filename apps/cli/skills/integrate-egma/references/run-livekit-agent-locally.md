# Run a LiveKit agent locally

Use this phase for an Egma run that targets a LiveKit worker in the current
repository. It starts a local worker against the selected LiveKit project. It
does not create, update, or deploy a LiveKit Cloud agent.

## Give worker custody to `egma run`

Use the entrypoint, dependency manifest, and registered worker name reported by
the coding agent after integration.

Before run approval, disclose the setup that this helper may perform. It may:

- install or upgrade LiveKit CLI to 2.18.2 or newer with Homebrew on macOS,
  `winget` on Windows, or LiveKit's downloaded installer on Linux;
- create `.venv` in the worker project when it finds no usable environment;
  and
- run `uv pip install` or Python `pip install` against the declared
  `pyproject.toml` or `requirements.txt` when that environment lacks Egma SDK
  0.2.0 or newer.

These are machine, repository, and dependency-environment writes. Name the
ones this repository may need and include them in the explicit run approval.
If the developer does not approve them, stop and let the developer prepare the
tools and environment before retrying.

Keep `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in the
`egma run` process environment. Confirm that each variable is present without
printing its value, then run:

```text
<egma> run <suite-directory> \
  --worker-entrypoint <repository-relative-entrypoint> \
  --worker-dependency-manifest <reported-python-manifest> \
  --worker-dispatch-name <reported-worker-name> \
  [--agent <name-or-id>] [--connection <name-or-id>]
```

Keep credential values out of command-line arguments and output. The run
command owns the worker process. It checks the worker environment, starts the
worker, waits until the exact dispatch name is registered, starts the remote
run only after readiness, and stops the worker when the run finishes or the
command is interrupted.

The dependency manifest must be `pyproject.toml` or `requirements.txt` in the
worker project, and that project must contain the entrypoint. The command checks
the same Python environment the worker uses for Egma SDK 0.2.0 or newer. A
worker never starts with only an uninstalled declaration.

The command also requires LiveKit CLI 2.18.2 or newer. This is the first release
whose `lk agent dev` path passes connection details through environment
variables. Internally it starts:

```text
lk agent dev --no-reload <entrypoint>
```

The worker remains in the foreground and its safe output is relayed. Readiness
requires this exact internal marker:

```text
egma:livekit-worker ready
```

If the worker stops before readiness, no remote run should exist. If the run
command fails after it prints a `run:` ID, that remote run already exists; do
not repeat the command just to recover progress.

## Dispatch ownership

Starting the worker registers it with LiveKit. Egma's simulator creates each
simulation room and dispatches the exact saved agent name into that room. Do
not run `lk dispatch create`, `lk agent create`, or `lk agent deploy`.

Treat the worker as ready only after LiveKit reports that it registered with
the exact reported worker name and the process remains alive. The `egma run`
process owns it until execution and grading finish or the command stops.
