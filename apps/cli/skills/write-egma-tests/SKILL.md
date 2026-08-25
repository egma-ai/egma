---
name: write-egma-tests
description: Write or edit Egma Markdown tests inside an existing egma/tests/<suite-directory>/ for a voice agent. Use when creating test situations, expected behaviors, persona-specific tests, or test-level mock-tool answers, including when converting existing test notes into Egma files.
---

# Write Egma tests

An Egma **test** describes one situation for a voice agent and the expected
behaviors that must hold. Egma executes it as one **simulation** per persona.

Write one Markdown file per test in one existing direct suite directory under
`egma/tests/`. Keep each test reviewable as ordinary repository content.

## Read before writing

1. Read `egma/config.yaml`, every direct suite manifest, and the existing test
   files. Use the suite directory named by the task. If none is named and more
   than one exists, ask which suite. If no suite exists, ask the developer to
   run `egma suite create <directory> --name <name>`.
2. Read the voice agent's committed prompts and tool definitions when the task
   depends on them.
3. Reuse the format 4 file shape and known persona values already present in
   the selected suite.
4. Leave `.env` files unread. Work from committed source and the facts supplied
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
- Under `## Expected behaviors`, write at least one numbered statement. Keep
  each statement observable in the transcript or tool record.
- Add `## Mock tools` when this test depends on a specific backend state — an
  empty calendar, a lookup that fails, an answer that takes three seconds.
  Otherwise leave the section out.
  - Where the project already has a mocked world in `egma/mock-tools.md`, a
    block here replaces that world's answer for this test alone. Do not repeat
    an answer the project file already gives.
  - Where the project has no mocked world, a block here is the only answer Egma
    will serve for that tool, and every tool without one runs for real.
  - Name the real tool in a `###` heading. Put either `answer` or `error` in its
    JSON block. Make `answer` the same JSON shape that the real tool returns. Do
    not infer that shape from this example.

## Handle personas carefully

Omit `personas` for the project's default persona. Name a persona only when the
test depends on who speaks to the agent. Use a name or id already supplied by
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

## Write strong expected behaviors

- Write one observable statement per item.
- Ground each statement in the voice agent's prompt, tools, or stated product
  requirement.
- Cover the ordinary path, important refusals, weak tool answers, and difficult
  user behavior when they matter to the task.
- Keep transport details out of a behavioral test.

An expected behavior is a product requirement, not a way to force a high
grade score. Keep it strict when the requirement is real.

## Finish locally

Read every changed file back. Confirm that its YAML frontmatter closes, its two
required headings exist, its expected-behavior list is not empty, and every
mock-tool JSON block parses.

Stop after the requested local files are correct. Run `egma push` or `egma run <suite-directory>`
only when the developer asks for that next action.
