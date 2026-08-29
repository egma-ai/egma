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

Run it in your repository. It opens a terminal wizard. On the welcome screen,
`[enter]` starts CLI authorization. Only after authorization succeeds does Egma
find your installed coding agents and ask which one to use. A later `[enter]`
starts the repository work after Egma has shown exactly what it will do. When
the wizard closes, it leaves a plain summary and, after a run, the results
address in your normal terminal buffer.

The wizard needs a real terminal for those choices. Piped or redirected, it
refuses and says so. Pass `--headless` to agree in the command itself and get
plain lines instead — that is how CI runs it.

## What it does today

<!-- The facts are FACTS in src/wizard/facts.ts, which is the source of truth; keep this sentence in step. -->

`npx @egma/cli` signs this machine in to Egma first. Only after authorization
succeeds does it look for Claude Code, Codex, Cursor, and OpenCode on this
machine and ask which installed coding agent to use. It then finds your voice
agent. It starts only the coding agent you chose, hands it Egma's own notes on
how voice agents are built, and has it read this folder and report which
framework runs it, what the voice agent is called, which LiveKit dispatch name
its worker registers, which file starts its worker, where its prompts live,
where its tools are defined,
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

Then it connects that agent so Egma can reach it, writes a first suite of
exactly four tests, puts them on Egma when you say so, and runs them. The wizard
stays with the run until every simulation has finished execution and every
completed trace has finished grading.
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
  Egma uses this key now to read your Retell agents and confirm the selected setup.
  For Text and Web call, Egma stores it encrypted and uses it to run each simulation through Retell.
  For Phone, Egma uses it only during setup and does not store it. It never lands in this repository.
  › ●●●●●●●●●●●●●●●●
```

That sentence is the whole promise, and it is enforced rather than intended.
The key is held in memory and sent to Retell during setup. For Text and Web
call, Egma also sends it to the platform, which seals it for simulations. For
Phone, setup does not send it to the platform. It is written to no repository file, printed in no
line, kept in no log, and never passed as a command argument — arguments are
readable by every process on your machine and are kept in your shell history.

Egma checks the key by listing the agents on the account. A key Retell will not
take, and a key for an account with no agents on it, are told apart by name and
each is worth one more try. One agent on the account is shown for confirmation
with nothing to answer; several get a list to choose from.

Egma lists your Retell **voice** agents, and no others. The agent's
configuration — its prompt, its voice, its tools — is pulled. Egma then asks the
one question, how it should test that agent, and offers three lanes:

```
◇ How should Egma test this agent?
  Pick as many as you want.

  › [ ] Text — Egma talks to the agent in text. No call is placed, and a run
        takes seconds.
    [ ] Web call — a voice call Egma places over the internet.
    [ ] Phone call — Egma dials the real number, so a run has true telephone
        latency and reaches your real tools.

  Egma creates these connections only after you confirm them.
