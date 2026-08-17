import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { InstalledCodingAgent } from "../src/acp/coding-agents.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
import { runWizard } from "../src/wizard/wizard-flow.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

let workspace: Workspace | null = null;

afterEach(async () => {
  await workspace?.remove();
  workspace = null;
});

describe("coding-agent choice", () => {
  it("starts only the selected agent and carries it into voice-agent discovery", async () => {
    workspace = await makeWorkspace({ "package.json": "{}\n" });
    const script = await workspace.script({
      steps: [
        { kind: "say", text: "egma:found framework retell-sdk\n" },
        { kind: "stop", reason: "end_turn" },
      ],
    });
    const chosen = workspace.launch(script);
    const installed: InstalledCodingAgent[] = [
      {
        id: "claude",
        name: "Claude Code",
        version: "2.1.233",
        executable: path.join(workspace.dir, "must-not-start"),
        launch: {
          id: "claude",
          name: "Claude Code",
          command: path.join(workspace.dir, "must-not-start"),
          args: [],
          env: {},
        },
      },
      {
        id: "codex",
        name: "Codex",
        version: "0.148.0",
        executable: chosen.command,
        launch: { ...chosen, id: "codex", name: "Codex" },
      },
    ];
    const ui = new HeadlessUI({ answers: { "coding-agent": "codex" } });

    const report = await runWizard({
      ui,
      codingAgent: { kind: "choose", installed },
      cwd: workspace.dir,
      signal: new AbortController().signal,
    });

    expect(report.kind).toBe("found-agent");
    expect(ui.record.codingAgentChoices.map((agent) => agent.id)).toEqual([
      "claude",
      "codex",
    ]);
    expect(ui.record.drivenAgent).toEqual({ id: "codex", name: "Codex" });
  });

  it("ends clearly when no supported coding agent was found", async () => {
    workspace = await makeWorkspace({});
    const ui = new HeadlessUI();

    const report = await runWizard({
      ui,
      codingAgent: { kind: "choose", installed: [] },
      cwd: workspace.dir,
      signal: new AbortController().signal,
    });

    expect(report).toEqual({ kind: "no-coding-agent" });
    expect(ui.record.phase).toBe("no-coding-agent");
  });
});
