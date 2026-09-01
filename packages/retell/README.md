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
- **The mocked world's lifecycle** — the order a run builds its temporary
  version in and the order it gives the account back, with every guard between
  the steps: `bindingDecisionsFor`, `buildMockedWorld`, `finishMockedWorld`.
  `finishMockedWorld` is both the teardown and the sweep, because they are the
  same act.
- **Discovery** — what ticking the mock-tools box finds: every tool in its
  honest class, the deterministic answer Egma would seed for each one it can
  intercept, and the tools that act outside the call and will really act.

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

## The live proof of the whole seam

Beside the fork check there is a second live suite, and it is the one the
founder asked for: **one mocked suite against the real Remedy agent, with the
record showing Egma answered while production served the customer's own
backend.** It lives in `apps/api/test/live-remedy.test.ts`, because it drives
Egma's own platform API as well as reading the Retell account, and its own
header carries the command, everything it needs, and what to bank when it
passes.

It is the 2026-08-27 hand-run turned into a script: capture the account, start
a mocked run, check mid-run that the temporary version points at Egma while the
serving version is byte-identical to the capture and a tagged number is
untouched, wait for the run, then check the temporary version is deleted, the
routing restored, and every simulation's three-class stamp truthful.

Like the fork check, **it is run by hand and never by CI or by an agent**, and
without its environment every check is skipped visibly. It needs three things
CI has none of: a Retell API key, a public tunnel in front of the deployment so
Retell can reach the mock endpoint, and funded model keys for the real voice
conversations it conducts.

## The live checklist

Three questions can only be answered against a real Retell account. One of them
is answered below; the other two are still the developer's to answer by hand.
Each finding lands, dated, in
`.scratch/mock-tools/research/retell-mocking-surface.md`.

**1. Does branching fork a Retell LLM?** — the command above.

**2. Which key signs a custom-function call? — ANSWERED 2026-08-31: the
account's webhook-signing key**, the one wearing the **Webhook** badge in the
dashboard's API Keys page. It is a different value from the agent's own Retell
API key, from every other management key on the account, and Egma is never
handed it: it cannot be read back over the API, so Egma can neither hold it nor
guess it.

Egma had guessed the agent's own key and refused any signature that did not
verify against it. The first live mocked run answered the question the hard
way — **every** mocked tool call failed on the signature, and the agent
apologised to the caller for a broken backend on every one of them.

The ruling is that **the signature is never refused on**. What authenticates one
of these requests is the address itself: an unguessable run identifier and an
unguessable simulation identifier that have to name the same live run, plus the
three gates in `apps/api/src/routes/mock-endpoint.ts` — live run, matching
simulation, covered tool. The header is still read, and a signature that does
not match the key Egma does hold is written to the log as one note, so the day
some account signs with a key Egma holds is measurable rather than assumed. The
endpoint's own file header carries the whole story.

**3. Does `{{egma_simulation}}` render into a tool URL on a live *voice*
call?** Per-call rendering into a custom-function URL is proven on a real agent
in text mode (2026-08-27), and rendering happens in the response engine, so
voice is expected to behave identically — but expected is not proven. The live
proof above answers it for free: a mock request arriving at
`/mock-tools/{run}/{simulation}/{tool}` with a real simulation identifier in the
middle segment **is** the evidence.

If it ever says no, the fallback is already designed and costs the lifecycle
nothing: write the simulation's identifier into the URL at transform time
instead of as a variable, and branch one temporary version per simulation
rather than one per run. Every step and every guard keeps its exact shape —
`packages/retell/src/mocked-world.ts` says so at the top, beside the order it
would keep.
