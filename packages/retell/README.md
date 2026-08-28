# @egma/retell

The shared Retell HTTP client. Every Egma surface that talks to Retell talks
through this package, so paging, refusal wording, and credential handling are
decided once.

The caller owns the credential. This client reads it on the way out to Retell
and never logs it, stores it, or returns it — and no refusal here repeats what
was sent.

## What it holds

- **Account reads** — the agents on an account, its telephone numbers, one
  number's own document, and one agent's whole configuration.
- **Version reads** — what a version reference (`latest`, an environment tag, a
  number) resolves to, and either response engine's configuration at a named
  version.
- **Version writes** — branch a new agent version from a named base, write tools
  onto a named engine version, delete a version, and pin or restore a number's
  inbound bindings.
- **The mocked-draft transform** — a pure function that points an engine's
  custom tools at Egma's mock endpoint, and the three-class coverage stamp
  saying what it could not stand in front of.

Every write names its version explicitly. Retell's own default is "the latest
version", and after a branch the latest version is the branch, so a write that
relied on the default could land on whichever version was minted most recently
anywhere on the account.

## The live fork check

One test in this package talks to a real Retell account, and it is **run by
hand, never by CI and never by an agent**. It answers whether branching an agent
version forks a Retell LLM the way it provably forks a conversation flow.

```sh
EGMA_LIVE_RETELL_API_KEY=<a Retell key> \
  npx vitest run --root packages/retell --config /dev/null test/live-fork.test.ts
```

Without `EGMA_LIVE_RETELL_API_KEY` the check is skipped, visibly. It creates its
own scratch Retell LLM and agent, branches one version, deletes all three, and
binds no telephone number — so it leaves the account as it found it, including
when a check inside it fails. It reads and writes nothing that was already
there.

Its finding is informational either way. The run builder's fork guard refuses a
branch whose engine reference still matches the serving version's, before any
write, so no lane depends on the answer.

## The live checklist

Two questions can only be answered against a real Retell account, and both are
the developer's to answer by hand. Each finding lands, dated, in
`.scratch/mock-tools/research/retell-mocking-surface.md`.

**1. Does branching fork a Retell LLM?** — the command above.

**2. Which key signs a custom-function call?** This one is not yet answered, and
Egma is currently guessing. The mock endpoint verifies a request's
`X-Retell-Signature` with **the agent's own Retell API key**, the one stored on
the agent. But Retell's *webhook* signatures are known to use a separate
webhook-signing key — the one wearing the **Webhook** badge in the dashboard's
API Keys page — which is a different value from every management key on the
same account. Whether a custom-function call uses that key, the management key,
or is not signed at all is unknown.

To answer it, run one mocked simulation and look at what arrives:

- **No `X-Retell-Signature` header at all** — Retell does not sign these. Egma
  already admits such requests; nothing to change.
- **A header that verifies** — the guess was right. Make the header required.
- **A header that does not verify** — every mocked tool call refuses with
  `bad_signature`, and the refusal says so. Point the check at the
  webhook-signing key instead: it is read in `resolveMockToolCall`
  (`packages/db/src/access/runs.ts`), which today selects the agent's stored
  Retell key.

Until it is answered the endpoint fails safe rather than open: a signature that
is present must verify, and a request carrying none is admitted on the two
unguessable identifiers and the live-run gate.
