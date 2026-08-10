---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
---

<!-- path-routing:start -->
Repository configuration overrides this skill's default planning paths.
If a Planning root is defined, resolve `CONTEXT.md`, `docs/adr/`,
`docs/agents/`, `.scratch/`, and `.out-of-scope/` from that root.
Skill-local paths remain unchanged.
<!-- path-routing:end -->

Run a `/grilling` session, using the `/domain-modeling` skill.
