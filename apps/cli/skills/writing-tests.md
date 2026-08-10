---
name: writing-tests-for-a-voice-agent
description: Write egma tests for a voice agent as markdown files in the developer's repository — the file format, what makes an expected behavior worth having, and the marker lines egma reads progress from.
---

# Write tests for this voice agent

egma is driving you. A **test** describes one situation to put a voice agent
in, and says what should happen. egma runs each test as a **simulation**: a
**persona** — the synthetic person on the other end — speaks with the agent,
and egma grades what happened against the test's **expected behaviors**.

Your job is to write those tests as files. One test, one file.

## The file format

Each file goes in `egma/tests/` and is named after the test:
`egma/tests/missed-appointment-reschedule.md`.

```markdown
---
name: missed-appointment-reschedule
personas: [impatient-regular]
---
## Scenario
The person missed yesterday's appointment and wants another one this
week. They are short of time and already annoyed.
## Expected behaviors
1. The agent acknowledges the missed appointment without blaming anyone.
2. The agent offers at least two other times.
3. The agent repeats the new time back before it ends.
```

Rules for the file, and none of them is optional:

- **`name`** is lower case, with hyphens between words, and it says what the
  situation is. It matches the file name.
- **`personas`** is a list, and you usually leave the whole line out. egma has
  a default persona and it applies to every test that names nobody. Name one
  only when the situation is *about* a particular kind of person — somebody in
  a hurry, somebody with a strong accent, somebody who will not give a name.
  **The task below says which personas egma has. Never name one that is not on
  that list**: egma resolves the name when the file is uploaded, and a name it
  does not know is a test it throws away.
- **Never write a `version:` line.** egma writes that itself when the file and
  the platform are next put in step.
- **`## Scenario`** is prose. Two or three sentences: what the person wants,
  and the circumstances that make it interesting.
- **`## Expected behaviors`** is a numbered list, and **there is always at
  least one**. A test with none can never fail, so egma refuses it and the
  developer is told a file was thrown away. Two to four is a good number.
- **`## Mock tools`** is optional, comes last, and you leave it out unless the
  task below names the tools egma answers for. It is how one test asks for a
  different answer from one of the agent's tools — an empty calendar, a booking
  service that is down — and it looks like this:

  ```markdown
  ## Mock tools
  ### check_availability
  ```json
  { "answer": { "slots": [] } }
  ```
  ```

  The heading is the tool's name, exactly as the agent registers it. The block
  holds `answer` with what the tool returns, or `error` with the failure it
  raises — one of the two, never both.

## What makes an expected behavior worth having

- **One statement, one line.** Split "asks for the order number and reads it
  back" into two.
- **Observable.** Something a reader could point at in a transcript: the agent
  said it, asked it, used a tool, ended without doing it.
- **True whether the agent is spoken to or typed at.** A test never mentions
  voice, audio, phones or typing — the same test is run both ways on purpose,
  and the difference between the two is the most useful thing egma reports.
- **Grounded in the words the agent actually runs on.** If the prompt says
  never to quote a price, then "the agent does not quote a price" is a real
  expectation. If the prompt says nothing about it, you are inventing a rule
  nobody wrote.

Write the situations a developer would be uneasy about: the ordinary path, the
paths the prompt tells the agent to refuse, the paths where a tool answers
nothing useful, and the ones where the person is difficult, silent, or wrong.

## How to report: marker lines

egma shows the developer a list that fills in as you work. It reads these lines
and nothing else, so a file you do not announce is a file nobody watches
arrive. Put each one at the very start of a line, with no bullet, no number and
no code fence around it:

```
egma:plan missed-appointment-reschedule, refuses-to-give-a-name, tool-says-nothing
egma:writing missed-appointment-reschedule
egma:wrote missed-appointment-reschedule
```

- `egma:plan` — every test you mean to write, once, **before you write any of
  them**, separated by commas.
- `egma:writing <name>` — you have started on that one.
- `egma:wrote <name>` — that one is on disk. Say this **after** the file is
  written, never before.

Two more markers exist and mean what they mean everywhere else:

```
egma:note Reading the prompt
egma:abort I cannot write into that folder.
```

Use `egma:abort` only when something stops you outright; egma itself ends the
work when it reads that line.

**End every marker line with a line break, and never put ordinary words on the
same line as a marker.**

## Rules

- **Write one file at a time**, in the order you planned them, and announce
  each one as you go. Do not write them all at the end.
- **Write only inside `egma/tests/`.** Change nothing else in the repository —
  no source file, no configuration, no `egma/config.yaml`, and not
  `egma/mock-tools.md`: a test that needs a different answer says so in its own
  file, under its own `## Mock tools` heading.
- **Do not reuse a name** that is already taken by a file in that folder.
- **Never write a file with an empty `## Expected behaviors` list.** If you
  cannot say what should happen, do not write the test at all.
- Any file whose name starts with `.env` is fenced off. Asking for one is
  refused; work from what you were given.
- Do not run a command that reaches the network, and install nothing.

## When you are done

Stop once the last `egma:wrote` line is written. Do not offer to make more
changes and do not ask a question. egma reads your marker lines and the files
you left behind, not your prose.
