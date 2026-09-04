# Egma CLI

The Egma CLI gives developers and coding agents small, promptless commands for
working with an Egma Project from a repository. Agent Skills own the workflow
and the repository-specific judgment. The CLI performs the named local or
remote operation.

The npm package is `egma-cli`. It installs the `egma` command.

```bash
npm install --global egma-cli
egma --help
```

Node.js 22 or newer is required.

## Use it with the Egma skills

Install the public skills separately:

```bash
npx --yes skills add egma-ai/egma \
  --skill integrate-egma \
  --skill write-egma-tests
```

The developer tells the coding agent the outcome, such as:

> Use the integrate-egma skill to set up simulation testing and production
> monitoring for the Retell agent in this repository.

The goal and the voice-agent platform come from that request and the source
code. They are not CLI state. The skill tells the coding agent what to inspect,
which choices need the developer, and which CLI command performs each step.

## Public command tree

```text
egma login
egma logout
egma init
egma pull
egma push

egma agent register
egma agent connection options
egma agent connection add
egma agent monitoring setup
egma agent monitoring stop

egma project api-key create
egma persona list
egma suite create
egma run create
egma run cancel
egma self-host up
```

Run `--help` at any node or leaf. For example:

```bash
egma agent --help
egma agent connection --help
egma agent connection add --help
```

The CLI has no wizard, interactive setup state machine, JSON output mode, or
public recovery and retry-key controls.

## Sign in and initialize a repository

Start browser-based device login:

```bash
egma login
```

For a self-hosted Egma instance:

```bash
egma login --url http://localhost:3101
```

The saved login is machine-local. By default it is under `~/.egma/`. Set
`EGMA_HOME` to use another machine-local directory. `EGMA_API_KEY` is also
supported; when present, it takes precedence over a saved login.

Initialize from the voice-agent repository:

```bash
egma init
```

Every new organization already has a Project. `init` never creates one. When
the login identifies a Project, `init` selects that Project and pulls its
Agents, Connections, suites, and tests. Use `--project <Project ID>`
only with an organization-scoped or older credential that does not identify one
Project. In that case, `init` lists the available Project IDs when the flag is
missing.

If this repository already points to the same Project, `init` acts as a pull.
If it points to another Project, Egma changes nothing and tells you to move or
delete `egma/` before initializing again.

Repository commands read the Egma URL and Project from `egma/config.yaml`. If
the file is absent, they stop and suggest `egma init`. Only `login`, `logout`,
and `init` accept `--url`.

Sign out from one Egma instance with:

```bash
egma logout
```

Logout revokes the saved device-login key, then removes only that origin from
the local credential file. It never revokes `EGMA_API_KEY`, never changes the
repository's `egma/` folder, and leaves the machine-local `~/.egma/` directory
in place.

## The committed repository index

`egma/config.yaml` contains stable, non-secret selectors:

```yaml
format: 4
platform:
  origin: https://app.egma.ai
project:
  id: prj_...
  name: Example Project
agents:
  - id: agt_...
    name: Receptionist
    platform: retell
    connections:
      - id: con_...
        name: Retell text mode
```

The file does not contain provider Agent IDs, Access, Modality, connection
types, or credentials. Egma reads those current facts from the platform API.

## Inspect connection options

Before registration, ask the selected Egma platform for its current connection
catalog:

```bash
egma agent connection options --platform retell
egma agent connection options --platform livekit
```

The API owns the supported Access and Modality combinations and which public or
secret fields each combination requires. The CLI maps those fields to readable
flags and credential sources. It does not keep a second required-fields table.

For Retell, the command also discovers provider Agents and prints each Retell
Agent ID, name, attached phone numbers, and usable registration command shapes.
It needs the Retell key for this first discovery:

```bash
EGMA_RETELL_API_KEY=... \
  egma agent connection options --platform retell
```

After registration, pass `--agent <Egma Agent ID>` to reuse the Retell key
sealed on that Egma Agent:

```bash
egma agent connection options \
  --platform retell \
  --agent agt_...
```

## Register an Agent and its first Connection

`agent register` creates or reuses one Egma Agent and adds its first Connection
in one API operation.

Retell text example:

```bash
EGMA_RETELL_API_KEY=... \
  egma agent register \
  --platform retell \
  --retell-agent agent_... \
  --access retell-api-key \
  --modality chat
```

Retell phone example:

```bash
EGMA_RETELL_API_KEY=... \
  egma agent register \
  --platform retell \
  --retell-agent agent_... \
  --access retell-phone-number \
  --modality voice \
  --phone-number +14155550111
```

The Retell Agent ID is accepted only for initial registration. The server keeps
that provider identity on the Egma Agent. Later commands use the Egma Agent ID.

LiveKit Project credentials example:

```bash
EGMA_LIVEKIT_API_KEY=... \
EGMA_LIVEKIT_API_SECRET=... \
  egma agent register \
  --platform livekit \
  --name receptionist \
  --access livekit-project-credentials \
  --modality voice \
  --livekit-url wss://example.livekit.cloud \
  --dispatch-name receptionist
```

