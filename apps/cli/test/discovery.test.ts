/**
 * Finding the voice agent, against a committed repository and a scripted agent.
 *
 * No model, no network, no human. What is checked is what a developer could
 * check afterwards: what the wizard said on screen, what the summary card holds,
 * what the coding agent was handed, what landed on disk, and the one line left
 * behind. Never the order egma did things in.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HeadlessUI } from "../src/ui/headless-ui.ts";
import { buildExitLine, buildExitNotice } from "../src/wizard/exit-line.ts";
import { walk } from "../src/wizard/walk.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import {
  RETELL_FIXTURE_REPO,
  filesUnder,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

type Report = {
  observations: Record<string, unknown>;
  instructions: string[];
  folders: string[];
  loggedInWith: string | null;
};

/** One turn of the agent's own words, ended the way a real one ends a line. */
function says(...lines: string[]): FakeStep {
  return { kind: "say", text: `${lines.join("\n")}\n` };
}

/** What a coding agent that read the fixture repository properly would report. */
const REPORTS_THE_FIXTURE: FakeStep[] = [
  says("egma:note Reading package.json"),
  {
    kind: "tool-call",
    id: "t1",
    title: "Read",
    toolKind: "read",
    locations: [{ path: "package.json" }],
  },
  { kind: "read-file", path: "package.json", recordAs: "manifest" },
  { kind: "tool-call-update", id: "t1", status: "completed" },
  says(
    "I can see a Retell agent here.",
    "egma:found framework retell-sdk",
    "egma:found prompts prompts/order-line.md (pushed to Retell by scripts/deploy.ts)",
    "egma:found tools src/tools/*.ts (2 definitions, registered as Retell custom tools)",
    "egma:found deploy Retell-hosted; scripts/deploy.ts updates the agent",
    "egma:found agent-id src/config.ts",
  ),
  { kind: "stop", reason: "end_turn" },
];

/** A folder with nothing in it that egma could test. */
const REPORTS_NOTHING: FakeStep[] = [
  says("egma:note Reading the folder"),
  says("egma:none There is no voice agent in this folder."),
  { kind: "stop", reason: "end_turn" },
];

