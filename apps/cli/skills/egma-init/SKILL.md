---
name: egma-init
description: Create the first Egma agent, Retell connection, and default-persona test from an egma-receptionist repository.
---

# Egma first test

Use this skill when the user wants to connect an existing `egma-receptionist`
Retell agent to Egma or create its first test.

## Boundaries

- Use the `egma` CLI for every read and write.
- Do not read, print, or ask the user to paste Retell or Egma credentials.
- Do not call the Retell API directly. The CLI reads the repository environment
  without returning secret values.
- Do not change the Retell agent, upload source code, or start a simulation.
- Keep the test scenario separate from the expected behavior. The simulated
  caller must not see the expected behavior.
- Show the complete plan and get one clear approval before apply.

## Flow

1. Inspect `tenants/*/agents/*` and choose the Retell agent the user means. If
   more than one is plausible, ask one short selection question.
2. Propose one narrow happy-path scenario and one observable expected behavior
   from the selected agent's local prompt or flow.
3. Run:

   ```bash
   egma init --tenant <tenant> --agent <agent> \
     --scenario '<what the caller wants>' \
     --expect '<what the tested agent must do>' \
     --plan --json
   ```

4. Explain the returned plan in plain language. State that Retell will not
   change, source code will not upload, and no simulation will start.
5. After the user approves that exact plan, run the same command with
   `--apply --yes --json` instead of `--plan --json`.
6. Report the agent, connection, test, and persona IDs. Say `created, not run`.
   Show the exact next command returned by the CLI.
7. Run `egma init status --json` to confirm the receipt reads back.

On a rerun, use the same inputs. The CLI must return the same IDs and mark the
resources as reused.
