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

Drive one approved effort to one open pull request.

You are the coordinator. Dispatch implementation, control the review gates, land ticket branches, and update the tracker. Do not implement tickets yourself.

Implementation can run in parallel. Landing is always serial.

## Completion contract

The effort is complete when:

- every selected ticket is merged into the integration branch;
- every ticket is verified and marked `resolved` in the Planning root;
- the integration branch passes the full test suite against the latest base;
- one final pull request is open against the base branch;
- the final pull request remains unmerged for the user.

## Coordinator heartbeat

Create one repeating monitor for the whole effort before starting the first worker, test run, CI run, or pull-request review.

Use the harness-native monitor or wake-up mechanism. When it is unavailable, wait for no more than 60 seconds and schedule the next check before yielding.

Use this cadence:

- every minute while workers, reviewers, tests, or builds are active;
- every three minutes while waiting only for CI or the pull-request review bot.

Track each active item with its owner, branch, last commit, state, and time of last evidence.

On every heartbeat:

1. Inspect every worker and reviewer.
2. Read new command or test output.
3. Inspect branch commits and worktree state.
4. Poll pull-request checks and review threads.
5. Advance completed work immediately.
6. Record the latest evidence.
7. Schedule the next heartbeat before yielding.

Treat quiet work in stages:

- First quiet heartbeat: continue monitoring.
- Second quiet heartbeat: contact the same worker and inspect its branch, worktree, and command output.
- Third quiet heartbeat: treat it as stalled, diagnose the environment, and resume or replace the worker only after preserving its branch and commits.

Silence is never completion. Verify a terminal state from commits, test output, pull-request state, or a clear agent report.

Keep the heartbeat active while any work is pending. Stop it only when:

- the final pull request is open;
- a user decision is required;
- an external blocker prevents progress and has been reported with evidence.

Cancel the monitor when the coordination run ends. Leave no orphaned monitors. Do not end the coordinator task while non-terminal work remains. Yield to the heartbeat and resume from its next check.

## 1. Resolve the roots

Resolve the Code root and Planning root from repository configuration.

Stop if the Planning root or its `AGENTS.md` is missing. The environment owns repository provisioning.

Read:

- Planning `AGENTS.md`;
- `CONTEXT.md`;
- `docs/agents/issue-tracker.md`;
- relevant ADRs;
- `.scratch/<effort>/spec.md`;
- every ticket under `.scratch/<effort>/issues/`.

Use one shared Planning checkout for the whole effort. Pass its absolute path to every worker and reviewer.

The coordinator is the only Planning writer. Workers and reviewers treat it as read-only.

Record existing changes in both repositories. Preserve unrelated changes. Stop if a selected ticket already has uncommitted changes.

## 2. Build the ticket graph

Select tickets with `Status: ready-for-agent`.

Validate:

- every blocker exists;
- the graph has no cycles;
- resolved blockers are verified;
- every selected ticket has acceptance criteria;
- the effort has at least one unblocked ticket.

The frontier is every selected ticket whose blockers are resolved.

Before dispatch, change each frontier ticket to `Status: claimed`. Commit only the explicit tracker files that changed.

## 3. Create the integration branch

Resolve the repository's default base branch. Do not assume it is `main`.

Create or resume one integration branch for the effort. Follow the environment's required branch prefix.

Create one ticket branch and one Code worktree per frontier ticket. Base each ticket branch on the integration commit recorded at dispatch time.

Push the integration branch so ticket pull requests can use it as their base.

## 4. Dispatch the frontier

Dispatch as many frontier tickets as the current agent harness can run safely. Every ticket gets a stable worker name such as `impl-NN`.

Give each worker:

- its Code worktree path;
- the absolute Planning root;
- the recorded Planning commit;
- the full ticket text;
- the ticket and specification paths;
- the recorded integration base commit;
- the ticket branch name.

Its first action is to read Planning `AGENTS.md`, `CONTEXT.md`, the ticket, specification, and relevant ADRs.

Tell it to:

