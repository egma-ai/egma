---
name: coordinate-implementation
description: "Drive a whole ticketed effort to done — dispatch each ticket to its own implementation sub-agent, gate it behind a review sub-agent that talks back to the implementer until the findings stop, and fold every ticket into one integration branch that ends as a single open PR into main. Use when the user has a set of tickets and wants the effort built, not one ticket."
argument-hint: "Which effort's tickets to drive"
disable-model-invocation: true
---

# Coordinate Implementation

Drive a set of tickets to done. You are the **coordinator** — you dispatch the code, gate it, land it, and keep it alive. You do not write it.

Every ticket passes three gates: **implementation** by a sub-agent, a **review loop** between that sub-agent and a reviewer, then **the PR review bot**.

The loop is the reason this runs in conversation rather than as a script. A finished sub-agent that receives a message wakes up with its context intact, so the reviewer's findings go back to the agent that wrote the code and the fix costs almost nothing. Give every agent a name when you spawn it — that is what makes it addressable afterwards.

**One harness difference, and it is mechanical.** Waking a finished agent and messaging one agent from another work on both Claude Code and Codex. Isolation differs only in who does it: Claude Code takes an `isolation: "worktree"` flag, while Codex has no such flag, so cut the worktree yourself with `git worktree add` and give each agent its path. Same result, one extra command.

The branches fan out and back in. One **integration branch** per effort, cut from `main`. One **ticket branch** per ticket, cut from the integration branch and merged back into it. The integration branch ends as one PR into `main`, so `main` stays shippable and the user gets one branch to test and one PR to review.

**Never merge into `main`.** The final merge is the user's.

The issue tracker should have been provided to you — run `/setup-matt-pocock-skills` if it is missing.

## The whole context, in every worktree

A worktree carries tracked files only. Anything this repo ignores is absent from a fresh one, and nothing announces the absence.

The tracker does not live here, and `AGENTS.md` reaches it with a conditional: read it if it is in your checkout, carry on if it is not. **In a fresh worktree it is never there.** So a dispatched agent takes the second branch and builds without the ticket it was given, without the settled vocabulary, and without knowing either existed. Nothing errors. The work comes back fluent and unmoored — and the reviewer, in an identical worktree, grades it against the same blank.

So a worktree is not ready when the code is in it. Cut the code worktree, then cut the tracker into it, at the path `AGENTS.md` names:

```
git -C <tracker-repo> fetch origin
git -C <tracker-repo> worktree add --detach <agent-worktree>/<path> origin/main
```

`--detach` is what lets this happen more than once. A branch can be checked out in one worktree only, so the second agent that asks for `main` is refused outright; detached, every agent gets its own copy at the same commit. Fetch first, so an agent dispatched later sees tracker updates you have already landed.

The path is already ignored here, so no agent can commit it into this repo by accident.

**Agents read the tracker. Only you write it** — on `main`, in your own checkout. A commit made on a detached HEAD inside an agent's copy is unreachable the moment that worktree is removed.

## Per-ticket checklist

Copy this for each ticket and tick it off as you go:

```
NN — <ticket>
- [ ] worktree cut, with the tracker in it
- [ ] branch <effort>-tNN cut from <effort>
- [ ] implemented, full suite green
- [ ] review loop closed — clean, or capped and reported
- [ ] PR opened against <effort>
- [ ] every PR review bot thread fixed or answered
- [ ] re-run against the exact head it merges into, still green
- [ ] merged into <effort>, ticket recorded
```

## Process

### 1. Read the tickets, build the graph

Fetch every ticket in the effort and read each in full, including its **Blocked by** line and its status.

Reject before spending: cycles, blockers that do not exist, tickets that are not `ready-for-agent`.

The **frontier** is every ticket whose blockers are all merged into the integration branch.

Show the user the graph and the first wave in a few lines, then start. Stop only for a broken graph, an ambiguous effort name, or a ticket that is not ready.

### 2. Cut the integration branch

Read the branch and the working tree now — parallel sessions move checkouts.

Fetch, cut `<effort>` from `origin/main` if it does not exist, and push it so ticket PRs have a base.

### 3. Dispatch the whole frontier at once

One message, one `Agent` call per frontier ticket, so they run in parallel. Each gets:

- **A name**: `impl-NN`. Unnamed agents cannot be messaged later, and a name reused across tickets makes a send refuse rather than reach the wrong agent.
- **Opus 5 at the highest reasoning effort available.**
- **Its own worktree, with the tracker in it.** Parallel agents must never share a checkout. On Claude Code the code worktree comes from the `isolation: "worktree"` flag; on Codex there is no such flag, so cut it yourself with `git worktree add` and pass the path. The tracker is yours to cut either way — no harness flag knows about a second repo.
- **A self-contained prompt**: the ticket in full; where its worktree is and where the tracker sits inside it; branch `<effort>-tNN` based on the integration branch; follow `/implement` — TDD at pre-agreed seams, typecheck and single test files often, full suite at the end; push the ticket branch and stop there.
- **A reporting brief**: branch, commits, what it built, what it deliberately did not build, anything it found that the ticket got wrong.

