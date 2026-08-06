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

This is the first working slice. `npx egma` signs this machine in to egma, then
starts the coding agent you already have, gives it one small task — read a file
in this folder and say what it is — and shows you every action it takes while it
works. That proves the path the rest of the product runs on: egma drives your
own agent, on your own machine, with your own login.

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
code: WDJB-MJHT
approve_url: https://app.egma.ai/device?user_code=WDJB-MJHT
browser: opened
waiting: for this code to be approved in a browser
status: stored
credentials: /home/you/.egma/credentials

0 signed in   2 denied   3 the code ran out   4 egma did not answer
130 stopped part way
```

The key is written to `~/.egma/credentials`, readable only by you, together with
the address it belongs to.

### On a machine with no browser

Over SSH, on a devbox, in a container: press `[c]` and egma asks your terminal
to put the address on the clipboard of the machine your keyboard is on. Approve
it in a browser over there, then paste it back — the whole address, the
`?user_code=…` part of it, or just the code. All three work.

If your terminal is too narrow to show the address whole, egma says how much
wider it needs to be instead of drawing an address that breaks across two lines.

### Your own instance

```
EGMA_URL=http://localhost:3000 npx egma
```

or `--url`. It is kept beside the key after the first login, so later commands
find it without being told again.

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

  --coding-agent <id>  Which coding agent to drive, named as the agent
                       registry names it. Default: claude-acp
  --cwd <path>         The folder to work in. Default: this folder.
  --url <address>      The egma to talk to, for a self-hosted one. Kept
                       after the first login, so it is set once. EGMA_URL
                       does the same for a whole shell.
  --force              With login: sign in again even when this machine
                       already holds a key.
  --headless           Run with no terminal and no keystroke: plain lines,
                       and the task taken as already agreed to.
  -h, --help           Print this.
  -v, --version        Print the version.
```

`Ctrl-C` stops a run at any point. The agent, and anything the agent started,
is shut down before egma exits.

## Requirements

Node 22 or newer. A coding agent installed and logged in — Claude Code and
Codex both work, as does any agent in the protocol registry that ships as a
package.

## Licence

Apache 2.0. Parts of the terminal UI are adapted from the PostHog wizard under
the MIT licence; see `NOTICE`.