1. Use `/implement`.
2. Keep Planning read-only.
3. Implement only the ticket.
4. Run focused tests during development.
5. Run typechecking and the full suite.
6. Commit and push the ticket branch.
7. Report what changed, what did not change, and any ticket defect.

A worker that cannot read the Planning root must stop.

Register every dispatched worker and long-running command with the coordinator heartbeat.

## 5. Run the independent review loop

After implementation, send the ticket branch to a separate reviewer.

The reviewer uses `/code-review` with:

- the recorded integration base commit as the fixed point;
- the ticket as the specification;
- the Code worktree as the review target;
- the Planning root as read-only context.

Send findings back to the original implementer. Reuse the same implementer and reviewer for up to three rounds.

The result must be one of:

- `clean`: no findings remain;
- `capped`: findings remain after three rounds;
- `escalated`: the ticket or specification is wrong.

Only `clean` passes the gate. Stop and ask the user about `capped` or `escalated` work.

Register every reviewer with the coordinator heartbeat.

## 6. Run the pull-request review gate

Open a ticket pull request into the integration branch.

Wait for the configured review bot to finish against the latest push. Send valid findings to the original implementer. Answer findings that are not applied.

The gate passes when every review thread is fixed or answered.

If the repository has no configured review bot, report that fact and continue only when repository configuration allows it.

Register CI and pull-request review with the coordinator heartbeat. Let the heartbeat own their polling.

## 7. Land one ticket

Land one clean ticket at a time. Hold one coordinator-owned landing lock from the first refresh through the integration push. No other ticket may land while the lock is held.

Before merging:

1. Fetch and record the current remote integration commit.
2. Send the branch back to its implementer.
3. Update it against that exact integration commit.
4. Resolve conflicts in the ticket branch.
5. Run the full suite.
6. Rerun independent review against that exact integration commit, even when the refresh was conflict-free.
7. Require the refreshed branch to pass the review gate again.
8. Fetch the remote integration branch again and require its commit to equal the recorded commit.
9. Fast-forward the local integration branch to the reviewed ticket branch.
10. Push the integration branch normally. Treat a rejected push as evidence that the remote branch moved; never force it.

If the integration branch moved or the push was rejected, repeat the refresh, full suite, and independent review while keeping landing serial.

The successful guarded push is the merge. Confirm the integration branch remains green, then release the landing lock.

Then update the ticket in the Planning root:

- set `Status: resolved`;
- record the ticket pull request;
- record what landed;
- mark each verified acceptance criterion;
- record what each review gate found.

Commit only that ticket file. Remove its Code worktree after its branch is pushed, merged, and recoverable.

## 8. Advance the frontier

Recompute the graph after every merge.

Dispatch newly unblocked tickets while the next completed ticket moves through the serial landing gate.

## 9. Open the final pull request

After all selected tickets are resolved:

1. Fetch the remote base branch and record its commit.
2. Update the integration branch against that exact base commit.
3. Resolve conflicts on the integration branch.
4. Run the full suite.
5. Run independent `/code-review` against that base commit, using the effort specification and resolved tickets as the specification source.
6. Resolve findings, then repeat the full suite and independent review until the result is clean.
7. Fetch the remote base branch again immediately before pushing and require its commit to equal the recorded commit. If it moved, repeat the final refresh, full suite, and independent review.
8. Push the integration branch.
9. Open one pull request into the base branch.
10. Register the final pull request with the coordinator heartbeat and wait for required CI and review against its current head and base.
11. If the base moves or the checks become stale, repeat the refresh, full suite, independent review, and final pull-request checks.
12. Leave the green pull request open.

Report the final pull request, integration branch, Planning commits, ticket results, and any unresolved risk.

Never merge the final pull request.

## Recovery

Before restarting work, inspect existing branches, worktrees, pull requests, ticket states, and heartbeat state. Resume valid work instead of recreating it.

Silence is not success. Verify branches, commits, test results, and pull-request state directly.

If a worker stops responding, contact the same worker before replacing it. A replacement must read the ticket and branch state from the beginning.

Restore or recreate the coordinator heartbeat before resuming any non-terminal work.