describe("finding the voice agent", () => {
  /** The repository under test: the committed fixture, copied so it can be watched. */
  let repo: Workspace;
  /** Everything the test itself needs on disk, kept out of the repository. */
  let scratch: Workspace;

  beforeEach(async () => {
    repo = await makeWorkspace({}, { from: RETELL_FIXTURE_REPO });
    scratch = await makeWorkspace();
  });

  afterEach(async () => {
    await repo.remove();
    await scratch.remove();
  });

  const reportFile = (): string => path.join(scratch.dir, "agent-report.json");

  const observed = async (): Promise<Report> =>
    JSON.parse(await readFile(reportFile(), "utf8")) as Report;

  /** The record a dispatch left in the folder it was sent to work in. */
  const recordIn = async (dir: string): Promise<Report> =>
    JSON.parse(await readFile(path.join(dir, "fake-agent-report.json"), "utf8")) as Report;

  it("reports the framework, the prompts, the tools and how it reaches production", async () => {
    const script = await scratch.script({
      reportFile: reportFile(),
      steps: REPORTS_THE_FIXTURE,
    });

    const ui = new HeadlessUI();
    const report = await walk({
      ui,
      launch: scratch.launch(script),
      cwd: repo.dir,
      signal: new AbortController().signal,
    });

    // Every fact reached the screen while the agent worked.
    expect(ui.record.statuses).toContain("◆ Reading package.json");
    expect(ui.record.statuses).toContain("┊ Framework  retell-sdk");
    expect(ui.record.statuses).toContain(
      "┊ Prompts    prompts/order-line.md (pushed to Retell by scripts/deploy.ts)",
    );

    // And the card at the end holds all of them, in one place, aligned.
    expect(ui.record.summary.split("\n")).toEqual([
      "Your voice agent",
      "  Framework  retell-sdk",
      "  Prompts    prompts/order-line.md (pushed to Retell by scripts/deploy.ts)",
      "  Tools      src/tools/*.ts (2 definitions, registered as Retell custom tools)",
      "  Deploy     Retell-hosted; scripts/deploy.ts updates the agent",
      "  Agent id   src/config.ts",
    ]);

    expect(report).toEqual({
      kind: "found-agent",
      framework: "retell-sdk",
      prompts: "prompts/order-line.md (pushed to Retell by scripts/deploy.ts)",
    });
    expect(buildExitLine(report)).toBe(
      "Egma found your voice agent: retell-sdk, prompts in prompts/order-line.md (pushed to Retell by scripts/deploy.ts).",
    );
  });

  it("hands the coding agent both skills, and leaves the repository as it found it", async () => {
    const before = await filesUnder(repo.dir);

    const script = await scratch.script({
      reportFile: reportFile(),
      steps: REPORTS_THE_FIXTURE,
    });

    await walk({
      ui: new HeadlessUI(),
      launch: scratch.launch(script),
      cwd: repo.dir,
      signal: new AbortController().signal,
    });

    // The skills arrived as the task's own instructions — not installed, not
    // written down, not fetched: sent.
    const instructions = (await observed()).instructions;
    expect(instructions).toHaveLength(1);
    const sent = instructions[0] as string;
    expect(sent).toContain("name: finding-the-voice-agent");
    expect(sent).toContain("name: retell-voice-agents");
    expect(sent).toContain("egma:found framework retell-sdk");
    expect(sent).toContain("# Your task");
    expect(sent).toContain(repo.dir);

    // And nothing at all landed on the developer's disk.
    expect(await filesUnder(repo.dir)).toEqual(before);
    expect(before).toContain("prompts/order-line.md");
  });

  it("asks once for a pointer when the folder holds nothing, and looks there", async () => {
    const elsewhere = await makeWorkspace({}, { from: RETELL_FIXTURE_REPO });
    const empty = await makeWorkspace({ "README.md": "# nothing here yet\n" });

    try {
      // Each dispatch is its own agent, so each leaves its own record where it
      // was pointed — which is how both folders can be checked.
      const script = await scratch.script({
        steps: REPORTS_NOTHING,
        stepsByFolder: [{ contains: path.basename(elsewhere.dir), steps: REPORTS_THE_FIXTURE }],
      });

      const ui = new HeadlessUI({ answers: { "prompts-pointer": elsewhere.dir } });
      const report = await walk({
        ui,
        launch: scratch.launch(script),
        cwd: empty.dir,
        signal: new AbortController().signal,
      });

      // Asked once, and only once.
      expect(ui.record.asked).toEqual(["prompts-pointer"]);
      // Looked here first, then where it was pointed — two folders, two tasks.
      expect((await recordIn(empty.dir)).folders).toEqual([empty.dir]);
      expect((await recordIn(elsewhere.dir)).folders).toEqual([elsewhere.dir]);
      expect((await recordIn(elsewhere.dir)).instructions[0]).toContain(
        `Find the voice agent in ${elsewhere.dir}`,
      );
      expect(report).toEqual({
        kind: "found-agent",
        framework: "retell-sdk",
        prompts: "prompts/order-line.md (pushed to Retell by scripts/deploy.ts)",
      });
      expect(ui.record.summary).toContain("src/config.ts");
    } finally {
      await elsewhere.remove();
      await empty.remove();
    }
  });

  it("says in plain words where to run again when there is nothing to point at", async () => {
    const empty = await makeWorkspace({ "README.md": "# nothing here yet\n" });

    try {
      const script = await scratch.script({
        reportFile: reportFile(),
        steps: REPORTS_NOTHING,
      });

      // Nobody supplied a pointer, which is a real answer and not a hang.
      const ui = new HeadlessUI();
      const report = await walk({
        ui,
        launch: scratch.launch(script),
        cwd: empty.dir,
        signal: new AbortController().signal,
      });

      expect(ui.record.asked).toEqual(["prompts-pointer"]);
      expect(report).toEqual({ kind: "no-agent-context" });
      expect(buildExitLine(report)).toBe(
        "Egma found no voice agent to test. Run egma again where your agent is defined.",
      );
      expect(buildExitNotice(report)).toBeNull();
    } finally {
      await empty.remove();
    }
  });

  it("stops asking after the pointer, even when the pointer leads nowhere either", async () => {
    const alsoEmpty = await makeWorkspace({ "notes.txt": "nothing\n" });
    const empty = await makeWorkspace({ "README.md": "# nothing here yet\n" });

    try {
      const script = await scratch.script({
        reportFile: reportFile(),
        steps: REPORTS_NOTHING,
      });

      const ui = new HeadlessUI({ answers: { "prompts-pointer": alsoEmpty.dir } });
      const report = await walk({
        ui,
        launch: scratch.launch(script),
        cwd: empty.dir,
        signal: new AbortController().signal,
      });

      expect(ui.record.asked).toEqual(["prompts-pointer"]);
      expect(report).toEqual({ kind: "no-agent-context" });
    } finally {
      await alsoEmpty.remove();
      await empty.remove();
    }
  });

  it("hands the developer to the coding agent's own login, then finishes the step", async () => {
    const script = await scratch.script({
      reportFile: reportFile(),
      authRequiredUntilLogin: {},
      steps: REPORTS_THE_FIXTURE,
    });

    const ui = new HeadlessUI();
    const report = await walk({
      ui,
      launch: scratch.launch(script),
      cwd: repo.dir,
      signal: new AbortController().signal,
    });

    // It was the agent's own login that ran, and egma carried straight on.
    expect((await observed()).loggedInWith).toBe("own-login");
    expect(ui.record.statuses).toContain(
      "◆ Fake Agent needs you to log in. Handing you to its own login.",
    );
    expect(report.kind).toBe("found-agent");
    expect(ui.record.summary).toContain("retell-sdk");
  });

  it("ends the task itself when the agent says it cannot go on", async () => {
    const script = await scratch.script({
      reportFile: reportFile(),
      steps: [
        says("egma:abort This repository is not one I can read."),
        { kind: "wait", ms: 60_000 },
        { kind: "write-file", path: "never-written.txt", content: "x\n", recordAs: "afterAbort" },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const ui = new HeadlessUI();
    const report = await walk({
      ui,
      launch: scratch.launch(script),
      cwd: repo.dir,
      signal: new AbortController().signal,
    });

    // egma did not wait out the minute, and the step after the abort never ran.
    expect(await filesUnder(repo.dir)).not.toContain("never-written.txt");
    expect((await observed()).observations["afterAbort"]).toBeUndefined();

    // A stop is a stop. It is never told as an empty folder, so nobody is
    // asked to point egma somewhere else and nobody is told there is no voice
    // agent here — neither of which the agent said.
    expect(report).toEqual({
      kind: "coding-agent-stopped",
      drivenAgentName: "Fake Agent",
      reason: "This repository is not one I can read.",
    });
    expect(ui.record.asked).toEqual([]);
    expect(buildExitLine(report)).toBe(
      "Fake Agent stopped before it found your voice agent: This repository is not one I can read.",
    );

    // And the reason was on screen while it happened, not only at the end.
    expect(ui.record.statuses).toContain("✗ This repository is not one I can read.");
  });

  it("shows the agent's own words when it looked and found nothing", async () => {
    const empty = await makeWorkspace({ "README.md": "# nothing here yet\n" });

    try {
      const script = await scratch.script({ reportFile: reportFile(), steps: REPORTS_NOTHING });

      const ui = new HeadlessUI();
      await walk({
        ui,
        launch: scratch.launch(script),
        cwd: empty.dir,
        signal: new AbortController().signal,
      });

      // Every action is streamed, and "I found nothing" is the most important
      // thing this agent said all run.
      expect(ui.record.statuses).toContain("┊ There is no voice agent in this folder.");
    } finally {
      await empty.remove();
    }
  });

  it("names the command in a terminal line, which says nothing without one", async () => {
    const script = await scratch.script({
      reportFile: reportFile(),
      steps: [
        {
          kind: "tool-call",
          id: "t1",
          title: "Terminal",
          toolKind: "execute",
          rawInput: { command: "rg -l retell-sdk src", description: "Look for the SDK" },
        },
        { kind: "tool-call-update", id: "t1", status: "completed" },
        says("egma:found framework retell-sdk"),
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const ui = new HeadlessUI();
    await walk({
      ui,
      launch: scratch.launch(script),
      cwd: repo.dir,
      signal: new AbortController().signal,
    });

    expect(ui.record.statuses).toContain("◆ Terminal ┊ rg -l retell-sdk src");
    expect(ui.record.statuses).not.toContain("◆ Terminal");
  });

  it("keeps the agent's prose in the log and off the screen", async () => {
    const script = await scratch.script({
      reportFile: reportFile(),
      steps: REPORTS_THE_FIXTURE,
    });

    const kept: string[] = [];
    const ui = new HeadlessUI();
    await walk({
      ui,
      launch: scratch.launch(script),
      cwd: repo.dir,
      signal: new AbortController().signal,
      log: { file: path.join(scratch.dir, "agent.log"), write: (chunk) => kept.push(chunk) },
    });

    expect(kept.join("")).toContain("I can see a Retell agent here.");
    expect(ui.record.statuses.join("\n")).not.toContain("I can see a Retell agent here.");
  });

  it("prints what to paste when there is no coding agent on the machine", async () => {
    const ui = new HeadlessUI();
    const report = await walk({
      ui,
      launch: {
        id: "not-here",
        name: "Nothing",
        command: path.join(scratch.dir, "no-such-coding-agent"),
        args: [],
        env: {},
      },
      cwd: repo.dir,
      signal: new AbortController().signal,
    });

    expect(report).toEqual({ kind: "no-coding-agent" });

    const notice = buildExitNotice(report) as string;
    expect(notice).toContain("Open the coding agent you use, and paste this into it:");
    expect(notice).toContain("Find the voice agent in this repository");
    expect(buildExitLine(report)).toContain("no coding agent on this machine");
  });

});
