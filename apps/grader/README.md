# The grader service

This service grades completed traces. It uses the same work path for simulation
traces and production traces.

The service has no HTTP port. It claims temporary jobs from Postgres, reads the
trace from ClickHouse, runs every grader in the frozen plan, and appends one
grade row per project grader to ClickHouse.

## The data model

Three Postgres records control which graders can run:

- A `grader_definition` is the stable library identity and owner.
- A `grader_definition_version` is immutable executable logic, such as a
  prompt, code contract, model, output contract, and compatible modalities.
- A `project_grader` is one project's policy for that definition. It stores the
  scope and the pass threshold.

The temporary grading job freezes the exact definition version, project grader,
scope result, and pass threshold that apply to the trace. Later edits cannot
change work that was already requested.

The durable result is a ClickHouse `grade` row. It contains:

- the trace and project grader identities;
- the exact grader definition version;
- a normalized score from 0 through 1, or `null` when the grader errored;
- structured JSON details, including rationale and optional assertion details;
- the frozen pass threshold; and
- the time when the grade was written.

An errored grader writes `score: null` and a non-empty `details.error`. There is
no separate assertion table. Assertion results stay inside `details`.

ClickHouse keeps every regrade. Reads choose the newest row for each project
grader. When every selected grader has a score, the trace's combined score is
their arithmetic mean. A missing or errored grade leaves the combined score
unavailable. Egma does not create a trace-level, test-level, suite-level, or
run-level pass or fail result in this version.

## What happens for one trace

1. **Request.** Egma requests grading only when the trace is complete and its
   evidence is query-visible in ClickHouse.
2. **Freeze.** The request resolves every matching project grader and stores
   the resulting plan on one temporary Postgres job.
3. **Claim.** One service copy claims the job with `SKIP LOCKED` and a lease.
4. **Read.** The service reads the complete trace. For a simulation, it also
   reads the frozen test version when a grader needs test variables such as
   expected behaviors.
5. **Grade.** All graders in the frozen plan run as one job. A failure in one
   grader becomes an error grade and does not erase sibling results.
6. **Append.** The service appends all grade rows to ClickHouse.
7. **Finish.** Only after the durable append succeeds, the service deletes the
   successful temporary Postgres job. Terminal failed jobs remain for
   operations and diagnosis.

A Postgres notification wakes workers after the job commits. A periodic sweep
is only a backstop for a missed notification or an expired lease.

## When grading starts

A simulation trace can be graded only after the simulation completes and its
trace evidence is query-visible. Failed, canceled, and orphaned simulations do
not receive grades.

A production trace can be graded only after both facts are true:

- a supported agent platform sent an explicit conversation-ended event; and
- ingestion made the trace query-visible in ClickHouse.

A root span or a period of silence does not end a production trace.

If the end event and evidence arrive in either order, the second fact to arrive
creates the work. Replayed events do not create duplicate active jobs.

## Scope

Scope belongs to `project_grader`, not to a test or agent.

Simulation selectors can name:

- all simulations;
- one test suite; or
- one test.

Production scope is either off or a sample percentage from 1 through 100.
Overlapping simulation selectors still run a project grader once. A deleted or
missing selected ID matches nothing and never widens to all. Modality
compatibility is checked before a grader enters the frozen plan.

Expected behaviors is the only product grader in this version. Every project
gets it automatically. It grades every completed simulation, does not grade
production, and customers cannot edit its scope. Customers can edit its pass
threshold.

## Expected behaviors

The expected-behaviors grader reads the list from the simulation's frozen test
version. It makes one model call per behavior in parallel. Each assertion result
is stored inside the grade's `details.assertions` array. The top-level score is
the normalized fraction of behaviors that passed.

One failed assertion does not stop its siblings. If the grader cannot produce a
valid top-level score, it writes one error grade with a null score.

## Judge providers

A model-judged definition version owns its exact provider and model. The
deployment owns provider credentials. A project does not store a separate model
credential.

The selected credential is passed only to the provider adapter. It is not
stored in a definition, job, grade row, rationale, or log.

Tests inject a scripted judge. The optional live smoke test is the only grader
test that calls a real provider.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres control-plane store. |
| `CLICKHOUSE_URL` | required | Trace and grade store. |
| `EGMA_GRADER_CLAIMANT` | `grader-<host>-<pid>` | This worker's claim label. |
| `EGMA_GRADER_CAPACITY` | `4` | Maximum traces graded at once by one worker. |
| `EGMA_GRADER_HEARTBEAT_SECONDS` | `15` | Claim heartbeat interval. |
| `EGMA_GRADER_LEASE_SECONDS` | `120` | Time before a silent claim can be recovered. |
| `EGMA_GRADER_SWEEP_SECONDS` | `30` | Backstop interval for missed notifications. |
| `EGMA_GRADER_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN`, or `ERROR`. |

Provider credential configuration is shared with the other agent services. A
missing credential for a selected model fails the whole job before any grader
runs, so the service never writes a partial set caused by deployment setup.

## Adding a grader executor

Implement the contract in `src/graders/contract.ts` and add it to the roster in
`src/graders/index.ts`. The shared runtime continues to own claims, frozen plans,
trace reads, score validation, error conversion, and ClickHouse writes.

## Tests

```sh
pnpm db:up
npx vitest run apps/grader
```

The focused suite uses real Postgres and ClickHouse stores and a scripted judge.
The live OpenAI smoke test is opt-in:

```sh
TEST_OPENAI_API_KEY=sk-... npx vitest run apps/grader/test/live-openai.test.ts
```
