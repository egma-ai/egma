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
  and their default dynamic variables onto a named engine version in one PATCH,
  and delete a version.
- **The mocked-draft transform** — a pure function that makes an engine's custom
  tools routable per call, and the map of which variable routes which tool.
- **The mocked world's lifecycle** — the order a run builds its temporary
  version in and the order it gives the account back, with every guard between
  the steps: `bindingDecisionsFor`, `buildMockedWorld`, `finishMockedWorld`.
  `finishMockedWorld` is both the teardown and the sweep, because they are the
  same act.

Every write names its version explicitly. Retell's own default is "the latest
version", and after a branch the latest version is the branch, so a write that
relied on the default could land on whichever version was minted most recently
anywhere on the account.

## The transform, in full ([ADR-0022](../../egma-planning/docs/adr/0022-retell-web-call-mock-tools-route-per-call-through-url-variables.md))

One run makes one temporary version, and **which tools that version sends to
Egma is decided per call rather than written into it.** Two tests of one run
mock different tools; a shared version whose URLs pointed at Egma could not
send the other test's call anywhere real, because the real URL would be gone
from it.

So `mockedToolsFor` changes exactly one field per custom tool:

```
url:  https://backend.example.com/book
  →   {{egma_url_book}}https://backend.example.com/book
```

- **The original URL is kept byte for byte**, the customer's own variables
  inside it included. `headers` and `query_params` are **not** touched: the
  same version serves the tools a test does not mock, and those calls
  authenticate exactly as production does. What keeps those credentials out of
  Egma is the mock endpoint, which drops every header and query param that
  arrives and reads only the platform's signature.
- **The variable's name** is `egma_url_` plus the tool's name where the name is
  only letters, digits and underscores; otherwise `egma_url_` plus the name
  with every other character replaced by an underscore, plus an underscore and
  the first eight hex digits of the exact name's SHA-256 — so two names that
  sanitize alike still get two variables. Two tools that would share one
  variable, or a variable name the customer already fills, **refuse the run
  before anything is written**.
- **Every variable is declared with a single-space default**, never an empty
  one: Retell stores an empty default as *absent*, and an absent variable
  leaves `{{egma_url_book}}` literal, which is not a URL. A space is kept as
  set and is stripped when the URL is parsed. After the write the builder reads
  the version back and **refuses the run if any of those defaults is no longer
  one space**.
- **On every call**, the claim passes every one of those variables:
  `https://<egma origin>/mock-tools/<simulation>/<tool>#` for the tools that
  simulation's test names, and `""` for the rest, which renders to nothing and
  leaves the customer's own URL. The trailing `#` makes the original URL a
  fragment, and an HTTP client never sends a fragment.
- **Tools Retell executes itself and MCP servers are never rewritten.** A
  custom tool is a webhook and is the one kind a URL can be put in front of;
  everything else runs for real, on the temporary version exactly as on the
  customer's own.

## The live fork check

Two of the live questions are answered by one test in this package, and it is
**run by hand, never by CI and never by an agent**. It answers whether branching
an agent version forks a Retell LLM the way it provably forks a conversation
flow — and whether the per-call routing above behaves the same on a Retell LLM
engine as it does on the conversation flow the founder proved it on.

```sh
EGMA_LIVE_RETELL_API_KEY=<a Retell key> \
  npx vitest run --root packages/retell --config /dev/null test/live-fork.test.ts
```

Without `EGMA_LIVE_RETELL_API_KEY` the check is skipped, visibly. It creates its
own scratch Retell LLM and agent, branches one version, deletes all three, and
binds no telephone number — so it leaves the account as it found it, including
when a check inside it fails. It reads and writes nothing that was already
there.

The fork finding is informational either way: the run builder's fork guard
refuses a branch whose engine reference still matches the serving version's,
before any write, so no lane depends on the answer. The routing finding is not
informational — it is the second of ADR-0022's two owed checks, and the web-call
lane rests on it.

## The live proof of the whole seam

Beside the fork check there is a second live suite, and it is the one the
founder asked for: **one mocked suite against the real Remedy agent, with the
record showing Egma answered while production served the customer's own
backend.** It lives in `apps/api/test/live-remedy.test.ts`, because it drives
Egma's own platform API as well as reading the Retell account, and its own
header carries the command, everything it needs, and what to bank when it
passes.

It is the 2026-08-27 hand-run turned into a script, in the shape ADR-0022 asks
for: give two of the suite's tests two **different** sets of mocked tools, start
one run, check mid-run that exactly one temporary version exists and that every
custom tool on it carries its own `{{egma_url_…}}` in front of the customer's
own URL with their headers and query params untouched and every routing default
stored as one space, that the serving version is byte-identical to the capture
and no number was touched, then wait for the run and check the temporary
version is deleted and the serving version still byte-identical. It puts both
tests back exactly as it found them.

**The receiver is the developer's own.** Which host each *unmocked* call
reached is a fact about the customer's backend and no API of Egma's can read
it: point one tool at a receiver you can watch, and check it saw the calls of
the test that did not mock that tool and none of the other's.

Like the fork check, **it is run by hand and never by CI or by an agent**, and
without its environment every check is skipped visibly. It needs three things
CI has none of: a Retell API key, a public tunnel in front of the deployment so
Retell can reach the mock endpoint, and funded model keys for the real voice
conversations it conducts.

## The live checklist

Four questions can only be answered against a real Retell account, and all four
are the developer's to answer by hand. Each finding lands, dated, in
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
is present must verify, and a request carrying none is admitted on the
unguessable simulation identifier and the live-run gate.

**3. Does an explicit `""` render the routing prefix to nothing on a live
*voice* call?** ADR-0022's first owed check. Retell distinguishes a variable it
was never given — placeholder left literal, braces and all — from one passed as
`""`, which renders to nothing, and it validates a tool's *rendered* URL as it
creates a call: an unrendered `{{…}}` is refused with `Got invalid url`. So a
call Retell **accepts** is a call whose routing variables rendered.
`apps/api/test/live-version-lifecycle.test.ts` asks exactly that, twice — every
routing variable `""`, then one of them carrying Egma's address — against a
draft it branches and deletes, on the agent the environment names.

**4. Does a Retell LLM engine route the same way?** ADR-0022's second owed
check: the founder's proof was on a conversation-flow agent, and Retell
documents neither engine's behaviour here. The live fork check above answers it
on the scratch Retell LLM agent it already creates and deletes — the transform
is written onto the branched version, read back, and two web calls are created
against it.

If either ever says no, the fallback is already designed and costs the lifecycle
nothing: write the simulation's identifier into the URL at transform time
instead of as a variable, and branch one temporary version per simulation rather
than one per run. Every step and every guard keeps its exact shape.
