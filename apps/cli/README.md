# Egma CLI

The Egma CLI is the promptless command surface for integrating, testing, and
monitoring a voice agent. Public Agent Skills give a coding agent the workflow
and repository knowledge. Named CLI commands perform each local or remote
operation and print stable facts that the coding agent can read.

```bash
npx --yes @egma/cli
```

The package is `@egma/cli`; the command it installs is `egma`. The bare command
does only two things: it prints the public skill install command, and it prints
the exact handoff for the coding agent you already use. It does not sign in,
inspect the repository, start another agent, create resources, edit files, or
run tests.

## Requirements

- Node.js 22 or newer
- a coding agent that can read Agent Skills and run shell commands
- a browser where the developer can approve `egma login`

You can skip a global install. Use `egma` after a global install, or use
`npx --yes @egma/cli` as the command prefix on a clean machine.

## Give the repository to your coding agent

Run the bare command from the repository that contains the voice agent:

```bash
npx --yes @egma/cli
```

It prints this install command:

```bash
npx --yes skills add egma-ai/egma \
  --skill integrate-egma \
  --skill write-egma-tests \
  --skill egma
```

Then give your coding agent the printed handoff:

> Use the integrate-egma skill to complete the requested Egma simulation
> testing, production monitoring, or both for this repository's voice agent end
> to end.

For a self-hosted instance, add `--url` to the bare command. The output includes
the selected platform in the handoff:

```bash
npx --yes @egma/cli --url http://localhost:3101
```

The `integrate-egma` skill owns first-time discovery and setup. The `egma`
skill owns later pull, push, run, and result work. The `write-egma-tests` skill
owns the Markdown test format.

## The complete integration sequence

The copied end-to-end prompt authorizes the normal repository edits, remote
setup, publish, chat run, and monitoring work needed for its requested outcome.
The coding agent does not stop for repeated confirmation between these states.

1. The coding agent runs `egma login`. Egma opens the approval address, and the
   developer approves the request in the browser.
2. The coding agent inspects committed source without changing it. It identifies
   one voice agent, its platform, prompt, tools, entrypoint, and production path.
3. The pasted prompt selects **testing**, **monitoring**, or **both**. The coding
   agent asks only when the request or repository leaves a real choice.
4. The coding agent resolves the exact remote target from repository and CLI
   facts before `connect` or `monitoring enable` runs.
5. For supported testing, the coding agent connects the agent, lists valid
   personas, creates one suite, writes the smallest grounded test set, and adds
   the mocked world for a Python LiveKit worker.
6. The coding agent runs repository checks and `egma validate`, reads every
   changed file back, and shows the complete change.
7. The coding agent runs `egma push` as part of the requested end-to-end work.
8. The coding agent names the suite, agent, connection, modality, and simulation
   count. A real phone run is the exception: the coding agent warns that it
   places real calls and can cost money, then waits for approval.
9. The coding agent runs and follows the suite. For a repository-local Python
   LiveKit worker, the same `egma run` command starts, owns, and always stops the
   worker.
10. For monitoring or both, the coding agent runs `egma monitoring enable` on
    the settled agent, then reads
    `egma monitoring status`.

A monitoring-only integration skips the simulation connection, suite, test
files, publish, and run. A Both integration with supported testing finishes
only after the run and monitoring status are complete. JavaScript LiveKit
supports monitoring, but not simulation testing because its mocks are not
isolated between sessions. A JavaScript Testing request stops before remote
testing setup. A JavaScript Both request completes monitoring and reports the
testing boundary without claiming that Both completed.

## Sign in

The coding agent starts login:

```bash
egma login
```

Egma prints a short code and an approval URL, opens that URL when the machine
has a browser, and waits. The developer approves the code in the browser. The
command itself asks no terminal questions and reads no secret from standard
input.

```text
url: https://app.egma.ai
code: WDJBMJHT
approve_url: https://app.egma.ai/device?user_code=WDJBMJHT
browser: opened
waiting: for this code to be approved in a browser
status: stored
credentials: /home/you/.egma/credentials
```

If output says `browser: not-opened`, open `approve_url` yourself. The command
keeps polling until you approve or deny the request, the code expires, or an
interruption stops it.

`egma login` stores credentials in `~/.egma/credentials` and grants read access
only to the current user. `EGMA_HOME` changes the credentials folder. `egma
login --force` replaces an existing credential for the selected Egma instance.

For another Egma instance:

```bash
egma login --url http://localhost:3101
```

## Connect a Retell agent

