---
name: write-egma-tests
description: Write, edit, or convert notes into Egma Markdown test files under egma/tests/, including personas and test-level mock-tool answers.
---

# Write Egma tests

An Egma **test** describes one situation for a voice agent and the expected
behaviors that must hold. Egma executes it as one **simulation** per persona.

Write one Markdown file per test in one existing direct suite directory under
`egma/tests/`.

## Read before writing

1. Read `egma/config.yaml`. Use the suite directory named by the task. If none
   is named, inspect only the direct suite manifests. If more than one exists,
   ask which suite. If none exists, ask the developer to run
   `egma suite create <directory> --name <name>`.
2. Read the selected suite's `suite.yaml` and only the existing tests needed to
   avoid duplicates or preserve content the task changes.
3. Read the voice agent's committed prompts and tool definitions when the task
   depends on them.
4. Reuse the format 4 file shape and persona values supplied by Egma, supplied
   in the task, or already present in the repository.
5. Leave `.env` files unread. Work from committed source and the facts supplied
   by the developer.

If more than one voice agent could be the target, stop and ask which one. A
test for the wrong agent is not useful even when its Markdown is valid.

## Write a new test

Use the smallest new-file shape that says the authored intent. Egma adds its
sync fields after the file is pushed or pulled. The example assumes that the
real `check_availability` tool returns an object with a `slots` list. Verify the
actual tool contract before using this answer shape.

````markdown
---
format: 4
name: missed-appointment-reschedule
description: The person missed an appointment and needs another time this week.
personas:
  - name: Everyday person
---
## Scenario
The person missed yesterday's appointment and wants another one this week.
They are short of time and already annoyed.
## Expected behaviors
1. The agent acknowledges the missed appointment without blaming anyone.
2. The agent offers at least two other times.
3. The agent repeats the new time before it ends.
## Mock tools
### check_availability
```json
{ "answer": { "slots": ["Wednesday 15:00", "Thursday 11:00"] } }
```
````

Apply these rules:

- Make `name` lower case with hyphens and match the file name.
- Keep `description` short and useful in a list. Omit it when the name already
  says enough.
- Under `## Scenario`, state what the person wants and the conditions that make
  the test useful. Write a situation, not a script.
- Under `## Expected behaviors`, follow the judgeable-behavior rules below.
- Add `## Mock tools` when this test depends on a specific backend state — an
  empty calendar, a lookup that fails, an answer that takes three seconds.
  Otherwise leave the section out.
  - A mock tool represents an external dependency. Keep agent-runtime tools
    real: tools that complete a task, advance or hand off a workflow, stop the
    voice agent, validate data already held by the agent, or update in-memory
    state. In LiveKit, this includes tools whose body invokes
    `AgentTask.complete` or
    advances a `TaskGroup`. Replacing their implementation can stop the
    workflow.
  - Where the project already has a mocked world in `egma/mock-tools.md`, a
    block here replaces that world's answer for this test alone. Do not repeat
    an answer the project file already gives.
  - Where the project has no mocked world, a block here is the only answer Egma
    will serve for that tool, and every tool without one runs for real.
  - Name the real tool in a `###` heading. Put exactly one of `answer` or `error`
    in its JSON block. Add `delay_ms` when the answer must be delayed; write it
    as a whole number of milliseconds from 0 through 30000. For example, three
    seconds is `"delay_ms": 3000`. Make `answer` the same JSON shape that the
    real tool returns. Do not infer that shape from this example.

## Name a persona

Name at least one persona under `personas` in every test, because a test says
who speaks to the agent. Egma refuses a test that names none, so a file without
the line is a file the push turns away. Use a name or id already supplied by
Egma or already present in this repository.

Treat ids and sync pins as references, not prose. Inventing an id makes the
file point at something that does not exist.

## Edit an existing test

Preserve every machine-owned field already in the frontmatter, including:

- `format`
- `version`
- `identity_revision`
- persona ids and their display names

Preserve authored fields that the task does not change, including description,
personas, expected behaviors, and mock tools. Make the
smallest edit that completes the developer's request.

## Write judgeable expected behaviors

- When the task asks you to generate tests, write three expected behaviors by
  default. Add a fourth only for a distinct critical safety or completion
  requirement. Never write more than four expected behaviors in one generated
  test.
- Keep the behaviors specific to this test situation. Put a general requirement in
  its own focused test instead of repeating it across every test in a suite.
- Make each expected behavior judgeable in one simulation: write one observable,
  unconditional claim per item.
- Put the branch condition in `## Scenario`; use a separate test for each
  other branch.
- Ground each statement in the voice agent's prompt, tools, or stated product
  requirement.
- Cover the ordinary path, important refusals, weak tool answers, and difficult
  user behavior when they matter to the task.
- Keep transport details out of a behavioral test.

An expected behavior is a product requirement, not a way to force a high
grade score. Keep it strict when the requirement is real.

## Finish locally

Read every changed file back. A test file is complete only when:

- its YAML frontmatter opens and closes and contains only `format`, `name`,
  `description`, `personas`, `version`, and `identity_revision`;
- `format` is `4`, its name matches the file name, and it names at least one
  persona by a value supplied by Egma or already present in the repository;
- `## Scenario` contains a situation, `## Expected behaviors` contains at least
  one judgeable numbered statement, and both required headings exist; and
- every mock-tool block is a JSON object with exactly one of `answer` or `error`
  and, when present, a whole-number `delay_ms` from 0 through 30000.

Stop after the requested local files are correct. Run `egma push` or `egma run <suite-directory>`
only when the developer asks for that next action.
