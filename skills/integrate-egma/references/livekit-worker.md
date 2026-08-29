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

## Keep chat simulations silent

An Egma chat room starts with `egma-sim-chat-`. Read that mark from
`ctx.job.room.name` before the worker connects or starts its session. Through
the room-option API of the repository's installed LiveKit version, make the
chat branch disable audio input, audio output, and transcription syncing while
the voice branch keeps its previous options unchanged.

Trace the whole entrypoint for audio publishers outside the agent session, such
as `BackgroundAudioPlayer`, ambient loops, or direct track publication. Start
each publisher only outside the chat branch. Disabling session audio does not
silence an independent publisher.

Do not use custom room metadata as the chat signal. Production rooms do not use
the Egma prefix, so their voice path must remain unchanged.

## Place the testing hook

Use the testing import, call, and position from the current CLI contract once
for the initial agent. The agent and `AgentSession` must already exist, and the
hook must finish before `AgentSession.start`. Keep the worker's existing
connection behavior and session tool list; do not add another connection call
or replace the tools. The SDK follows LiveKit handoffs and prepares later
agents and tasks from this one initial hook.

## Place the monitoring hook

Use the monitoring import, call, and position from the current CLI contract.
It must run before `ctx.connect()` or any equivalent connection. Keep the Egma
URL and API key out of source; the monitoring command owns the secure local
handoff and its non-secret receipt, while the developer's deployment owns
runtime environment injection.

## Preserve exact dispatch identity

Record an explicit worker name in the worker options and use that exact name in
the Egma connection. `LIVEKIT_URL` identifies a project, not a worker, and a
similar cloud deployment name is not source identity.

Adding a registered name stops that worker from accepting every automatically
dispatched room. If the production path depends on automatic dispatch and has
no safe named-dispatch path, pause and explain the conflict instead of silently
changing production routing.

## Prove the change

Use the repository's existing formatter, type checks, and focused tests. Prove
that the requested hooks have the required order, chat reaches no audio
publisher, the previous voice path is unchanged, the exact dispatch name is
used, and the declared environment can import the Egma SDK. Read the final
entrypoint and dependency declaration before returning to onboarding.
