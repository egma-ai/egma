---
name: coordinate-implementation
description: Drive one ticketed effort through parallel implementation, independent review, serial integration, and one open pull request.
disable-model-invocation: true
---

<!-- path-routing:start -->
Repository configuration overrides this skill's default planning paths.
If a Planning root is defined, resolve `CONTEXT.md`, `docs/adr/`,
`docs/agents/`, `.scratch/`, and `.out-of-scope/` from that root.
Skill-local paths remain unchanged.
<!-- path-routing:end -->

# Coordinate Implementation

Coordinate one approved effort. Dispatch workers, control review gates, land ticket branches, and update the tracker. Keep implementation parallel and landing serial. Leave implementation to workers.

## Completion contract

The effort is complete when:

- every selected ticket is on the integration branch;
- every ticket is verified and marked `resolved` in the Planning root;
- the integration branch passes the full test suite against the latest base;
- one final pull request is open, green, and unmerged for the user.

## Completion notifications and watchdogs

Use harness completion notifications for workers and reviewers. Use bounded polling only for external systems.

Register each agent and long-running command with its owner, branch, last commit, state, last evidence, and a watchdog deadline 15 minutes later. Wait for the next harness event, command event, or nearest deadline.

On completion, verify a durable terminal result, cancel the watchdog, and advance the work. On timeout:

1. Inspect the harness state, branch, worktree, and command output once.
2. Reset the 15-minute deadline when a progress report, new output, commit, or external state change proves progress.
3. Otherwise ask the same worker for a status report and checkpoint.
4. After another 15 minutes without evidence, preserve its branch and commits, diagnose the environment, then resume or replace it.

Silence is never completion.

CI and pull-request review bots are external systems and might not send harness notifications. Poll each pending external system with a bounded wait of at most three minutes. Stop polling as soon as it reaches a terminal state.

Keep the coordinator active until:

- the final pull request is open and its required checks are green;
- a user decision is required;
- an external blocker prevents progress and has been reported with evidence.

Cancel all watchdogs and external monitors when coordination ends.

## 1. Resolve the roots

Resolve the Code and Planning roots from repository configuration. Stop if the Planning root or its `AGENTS.md` is missing; the environment owns provisioning.

Read:

- Planning `AGENTS.md`;
- `CONTEXT.md`;
- `docs/agents/issue-tracker.md`;
- relevant ADRs;
- `.scratch/<effort>/spec.md`;
- every ticket under `.scratch/<effort>/issues/`.

Use one shared Planning checkout. The coordinator is its only writer; pass its absolute path to workers and reviewers as read-only context.

Record existing changes in both repositories and preserve unrelated work. Stop when uncommitted work overlaps a selected ticket.

## 2. Preflight user inputs

Before branches, claims, or dispatch, read the specification and every ticket. Predict user-only inputs: credentials, access, infrastructure, datasets, devices, phone numbers, fixtures, approvals, and product decisions.

Inspect configured environment and secret locations first. Confirm availability without printing values. Ask once for all missing inputs, grouped by ticket with the reason and `hard blocker` or `optional`. Use the secure secret workflow, not chat.

Start after all hard blockers are available or the user narrows the effort. State when preflight needs no input.

## 3. Build the ticket graph

Select tickets with `Status: ready-for-agent`.

Require every blocker to exist, no cycles, verified resolved blockers, acceptance criteria on every selected ticket, and at least one unblocked ticket.

The frontier is every selected ticket whose blockers are resolved.

Before dispatch, change each frontier ticket to `Status: claimed`. Commit only the explicit tracker files that changed.

## 4. Create the integration branch

Resolve the repository's default base branch. Do not assume it is `main`.

Create or resume one integration branch using the required branch prefix. Create one ticket branch and Code worktree per frontier ticket, based on the integration commit recorded at dispatch.

Push the integration branch so ticket pull requests can use it as their base.

## 5. Dispatch the frontier

Dispatch as many frontier tickets as the harness can run safely. Give each worker a stable name such as `impl-NN`.

