# Egma

The Egma wizard and client, in one command.

```
npx @egma/cli
```

The package is `@egma/cli`; the command it installs is `egma`. Running it from
a checkout instead — for development, or ahead of a release — is
`node …/apps/cli/dist/bin.js`, the same command with every option and every
verb the same. See [Trying it on an instance of your
own](#trying-it-on-an-instance-of-your-own) for the two lines that do it.

Run it in your repository. It opens a terminal wizard, tells you what it is
about to do, and starts on one keystroke. When it closes, your terminal has one
plain line in it and nothing else.

That keystroke is how you agree to Egma driving your coding agent, so Egma needs
a real terminal to ask in. Piped or redirected, it refuses and says so. Pass
`--headless` to agree in the command itself and get plain lines instead — that
is how CI runs it.

## What it does today

<!-- The facts are FACTS in src/wizard/facts.ts, which is the source of truth; keep this sentence in step. -->

`npx @egma/cli` first finds the supported coding agents installed on this
machine and asks which one to use. It supports Claude Code, Codex, Cursor, and
OpenCode. It signs this machine in to Egma, then finds your voice agent. It starts
only the coding agent you chose, hands it Egma's own notes on how voice agents
are built, and has it read this folder and report which framework runs it, what
the voice agent is called, where its prompts live, where its tools are defined,
how it reaches production, and
where its identifier is written down. Every action it takes appears on screen
while it works, and the facts it finds arrive one line at a time.

The task tells your coding agent to change nothing, and any file whose name
starts with `.env` is refused when the agent goes through Egma for it. Both are
real, and neither is a lock: your coding agent runs its own commands, and a
command that writes is one Egma shows you rather than one Egma stops. That is
the trade — you see everything, as it happens.

Your code and your prompts never leave this machine.

If this folder holds no voice agent, Egma ends and says to use the folder that
contains the agent or configure it in the Egma UI.

Then it connects that agent so Egma can reach it, writes a first suite of tests
for it, puts them on Egma when you say so, and runs them — closing as soon as
the first completed trace has terminal grading, with the rest of the suite still
going on Egma.
See below.

## Signing in

Egma shows a short code and opens your browser on a page that already has it in
the field. You approve it there — signing up first if you are new — and Egma
collects a key of its own. No secret is ever typed into the terminal.

```
egma login
```

is the same thing with nobody watching: it asks nothing, prints one fact per
line, and exits with a number you can branch on. That is how a coding agent
signs a machine in.

```
url: http://localhost:3101
code: WDJBMJHT
approve_url: http://localhost:3101/device?user_code=WDJBMJHT
browser: opened
waiting: for this code to be approved in a browser
status: stored
credentials: /home/you/.egma/credentials

0 signed in   2 denied   3 the code ran out
4 Egma did not answer, or refused   130 stopped part way
```

The key is written to `~/.egma/credentials`, readable only by you, together with
the address it belongs to. Set `EGMA_HOME` to keep it somewhere else — it names
the folder itself, not a home to put `.egma` inside.

Already signed in? `egma login` says so and does nothing. Pass `--force` to sign
in again and replace the key this machine holds.

### On a machine with no browser

Over SSH, on a devbox, in a container: press `[c]` and Egma asks your terminal
to put the address on the clipboard of the machine your keyboard is on. Approve
it in a browser over there, then paste it back — the whole address, the
`?user_code=…` part of it, or just the code. All three work.

If your terminal is too narrow to show the address whole, Egma says how much
wider it needs to be instead of drawing an address that breaks across two lines.

### Your own instance

```
egma --url http://localhost:3101
```

`--url` is the one way to name an Egma, and it names it for that one command.
To say it once and be done, bind the repository — `egma init --url
http://localhost:3101` writes that platform URL into
`egma/config.yaml`, and every later command in the repository finds it there.
`3101` is where `docker compose up` puts an instance; see [Trying it on an instance of your own](#trying-it-on-an-instance-of-your-own),
which is also where the `egma` in that line comes from today.

## Connecting your voice agent

Finding your agent in the repository is not the same as being able to reach it,
so the wizard routes setup by the agent platform it found. Retell and LiveKit
work today. Pipecat and Vapi are recognized, but their CLI setup is coming soon;
the wizard says so and points to the Egma UI instead of asking for a Retell key.

### Retell

For Retell, the next thing Egma asks for is an API key. It is typed as dots, and
the screen says what happens to it before you type it:

```
◇ Paste your Retell API key (Retell dashboard → Settings → API keys).
  It is sent to Egma and stored encrypted. It never lands in a file here.
  › ●●●●●●●●●●●●●●●●
```

That sentence is the whole promise, and it is enforced rather than intended.
The key is held in memory, sent in one header to Retell and in one body to Egma,
which seals it. It is written to no file, printed in no line, kept in no log,
and never passed as a command argument — arguments are readable by every
process on your machine and are kept in your shell history.

Egma checks the key by listing the agents on the account. A key Retell will not
take, and a key for an account with no agents on it, are told apart by name and
each is worth one more try. One agent on the account is shown for confirmation
with nothing to answer; several get a list to choose from.

The agent's configuration — its prompt, its voice, its tools — is pulled. Egma
then shows the connection that matches the Retell agent's channel and asks you
to confirm it:

```
◇ How should Egma reach this agent?
  › Phone — Egma dials one of the agent's numbers and talks to it over the
    telephone network, the way the people who call it do.

  Egma creates this connection only after you confirm it.
```

Retell voice agents use a Phone Number connection with the Voice modality.
Retell chat agents use a Retell Chat API connection with the Chat modality. The
CLI flag for the chat reach is `--reach text`. An explicit choice that does not
match the agent stops before Egma writes a connection or a local binding.

For a voice agent, Egma lists the numbers Retell routes to that agent. You pick
one, and the
connection it writes holds that number and the Retell platform label. It holds
no Retell agent ID or credential, because the phone adapter needs neither. A
Retell chat agent uses a separate Retell Chat API connection, with its Retell
agent ID and sealed API key. Egma does not offer that chat path for a voice
agent.

Egma uses Retell's answer to verify the selected agent and connection. It does
not copy the full provider document into the agent record. Nothing in this step
writes to your Retell account: every request Egma makes to it is a read.

If your repository keeps a prompt of its own and it differs from what Retell is
running, Egma says so in one line and carries on. It never blocks: being out of
step is not an error, and the line names which of the two your tests will be
grounded in.

### LiveKit

For LiveKit, the wizard reads `GET /v1/connection-options` from the Egma
platform. The platform supplies the field names, help text, and credential
rules. You then choose one of two setups:

- **LiveKit project credentials — Recommended.** This is the quickest setup.
  Give Egma the project URL, API key, and API secret so it can manage room
  tokens for simulations.
- **Customer token endpoint — Advanced.** You operate an API that gives Egma a
  short-lived room token for each simulation. It must be a public HTTPS URL,
  and auth headers are required. The project signing secret stays on your side.

Secrets are drawn as dots and never enter wizard state, the coding-agent
context, a repository file, a log, or a command argument. Setup does not contact
the LiveKit server or token endpoint. Egma sends the completed connection to
`POST /v1/agents`, where the credentials are sealed. If the platform refuses a
field, the wizard shows that reason and gives one correction attempt. If an
agent name is already taken, it asks for another name; it never joins two
LiveKit targets by URL because a LiveKit URL identifies a server, not an agent.

LiveKit keeps its prompt and tools in repository code. Test writing therefore
uses the repository evidence and the context already held by the same coding
agent session; there is no provider prompt API to pull first.

### Retell without the wizard

```
egma connect
```

is the same thing with nobody watching. The key comes in on standard input or
out of the environment, never as an argument:

```
cat retell-key.txt | egma connect
EGMA_RETELL_API_KEY=… egma connect
```

`RETELL_API_KEY` is read too, so an environment that already has one needs
nothing new. With several agents on the account it lists them and refuses to
guess; name one with `--retell-agent`.

It refuses to guess the reach as well. Say `--reach text` or `--reach phone`
(or set `EGMA_REACH`); with neither, it creates nothing at all and exits 5 —
Egma will not decide on your behalf whether to dial somebody's telephone. With
`--reach phone` and several numbers routed to the agent, name one with
`--phone-number` or `EGMA_PHONE_NUMBER`.

**Running it twice over the same Retell agent is safe.** Egma reuses the agent
and the same selected connection when it can prove both identities. It reports
`created`, `reused`, or `connection_added` on the `registration:` line. A
Retell voice agent stays on a phone connection; this repeat behavior does not
turn it into a Retell chat connection. `agent_registration:` and
`connection_registration:` state what happened to each record.

```
url: http://localhost:3101
retell_agents: 1
retell_agent_id: agent_…
retell_response_engine: retell-llm
prompt_characters: 2140
tools: 7
reach: phone
phone_number: +14155550111
agent_id: agt_01K…
agent_name: order-line
connection_id: con_01K…
connection_name: phone_number-1
agent_platform: retell
connection_type: phone_number
access_variant: phone_number.public_e164
product_label: Retell phone
connection_modality: voice
registration: created
agent_registration: created
connection_registration: created
drift: no
grounded_in: retell
status: connected

0 connected   2 the key was refused   3 no agents on that account
4 Retell or Egma did not answer, or refused
5 a choice only you can make was not made: which agent, text or phone, or
  which number   6 no key given   7 not signed in to Egma
8 Retell routes no number to that agent   130 stopped part way
```

## Your tests are files in your repository

```
egma/
  config.yaml     what this folder points at — names and ids
  mock-tools.md   what Egma answers for the agent's tools with
  tests/
    release/      one local directory per suite
      suite.yaml  stable suite id and mutable display name
      *.md        zero or more tests in this suite
```

`egma init` makes it. Everything in it is committed: nothing secret ever lands
here, so there are no gitignore lines to write and none to forget. Your tests
are code your team reviews in pull requests.

Create a suite with `egma suite create release --name "Release contract"`.
Egma creates the platform record first, then writes exactly:

```yaml
id: ste_01K3XQ7M4E8YB2FVN0H9TZQWER
name: Release contract
```

One test is one file:

```markdown
---
format: 4
name: missed-appointment-reschedule
description: The caller missed an appointment and needs another time this week.
---
## Scenario
The caller missed yesterday's appointment and wants to
reschedule this week. They are short on time and irritated.
## Expected behaviors
1. The agent acknowledges the missed appointment without blame.
2. The agent offers at least two concrete alternative slots.
3. The agent confirms the new booking before ending the call.
```

Name a persona only when the situation needs a particular kind of person on the
other end; leave `personas` out and the default one applies. A new format 4 file
can leave out `version`, `identity_revision`, and persona IDs. `pull` or `push`
writes the current machine fields.

`egma/mock-tools.md` is the mocked world: a **mock tool** answers for one of
your agent's tools while a simulation runs, so a test never reaches your real
backend and can ask for the branch you want to see — an empty calendar, a
booking service that is down.

``````markdown
## Mock tools
### check_availability
```json
{
  "answer": { "slots": [] },
  "delay_ms": 250
}
```
``````

Send `error` instead of `answer` for the failure a tool raises, `delay_ms` to
make a mocked backend take as long as the real one, and `agents` to narrow a
mock tool to some of your agents rather than all of them. A test that needs a
different answer writes the same section into its own file, below its expected
behaviors — that override belongs to the test and is versioned with it, while
the project's own mock tools are the one authored thing Egma does not version,
so pushing an edit writes over what was there.

## Your first suite of tests

The wizard asks one question before it writes anything: do you already have
test cases written down — a spreadsheet, a document, a page of notes? Drop a
path and your own coding agent turns each one into a test file first. Egma
reads that file itself and hands the whole of it over inside the task, so
nothing goes looking on your disk; the file has to be inside the folder you ran
Egma in, and `.env` files are never read. Press `[n]` and Egma writes the whole
suite itself.

Egma creates the real platform suite and writes its `suite.yaml` first. Then
your coding agent writes tests into that direct suite directory, grounded in
what your provider is actually running and in what it found in your repository. They
arrive one file at a time, with what is still to come beside them:

```
A test                            ◼ quoted-a-price          written
                                  ▶ lost-the-order-number   writing…
One situation to put your agent   ◻ open-on-sunday
in: what the person on the other
end wants, and the expected       Progress: 2/12
behaviors that say what should
happen.
```

Beside them, Egma's own words: what a test is, what a run and its simulations
are, and the difference between a metric and a grader. The cards turn on their
own and nothing waits on them — the suite is written at exactly the speed it
would be with the pane closed.

Twelve tests, each with at least one expected behavior. A test with none can
never fail, so Egma will not upload one; nor will it upload a file it could not
read. Either way it says which file and why, and leaves the file exactly where
it is for you to fix.

Then one keystroke:

```
12 tests generated · suite "order-line tests"

  › quoted-a-price          default persona
    lost-the-order-number   default persona
    open-on-sunday          somebody-in-a-hurry
    … 9 more (↑↓ browse · e opens in $EDITOR)

Run these against order-line over retell_chat_api-1 (chat)?

[enter] run   [e] edit first   [q] quit
```

`[e]` opens the highlighted file in your `$EDITOR` — Egma hands the terminal
over and takes it back — and returns you here. `[q]` closes the wizard with
every file still in your repository, ready for `egma push` when you have read
them. `[enter]` pushes them and carries on.

It is a pause to scan, not a review. The tests are code in your repository
either way, and code is reviewed in a pull request.

## Your first run

`[enter]` pushes the list and starts a **run**: one execution of those tests
against your voice agent over the connection Egma registered. Each test becomes
one **simulation** per persona, and each one arrives on its own line and moves:

```
run run_01K7QXV2M8  ·  12 simulations

◼ quoted-a-price            grading complete
▶ lost-the-order-number     in progress
▶ open-on-sunday            dialing…
◻ after-hours-emergency     queued

✓ First result: quoted-a-price grading complete

execution 1/12 finished  ·  grading 1/1 terminal  ·  errors 0
```

**The wizard does not wait for the suite.** It waits for the first completed
trace whose whole grading work is terminal. It never advances on the first
individual grade. The run carries on on Egma; shutting your terminal has never
stopped one.

**Grading starts after a completed conversation.** A grader reads trace
evidence, test values, outcomes, and metrics and returns one normalized score
from `0` to `1`. Expected behaviors is one grader. Its detailed assertion
results stay inside its one grade. The results page shows each grade, its pass
threshold, its individual result, and its evidence.

Several grades can have a display-only combined score. Egma does not turn that
score into a simulation, test, suite, or run pass/fail result. A low grade does
not make `egma run` fail. An execution error or grading-system error does.

The run screen reports grading as `not_requested`, `pending`, `running`,
`complete`, or `error`. A simulation that failed or was canceled before it
produced a completed trace has no grading state and adds no grading wait. A
grader outside scope or incompatible with the trace writes no grade; it is not
called skipped.

If your connection type has no simulator adapter, Egma refuses
the run **at creation**, in its own words, and the wizard prints those words as
they came. You never wait on a run that could not happen.

```
egma run generated
```

is the same thing with nobody watching. It pins the version of every test it
runs, prints every change as it lands, and answers with a number:

```
url: http://localhost:3101
folder: /repo/egma
agent: agt_01K…
connection: con_01K…
pin: quoted-a-price tstv_01K…
pin: lost-the-order-number tstv_01K…
run: run_01K…
tests: 2
simulations: 2
results: http://localhost:3101/runs/run_01K…
simulation: quoted-a-price default-persona running
simulation: quoted-a-price default-persona completed
grading: quoted-a-price default-persona pending
grading: quoted-a-price default-persona running
grading: quoted-a-price default-persona complete
first-result: quoted-a-price default-persona complete
simulation: lost-the-order-number default-persona completed
grading: lost-the-order-number default-persona not_requested
execution-finished: 2
execution-failed: 0
execution-canceled: 0
grading-terminal: 2
grading-complete: 1
grading-not-requested: 1
grading-errors: 0
grading-pending: 0
grading-running: 0
simulations: 2
status: completed

0 execution and grading finished without an operational error
1 nothing here to run   2 not signed in
4 Egma did not answer, or refused
5 Egma would not start the run, and said why
6 execution or grading had an operational error   130 stopped part way
```

`--no-follow` starts the run and returns at once, without waiting for execution
or grading — for when you want the suite going and will read the results page
later.

It runs the complete suite named by the local directory. The manifest supplies
the stable suite ID, and each simulation records the exact test version it ran.

**Your folder and Egma have to agree, or nothing starts.** A file Egma has never
seen, a stale file, or a missing or extra test refuses the whole run. Run
`egma push` or `egma pull` until the local suite and Egma match exactly. The
server checks the same exact test/version set inside the start transaction.

## The skill, if you want it

The last thing the wizard asks:

```
◇ Install the Egma skill into Claude Code, so it can drive Egma
  on its own next time?   [p] project   [g] global   [s] skip
```

`[p]` writes `.claude/skills/egma/SKILL.md` in this repository — commit it and
your whole team has it. `[g]` writes `~/.claude/skills/egma/SKILL.md`, for every
repository you open. `[s]` writes nothing at all, and is a perfectly good
answer: `egma --help` is enough for any coding agent to drive the whole product.

Codex keeps its skills under `.codex/`, Cursor under `.cursor/`, and OpenCode
under `.opencode/` for a project or `~/.config/opencode/` globally.

Egma writes the one file itself. Nothing is downloaded, nothing else on your
machine is touched, and the screen names the exact path before you press
anything.

## The line the wizard leaves behind

The wizard draws on the terminal's alternate screen, which your terminal throws
away. So everything you need is printed after that screen is released, in plain
text, each item alone on its line so a triple-click takes it whole:

```
✓ Your first run is live — 3 of 12 simulation results ready.

http://localhost:3101/runs/run_01K7QXV2M8ZB4C6D8E0F2G4H6J

Tests are code now: egma/tests/ (committed). Edit them, then egma push.
Hand your coding agent this: "Read egma/config.yaml, then egma --help — you can pull, push, and trigger runs from here."
```

The results address **opens already signed in** — your browser holds the
sign-in from the approval at the start of the wizard. That is why nothing rides on
the address: no token, no key, no query at all.

## Keeping the folder and Egma in step

```
egma pull     stages and writes all suites, tests, and Mock Tools
egma push     sends one atomic full-repository change set
```

Sync is a verb you run. Nothing syncs in the background, because two things
saving over each other silently is how this goes wrong everywhere it has been
tried.

Each file remembers the version it was last synced at. `push` sends the complete
repository with its expected versions. A conflict refuses the atomic change set:

```
conflict: missed-appointment-reschedule
file: egma/tests/release/missed-appointment-reschedule.md
uploaded: nothing
status: refused
```

Nothing is merged and nothing is uploaded. Run `egma pull`, look at what your
teammate changed in the dashboard, then push again. A push that goes through
creates a new version on Egma — the old one is never overwritten, so results
from last week still say what they ran — and writes the new version id back
into your files.

`egma push` also relays Egma's own refusals. A test with no expected behaviors
cannot ever fail, so Egma will not store one, and the reason you see is Egma's
own words.

All three verbs print one fact per line and answer with a number you can branch
on, so a coding agent can run them and act on what comes back without anybody
reading the screen:

```
url, folder, and then one line per test: what happened to it, the file,
and the version the file now pins.

0 done   1 no egma folder here   2 not signed in
4 Egma did not answer, or refused
5 push refused: Egma has moved on, pull first
6 Egma turned a test away at its door   130 stopped part way
```

## The context Egma hands your coding agent

Egma has three public Agent Skills, authored in the public repository under
`skills/`: `egma` for operating the product, `find-voice-agent` for mapping a
repository's voice agent, and `write-egma-tests` for writing the local test
files. The CLI package carries the exact snapshot from its release tag.

The wizard puts `write-egma-tests` at the front of each generation task. It
then adds the facts for this repository and the CLI marker lines its screen
reads. Discovery puts `find-voice-agent` at the front of its task. When the
repository points to Retell or LiveKit, the coding agent reads only that
provider reference from the public skill. The exact marker lines remain part of
the wizard task.

Nothing is downloaded while the wizard runs. The public skills and their
references are read from this package. The only skill that the wizard offers to
install is `egma`, and it does so only when you say yes at the end of the wizard.

You can install the public skills independently for any supported coding agent:

```sh
npx skills add egma-ai/egma --skill egma
npx skills add egma-ai/egma --skill find-voice-agent
npx skills add egma-ai/egma --skill write-egma-tests
```

Leave out `--skill` to choose from all three.

## How it reaches your coding agent

Over the [Agent Client Protocol](https://agentclientprotocol.com). The agent runs
as a subprocess and Egma is the client. Before the consent screen, Egma checks
for Claude Code, Codex, Cursor, and OpenCode on this machine and shows the ones
it can prove are installed. It does not start ACP, log in, or download an agent
during this check. `--coding-agent <id>` makes the choice without a screen.

The wizard opens one ACP process and one session after consent. Discovery,
conversion, and test writing are later turns in that same session, so the coding
agent keeps the repository context it already built. Egma never starts a fresh
ACP job between those steps.

Your code and your prompts never leave your machine. There is no Egma model in
this path and no Egma server in it.

## Questions, and the one file that is never read

Egma answers every permission request the agent raises, and starts it in the
most permissive mode it offers, so you are not interrupted while it works.
That is only safe because everything the agent does appears on screen as it
happens.

One thing is never allowed: any file whose name starts with `.env`. Those hold
secrets, and once read they are in a model's context for good. Egma refuses the
file and tells the agent to work from your code and to ask you for anything it
still needs.

That holds while Egma sets monitoring up on LiveKit, where a `.env` really is
written: the two lines the Egma SDK reads are written by Egma's own code, with
your agreement, and only when Git already ignores the file. Your coding agent
still never opens it.

## Options

```
egma [options]           The wizard.
egma login [options]     Sign this machine in. No questions, plain lines.
egma connect [options]   Register your voice agent and a way to reach it.
                         The key comes in on standard input or from the
                         environment, never as an argument.
egma init [options]      Make the egma folder this repository's tests live
                         in. Talks to nobody, unless --url names an Egma to
                         bind this repository to. Safe to run again.
egma suite create <directory> --name <name>
                         Create a platform suite, then its local manifest.
egma pull [options]      Stage and write the complete project repository.
egma push [options]      Send one atomic complete repository change set.
egma run <suite-directory> [options]
                         Run the complete suite after an exact sync check.
                         Follows the run and prints every change.
egma monitoring enable [options]
                         Start watching this agent's production traffic. On
                         Retell the account key comes in on standard input,
                         never as an argument. On LiveKit Egma mints a project
                         key and writes the two lines the Egma SDK reads into
                         .env when Git ignores it, printing them either way.
egma monitoring disable  Turn the switch off. Everything stored stays stored.
egma monitoring status   Print the switch, the binding, the key hint, and when
                         a production conversation last arrived.

  --coding-agent <id>  Use one installed coding agent without asking.
                       claude, codex, cursor, opencode
  --cwd <path>         The folder to work in. Default: this folder.
  --url <address>      Which Egma this one command talks to. It is the only
                       way to name one, so a command that should reach that
                       Egma carries it. With init and with the wizard, Egma
                       records the normalized URL in egma/config.yaml, and
                       every later command in this repository then needs no
                       address at all.
  --force              With login: sign in again even when this machine
                       already holds a key.
  --no-follow          With run: start the run and return at once, without
                       waiting for execution or grading. The run carries on on Egma.
  --retell-agent <id>  With connect: which agent, when the Retell account
                       holds more than one.
  --reach <text|phone> With connect and a headless wizard: how Egma should
                       reach the agent. Egma creates the one you choose and
                       never both, and creates nothing when neither is said.
  --phone-number <e164>
                       With --reach phone: which of the agent's numbers to
                       dial, when Retell routes more than one to it.
  --repo-prompt <path> With connect: the prompt file in this repository, so
                       Egma can say whether it and Retell have drifted apart.
  --existing-tests <path>
                       With the wizard: test cases you already have written
                       down, inside this folder. They are turned into test
                       files before Egma writes any of its own.
  --agent <name>       With init: what to call the voice agent this
                       folder's tests are for.
  --connection <name>  With init: what to call the way Egma reaches it.
  --name <name>        With suite create: the suite display name. With run:
                       an optional run name. With monitoring enable: what to
                       call the agent Egma writes.
  --platform <retell|livekit>
                       With monitoring enable: which platform runs this agent.
                       Left out, Egma reads it from the agent's own binding, or
                       from the connections that reach it, and refuses when it
                       cannot tell.
  --platform-agent <id>
                       With monitoring enable on Retell: which agent on the
                       account to watch, when it holds more than one.
  --headless           Run with no terminal and no keystroke: plain lines,
                       and the task taken as already agreed to.
  -h, --help           Print this.
  -v, --version        Print the version.

Environment:
  EGMA_HOME            The folder Egma keeps this machine's key in.
                       Default: ~/.egma
  EGMA_RETELL_API_KEY  Your Retell key, for egma connect. RETELL_API_KEY is
                       read too, so an environment that already has one needs
                       nothing new.
  EGMA_RETELL_AGENT_ID Which Retell agent, same as --retell-agent.
  EGMA_REACH           text for a Retell Chat connection, or phone for a
                       Phone connection; same as --reach.
  EGMA_PHONE_NUMBER    Which number to dial, same as --phone-number.
  EGMA_RETELL_URL      The Retell to talk to. Default: https://api.retellai.com
  EGMA_EXISTING_TESTS  Your existing test cases, same as --existing-tests.
  VISUAL, EDITOR       What e opens a generated test in, at the gate.
```

`Ctrl-C` stops a run at any point. The agent, and anything the agent started,
is shut down before Egma exits, and the line left behind says where it stopped.
If tests had already been written into `egma/tests/`, that line says how many
are there — they are yours, and Egma never removes them to tidy up its own
report.

## Requirements

Node 22 or newer. Install at least one of Claude Code, Codex, Cursor, or
OpenCode. The interactive wizard lists the supported agents it finds and asks
which one to use. A headless run with several installed agents needs
`--coding-agent <id>`.

You do not have to be logged in to it first. If it asks Egma to log in, Egma
hands you to that agent's own login and carries on where it left off. And if
there is no coding agent here for Egma to drive at all, it prints the words to
paste into whichever one you do use, and stops.

## Trying it on an instance of your own

Egma is open source and runs on your machine. That checkout is a **platform
workspace** — the deployment's own directory, and deliberately not your agent
repository. The platform's carrier and provider credentials belong to whoever
runs the platform; an agent repository holds only tests and the address of the
platform that owns their identifiers. On one laptop both are often yours, and
they stay two directories, because one platform serves many repositories.

Clone the repository, then, from your checkout of it:

```
pnpm install
npx @egma/cli self-host up
```

That starts a whole Egma — Postgres, ClickHouse, the API, the pages, the
simulator, the grader, and the LiveKit server, SIP gateway and Redis a phone
call needs — and prints the address to point an agent repository at. Open it and
sign up: you become the admin of your own instance.

Put the deployment's current provider keys in `.env` as
`EGMA_OPENAI_API_KEY`, `EGMA_DEEPGRAM_API_KEY`, and
`EGMA_CARTESIA_API_KEY`. Persona and grader versions choose the models; these
variables supply credentials only.

Configure the optional carrier route in the same directory:

```
npx @egma/cli login --url http://localhost:3101
npx @egma/cli self-host setup
```

It asks only how a call reaches the telephone network. The carrier route is
written through the platform's own API, which is why you log in first. The SIP
password is sealed in Postgres and is handed to a simulator only on a claimed
phone work order.

For the phone half, a Twilio administrator creates one SIP credential per
developer and one for production in the credential list already attached to the
shared trunk. All of them use the same trunk address and source number. Each
developer keeps their own pair outside the database.

Setup asks for the trunk address and source number, plus the SIP username and
password when the carrier uses credential authentication. It writes the
complete bundle into the platform store. Keep that bundle in the ignored
`.env` file or a password manager if a fresh database must restore it later;
the CLI does not write an environment file. Setup never asks for the Twilio
Account SID or Auth Token, never contacts Twilio, and never creates or changes
a SIP credential.

Normal setup does not replace a held carrier bundle. To replace one developer
credential safely, an administrator first adds the new credential beside the
old one. Export the trunk address, source number, new SIP username and new SIP
password, then run `egma self-host setup --replace-carrier --yes`. Run one phone
simulation with the new bundle, then revoke the old credential. The command
still does not contact Twilio. Hosted production uses its deployment secret
instead of this self-hosted command.

To run the command from this same checkout rather than from npm, build it:

```
pnpm --filter @egma/cli build
```

Then run it from the repository that holds your voice agent, naming the
instance you just signed up on:

```
cd ~/your-voice-agent
node ~/egma/apps/cli/dist/bin.js --url http://localhost:3101
```

(`~/egma` is wherever you cloned this. From npm, that whole line is
`npx @egma/cli --url http://localhost:3101`.)

The wizard signs this machine in against that instance, registers your agent
and a way to reach it, writes a first suite of tests with your coding agent,
puts them on Egma when you say so, and starts a run over them.

**Then it waits for the first result.** The simulator claims the work and holds
the conversation; graders run after a completed trace. The wizard moves on only
after that trace's whole grading work is terminal. The headless `egma run`
command follows all simulations until execution is terminal and every completed
trace has terminal grading.

The whole wizard flow is checked against a real instance the same way. On a checkout
that has had `pnpm install`, and on a machine with a Chrome — or with
`PLAYWRIGHT_BROWSERS_PATH` pointing at a Playwright Chromium, because the
approval really happens in a browser — it is two commands:

```
pnpm db:up
pnpm --filter @egma/cli smoke:wizard-flow
```

The second builds everything it needs, starts an Egma of its own, signs in,
registers, pushes and runs — and says at the end what it proved and what waits.
Set `RETELL_API_KEY` to register against your own Retell account instead of the
stand-in one it starts.

## Licence

Apache 2.0. Parts of the terminal UI are adapted from the PostHog wizard under
the MIT licence; see `NOTICE`.
