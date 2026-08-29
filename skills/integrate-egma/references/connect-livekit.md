# Connect a LiveKit worker

Use this phase after discovery proves a LiveKit worker. Ground the connection
in committed repository evidence. Its first incomplete query is read-only. Run
the complete connection only after the developer approves its exact resources
and choices.

## Read the offered choices

Run `<egma> connect --platform livekit` with no provider fields to read its
`modality_option`, `access_variant_option`, and `required_field` lines. This
incomplete command writes nothing. Present multiple modalities or access
variants to the developer and use only the exact selected value.

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
