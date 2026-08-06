# egma

The egma wizard and client, in one command.

```
npx egma
```

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

### Your own instance

```
EGMA_URL=http://localhost:3000 npx egma
```

or `--url`. It is kept beside the key after the first login, so later commands
find it without being told again.

## The notes egma hands your coding agent

They are markdown files inside this package, under `skills/`. They are sent as
part of the task, at the moment the task is sent. Nothing is installed on your
machine, nothing is downloaded, and nothing is written to your repository.

Today there are two: one on finding a voice agent in a repository nobody has
described, and one on what a Retell voice agent looks like from the inside.

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
egma init [options]      Make the egma folder this repository's tests live
                         in. Safe to run again.
egma pull [options]      Write egma's current test versions into it.
egma push [options]      Upload the tests in it. Refuses, naming names, when
                         egma has moved on since your last pull.

  --coding-agent <id>  Which coding agent to drive, named as the agent
                       registry names it. Default: claude-acp
  --cwd <path>         The folder to work in. Default: this folder.
  --url <address>      The egma to talk to, for a self-hosted one. Kept
                       after the first login, so it is set once. EGMA_URL
                       does the same for a whole shell.
  --force              With login: sign in again even when this machine
                       already holds a key.
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
```

`Ctrl-C` stops a run at any point. The agent, and anything the agent started,
is shut down before egma exits.

## Requirements

Node 22 or newer. A coding agent installed — Claude Code and Codex both work,
as does any agent in the protocol registry that ships as a package.

You do not have to be logged in to it first. If it asks egma to log in, egma
hands you to that agent's own login and carries on where it left off. And if
there is no coding agent here for egma to drive at all, it prints the words to
paste into whichever one you do use, and stops.

## Licence

Apache 2.0. Parts of the terminal UI are adapted from the PostHog wizard under
the MIT licence; see `NOTICE`.
