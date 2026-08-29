# Connect a LiveKit worker

Use this phase after discovery proves a LiveKit worker. Ground the connection
in committed repository evidence. Its first incomplete query is read-only. Run
the complete connection only after the developer approves its exact resources
and choices.

## Read the offered choices

Read the catalog in promptless, read-only steps:

1. Run `<egma> connect --platform livekit` to read its `modality_option`
   lines.
2. Repeat it with `--modality <offered-modality>` to read the
   `access_variant_option` lines for that modality.
3. Repeat it with the chosen `--modality` and `--access-variant` to read every
   `required_field` and `required_secret` fact for that catalog entry.

Each incomplete command exits with an unchosen or missing-input status and
writes nothing. When the developer asks for a first end-to-end test without
naming a modality, use `chat` when it is offered and state that low-cost default
in the setup plan instead of asking a separate modality question. Ask for the
modality when `chat` is unavailable or the requested proof needs audio. Always
present every offered access variant and ask when more than one is available.
For every other request, present multiple modalities to the developer and use
only the exact selected value. Do not add credentials until the fields and
exact remote setup have been approved.

Read `<egma> connect --help` for the current option names. A complete command
has this shape:

```text
<egma> connect --platform livekit \
  --name <egma-agent-name> \
  --modality <offered-modality> \
  --access-variant <offered-access-variant> \
  --livekit-url <wss-url> \
  [--dispatch-name <registered-worker-name>] \
  [--token-endpoint <https-url>] \
  [--metadata <json-object>]
```

Supply only the fields requested for the selected access variant. Use the
registered dispatch name proved by source. A similar worker name is not
identity.

## Keep provider credentials out of arguments

For LiveKit project credentials, set `EGMA_LIVEKIT_API_KEY` and
`EGMA_LIVEKIT_API_SECRET` in the environment of this command. For a customer
token endpoint, set `EGMA_LIVEKIT_TOKEN_HEADERS` to its JSON header object.
Ask the developer to supply the required values without printing or inspecting
them. Never put a key, secret, or header object in command arguments.

When the command reports a missing or invalid public field, fix only that
field. When it reports a missing or invalid credential, ask the developer to
correct the named environment value. On `name-taken`, ask for a new Egma agent
name. Repeat the command only after the unresolved choice or input is supplied.

Finish when the receipt reports `status: connected`, the intended agent and
connection IDs, modality, access variant, and `grounded_in: repository`. Keep
the receipt as identity evidence. It contains no provider prompt or tool
context and must contain no credential value.

The CLI prints `receipt: livekit-registration`, `project_id`, and the complete
agent and connection facts as soon as Egma confirms remote registration. It
prints them before it reads the project or updates `egma/config.yaml`. If a
later local step fails, keep those facts and run the printed recovery command:

```text
<egma> connect record \
  --platform livekit \
  --project-id <project_id> \
  --agent-id <agent_id> \
  --connection-id <connection_id>
```

That command authenticates, reads and proves the exact remote project, agent,
and LiveKit room connection, then writes their current names and modality to
local `egma/config.yaml`. It takes no provider credential and makes no remote
write. Do not repeat the complete connection command after
`status: repository-record-failed`.

The complete command prints `registration_name` immediately before its remote
registration request. If the command becomes unreachable before it prints a
registration receipt, do not choose a new name, repeat the setup, or inspect the
Egma UI for IDs. Use the same provider-public target that the developer
approved:

```text
<egma> connect record \
  --platform livekit \
  --livekit-url <approved-wss-url> \
  --dispatch-name <registered-worker-name> \
  [--modality <chat|voice>] \
  [--access-variant <offered-access-variant>] \
  [--metadata <approved-json>] \
  [--name <last-registration_name>]
```

For a token-endpoint target, replace `--dispatch-name` with
`--token-endpoint <https-url>`. Pass exactly one of those flags. The modality
and access variant are optional match refinements. Pass `--metadata` exactly
when the approved setup included it; omission requires a target with none.
`--name` only prefers a matching Egma agent name; it does not define the
LiveKit target. If several
equivalent connections remain, match the approved access variant and modality
against the printed `connection_option` lines and repeat with that
`--connection-id`.

Provider-public recovery makes no remote write and writes the equivalent target
to local `egma/config.yaml`. `registration-not-found` means Egma has no
equivalent public LiveKit target. It does not mean that the attempted name is
absent. Explain that result, get fresh setup approval, and only then repeat the
original command.