```

**Several lanes may be picked at once.** Each one becomes its own connection on
the same Egma agent, and one test suite runs over all of them. Nothing is
ticked until you tick it, and an empty answer creates nothing. In the terminal
you tick a row with space and confirm with enter; on the command line you say
`--lanes` with the lane names separated by commas, as in `--lanes text,phone`.

Each lane writes its own connection. Text writes a Retell text mode connection
holding the Retell agent ID and a sealed API key. A web call writes a Retell web
call connection holding the same two, and it is the lane a mocked run is
conducted over. A phone call makes Egma list the numbers Retell routes to that
agent; you pick one, and the connection it writes holds that number and the
Retell platform label — no Retell agent ID and no credential, because the phone
adapter needs neither.

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
rules.

It asks how you want to test this agent first. **Chat** types to the agent and
reads its words back, so a whole test suite finishes in seconds and nothing is
spoken. **Voice** reaches the agent through the room's audio. Chat needs a
short setup in your worker, which the same integration task gives your coding
agent, and it is offered with project credentials alone: there Egma makes the room
whose name tells your worker to answer in text, and dispatches the worker that
reads it.

For voice you then choose one of two setups:

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
field, the wizard shows that reason and gives one correction attempt.

One worker is one Egma agent. Registering the same server and the same
registered worker name again adds a connection to the agent Egma already holds,
so a chat result and a voice result stay side by side on one agent. A worker of
the same name on a second server stays a second agent; when the Egma agent name
that one wants is already taken, the wizard says so and stops rather than
joining two deployments under one row.

LiveKit keeps its prompt and tools in repository code. Test writing therefore
uses the repository evidence and the context already held by the same coding
agent session; there is no provider prompt API to pull first.

For the run, Egma uses the discovered entrypoint and dispatch name. It checks
for LiveKit CLI 2.18.2 or newer, starts `lk agent dev` in the repository, waits
until the worker registers, and stops it when the run ends. The URL, API key,
and API secret reach that process only through its environment. Egma does not
create or deploy a LiveKit Cloud agent.

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

It refuses to guess the lanes as well. Say `--lanes` with any of `text`,
`web-call` and `phone` — several of them separated by commas, as in
`--lanes text,phone` — or set `EGMA_LANES`; with neither, it creates nothing at
all and exits 5, because Egma will not decide on your behalf whether to dial
somebody's telephone. A word that is not a lane fails the whole list rather than
being dropped quietly. With `phone` among the lanes and several numbers routed
to the agent, name one with `--phone-number` or `EGMA_PHONE_NUMBER`.

**Running it twice over the same Retell agent is safe.** Egma reuses the agent
and the connections it can prove the identity of. It reports `created`,
`reused`, or `connection_added` on the `registration:` line. A second pass
naming a lane that is already there reuses that lane rather than writing it
twice. `agent_registration:` and `connection_registration:` state what happened
to each record.

```
url: http://localhost:3101
retell_agents: 1
retell_agent_id: agent_…
retell_response_engine: retell-llm
prompt_characters: 2140
tools: 7
lanes: text,phone
lane_connection: text con_01K… retell_text_mode-1 created
lane_connection: phone con_01K… phone_number-1 created
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
5 a choice only you can make was not made: which agent, which lanes, or
  which number   6 no key given   7 not signed in to Egma
8 Retell routes no number to that agent   130 stopped part way
```

## Your tests are files in your repository

```
egma/
  config.yaml     format 3 platform, project, agents, and connection modalities
  mock-tools.md   what Egma answers for the agent's tools with
  tests/
    release/      one local directory per suite
      suite.yaml  stable suite id and mutable display name
      *.md        zero or more tests in this suite
    regression/   another suite in the same project
      suite.yaml
      *.md
```

`egma init` makes it. Everything in it is committed: nothing secret ever lands
here, so there are no gitignore lines to write and none to forget. Your tests
are code your team reviews in pull requests.

`egma/config.yaml` has one strict shape. A project can name many agents, and
each agent can name many connections:

```yaml
format: 3
platform:
  origin: https://app.egma.ai
project:
  id: prj_01K3XQ7M4E8YB2FVN0H9TZQWER
  name: Voice agents
agents:
  - id: agt_01K3XQ7M4E8YB2FVN0H9TZQWER
    name: Front desk
    connections:
      - id: con_01K3XQ7M4E8YB2FVN0H9TZQWER
        name: livekit_voice-1
        modality: voice
      - id: con_01K3XQ7M4E8YB2FVN0H9TZQWES
        name: phone_number-1
        modality: voice
  - id: agt_01K3XQ7M4E8YB2FVN0H9TZQWES
    name: After hours
    connections: []
```

Format 3 is required. Every connection records `modality: chat` or
`modality: voice`. Older folder formats are refused; this CLI has no legacy
reader or compatibility alias. Run the wizard again to add another target or
another suite. It keeps the agents, connections, and suite directories that are
already present.

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

Name at least one persona under `personas`: a test says who calls, so Egma
refuses one that names none and the push turns that file away. A new format 4
file can leave out `version` and `identity_revision`, and may name its personas
by name rather than by ID. `pull` or `push` writes the current machine fields.

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
Egma in, and `.env` files are never read. Keep **No** selected and press
`[enter]` for Egma to write the whole suite itself.

Egma creates the real platform suite and writes its `suite.yaml` first. Then
your coding agent writes tests into that direct suite directory, grounded in
what your provider is actually running and in what it found in your repository.
The screen shows the coding-agent session itself and an honest file count while
it works:

```
Writing tests for your voice agent.
Progress: 2/4
This may take a couple of minutes.

Coding agent: Claude Code
Claude Code: I am checking the worker and its tools.
◆ Read src/agent.py
```

Four tests, each with at least one expected behavior. A test with none can
never fail, so Egma will not upload one; nor will it upload a file it could not
read. Either way it says which file and why, and leaves the file exactly where
it is for you to fix.

Then one keystroke:

```
4 tests

  quoted-a-price
  lost-the-order-number
  open-on-sunday
  after-hours-emergency

