# Egma CLI prototype

This prototype creates the first Egma agent, Retell connection and test from an
`egma-receptionist` repository. It reuses the project's seeded persona. It does
not change Retell, upload source code or start a simulation.

Build Egma and start the local deployment:

```bash
pnpm install
pnpm build
docker compose up -d --build
```

Authenticate once. The API key is stored outside the repository:

```bash
pnpm egma auth login
```

From the Egma checkout, preview one target agent:

```bash
pnpm egma init \
  --cwd /path/to/egma-receptionist \
  --tenant suncrest \
  --agent front-desk-flow-v1 \
  --scenario 'The caller wants to move an existing appointment.' \
  --expect 'The agent verifies the existing appointment before offering a new time.' \
  --plan
```

After approval, replace `--plan` with `--apply`. The command writes a
non-secret `.egma/project.yaml` receipt in the target repository. Run the same
command again to confirm that all resource IDs are reused.

Install the bundled Agent Skill in the target repository:

```bash
pnpm egma skill install --cwd /path/to/egma-receptionist
```

Use `--json` on plan, apply and status commands for coding-agent workflows.

The prototype composes the ordinary resource API described in
[`docs/factory-api.md`](../../docs/factory-api.md). That contract is part of
the prototype and can change before the first simulation path is accepted.
