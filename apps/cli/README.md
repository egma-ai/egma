# egma

The egma wizard and client, in one command.

```
npx egma
```

**Not yet, though: that package is not published.** The name on npm is a
placeholder that holds it and runs nothing, so today the command is built from
a checkout — see [Trying it on an instance of your
own](#trying-it-on-an-instance-of-your-own) for the two lines that do it.
Everywhere below, `npx egma` is the shape the command takes when it ships;
`node …/apps/cli/dist/bin.js` is the same command today, and every option and
every verb is the same.

Run it in your repository. It opens a terminal wizard, tells you what it is
about to do, and starts on one keystroke. When it closes, your terminal has one
plain line in it and nothing else.

That keystroke is how you agree to egma driving your coding agent, so egma needs
a real terminal to ask in. Piped or redirected, it refuses and says so. Pass
`--headless` to agree in the command itself and get plain lines instead — that
is how CI runs it.

## What it does today

<!-- The facts are FACTS in src/wizard/facts.ts, which is the source of truth; keep this sentence in step. -->

`npx egma` signs this machine in to egma, then finds your voice agent. It starts
the coding agent you already have, hands it egma's own notes on how voice agents
are built, and has it read this folder and report which framework runs it, where
its prompts live, where its tools are defined, how it reaches production, and
where its identifier is written down. Every action it takes appears on screen
while it works, and the facts it finds arrive one line at a time.

The task tells your coding agent to change nothing, and any file whose name
starts with `.env` is refused when the agent goes through egma for it. Both are
real, and neither is a lock: your coding agent runs its own commands, and a
command that writes is one egma shows you rather than one egma stops. That is
the trade — you see everything, as it happens.

Your code and your prompts never leave this machine.

If this folder holds no voice agent, egma asks once for the folder your prompts
are in — teams often keep them apart — looks there, and otherwise says plainly
that you should run it where your agent is defined.

Then it connects that agent so egma can reach it, writes a first suite of tests
for it, puts them on egma when you say so, and runs them — closing as soon as
the first verdict has landed, with the rest of the suite still going on egma.
See below.

## Signing in

egma shows a short code and opens your browser on a page that already has it in
the field. You approve it there — signing up first if you are new — and egma
collects a key of its own. No secret is ever typed into the terminal.

```
egma login
```

is the same thing with nobody watching: it asks nothing, prints one fact per
line, and exits with a number you can branch on. That is how a coding agent
signs a machine in.

```
url: https://app.egma.ai
code: WDJBMJHT
approve_url: https://app.egma.ai/device?user_code=WDJBMJHT
browser: opened
waiting: for this code to be approved in a browser
status: stored
credentials: /home/you/.egma/credentials

0 signed in   2 denied   3 the code ran out
4 egma did not answer, or refused   130 stopped part way
```

The key is written to `~/.egma/credentials`, readable only by you, together with
the address it belongs to. Set `EGMA_HOME` to keep it somewhere else — it names
the folder itself, not a home to put `.egma` inside.

Already signed in? `egma login` says so and does nothing. Pass `--force` to sign
in again and replace the key this machine holds.

### On a machine with no browser

Over SSH, on a devbox, in a container: press `[c]` and egma asks your terminal
to put the address on the clipboard of the machine your keyboard is on. Approve
it in a browser over there, then paste it back — the whole address, the
`?user_code=…` part of it, or just the code. All three work.

If your terminal is too narrow to show the address whole, egma says how much
wider it needs to be instead of drawing an address that breaks across two lines.

### Your own instance

```
EGMA_URL=http://localhost:3101 egma
```

or `--url`. It is kept beside the key after the first login, so later commands
find it without being told again. `3101` is where `docker compose up` puts an
instance; see [Trying it on an instance of your own](#trying-it-on-an-instance-of-your-own),
which is also where the `egma` in that line comes from today.

## Connecting your voice agent

Finding your agent in the repository is not the same as being able to reach it,
so the next thing egma asks for is a Retell API key. It is typed as dots, and
the screen says what happens to it before you type it:

```
◇ Paste your Retell API key (Retell dashboard → Settings → API keys).
  It is sent to egma and stored encrypted. It never lands in a file here.
  › ●●●●●●●●●●●●●●●●
```

That sentence is the whole promise, and it is enforced rather than intended.
The key is held in memory, sent in one header to Retell and in one body to egma,
which seals it. It is written to no file, printed in no line, kept in no log,
and never passed as a command argument — arguments are readable by every
process on your machine and are kept in your shell history.

egma checks the key by listing the agents on the account. A key Retell will not
take, and a key for an account with no agents on it, are told apart by name and
each is worth one more try. One agent on the account is shown for confirmation
with nothing to answer; several get a list to choose from.

The agent's configuration — its prompt, its voice, its tools — is pulled and
registered on egma, together with a connection for reaching it. **What Retell
answered is kept exactly as it answered it**, beside what egma read out of it,
so a field egma has no place for today is still there tomorrow.

If your repository keeps a prompt of its own and it differs from what Retell is
running, egma says so in one line and carries on. It never blocks: being out of
step is not an error, and the line names which of the two your tests will be
grounded in.

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

**Running it twice over the same Retell agent is safe.** egma answers the
registration you already have rather than making a second one, stores the key
you just gave, and says which of three things it did on the `registration:`
line — `created`, `reused`, or `connection_added` when the same agent gained
another way of being reached. The last two also print a `note:` line saying it
in plain words.

```
url: https://app.egma.ai
retell_agents: 1
retell_agent_id: agent_…
retell_response_engine: retell-llm
prompt_characters: 2140
tools: 7
agent_id: agt_01K…
agent_name: order-line
connection_id: con_01K…
connection_name: retell-1
connection_type: retell
connection_modality: voice
registration: created
drift: no
grounded_in: retell
status: connected

0 connected   2 the key was refused   3 no agents on that account
4 Retell or egma did not answer, or refused   5 several agents, none named
6 no key given   7 not signed in to egma   130 stopped part way
```

## Your tests are files in your repository

```
egma/
  config.yaml     what this folder points at — names and ids
  tests/          one markdown file per test
```

`egma init` makes it. Everything in it is committed: nothing secret ever lands
here, so there are no gitignore lines to write and none to forget. Your tests
are code your team reviews in pull requests.

One test is one file:

```markdown
---
name: missed-appointment-reschedule
personas: [impatient-caller]
version: tstv_01K…
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
other end; leave `personas` out and the default one applies. `version:` is
absent until `pull` or `push` writes it.

## Your first suite of tests

The wizard asks one question before it writes anything: do you already have
test cases written down — a spreadsheet, a document, a page of notes? Drop a
path and your own coding agent turns each one into a test file first. egma
reads that file itself and hands the whole of it over inside the task, so
nothing goes looking on your disk; the file has to be inside the folder you ran
egma in, and `.env` files are never read. Press `[n]` and egma writes the whole
suite itself.

Then your coding agent writes tests into `egma/tests/`, grounded in what your
provider is actually running and in what it found in your repository. They
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

Beside them, egma's own words: what a test is, what a run and its simulations
are, and the difference between a metric and a grader. The cards turn on their
own and nothing waits on them — the suite is written at exactly the speed it
would be with the pane closed.

Twelve tests, each with at least one expected behavior. A test with none can
never fail, so egma will not upload one; nor will it upload a file it could not
read. Either way it says which file and why, and leaves the file exactly where
it is for you to fix.

Then one keystroke:

```
12 tests generated · suite "first-suite"

  › quoted-a-price          default persona
    lost-the-order-number   default persona
    open-on-sunday          somebody-in-a-hurry
    … 9 more (↑↓ browse · e opens in $EDITOR)

Run these against order-line over retell-1 (voice)?

[enter] run   [e] edit first   [q] quit
```

`[e]` opens the highlighted file in your `$EDITOR` — egma hands the terminal
over and takes it back — and returns you here. `[q]` closes the wizard with
every file still in your repository, ready for `egma push` when you have read
them. `[enter]` pushes them and carries on.

It is a pause to scan, not a review. The tests are code in your repository
either way, and code is reviewed in a pull request.

## Your first run

`[enter]` pushes the list and starts a **run**: one execution of those tests
against your voice agent over the connection egma registered. Each test becomes
one **simulation** per persona, and each one arrives on its own line and moves:

```
run run_01K7QXV2M8  ·  12 simulations

◼ quoted-a-price            passed
▶ lost-the-order-number     in progress
▶ open-on-sunday            dialing…
◻ after-hours-emergency     queued

✓ First verdict: quoted-a-price passed

passed 1  ·  failed 0  ·  skipped 0  ·  errored 0  ·  waiting 11
```

**The wizard does not wait for the suite.** It waits for the first verdict —
that is the point where you stop taking egma's word for it — and then closes.
The run carries on on egma; shutting your terminal has never stopped one.

**On an instance today, no verdict arrives yet.** The run is created, it is
followed live, and every simulation sits in `queued`, because the piece that
hands a test to the simulator and the grader that scores what it did are still
being built. Everything up to that point is real. Until they land, close the
window when you have seen the run — the run is yours on egma either way, at the
address the screen shows.

A **verdict** is one of four, and egma never turns four into three:

- `passed` — the agent did what the test expected.
- `failed` — it did not. Something in your agent is wrong.
- `skipped` — nothing was judged. The test needed something this connection
  cannot do, or a grader had nothing it could score here.
- `errored` — the simulation never happened. The agent was not reached, or egma
  broke.

A test that could not run is not a test that failed, and reporting one as the
other would send you hunting a bug that is not there.

If your connection is of a type whose adapter has not shipped yet, egma refuses
the run **at creation**, in its own words, and the wizard prints those words as
they came. You never wait on a run that could not happen.

```
egma run
```

is the same thing with nobody watching. It pins the version of every test it
runs, prints every change as it lands, and answers with a number:

```
url: https://app.egma.ai
folder: /repo/egma
agent: agt_01K…
connection: con_01K…
pin: quoted-a-price tstv_01K…
pin: lost-the-order-number tstv_01K…
run: run_01K…
tests: 2
simulations: 2
results: https://app.egma.ai/runs/run_01K…
simulation: quoted-a-price default-persona running
verdict: quoted-a-price default-persona passed
first-verdict: quoted-a-price default-persona passed
simulation: lost-the-order-number default-persona completed
verdict: lost-the-order-number default-persona skipped
reason: this test needs DTMF, and this connection has none
passed: 1
failed: 0
skipped: 1
errored: 0
pending: 0
simulations: 2
status: completed

0 the run finished and nothing failed or errored
1 nothing here to run   2 not signed in   3 a test failed
4 egma did not answer, or refused
5 egma would not start the run, and said why
6 a simulation errored, so nothing concluded   130 stopped part way
```

`--no-follow` starts the run and returns at once, without waiting for a verdict
— for when you want the suite going and will read the results page later.

It runs what egma holds, pinning the current version of each test, so a run is a
record of exactly what executed.

**Your folder and egma have to agree, or nothing starts.** A file egma has never
seen is named on an `unknown:` line; a file egma holds different content for is
named on a `not-pushed:` line. Either one refuses the whole run and names the
fix, which is `egma push` both times. The comparison is the content of each
test, field by field, and never a version number — the numbers agree with each
other exactly when you edited a file and did not push it, which is the case this
gate is for. A run that went ahead over the difference would come back green
about words nobody executed.

## The skill, if you want it

The last thing the wizard asks:

```
◇ Install the egma skill into Claude Code, so it can drive egma
  on its own next time?   [p] project   [g] global   [s] skip
```

`[p]` writes `.claude/skills/egma/SKILL.md` in this repository — commit it and
your whole team has it. `[g]` writes `~/.claude/skills/egma/SKILL.md`, for every
repository you open. `[s]` writes nothing at all, and is a perfectly good
answer: `egma --help` is enough for any coding agent to drive the whole product.

Codex keeps its skills the same way, under `.codex/` instead. A coding agent
egma has no skill convention for is not offered one, rather than being handed a
file in a directory it may never read.

egma writes the one file itself. Nothing is downloaded, nothing else on your
machine is touched, and the screen names the exact path before you press
anything.

## The line the wizard leaves behind

The wizard draws on the terminal's alternate screen, which your terminal throws
away. So everything you need is printed after that screen is released, in plain
text, each item alone on its line so a triple-click takes it whole:

```
✓ Your first run is live — 3 of 12 graded so far.

https://app.egma.ai/runs/run_01K7QXV2M8ZB4C6D8E0F2G4H6J

Tests are code now: egma/tests/ (committed). Edit them, then egma push.
Hand your coding agent this: "Read egma/config.yaml, then egma --help — you can pull, push, and trigger runs from here."
```

The results address **opens already signed in** — your browser holds the
sign-in from the approval at the start of the walk. That is why nothing rides on
the address: no token, no key, no query at all.

## Keeping the folder and egma in step

```
egma pull     writes egma's current versions into your files
egma push     uploads yours
```

Sync is a verb you run. Nothing syncs in the background, because two things
saving over each other silently is how this goes wrong everywhere it has been
tried.

Each file remembers the version it was last synced at. `push` compares that
with what egma currently holds, and **refuses when egma has moved on**, naming
every test that moved:

```
conflict: missed-appointment-reschedule
file: egma/tests/missed-appointment-reschedule.md
uploaded: nothing
status: refused
```

Nothing is merged and nothing is uploaded. Run `egma pull`, look at what your
teammate changed in the dashboard, then push again. A push that goes through
creates a new version on egma — the old one is never overwritten, so results
from last week still say what they ran — and writes the new version id back
into your files.

`egma push` also relays egma's own refusals. A test with no expected behaviors
cannot ever fail, so egma will not store one, and the reason you see is egma's
own words.

All three verbs print one fact per line and answer with a number you can branch
on, so a coding agent can run them and act on what comes back without anybody
reading the screen:

```
url, folder, and then one line per test: what happened to it, the file,
and the version the file now pins.

0 done   1 no egma folder here   2 not signed in
4 egma did not answer, or refused
5 push refused: egma has moved on, pull first
6 egma turned a test away at its door   130 stopped part way
```

## The notes egma hands your coding agent

They are markdown files inside this package, under `skills/`. They are sent as
part of the task, at the moment the task is sent. Nothing is installed on your
machine, nothing is downloaded, and nothing is written to your repository.

Today there are three: one on finding a voice agent in a repository nobody has
described, one on what a Retell voice agent looks like from the inside, and one
on writing a test file that says something worth checking.

A fourth, `skills/egma/SKILL.md`, is the only one that is ever *installed* —
and only when you say so, at the end of the walk. It teaches a coding agent to
drive egma: read `egma/config.yaml`, run `egma --help`, pull, push, run, and
keep the four verdicts apart.

## How it reaches your coding agent

Over the [Agent Client Protocol](https://agentclientprotocol.com). The agent runs
as a subprocess and egma is the client. Which agents exist, and the command that
starts each one, come from the protocol's own agent registry, mirrored inside
this package so a first run needs no network for the lookup.

Your code and your prompts never leave your machine. There is no egma model in
this path and no egma server in it.

## Questions, and the one file that is never read

egma answers every permission request the agent raises, and starts it in the
most permissive mode it offers, so you are not interrupted while it works.
That is only safe because everything the agent does appears on screen as it
happens.

One thing is never allowed: any file whose name starts with `.env`. Those hold
secrets, and once read they are in a model's context for good. egma refuses the
file and tells the agent to work from your code and to ask you for anything it
still needs.

## Options

```
egma [options]           The wizard.
egma login [options]     Sign this machine in. No questions, plain lines.
egma connect [options]   Register your voice agent and a way to reach it.
                         The key comes in on standard input or from the
                         environment, never as an argument.
egma init [options]      Make the egma folder this repository's tests live
                         in. Safe to run again.
egma pull [options]      Write egma's current test versions into it.
egma push [options]      Upload the tests in it. Refuses, naming names, when
                         egma has moved on since your last pull.
egma run [options]       Run this folder's tests, pinning the version of each.
                         Follows the run and prints every change.

  --coding-agent <id>  Which coding agent to drive, named as the agent
                       registry names it. Default: claude-acp
  --cwd <path>         The folder to work in. Default: this folder.
  --url <address>      The egma to talk to, for a self-hosted one. Kept
                       after the first login, so it is set once. EGMA_URL
                       does the same for a whole shell.
  --force              With login: sign in again even when this machine
                       already holds a key.
  --no-follow          With run: start the run and return at once, without
                       waiting for a verdict. The run carries on on egma.
  --retell-agent <id>  With connect: which agent, when the Retell account
                       holds more than one.
  --repo-prompt <path> With connect: the prompt file in this repository, so
                       egma can say whether it and Retell have drifted apart.
  --existing-tests <path>
                       With the wizard: test cases you already have written
                       down, inside this folder. They are turned into test
                       files before egma writes any of its own.
  --agent <name>       With init: what to call the voice agent this
                       folder's tests are for.
  --connection <name>  With init: what to call the way egma reaches it.
  --suite <name>       With init: what to call this folder's test suite.
  --headless           Run with no terminal and no keystroke: plain lines,
                       and the task taken as already agreed to.
  -h, --help           Print this.
  -v, --version        Print the version.

Environment:
  EGMA_URL             The egma to talk to, for a whole shell. Same as --url.
  EGMA_HOME            The folder egma keeps this machine's key in.
                       Default: ~/.egma
  EGMA_RETELL_API_KEY  Your Retell key, for egma connect. RETELL_API_KEY is
                       read too, so an environment that already has one needs
                       nothing new.
  EGMA_RETELL_AGENT_ID Which Retell agent, same as --retell-agent.
  EGMA_RETELL_URL      The Retell to talk to. Default: https://api.retellai.com
  EGMA_EXISTING_TESTS  Your existing test cases, same as --existing-tests.
  VISUAL, EDITOR       What e opens a generated test in, at the gate.
```

`Ctrl-C` stops a run at any point. The agent, and anything the agent started,
is shut down before egma exits, and the line left behind says where it stopped.
If tests had already been written into `egma/tests/`, that line says how many
are there — they are yours, and egma never removes them to tidy up its own
report.

## Requirements

Node 22 or newer. A coding agent installed — Claude Code and Codex both work,
as does any agent in the protocol registry that ships as a package.

You do not have to be logged in to it first. If it asks egma to log in, egma
hands you to that agent's own login and carries on where it left off. And if
there is no coding agent here for egma to drive at all, it prints the words to
paste into whichever one you do use, and stops.

## Trying it on an instance of your own

egma is open source and runs on your machine. That checkout is a **platform
workspace** — the deployment's own directory, and deliberately not your agent
repository. The platform's carrier and provider credentials belong to whoever
runs the platform; an agent repository holds only tests and the address of the
platform that owns their identifiers. On one laptop both are often yours, and
they stay two directories, because one platform serves many repositories.

Clone the repository, then, from your checkout of it:

```
pnpm install
npx egma self-host up
```

That starts a whole egma — Postgres, ClickHouse, the API, the pages, the
simulator, the grader, and the LiveKit server, SIP gateway and Redis a phone
call needs — and prints the address to point an agent repository at. Open it and
sign up: you become the admin of your own instance.

It also prints the platform's **phone** state, separately from being ready,
because a platform with no carrier runs text simulations perfectly well. To make
it able to place calls, one more command in the same directory:

```
npx egma self-host phone setup
```

It asks for a Twilio account, a voice number that account **already owns**, and
one OpenAI key — the persona's words, its voice, its ears and the judge. It
shows a plan before it writes anything to your carrier, and it never buys, ports
or registers a number. The Twilio Auth Token is used once and kept nowhere: what
runs afterwards holds a SIP credential for one trunk and nothing else on that
account.

The command itself is not on npm yet, so build it from the same checkout:

```
pnpm --filter egma-cli build
```

Then run it from the repository that holds your voice agent, naming the
instance you just signed up on:

```
cd ~/your-voice-agent
EGMA_URL=http://localhost:3101 node ~/egma/apps/cli/dist/bin.js
```

(`~/egma` is wherever you cloned this. When the package ships, that whole line
becomes `npx egma`.)

The wizard signs this machine in against that instance, registers your agent
and a way to reach it, writes a first suite of tests with your coding agent,
puts them on egma when you say so, and starts a run over them.

**Where it stops today.** The run is created and followed live, and no verdict
arrives: nothing claims a simulation yet, so the run stays pending and every
simulation stays queued. What is missing is the grader and the piece that hands
a test to the simulator; both are being built. Everything before them is real,
and the moment they land the first verdict arrives on the same screen with
nothing here to change.

The whole walk is checked against a real instance the same way. On a checkout
that has had `pnpm install`, and on a machine with a Chrome — or with
`PLAYWRIGHT_BROWSERS_PATH` pointing at a Playwright Chromium, because the
approval really happens in a browser — it is two commands:

```
pnpm db:up
pnpm --filter egma-cli smoke:walk
```

The second builds everything it needs, starts an egma of its own, signs in,
registers, pushes and runs — and says at the end what it proved and what waits.
Set `RETELL_API_KEY` to register against your own Retell account instead of the
stand-in one it starts.

## Licence

Apache 2.0. Parts of the terminal UI are adapted from the PostHog wizard under
the MIT licence; see `NOTICE`.
