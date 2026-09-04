---
name: write-egma-tests
description: Write, edit, or convert notes into Egma Markdown tests, including personas, mock-tool answers, and the env a test runs in.
---

# Write Egma tests

An Egma **test** describes one situation for a voice agent and the expected
behaviors that must hold. It also carries the world that situation happens in:
the **mock tools** it answers for itself, and the **env** the call starts with.
Egma executes it as one **simulation** per persona.

**Only what a test names is mocked. Everything else runs for real.** A test
naming no mock tool runs the agent against its real backend from end to end, so
"the calendar is full" and "the calendar is open" are two tests, each naming one
tool.

Write one Markdown file per test in the direct suite directory that the CLI
created. Run `npm install --global egma-cli` if the `egma` command is unavailable. Read
current help before using an operation; it owns command syntax and file
locations.

## Read before writing

1. Let the CLI inspect its repository state and locate the suite named by the
   task. If more than one suite remains possible, ask which suite. If none
   exists, use `integrate-egma` so the CLI creates the scaffold before this
   focused authoring skill writes tests.
2. Read the selected CLI-created suite metadata and only the existing tests
   needed to avoid duplicates or preserve content the task changes.
3. Read the voice agent's committed prompts and tool definitions when the task
   depends on them.
4. Reuse the test-file shape and persona values supplied by the current CLI,
   supplied in the task, or already present in the repository. If no valid
   persona value is present, use the current read-only persona-list operation
   and only a returned name or stable ID.
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
format: 5
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
## Env
```json
{ "retell_dynamic_variables": { "caller_name": "Margaret" } }
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
  empty calendar, or a lookup that fails. Otherwise leave the section out.
  - A mock tool represents an external dependency. Keep agent-runtime tools
    real: tools that complete a task, advance or hand off a workflow, stop the
    voice agent, validate data already held by the agent, or update in-memory
    state. In LiveKit, this includes tools whose body invokes
    `AgentTask.complete` or
    advances a `TaskGroup`. Replacing their implementation can stop the
    workflow.
  - A mock tool belongs to the test that writes it. A block here is the only
    answer Egma serves for that tool in this test, and every tool without one
    runs for real. There is no project-wide list and no file outside the test.
  - Name the real tool in a `###` heading, spelled exactly as the agent
    registers it. A name that matches no tool of the agent answers nothing and
    leaves no trace on the record.
  - Put exactly one of `answer` or `error` in its JSON block, and nothing else.
    Make `answer` the same JSON shape that the real tool returns. Do not infer
    that shape from this example. Use `error` to force the failure branch.
  - Name each tool at most once. Matching is by name only; a mock tool never
    reads a call's arguments.
- Add `## Env` when this test needs the agent started in a specific world. Write
  one JSON block holding at most these two keys, and leave the section out when
  the test needs neither:
  - `retell_dynamic_variables`: the values Retell substitutes into the agent's
    prompt and tool configuration for the call, as an object of text values. A
    name beginning `egma_` is reserved and refused, because Egma keeps those for
    what it says to the simulator itself.
  - `job_dispatch_metadata`: the JSON object the LiveKit worker reads at
    `ctx.job.metadata`, written to the dispatch byte for byte.
  - One test may hold both keys. On a run, the key for the other platform is
    simply not used, and the run says so.

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
personas, expected behaviors, mock tools, and env. Make the smallest edit that
completes the developer's request.

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
- `format` is `5`, its name matches the file name, and it names at least one
  persona by a value supplied by Egma or already present in the repository;
- `## Scenario` contains a situation, `## Expected behaviors` contains at least
  one judgeable numbered statement, and both required headings exist;
- every mock-tool block is a JSON object with exactly one of `answer` or
  `error`, and nothing else; and
- any `## Env` block is one JSON object holding at most
  `retell_dynamic_variables` and `job_dispatch_metadata`, with no variable name
  beginning `egma_`.

Use the current local validation operation after reading the changed files
back. Fix every named local problem and repeat it until validation succeeds.
Stop after the requested local files are valid unless the active task also asks
to publish or run them. An end-to-end setup request already includes those
normal next steps.
