# Run a LiveKit agent locally

Use this phase for an Egma run that targets a LiveKit worker in the current
repository. It starts a local worker against the selected LiveKit project. It
does not create, update, or deploy a LiveKit Cloud agent.

## Start the foreground worker

Use the entrypoint and dispatch name proved during discovery. From this skill
directory, run:

```text
node scripts/livekit-local.mjs --cwd <repository-root> --entrypoint <repository-relative-entrypoint> --dispatch-name <discovered-dispatch-name>
```

The process requires `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and
`LIVEKIT_API_SECRET` in its environment. Keep their values out of command-line
arguments and output.

The helper checks for LiveKit CLI 2.18.2 or newer. Version 2.18.2 is the
minimum because `lk agent dev` passes connection details to the worker through
environment variables. When needed, the helper uses
LiveKit's documented installer for the current operating system, checks the
installed version again, and starts:

```text
lk agent dev --no-reload <entrypoint>
```

It remains in the foreground and relays the worker's output. After LiveKit
reports a registered worker, the helper writes this exact line to stdout:

```text
egma:livekit-worker ready
```

Egma waits for that marker, owns the process, and stops it after the run. A
normal `SIGTERM` exits with status 0.

## Dispatch ownership

Starting the worker registers it with LiveKit. Egma's simulator creates each
simulation room and dispatches the exact saved agent name into that room. The
helper must not run `lk dispatch create`, `lk agent create`, or
`lk agent deploy`.

Treat the worker as ready only after LiveKit reports that it registered with
the exact discovered dispatch name and the process remains alive. Keep it
running until Egma completes or stops the run.
