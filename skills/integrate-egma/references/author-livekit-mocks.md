# Author the LiveKit mocked world

Use this phase only for LiveKit testing or both, after the first tests exist and
the worker has Egma's testing entry.

## Classify the real tools

Read the tool definitions and handlers used by the selected agent. A tool is an
external dependency when its implementation crosses the agent process to a
database, API, queue, file service, calendar, payment system, or another
service. Give each external-dependency tool one grounded default answer in
`egma/mock-tools.md`.

Keep agent-runtime tools real. This includes tools that complete a task, change
or hand off the agent workflow, stop the agent, validate state already held in
the process, or update in-memory state. In LiveKit, a tool that calls
`AgentTask.complete` or advances a `TaskGroup` is agent-runtime control. When
one implementation mixes an external effect with runtime control and the two
cannot safely be separated, report it and stop before a simulation reaches the
real effect.

## Write grounded answers

Preserve the file's existing prose and `## Mock tools` heading. Add one `###
<real-tool-name>` heading and one JSON object for each external dependency:

````markdown
### check_availability
```json
{
  "answer": { "slots": ["2026-09-01T09:00:00Z"] }
}
```
````

Use exactly one of `answer` or `error`. Add a whole-number `delay_ms` from 0
through 30000 only when timing is part of the test. Match the real tool's
return or error shape from source; do not invent fields or call the real
backend to obtain sample data.

Put a different answer inside one test's `## Mock tools` section only when that
test needs a specific branch. The `write-egma-tests` skill owns those test
overrides. Read the completed project file and changed tests back, then let
`egma validate` prove their syntax before review.
