# Egma CLI

The Egma CLI gives developers and coding agents small, promptless commands for
working with an Egma Project from a repository. Workflow and
repository-specific judgment stay outside the CLI. The CLI performs the named
local or remote operation.

The npm package is `egma-cli`. It installs the `egma` command.

```bash
npm install --global egma-cli
egma --help
```

Node.js 22 or newer is required.

## Use it from a coding agent

The CLI is designed to be used by a coding agent that has workflow guidance.
The public `integrate-egma` skill is still being authored and does not yet
contain complete Connection and monitoring guides. Use the command workflow in
this README directly until that skill is complete. The test-authoring skill is
available separately:

```bash
npx --yes skills add egma-ai/egma \
  --skill write-egma-tests
```

The developer tells the coding agent the outcome, such as:

> Set up simulation testing and production monitoring for the Retell agent in
> this repository. Follow the Egma CLI workflow in its README.

The goal and the voice-agent platform come from that request and the source
code. They are not CLI state. The coding agent inspects the repository, asks
only when a real choice remains, and uses one CLI command for each operation.

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
egma suite delete
egma test delete
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
Agent ID, name, attached phone numbers, and reusable Connection command shapes.
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

## Register an Agent

`agent register` registers only an Egma Agent identity. It does not accept
Access, Modality, provider identity, Connection configuration, or provider
credentials.

Retell example:

```bash
egma agent register --platform retell --name Receptionist
```

LiveKit example:

```bash
egma agent register --platform livekit --name Receptionist
```

If `--name` is omitted, Egma uses the repository directory name. The command
prints the stable Egma Agent ID and refreshes `egma/config.yaml`.

## Add a Connection

Use the Egma Agent ID from `egma/config.yaml`. Access and Modality are always
explicit.

Add the first Retell chat Connection:

```bash
EGMA_RETELL_API_KEY=... \
  egma agent connection add \
  --agent agt_... \
  --access retell-api-key \
  --modality chat \
  --retell-agent agent_...
```

The first Retell Connection binds the selected Retell Agent to the Egma Agent.
Later Retell Connections reuse that stored provider identity and credential.
For example, add a phone Connection:

```bash
egma agent connection add \
  --agent agt_... \
  --access retell-phone-number \
  --modality voice \
  --retell-phone-number +14155550111
```

If the phone Connection is the first one, also supply the one-time key and
`--retell-agent` exactly as in the first example.

Add a LiveKit Project-credentials Connection:

```bash
EGMA_LIVEKIT_API_KEY=... \
EGMA_LIVEKIT_API_SECRET=... \
  egma agent connection add \
  --agent agt_... \
  --access livekit-project-credentials \
  --modality voice \
  --livekit-url wss://example.livekit.cloud \
  --livekit-agent-name receptionist
```

Add a LiveKit token-endpoint Connection:

```bash
EGMA_LIVEKIT_TOKEN_ENDPOINT_HEADERS='{"Authorization":"Bearer ..."}' \
  egma agent connection add \
  --agent agt_... \
  --access livekit-token-endpoint \
  --modality voice \
  --livekit-url wss://example.livekit.cloud \
  --livekit-token-endpoint https://example.com/livekit/token
```

`--name` is an optional Connection name. The platform product label is the
default. There is no `--platform` flag on Connection creation because the Egma
Agent supplies its platform. Run `egma agent connection add --help` for every
accepted flag.

## Provider credentials

Provider credentials are needed during setup. Egma seals the credential on the
platform. The CLI never writes it to `egma/config.yaml` or an environment file.

Use the canonical environment variables shown above, or use
`--credentials-stdin`. Standard input is one JSON object with the API credential
field names. When a coding agent starts the CLI as a child process, it can write
`{"apiKey":"..."}` for Retell or
`{"apiKey":"...","apiSecret":"..."}` for LiveKit directly to that process.
It must not build a shell command that contains either secret.

Do not put secrets in CLI arguments. Arguments can be saved in shell history
and exposed through process inspection.

When an Egma Agent already has a sealed provider credential, that stored value
wins. A leftover environment variable does not rotate it. When no stored value
exists, explicit standard input wins over the canonical environment variable.

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

Delete an existing remote Suite or Test through its local repository handle:

```bash
egma suite delete receptionist-core
egma test delete receptionist-core/greets-the-caller.md
```

Egma deletes the remote resource first. It removes the exact local directory or
file only after the platform confirms deletion. A refused remote deletion keeps
all local bytes. An unpushed local Test has no remote identity, so remove that
draft directly instead of using `egma test delete`.

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
After a successful start it prints the Run ID and the web results URL, then
returns. Follow progress on that web page.

Before a real phone Run, the coding agent must state the Suite, target, and
expected simulation count, warn that calls can cost money, and obtain fresh
developer approval. The CLI does not prompt for that approval.

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
Agent. Monitoring-only setup for a bare Retell Agent accepts `--retell-agent`
and a one-time credential through `EGMA_RETELL_API_KEY` or JSON on standard
input. Stop future call pulls with:

```bash
egma agent monitoring stop \
  --agent agt_... \
  --platform retell
```

For LiveKit, setup and stop do not mutate the repository or the platform. They
print the planned integration-skill handoff because the source-code change does
not belong in the CLI:

```bash
egma agent monitoring setup \
  --agent agt_... \
  --platform livekit
```

The command prints:

```bash
npx --yes skills add egma-ai/egma --skill integrate-egma
```

That handoff is not completed setup while the public monitoring guide is still
being authored. Follow the Python or JavaScript SDK monitoring guide directly.
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

Commands print readable prose, headings, lists, and copyable IDs. Humans and
coding agents read the same output. There is no `--json` mode or stable private
`key: value` protocol.

Exit `0` means the requested operation completed or was already satisfied. Exit
`1` means it did not complete. Exit `130` means the command was interrupted.
Each command's help describes the inputs it accepts; command output explains the
next action when work cannot continue.

## Licence

Apache 2.0.
