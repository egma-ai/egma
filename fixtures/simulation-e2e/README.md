# Full simulation proof

This local command runs the same six required live cases as CI, one at a time:
Python and JavaScript LiveKit chat and voice, then Retell text and web. Every
case uses mocks, calls a real tool, stores conversation and tool evidence, and
reads the result and grade in a real browser.

Install the repository dependencies, Docker, Python 3.11 or newer, uv, Chrome,
and `cloudflared`. Set `EGMA_OPENAI_API_KEY` and
`SIMULATION_E2E_RETELL_API_KEY` in the gitignored root `.env` file, then run:

```sh
pnpm test:simulation-e2e:live
```

Retell uses a quick tunnel by default. To use an isolated locally managed
tunnel instead, set all three values in `.env`:
`SIMULATION_E2E_TUNNEL_ID`, `SIMULATION_E2E_TUNNEL_URL`, and
`SIMULATION_E2E_TUNNEL_CREDENTIALS_FILE`. The URL must be the fixed HTTPS
origin routed to that tunnel. Keep the credentials file outside the repository.
The hostname must allow server callbacks without a browser challenge.

The command starts the local data stores, syncs the simulator, and runs all six
cases with LiveKit Agents 1.7.1, project credentials, mocks on, and the ten
second session-start delay. It stops at the first failure. Redacted proof files
are written under `.proofs/simulation-e2e`.
