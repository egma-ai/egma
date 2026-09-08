# LiveKit end-to-end proof

This required lane runs the packaged Python and JavaScript SDKs as real LiveKit
worker processes. Each worker joins an isolated local LiveKit Docker server.
The shipped simulator claims a workbench simulation and conducts the chat or
voice conversation with a real OpenAI model. Voice also uses real OpenAI speech
recognition and speech generation.

Each chat and voice case proves that the simulator receives the caller and
agent turns, the SDK sends attributed OTLP protobuf spans, the one configured
mock answers every `check_availability` call, and the fixture's real tool does
not run. The chat case delays `session.start` for ten seconds after
`simulation()` succeeds. This proves the first caller input waits for the
native session to be ready. An ordinary production-room dispatch separately
proves that `simulation()` returns without exporting spans and leaves the
original tool callable.

The full workbench path uses the public project-credentials connection. Its
real order is simulator first, followed by named worker dispatch. Reverse and
late startup order is covered by the SDK and simulator protocol tests because
the public customer token-endpoint path rejects local addresses by design.

The workbench is the real simulator control-plane driver, and the OTLP receiver
decodes the real SDK export. This fixture does not start the platform API or its
databases, so it does not prove API persistence. The API ingestion tests own
that boundary.

Run from the repository root after `uv sync --frozen` in `apps/simulator`:

```sh
LIVEKIT_E2E_OPENAI_API_KEY=... pnpm --filter @egma/livekit-e2e test
```

Docker, Node.js, pnpm, Python 3.11, uv, and the model key are required. A
missing prerequisite is a failure. Output under `.proofs/livekit-e2e` contains
the local logs. Only redacted files under each run's `upload` directory are
safe for CI artifact upload; specifications are deleted because they contain
the model credential.

Fork pull requests cannot receive the repository secret. After review, a
maintainer must run the Tests workflow on a trusted branch with `deploy=false`;
the LiveKit job fails when the secret is unavailable and never checks out fork
code with repository credentials.