LiveKit token endpoint example:

```bash
EGMA_LIVEKIT_TOKEN_HEADERS='{"Authorization":"Bearer ..."}' \
  egma agent register \
  --platform livekit \
  --name receptionist \
  --access livekit-token-endpoint \
  --modality voice \
  --livekit-url wss://example.livekit.cloud \
  --token-endpoint https://example.com/livekit/token
```

`--name` and `--connection-name` are optional when the platform can supply a
clear default. Run `egma agent register --help` for every accepted flag.

## Provider credentials

Provider credentials are needed during setup. Egma seals the credential on the
platform. The CLI never writes it to `egma/config.yaml` or an environment file.

Use the canonical environment variables shown above, or use
`--credentials-stdin`. Retell standard input is the raw API key:

```bash
printf '%s' "$RETELL_KEY" | \
  egma agent connection options \
  --platform retell \
  --credentials-stdin
```

LiveKit standard input is one JSON object:

```bash
printf '%s' '{"apiKey":"...","apiSecret":"..."}' | \
  egma agent register \
  --platform livekit \
  --name receptionist \
  --access livekit-project-credentials \
  --modality voice \
  --livekit-url wss://example.livekit.cloud \
  --dispatch-name receptionist \
  --credentials-stdin
```

Do not put secrets in CLI arguments. Arguments can be saved in shell history
and exposed through process inspection.

When an Egma Agent already has a sealed provider credential, that stored value
wins. A leftover environment variable does not rotate it. When no stored value
exists, explicit standard input wins over the canonical environment variable.

## Add another Connection

Use the Egma Agent ID from `egma/config.yaml`:

```bash
egma agent connection add \
  --agent agt_... \
  --access retell-api-key \
  --modality voice
```

The Agent supplies its platform and provider Agent ID. Do not pass `--platform`
or `--retell-agent`. Use the public fields required by the selected server
catalog option. Run `egma agent connection add --help` for the accepted flags.

## Pull, author, and push tests

Pull the complete remote repository state:

```bash
egma pull
```

Pull refreshes the Agent and Connection index, suites, and tests. It keeps local
test drafts instead of overwriting them.

List the Project's personas and create a suite:

```bash
egma persona list
egma suite create receptionist-core --name "Receptionist core"
```

Write tests under `egma/tests/receptionist-core/`. One Markdown file is the
whole of one test: its scenario, its expected behaviors, its personas, the mock
tools it answers for itself under `## Mock tools`, and the world it starts in
under `## Env`. The `write-egma-tests` skill owns the Markdown format and
test-authoring guidance.

Push the complete repository state:

```bash
egma push
```

Push validates before it uploads. There is no separate public validation
command. The generated platform client and API contract remain the source of
truth for what the server accepts.

## Create and cancel Runs

The first argument to `run create` is a local suite directory, not a Suite ID.
The Egma Agent and Connection IDs are explicit:

```bash
egma run create receptionist-core \
  --agent agt_... \
  --connection con_... \
  --name "Release check"
```

The command pushes the complete repository first. A failed push creates no Run.
After a successful start it prints only the Run ID, the web results URL, and
`status: started`, then returns. Follow progress on that web page.

Cancel a Run with:

```bash
egma run cancel run_...
```

## Production monitoring

Set up Retell monitoring for an explicit Egma Agent:

```bash
egma agent monitoring setup \
  --agent agt_... \
  --platform retell
```

Retell setup uses the provider identity and sealed key stored on the Egma
Agent. Stop it with:

```bash
egma agent monitoring stop --agent agt_...
```

For LiveKit, setup and stop do not mutate the repository or the platform. They
point the coding agent to the integration skill, which owns the source-code
change:

```bash
egma agent monitoring setup \
  --agent agt_... \
  --platform livekit
```

The command prints:

```bash
npx --yes skills add egma-ai/egma --skill integrate-egma
```

The CLI does not claim that LiveKit monitoring is active or inactive before a
trace arrives.

## Create a Project API key

```bash
egma project api-key create --name "Local automation"
```

The key is scoped to the Project in `egma/config.yaml`. Its secret is printed
once and is not stored by the CLI.

## Start a self-hosted platform

From an Egma platform checkout:

```bash
pnpm install
cp .env.example .env
chmod 600 .env
egma self-host up
```

This command starts the local Egma services. It is the only public command that
uses the platform workspace instead of a voice-agent repository.

To use a local CLI build from another repository:

```bash
pnpm --filter egma-cli build
cd /path/to/voice-agent
node /path/to/egma/apps/cli/dist/bin.js --help
```

## Output and exit behavior

Commands print readable facts, one per line. Humans and coding agents can read
the same output. There is no `--json` mode.

Exit `0` means the requested operation completed. Other exits distinguish
missing input, authentication, platform refusal or outage, local write failure,
and interruption. Exit `130` means the command was interrupted. Each command's
help describes the inputs it accepts; command output explains the next action
when work cannot continue.

## Licence

Apache 2.0.