0 mock tools written

Press Enter to run.
[q] quit
```

`[q]` closes the wizard with every file still in your repository, ready for
`egma push` when you have read them. `[enter]` pushes them and carries on.

It is a pause to scan, not a review. The tests are code in your repository
either way, and code is reviewed in a pull request.

## Your first run

`[enter]` pushes the list and starts a **run**: one execution of those tests
against your voice agent over the connection Egma registered. Each test becomes
one **simulation** per persona, and each one arrives on its own line and moves:

```
run run_01K7QXV2M8  ·  4 simulations
Results: https://app.egma.ai/projects/prj_01…/runs/run_01K7QXV2M8

◼ quoted-a-price            grading complete
◼ lost-the-order-number     grading complete
◼ open-on-sunday            grading complete
◼ after-hours-emergency     grading complete

✓ First result: quoted-a-price grading complete

execution 4/4 finished  ·  grading 4/4 terminal  ·  errors 0

[enter] open results in browser   [ctrl-c] stop
```

**The wizard waits for the complete suite.** It keeps the run screen open until
every simulation has ended and every completed trace has terminal grading. The
results address is a terminal link, and `[enter]` opens it in your browser. The
same address remains as a plain line when the wizard closes.

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
egma run order-line-tests
```

is the same thing with nobody watching. The suite does not belong to one agent:
a run selects the suite, agent, and connection together. When the config names
more than one runnable agent or more than one connection under the selected
agent, name them exactly:

```sh
egma run order-line-tests --agent "Front desk" --connection livekit_voice-1
```

It pins the version of every test it runs, prints every change as it lands, and
answers with a number:

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
results: http://localhost:3101/projects/prj_01K…/runs/run_01K…
simulation: quoted-a-price Everyday caller running
simulation: quoted-a-price Everyday caller completed
grading: quoted-a-price Everyday caller pending
grading: quoted-a-price Everyday caller running
grading: quoted-a-price Everyday caller complete
first-result: quoted-a-price Everyday caller complete
simulation: lost-the-order-number Everyday caller completed
grading: lost-the-order-number Everyday caller not_requested
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

`[p]` puts the real skill folders in `.agents/skills/` in this repository —
commit them and your whole team has them. When Claude Code is selected, the
standard installer also creates `.claude/skills/<skill>` symlinks to that
canonical store. `[g]` uses the standard installer's global folders for the
selected coding agent. `[s]` writes nothing at all, and is a perfectly good
answer: `egma --help` is enough for any coding agent to drive the whole product.

Egma runs the pinned `skills` installer that ships in the CLI package. Nothing
is downloaded, and the screen names the paths the installer wrote.

## The line the wizard leaves behind

The wizard draws on the terminal's alternate screen, which your terminal throws
away. So everything you need is printed after that screen is released, in plain
text, each item alone on its line so a triple-click takes it whole:

