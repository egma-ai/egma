---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

<!-- path-routing:start -->
Repository configuration overrides this skill's default planning paths.
If a Planning root is defined, resolve `CONTEXT.md`, `docs/adr/`,
`docs/agents/`, `.scratch/`, and `.out-of-scope/` from that root.
Skill-local paths remain unchanged.
<!-- path-routing:end -->

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work.

Commit your work to the current branch.
