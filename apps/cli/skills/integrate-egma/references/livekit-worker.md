# Integrate a LiveKit worker

Use this reference only after discovery identifies the exact worker job
entrypoint and the onboarding outcome. Make the smallest source change that
adds the requested Egma capability, and preserve every existing Egma hook and
production behavior.

## Apply the requested capability

- Testing needs silent chat-room handling, the Egma testing hook, and one exact
  registered dispatch name.
- Monitoring needs the Egma monitoring hook and the deployment environment
  handoff printed by the monitoring command.
- Both needs both hooks in the order reported by the current CLI contract.

The hooks below are Python SDK APIs. A worker built with `@livekit/agents` can
receive the equivalent silent-chat change through its installed LiveKit APIs,
but the Egma SDK hooks are not supported there yet. Report that boundary and
stop before remote setup when the requested outcome needs an unsupported hook.

If several job entrypoints or workers remain credible, show the evidence and
ask which one to change. Do not guess a file or combine one worker's dispatch
name with another worker's source.

## Install the latest SDK

Add the latest Egma Python SDK through the dependency file and package manager
this repository already uses:

```text
egma @ git+https://github.com/egma-ai/egma.git#subdirectory=sdks/python
```

Do not add an SDK version, tag, or commit. Let the repository's package manager
resolve and lock the current source in its normal way.

## Read the current source contract

Run the read-only LiveKit source-contract command listed by the current
`egma --help`. It reports the hook calls and positions, room signals, dispatch
rule, and supported language. Do not replace the SDK with a machine-local
checkout or a different package.

## Apply the printed contract

Apply the requested hook, position, room handling, supported-language, and
dispatch facts printed by the current CLI to the discovered entrypoint. Adapt
them only through APIs in the repository's installed LiveKit dependency.
Preserve the worker's existing connection behavior, tools, and production voice
path.

Trace the whole entrypoint for audio publishers outside the agent session, such
as `BackgroundAudioPlayer`, ambient loops, or direct track publication. Start
each publisher only outside the chat branch. Disabling session audio does not
silence an independent publisher.

Keep the Egma URL and API key out of source. The monitoring command owns the
secure local handoff and its non-secret receipt, while the developer's
deployment owns runtime environment injection.

Use the dispatch identity required by the printed contract in both the source
and the Egma connection. If that change would stop a production path that
depends on automatic dispatch, pause and explain the conflict before changing
production routing.

## Prove the change

Use the repository's existing formatter, type checks, and focused tests. Prove
every source fact printed by the current contract, prove chat reaches no audio
publisher, and prove the previous production path is unchanged. Confirm that
the declared environment imports the Egma SDK, then read the final entrypoint
and dependency declaration before returning to onboarding.
