# Egma customer documentation

This directory contains the Mintlify site published at `docs.egma.ai`.
Configuration lives in `docs.json`. Pages use MDX with YAML front matter.

## Content boundary

- Document behavior that exists in the public repository.
- Keep internal plans, research, roadmaps, and private operations out of this directory.
- Trace setup instructions through the complete customer path before publishing them.
- Do not describe proposed behavior as available behavior.

## Product terms

- A **test** describes a situation and its expected behaviors.
- A **test suite** is a project-owned container of tests that are reviewed and
  run together.
- A **run** executes one complete test suite against one agent connection.
- A **simulation** is one test executed once inside a run.
- A **persona** is the synthetic person who talks to the customer's **agent**.
- A **metric** is an observed fact, such as duration or latency.
- A **grader** assigns one normalized score to a trace. A **grade** keeps that
  score, its details, the grader's frozen pass threshold, and a derived
  individual result.
- A **combined score** is the display-only arithmetic mean of all selected
  grader scores. It is not an overall pass/fail verdict.

Do not use `eval`, `evaluator`, `digital human`, or `session` for a simulation.

## Writing style

- Write the product name as **Egma** in prose and interface text. Use lowercase
  `egma` only for commands, packages, URLs, paths, identifiers, and literal values.
- Use active voice and address the reader as “you.”
- Keep sentences short and direct.
- Use sentence case for headings.
- Use bold text for interface labels.
- Use code formatting for file names, commands, paths, fields, and values.
- Prefer one complete working path over several partial examples.

## Checks

- Keep every page in the `docs.json` navigation unless it is intentionally hidden.
- Check internal links and referenced source paths.
- Run the Mintlify preview before publishing a large change.
