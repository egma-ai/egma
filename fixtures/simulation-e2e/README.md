# GPT Live full simulation proof

This opt-in local command runs the GPT Live persona through the public persona,
run, claim, result, grading, and browser flow. It runs Python and JavaScript
LiveKit chat and voice through project credentials and customer token endpoints,
then Retell text and web, one cell at a time. Every cell uses a real provider and
transport. Tool mocks keep the customer-agent result repeatable without asserting
exact model wording, turn counts, speech speed, or wall-clock timing.

Install the repository dependencies, Docker, Python 3.11 or newer, uv, Chrome,
and `cloudflared`. Set `EGMA_OPENAI_API_KEY` and
`SIMULATION_E2E_RETELL_API_KEY` in the gitignored root `.env` file, then run:

```sh
pnpm test:simulation-e2e:gpt-live
```

Retell uses a quick tunnel by default. To use an isolated locally managed
tunnel instead, set all three values in `.env`:
`SIMULATION_E2E_TUNNEL_ID`, `SIMULATION_E2E_TUNNEL_URL`, and
`SIMULATION_E2E_TUNNEL_CREDENTIALS_FILE`. The URL must be the fixed HTTPS
origin routed to that tunnel. Keep the credentials file outside the repository.
The hostname must allow server callbacks without a browser challenge.

The command starts the local data stores, syncs the simulator, and runs the
configured cells with project credentials, mocks on, and the session-start
delay. It stops at the first failure. It is not part of default CI and never
runs merely because credentials exist. Redacted proof files are written under
`.proofs/simulation-e2e`; a provider credit or configuration error is recorded
as a failure, not a pass.

The phone proof uses the repository's existing LiveKit SIP test against its
configured destination. It is separate from this fixture because this fixture
creates an isolated Retell agent, while a phone test must not rewrite a shared
number's inbound route. See `apps/simulator/tests/test_live_phone.py` for the
required destination and trunk settings. An omitted phone run is not evidence
that phone support passed.

`pnpm test:simulation-e2e:live` keeps the existing separate STT, reasoning, and
TTS persona coverage. The GPT Live command selects the combined Live speech
mode explicitly.

The `Tests` workflow always runs the separate persona cells. A manual dispatch
with `gpt_live_personas` enabled adds the GPT Live cells for both LiveKit access
variants and Retell text and web. Keep `deploy` disabled when dispatching a
feature branch.