Keep the Retell key on standard input or in the environment. Do not put it in a
command argument.

Egma seals a copy on the agent so production monitoring can be enabled later
without asking for the key again. Text and web-call connections also keep a
sealed copy for simulations. A phone connection keeps no key. The key never
lands in the repository.

```bash
EGMA_RETELL_API_KEY=key_live_... egma connect \
  --platform retell \
  --show-context \
  --retell-agent agent_... \
  --lanes text,web-call
```

The supported lanes are `text`, `web-call`, and `phone`. Several lanes create
several connections on the same Egma agent. A phone lane also needs the exact
public number when Retell routes more than one number to the agent:

```bash
cat retell-key.txt | egma connect \
  --platform retell \
  --show-context \
  --retell-agent agent_... \
  --lanes phone \
  --phone-number +14155550111
```

`--show-context` adds `provider_prompt:` and `provider_tools:` JSON facts to the
receipt. The coding agent uses that non-secret provider context to ground the
first tests. `--repo-prompt <path>` also compares a committed local prompt with
the prompt Retell runs and reports drift without blocking setup.

When a required choice is missing, the command lists exact options and writes
nothing. The coding agent shows those choices to the developer and repeats the
command only after the developer chooses.

## Connect a LiveKit worker

The selected Egma instance owns its LiveKit connection inputs. Read the catalog
in promptless steps without supplying credentials:

```bash
egma connect --platform livekit
egma connect --platform livekit --modality voice
egma connect --platform livekit \
  --modality voice \
  --access-variant livekit_room.project_credentials
```

The first incomplete command prints `modality_option`. The second prints
`access_variant_option` for the chosen modality. The third prints the
`required_field` and `required_secret` facts for the chosen catalog entry. Each
incomplete command is read-only and exits because a choice or input is missing.

Project credentials support the catalog's chat or voice modality. Supply the
key pair only in the command environment:

```bash
EGMA_LIVEKIT_API_KEY=... \
EGMA_LIVEKIT_API_SECRET=... \
egma connect \
  --platform livekit \
  --name front-desk \
  --modality voice \
  --access-variant livekit_room.project_credentials \
  --livekit-url wss://acme.livekit.cloud \
  --dispatch-name receptionist \
  --metadata '{"tenant":"acme"}'
```

The customer token endpoint variant is voice-only in the current catalog. It
keeps the LiveKit signing secret on your side:

```bash
EGMA_LIVEKIT_TOKEN_HEADERS='{"Authorization":"Bearer ..."}' \
egma connect \
  --platform livekit \
  --name front-desk \
  --modality voice \
  --access-variant livekit_room.customer_token_endpoint \
  --livekit-url wss://acme.livekit.cloud \
  --token-endpoint https://tokens.example/livekit
```

Use only variants and fields printed by the platform catalog. The CLI never
accepts LiveKit secrets as flags. A successful receipt ends with
`grounded_in: repository` and `status: connected`.

The CLI prints a non-secret remote receipt before it tries to persist the
registration locally. Its identity facts include:

```text
receipt: livekit-registration
project_id: prj_...
agent_id: agt_...
agent_name: front-desk
connection_id: con_...
connection_name: livekit_voice-1
connection_modality: voice
```

If the local record fails, the command exits `9` with
`status: repository-record-failed` and a `recovery_command`. Fix the local
problem, then run that exact command. Its essential form is:

```bash
egma connect record \
  --platform livekit \
  --project-id <id> \
  --agent-id <id> \
  --connection-id <id>
```

The recovery command authenticates with Egma, proves that the receipt IDs name
one LiveKit registration, and writes that proven target to local
`egma/config.yaml`. It makes no remote write, reads no provider secret, and does
not contact LiveKit.

Every complete connect command prints `registration_name` before each remote
registration request. If a Retell or LiveKit reply becomes unclear before a
receipt, use the settled provider-public identity without repeating setup.
For Retell, provide the provider agent ID and exactly one lane:

```bash
egma connect record \
  --platform retell \
  --retell-agent <provider-id> \
  --lanes <text|web-call|phone> \
  [--phone-number <e164>] \
  [--name <registration_name>]
```

Add `--phone-number` for the phone lane. For LiveKit, provide the server URL and
exactly one public access door:

```bash
egma connect record \
  --platform livekit \
  --livekit-url <wss-url> \
  --dispatch-name <registered-worker-name> \
  [--modality <chat|voice>] \
  [--access-variant <id>] \
  [--metadata <json>] \
  [--name <registration_name>]
```

