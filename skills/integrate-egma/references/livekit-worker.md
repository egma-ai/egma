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

Python workers support testing and monitoring. JavaScript workers built with
`@livekit/agents` support monitoring through `@egma/livekit`, but they do not
yet support Egma simulation testing because their process-wide mocks are not
isolated between sessions. For a JavaScript Testing request, report that
boundary and stop before remote testing setup. For a JavaScript Both request,
complete monitoring, report that testing remains unsupported, and do not claim
that Both completed.

If several job entrypoints or workers remain credible, show the evidence and
ask which one to change. Do not guess a file or combine one worker's dispatch
name with another worker's source.

## Install the latest SDK

Use the dependency file and package manager already used by the repository.
For Python, add the latest Egma SDK from:

```text
egma @ git+https://github.com/egma-ai/egma.git#subdirectory=sdks/python
```

For JavaScript, add the latest `@egma/livekit` package with the repository's
package manager. Do not add an SDK version, tag, or commit to either dependency
request. Let the repository's package manager resolve and lock the latest
compatible release in its normal way.

## Read the current source contract

Run the read-only LiveKit source-contract command listed by the current
`egma --help`. It reports the hook calls and positions, room signals, dispatch
rule, and supported language.

## Apply the printed contract

Apply only the printed facts that match the discovered language and requested
capability. Monitoring uses its language's package, import, call, and position.
Testing uses its testing hook, room handling, chat rule, and dispatch identity.
A supported Both request uses the union. Do not apply simulation facts to a
JavaScript monitoring change. Adapt the selected facts only through APIs in the
repository's installed LiveKit dependency. Preserve the worker's existing
connection behavior, tools, and production voice path.

For testing, trace the whole entrypoint for audio publishers outside the agent
session, such as `BackgroundAudioPlayer`, ambient loops, or direct track
publication. Start each publisher only outside the chat branch. Disabling
session audio does not silence an independent publisher.

Keep the Egma URL and API key out of source. The monitoring command owns the
secure local handoff and its non-secret receipt, while the developer's
deployment owns runtime environment injection.

For testing, use the dispatch identity required by the printed contract in both
the source and the Egma connection. If that change would stop a production path
that depends on automatic dispatch, pause and explain the conflict before
changing production routing.

## Prove the change

Use the repository's existing formatter, type checks, and focused tests. Prove
every printed source fact that applies to the selected language and capability,
and prove the previous production path is unchanged. For testing, also prove
that chat reaches no audio publisher. Confirm that the declared environment
imports the Egma SDK, then read the final entrypoint and dependency declaration
before returning to onboarding.