Agents run in the background and report as they finish. Take each one as it lands rather than waiting for the set — the moment a ticket's last blocker merges, dispatch it.

### 4. The review loop

Spawn `review-NN` **after** `impl-NN` exists, never before. Where the roster of siblings an agent may message is a snapshot taken when it starts, a reviewer spawned first cannot see the implementer at all.

The reviewer runs `/code-review` on the ticket branch: the integration branch as the fixed point, the ticket as the spec. It is not the implementer, because an author reviewing its own work shares its blind spot. It reports findings and changes no code.

It needs the tracker too, cut the same way — a reviewer that cannot read the ticket cannot check the code against it, and grades the work against its own guess instead. That is worse than no review, because it reports back clean.

Then loop, up to three rounds: findings go to `impl-NN`, which fixes what is right and answers what is wrong rather than obeying it; `review-NN` re-checks. Keep the same two agents throughout. The reviewer remembers what it already raised and what was answered, so nothing rejected comes back, and independence was established the moment it was not the author.

The loop ends in one of three states, and you report which:

- **Clean** — a round raised nothing new.
- **Capped** — three rounds ran and findings remain. Name them. A cap that goes unreported reads as a pass.
- **Escalated** — the finding is not a code fault; the ticket is wrong. Land what is sound, leave the ticket open, and bring it to the user.

### 5. Land

`impl-NN` opens the PR against the **integration branch** and works the PR review bot. It still holds the context, so a fix is cheap.

The bot's comments arrive minutes after the PR opens, sometimes in waves as later pushes get re-reviewed. Fix in the same branch, never a follow-up PR. Reply on the thread when a comment is wrong and it is not acting on it, so the record shows the comment was weighed. Ready when every thread is fixed or answered.

**You merge, not the agent.** Only you know what else is in flight. Read the git state before every merge.

**One rule governs landing: a branch may merge only if its last full-suite run was against the exact commit it is merging into.** Everything else here follows from that.

Every merge moves the integration head, so every other open branch fails the rule the instant one lands. They were built and reviewed against a head that no longer exists. Git stops a textual conflict; it does not stop a sibling that renamed what this branch still calls, or changed a behaviour this branch still assumes — the merge is clean and the suite is broken.

So land one branch at a time, and refresh only the branch you are landing next: send it back to its `impl-NN` to take the current head and re-run the full suite, then merge it while that head still stands. It holds the context, so each refresh is cheap.

Refreshing the whole queue at once looks faster and is not. The first merge invalidates every run still in flight, and those branches have to go round again — the same staleness, one level down. Implementation stays parallel; only landing is serial. That is the price of an integration branch that is green at every commit rather than green at the end.

Record the outcome on the ticket once it is merged and green — status resolved, the PR, what landed, what each gate found. That commit goes wherever the tracker lives, from your own checkout, not this repo and not an agent's.

### 6. Advance

A ticket is done when it is merged. Recompute the frontier and dispatch whatever just came unblocked. Immediately.

### 7. Close the effort out

When every ticket has folded in, merge the latest `main` **into** the integration branch and resolve the conflicts there, not in the final PR. Run the full suite. The tickets have already met each other one merge at a time; this is where they meet everything else that landed on `main` while you worked.

Open one PR, integration branch → `main`, and **leave it open**.

Report the branch to check out, the PR to review, and per-ticket status.

## Sequencing

A wide refactor cannot be split into parallel rewrites of the same call sites. Expand, migrate in batches, contract — the batches share the integration branch, and green is promised only at the end.

## Keeping it alive

Nothing supervises this but you.

- **Silence is not success.** Check the branch — does it exist, does it carry commits, does the suite pass? Never mark a ticket done on an absent report, and never guess at a pending agent's result.
- **An agent that never quotes its ticket probably cannot see it.** A missing tracker raises nothing; it just reads as an agent working from a thin brief. Check the path before you accept the work.
- **Message before you respawn.** A stalled agent still holds everything it knew, and a message wakes it. A fresh agent starts from nothing.
- **A whole quiet wave means the machine, not the model** — a dead container daemon, a missing service, a command that failed for permissions without saying so. Fix it and resume; the work on the branches normally survives.
- **Give suites and builds generous timeouts**, and poll on the work's cadence.