```
✓ Your first run is live — 3 of 4 simulation results ready.

http://localhost:3101/projects/prj_01K7QXV2M8ZB4C6D8E0F2G4H6J/runs/run_01K7QXV2M8ZB4C6D8E0F2G4H6J

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
`skills/`: `egma` for operating the product, `integrate-egma` for finding and
integrating a repository's voice agent, and `write-egma-tests` for writing the
local test files. The CLI package carries the exact snapshot from its release
tag.

The wizard puts `write-egma-tests` at the front of each generation task. It
then adds the facts for this repository and the CLI marker lines its screen
reads. Discovery and integration use the short `integrate-egma` router. The
coding agent reads only the reference for the current phase. The exact marker
lines remain part of the wizard task.

Nothing is downloaded while the wizard runs. The public skills and their
references are read from this package. The wizard offers all three only when
you say yes at the end of the wizard.

You can install the public skills independently for any supported coding agent:

```sh
npx skills add egma-ai/egma --skill egma
npx skills add egma-ai/egma --skill integrate-egma
npx skills add egma-ai/egma --skill write-egma-tests
```

Leave out `--skill` to choose from all three.

## How it reaches your coding agent

Over the [Agent Client Protocol](https://agentclientprotocol.com). The agent runs
as a subprocess and Egma is the client. After the start screen, Egma authorizes
the CLI. Only then does it check for Claude Code, Codex, Cursor, and OpenCode on
this machine and show the ones it can prove are installed. It does not start
ACP or download an agent during this check. `--coding-agent <id>` makes the
choice without a screen after authorization.

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
no separate approval screen. The safe writer runs automatically only when Git
already ignores the file, refuses links and non-regular files, writes
atomically, and restricts the file to its owner. Your coding agent still never
opens it.

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
                         key and automatically writes the two lines the Egma SDK
                         reads into .env when Git ignores it, printing them
                         either way.
egma monitoring disable  Turn the switch off. Everything stored stays stored.
egma monitoring status   Print the switch, the binding, the key hint, and when
                         a production conversation last arrived.
egma monitoring record --agent <id> [--monitoring-key-id <id>]
                         Recover the repository record after remote monitoring
                         succeeded. LiveKit also needs the non-secret worker-key
                         id from the setup receipt.

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
  --lanes <list>       With connect and a headless wizard: how Egma should
                       test the selected Retell agent. Any of text,
                       web-call and phone, separated by commas — several
                       lanes land as connections on one Egma agent in one
                       pass. Egma creates nothing when none is said.
  --phone-number <e164>
                       With the phone lane: which of the agent's numbers to
                       dial, when Retell routes more than one to it.
  --repo-prompt <path> With connect: the prompt file in this repository, so
                       Egma can say whether it and Retell have drifted apart.
  --existing-tests <path>
                       With the wizard: test cases you already have written
                       down, inside this folder. They are turned into test
                       files before Egma writes any of its own.
  --agent <name-or-id> With run and ordinary monitoring actions: which
                       configured voice agent to use. With monitoring record:
                       the stable Egma agent id from the receipt.
  --connection <name-or-id>
                       With run: which configured connection under that agent
                       to use when it has more than one.
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
  --monitoring-key-id <id>
                       With monitoring record on LiveKit: the non-secret
                       worker-key id from the failed setup receipt.
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
  EGMA_LANES           Which lanes to test over, same as --lanes.
  EGMA_PHONE_NUMBER    Which number to dial, same as --phone-number.
  EGMA_RETELL_URL      The Retell to talk to. Default: https://api.retellai.com
  EGMA_EXISTING_TESTS  Your existing test cases, same as --existing-tests.
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
cp .env.example .env
chmod 600 .env
npx @egma/cli self-host up
```

That starts a whole Egma — Postgres, ClickHouse, the API, the pages, the
simulator, the grader, and the LiveKit server, SIP gateway and Redis a phone
call needs — and prints the address to point an agent repository at. Open it and
sign up: you become the admin of your own instance.

The normal `.env` contains only external values. Add the current key for each
provider selected by a persona or grader version:

```
EGMA_OPENAI_API_KEY=...
EGMA_CARTESIA_API_KEY=...
EGMA_DEEPGRAM_API_KEY=... # only when selected
```

For optional phone simulations, add a complete carrier route to the same file:

```
EGMA_PHONE_TRUNK_ADDRESS=example.pstn.twilio.com
EGMA_PHONE_SOURCE_NUMBER=+15551234567
EGMA_PHONE_TRUNK_USERNAME=egma-local
EGMA_PHONE_TRUNK_PASSWORD=...
```

Wrap a credential containing `$` in single quotes. To disable phone
simulations, remove all four values. A phone route is either absent or complete.

For Twilio, the username and password come from the SIP credential list
attached to the trunk. They are never the Twilio Account SID and Auth Token.
Use one shared trunk and source number, with one SIP pair per developer and one
for production.

Run `egma self-host up` after changing `.env`. The command generates and
preserves internal auth, encryption, simulator, bundled-MinIO, and LiveKit
credentials in `.egma-platform/platform.env`. Compose supplies safe local
defaults.

The four phone values are ordinary deployment credentials. They are not stored
in Postgres. The API receives them when `self-host up` starts the containers and
adds them only to phone work orders. To rotate a SIP credential, replace all
four values, run `self-host up`, test one phone simulation, and then revoke the
old credential in Twilio.

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

**Then it waits for the complete run.** The simulator claims the work and holds
each conversation; graders run after a completed trace. The wizard keeps the
run screen open until every simulation has ended and every completed trace has
terminal grading. The headless `egma run` command follows the same completion
boundary.

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
