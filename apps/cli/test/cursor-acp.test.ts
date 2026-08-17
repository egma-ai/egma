import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HeadlessUI } from "../src/ui/headless-ui.ts";
import { runWizard } from "../src/wizard/wizard-flow.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

let workspace: Workspace | null = null;

afterEach(async () => {
  await workspace?.remove();
  workspace = null;
});

describe("Cursor's ACP extensions", () => {
  it("answers both blocking requests so the wizard cannot hang", async () => {
    workspace = await makeWorkspace({});
    const reportFile = path.join(workspace.dir, "cursor-report.json");
    const script = await workspace.script({
      reportFile,
      steps: [
        { kind: "cursor-ask-question", recordAs: "question" },
        { kind: "cursor-create-plan", recordAs: "plan" },
        { kind: "say", text: "egma:none No voice agent here.\n" },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const report = await runWizard({
      ui: new HeadlessUI(),
      launch: { ...workspace.launch(script), id: "cursor", name: "Cursor" },
      cwd: workspace.dir,
      signal: new AbortController().signal,
    });
    const observed = JSON.parse(await readFile(reportFile, "utf8")) as {
      observations: Record<string, unknown>;
    };

    expect(report.kind).toBe("no-agent-context");
    expect(observed.observations).toMatchObject({
      question: {
        outcome: {
          outcome: "skipped",
          reason: "Egma owns this wizard's questions.",
        },
      },
      plan: {
        outcome: {
          outcome: "rejected",
          reason: "Egma does not need a separate plan approval.",
        },
      },
    });
  });
});