For a token-endpoint target, replace `--dispatch-name` with
`--token-endpoint <https-url>`; provide exactly one of those flags. Pass
`--metadata` when the settled setup included it; omitting the flag requires a
target with no metadata. `--name` only prefers a matching Egma agent name; it
is not identity. If several
equivalent connections remain, the command prints `connection_option` lines so
the coding agent can repeat it with an exact `--connection-id` from command
output, without inspecting the Egma UI. Exact receipt IDs are the other
recovery mode. Both modes make no remote write, need no provider credential,
and write the proven or equivalent target to local `egma/config.yaml`. A
`registration-not-found` status means Egma has no equivalent public target. It
does not mean that an exact agent name is absent. Retell also stops when a
same-name row has no provable provider identity, including an ambiguous
phone-only row. It never creates a suffixed duplicate from that uncertainty.

## Create and author a suite

After a testing connection exists, list the personas the bound project allows:

```bash
egma personas
```

Each `persona:` line is JSON with a stable `id` and display `name`. A test must
name at least one returned persona. If the bound project already has remote
suites, run `egma pull` before creating anything.

Create the remote suite and its local manifest:

```bash
egma suite create receptionist-core --name "Receptionist core"
```

If create returns `status: unreachable`, Egma may have created the remote suite
before the response failed. If create returns `status: local-write-failed`, the
printed remote suite definitely exists. Run `egma pull` before any other create
attempt, then use the pulled suite when it exists.

The coding agent then writes the smallest grounded Markdown test set under
`egma/tests/receptionist-core/`. For Python LiveKit testing it also connects the
Egma SDK test entry and writes the project-wide external-dependency answers in
`egma/mock-tools.md`, with test-specific overrides only where a case needs a
different branch. JavaScript LiveKit testing stops before this setup because
the SDK does not provide session-isolated simulation mocks.

The repository folder is safe to commit:

```text
egma/
  config.yaml
  mock-tools.md
  tests/
    receptionist-core/
      suite.yaml
      *.md
```

No provider secret belongs in this folder.

## Validate, review, and publish

`validate` is read-only. It parses the complete local folder, checks every test
and mock-tool block, and confirms that each persona reference resolves to one
persona in the bound project.

```bash
egma validate
```

It prints `status: valid` only after the complete repository passes. On an
error it names every issue and writes nothing.

When the active task asks to publish the reviewed files:

```bash
egma push
```

`push` validates and uploads the complete repository as one project change. A
version conflict uploads nothing. Run `egma pull`, reconcile the remote change,
validate again, review the new diff, and retry when the task still asks to
publish.

## Run a suite

The run argument is the local suite directory:

```bash
egma run receptionist-core \
  --agent "Front desk" \
  --connection livekit_voice-1
```

When the repository has one runnable target, you can omit `--agent` and
`--connection`. The local suite must exactly match the current platform
versions.
Without `--no-follow`, the command waits until execution and all requested
grading are terminal. A low score does not make the command fail; an execution
or grading-system error does.

`--no-follow` returns after the remote run starts. Do not use it with a
CLI-owned local worker.

After preflight and before the start `POST`, the command prints an
`idempotency-key:`. If the start response becomes unclear and output contains
no `run:` receipt, repeat the exact same start with that key:

```bash
egma run receptionist-core \
  --agent "Front desk" \
  --connection livekit_voice-1 \
  --idempotency-key run_...
```

Keep the suite, agent, connection, run name, and current test versions exactly
the same. Never reuse the key for changed inputs or for a new run. A printed
`run:` ID identifies a run that already exists, so use that receipt instead of
starting again.

### Run with a local LiveKit worker

Pass all three worker flags together:

```bash
LIVEKIT_URL=wss://acme.livekit.cloud \
LIVEKIT_API_KEY=... \
LIVEKIT_API_SECRET=... \
egma run receptionist-core \
  --worker-entrypoint src/agent.py \
  --worker-dependency-manifest pyproject.toml \
  --worker-dispatch-name receptionist \
  --agent "Front desk" \
  --connection livekit_voice-1
```

The dependency manifest must be the worker project's `pyproject.toml` or
`requirements.txt`. The CLI checks the files and environment, starts the
worker, waits for its exact dispatch name to register, then starts the run. It
always stops the worker when the followed run completes, fails, or is
interrupted. The worker credentials are read only from `LIVEKIT_URL`,
`LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`.

