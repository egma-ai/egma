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
  type, grading instructions, settings contract, and
  compatible modalities.
- A `project_grader` is one project's policy for that definition. It stores the
  scope, complete setting values (including the LLM provider and model), and the
  pass threshold. Custom definitions are owned by the same project. Egma
  definitions are shared across projects.

The temporary grading job freezes the exact definition version, project grader,
setting values, scope result, and pass threshold that apply to the trace. Later
edits cannot change work that was already requested.

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

Expected behaviors is the only grader that every project gets automatically. It
grades every completed simulation, does not grade production, and customers
cannot edit its scope. Customers can edit its model and pass threshold.

Response latency is an optional Egma grader. A project chooses whether to use
it, where it applies, its Maximum response time (p90) setting, and its pass
threshold. It bounds the p90 of the conversation's turn response latencies,
which is the reduction the simulation page also leads with. A custom LLM grader
is visible only in its owning project.

## LLM grading

Every LLM grader uses the same executor. The stable Expected behaviors ID does
not select a special execution path. The saved prompt controls what is graded.
A custom clone of that prompt can produce the same multi-criterion result.

The executor makes one model request per trace. It sends the saved instruction
as `instruction_1`, the simulation's frozen expected behaviors as
`behavior_1..N`, and the existing transcript, ending outcome, tool names and
arguments, and observed metrics. Production sends no test behaviors. Tool
return payloads are excluded.

The provider response must be exactly a `results` array whose entries have
`id`, `decision`, `rationale`, and `cited_turns`. Validation accepts either the
single instruction result or the complete nonempty behavior set. It rejects
extra properties, empty or partial results, mixed families, duplicate or
unknown IDs, invalid decisions, and citations outside the supplied transcript.
It cannot prove that a structurally complete family matches the prompt's intent.

Each `met` contributes one and each `not_met` contributes zero. The top-level
score is the fraction of criteria met, so two of three is `2/3`. Any
`cannot_determine` makes the top-level score null while retaining all decisions,
reasons, turn citations, and resolved span citations in `details.assertions`.
Malformed responses and failed calls also yield an error grade with a null
score. Sibling graders still execute independently.

## Response latency

The response-latency grader reads the existing `turn_response_latency` metric
and computes its p90. It returns `1` at or below the project's frozen maximum
and `0` above it. Missing latency evidence produces an error grade.

Customers cannot run custom code. Trusted Egma code executors live in this
repository and are selected by their stable definition ID.

## Judge providers

A project saves its exact provider and model in `parameter_values`. A grading
plan copies those settings before execution. Later core releases, model edits,
removal, delayed claims, and retries cannot replace the frozen choice. Settings
edits do not create core versions. Only edits to a current custom prompt create
a new core; historical and Egma-owned cores are read-only.

The deployment owns provider credentials. A project does not store a separate
model credential.

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
| `EGMA_GRADER_INGESTION_LOG_DIR` | `/var/lib/egma/grader-ingestion` | Persistent local log for paid judge usage. Mount a separate writable volume here; the grader does not use the API ingestion log directory. |

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
