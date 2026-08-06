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

`npx egma` finds your voice agent. It starts the coding agent you already have,
hands it egma's own notes on how voice agents are built, and has it read this
folder and report four things: which framework runs your voice agent, where its
prompts live, where its tools are defined, and how it reaches production. Every
action it takes appears on screen while it works, and the facts it finds arrive
one line at a time.

Nothing is changed and nothing is written. Your code and your prompts never
leave this machine.

If this folder holds no voice agent, egma asks once for the folder your prompts
are in — teams often keep them apart — looks there, and otherwise says plainly
that you should run it where your agent is defined.

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
egma [options]

  --coding-agent <id>  Which coding agent to drive, named as the agent
                       registry names it. Default: claude-acp
  --cwd <path>         The folder to work in. Default: this folder.
  --headless           Run with no terminal and no keystroke: plain lines,
                       and the task taken as already agreed to.
  -h, --help           Print this.
  -v, --version        Print the version.
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