The copied end-to-end prompt authorizes normal worker preparation. The
integration skill adds the latest unpinned Egma Python SDK through the
repository's package manager. The CLI may install or upgrade LiveKit CLI 2.18.2
or newer, create `.venv`, and install the declared dependencies with `uv` or
Python `pip`. The coding agent reports these changes and pauses only for an
unsafe conflict.

## Enable production monitoring

Monitoring is separate from simulation connections.

For Retell, send the account key on standard input and select the provider
agent when required:

```bash
cat retell-key.txt | egma monitoring enable \
  --platform retell \
  --platform-agent agent_...

egma monitoring status
```

For LiveKit, the coding agent installs the latest unpinned Egma SDK with the
repository's package manager. It adds `monitor_livekit(ctx)` to a Python worker
or installs `@egma/livekit` and adds `monitorLiveKit(ctx)` to a JavaScript
worker. It then enables the exact monitoring target:

```bash
egma monitoring enable --platform livekit
egma monitoring status
```

The LiveKit command never prints the minted secret. It writes the two SDK
environment values only to a regular `.env` file that Git already ignores. The
receipt prints the non-secret `env_file`, `monitoring_key_id`, and masked
`api_key` hint. If Egma cannot make the safe write, it tries to revoke the fresh
key and fails setup. If it cannot confirm revocation, the failure names the key
ID that the developer must revoke before retrying. The coding agent does not
read the file or repeat its secret.

Use `egma monitoring disable` to turn Retell polling off while keeping stored
conversations and the platform binding. `egma monitoring record` is a recovery
command for the narrow case where remote monitoring setup succeeded but the
repository record failed.

## Promptless command contract

Every named command asks no terminal questions. It prints one fact per line,
uses `status:` for the result, and uses its exit code as the next branch. A
coding agent can therefore perform the complete integration without a private
driver or terminal screen protocol.

The common options are:

```text
--cwd <path>     repository or platform workspace; default is the current folder
--url <address>  Egma platform for this command
--force          with login, replace the stored credential
-h, --help       current verbs, flags, environment, and exit codes
-v, --version    package version
```

Provider credentials never belong in arguments. The CLI refuses flag names
that could expose a secret through process lists or shell history.

## Keep the repository and Egma in step

```bash
egma pull
egma validate
egma push
```

`pull` plans and validates the complete local update before writing. It brings
remote suites, test versions, and project mock tools into the repository while
keeping unsynced local drafts. `push` is an atomic full-repository write.

## Start a self-hosted Egma platform

Egma runs as open-source software on your machine. The Egma checkout serves as
a **platform workspace**. Keep it separate from each voice-agent repository
because one platform can serve many agent repositories and platform secrets
must not spread into them.

From the Egma checkout:

```bash
pnpm install
cp .env.example .env
chmod 600 .env
npx --yes @egma/cli self-host up
```

This starts Postgres, ClickHouse, MinIO, the API, web application, simulator,
grader, bundled LiveKit server, SIP gateway, and Redis. It prints the platform
address to use from an agent repository.

The operator's `.env` contains only external values. Add the current key for
each model or voice provider selected by a persona or grader version:

```text
EGMA_OPENAI_API_KEY=...
EGMA_CARTESIA_API_KEY=...
EGMA_DEEPGRAM_API_KEY=... # only when selected
```

For optional phone simulations, add one complete carrier route:

```text
EGMA_PHONE_TRUNK_ADDRESS=example.pstn.twilio.com
EGMA_PHONE_SOURCE_NUMBER=+15551234567
EGMA_PHONE_TRUNK_USERNAME=egma-local
EGMA_PHONE_TRUNK_PASSWORD=...
```

Wrap a credential containing `$` in single quotes. To disable phone
simulations, remove all four values. The route must be absent or complete. For
Twilio, the username and password come from the SIP credential list attached to
the trunk. They are not the Account SID and Auth Token.

`egma self-host up` generates and preserves credentials used only between Egma
containers in `.egma-platform/platform.env`. Keep that file private and back it
up with the database volumes. External provider and carrier values remain in
the operator's `.env`; Postgres does not store them.

After changing `.env`, run `egma self-host up` again. To rotate a SIP
credential, replace all four carrier values, start the platform, test one phone
simulation, then revoke the old credential.

To use the CLI build from the same checkout:

```bash
pnpm --filter @egma/cli build
cd ~/your-voice-agent
node ~/egma/apps/cli/dist/bin.js --url http://localhost:3101
```

The bare local command prints the same skill install and coding-agent handoff.
The coding agent then runs the named commands against the supplied URL.

## Licence

Apache 2.0.