Give each worker:

- its Code worktree path;
- the absolute Planning root;
- the recorded Planning commit;
- the ticket and specification paths;
- the recorded integration base commit;
- the ticket branch name.

Require its first action to read Planning `AGENTS.md`, `CONTEXT.md`, the ticket, specification, and relevant ADRs. Tell it to:

1. Use `/implement`.
2. Keep Planning read-only.
3. Implement only the ticket.
4. Commit and push the ticket branch.
5. Report what changed, what did not change, and any ticket defect.

A worker that cannot read the Planning root must stop.

## 6. Run the independent review loop

After implementation, send the ticket branch to a separate reviewer.

The reviewer uses `/code-review` with:

- the recorded integration base commit as the fixed point;
- the ticket as the specification;
- the Code worktree as the review target;
- the Planning root as read-only context.

Send findings to the original implementer. Reuse the same implementer and reviewer for up to three rounds.

The result must be one of:

- `clean`: no findings remain;
- `capped`: findings remain after three rounds;
- `escalated`: the ticket or specification is wrong.

Only `clean` passes. Ask the user about `capped` or `escalated` work.

## 7. Run the pull-request review gate

Open a ticket pull request into the integration branch.

Wait for the configured review bot against the latest push. Send valid findings to the original implementer and answer findings that are not applied. Pass when every thread is fixed or answered.

If the repository has no configured review bot, report that fact and continue only when repository configuration allows it.

Track CI and review with the bounded external wait loop.

## 8. Land one ticket

Land one clean ticket at a time. Hold one coordinator-owned landing lock from the first refresh through the integration push.

Before landing:

1. Fetch and record the current remote integration commit.
2. Send the branch back to its implementer.
3. Update it against that exact integration commit.
4. Resolve conflicts in the ticket branch.
5. Run the full suite.
6. Rerun independent review against that exact integration commit, even when the refresh was conflict-free.
7. Push the reviewed refresh to the ticket branch.
8. Run the pull-request review gate against that pushed commit.
9. If either gate causes changes, have the implementer commit and push them, then repeat the full suite and both gates against that commit.
10. Fetch the remote integration branch again and require its commit to equal the recorded commit.
11. Fast-forward the local integration branch to the reviewed ticket branch.
12. Push normally. A rejected push means the remote moved; never force it.

If the integration branch moved or the push was rejected, repeat the whole landing gate while keeping landing serial.

The guarded push is the merge. Confirm the integration branch remains green, then release the lock.

Then update the ticket in the Planning root:

- set `Status: resolved`;
- record the ticket pull request;
- record what landed;
- mark each verified acceptance criterion;
- record what each review gate found.

Commit only that ticket file. Remove its Code worktree after the branch is pushed, landed, and recoverable.

## 9. Advance the frontier

Recompute the graph after every landing.

Dispatch newly unblocked tickets while the next completed ticket moves through the serial landing gate.

## 10. Open the final pull request

After all selected tickets are resolved:

1. Fetch the remote base branch and record its latest commit.
2. Update the integration branch against that exact base commit.
3. Resolve conflicts on the integration branch.
4. Run the full suite.
5. Run independent `/code-review` against that base commit, using the effort specification and resolved tickets as the specification source.
6. Resolve findings, then repeat the full suite and independent review until the result is clean.
7. Push the integration branch.
8. Open one pull request into the base branch.
9. Wait for required CI and review with the bounded external wait loop.
10. Leave the green pull request open.

The open green pull request is the handoff. Later base movement does not restart coordination; the user decides when to update or merge it.

Report the final pull request, integration branch, Planning commits, ticket results, and any unresolved risk.

## Recovery

Before restarting work, inspect existing branches, worktrees, pull requests, ticket states, and watchdog state. Resume valid work instead of recreating it.

If a worker stops responding, contact the same worker before replacing it. A replacement must read the ticket and branch state from the beginning.

Restore or recreate watchdog deadlines and external waits before resuming any non-terminal work.
