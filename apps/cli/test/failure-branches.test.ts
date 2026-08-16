/**
 * The five ways the walk does not reach a suite, each one ending honestly.
 *
 * They are first-class here rather than an afterthought, because a wizard is
 * judged on what it does when the machine is cold, the key is wrong, the
 * repository is the wrong one, or Egma cannot do the thing the developer is
 * about to be charged for.
 *
 * What is asserted is what the developer is left with — the line in their
 * scrollback, the number the shell gets, and whether they were asked the same
 * question twice. Not the order Egma tried things in.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INVALID_KEY_LINE } from "../src/retell/connect.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
import { buildExitLine, buildExitNotice } from "../src/wizard/exit-line.ts";
import { alreadyAsked } from "../src/wizard/login-step.ts";
import { walk } from "../src/wizard/walk.ts";
import type { FakeStep } from "./support/fake-agent.ts";
import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import {
  CLI_ENTRY,
  RETELL_FIXTURE_REPO,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const KEY = "key_3d8e1f60ba725c94af13";
const WRONG_KEY = "key_0000000000000000notthis";

const ACCOUNT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_quillfeather_order_line",
      agent_name: "order-line",
      response_engine: { type: "retell-llm", llm_id: "llm_quillfeather" },
    },
  ],
  llms: [{ llm_id: "llm_quillfeather", general_prompt: "Answer the order line.\n" }],
};

/** What the find-the-agent step is answered with when it is meant to succeed. */
const FOUND: FakeStep[] = [
  { kind: "say", text: "egma:found framework retell-sdk\n" },
  { kind: "stop", reason: "end_turn" },
];

/** A scripted agent that writes the one test the walk asked it for. */
const WRITES_ONE_TEST = {
  contains: "Write 1 test",
  steps: [
    { kind: "say", text: "egma:writing open-on-sunday\n" },
    {
      kind: "write-file",
      path: "egma/tests/open-on-sunday.md",
      content: [
        "---",
        "name: open-on-sunday",
        "---",
        "## Scenario",
        "Somebody rings on a Sunday.",
        "## Expected behaviors",
        "1. The agent says which days the workshop opens.",
        "",
      ].join("\n"),
    },
    { kind: "say", text: "egma:wrote open-on-sunday\n" },
    { kind: "stop", reason: "end_turn" },
  ] as FakeStep[],
};

let platform: Platform;
let retell: FakeRetell;
let workspace: Workspace;

beforeEach(async () => {
  platform = await startPlatform();
  retell = await startFakeRetell(ACCOUNT);
  workspace = await makeWorkspace({}, { from: RETELL_FIXTURE_REPO });
  await workspace.signIn(platform.url, platform.device.mint());
});

afterEach(async () => {
  await retell.close();
  await platform.close();
  await workspace.remove();
});

/** The walk, with whatever the developer would have answered written down. */
async function walkWith(options: {
  readonly script: string;
  readonly answers?: Partial<Record<"prompts-pointer" | "retell-key" | "reach", string>>;
}) {
  // Text unless a check says otherwise: every branch here is about a way the
  // walk can fail before or after the choice, not about the choice itself.
  const ui = new HeadlessUI({ answers: { reach: "text", ...(options.answers ?? {}) } });

  // A walk that gets as far as a suite ends in a run, and a run ends when
  // verdicts arrive. Nothing here conducts a simulation, so the fixture is
  // given the one thing a platform with a simulator attached has. The branches
  // that never reach a run are unaffected by it.
  const grading = gradeEveryRun(platform);
  let report;
  try {
    report = await walk({
      ui,
      launch: workspace.launch(options.script),
      cwd: workspace.dir,
      signal: new AbortController().signal,
      platform: alreadyAsked({
        url: platform.url,
        instanceId: platform.instanceId,
        credentialsFile: workspace.credentialsFile,
      }),
      retell: { url: retell.url },
      howManyTests: 1,
      home: path.join(workspace.dir, "pretend-home"),
      runPollMs: 20,
    });
  } finally {
    grading.stop();
  }
  return { ui, report };
}

describe("no coding agent on this machine", () => {
  it("prints what to paste into one, and leaves without a fault", async () => {
    // A command that is not on this machine is the same thing to a developer as
    // no coding agent at all, so it is the same ending.
    const missing = path.join(workspace.dir, "no-such-coding-agent");

    const result = await new Promise<{ stdout: string; code: number }>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          CLI_ENTRY,
          "--url",
          platform.url,
          "--headless",
          "--cwd",
          workspace.dir,
          "--",
          missing,
        ],
        {
          cwd: workspace.dir,
          env: workspace.env(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.on("close", (code) => resolve({ stdout, code: code ?? 1 }));
    });

    // Egma did everything it could, so this is the run finishing rather than
    // failing — and the developer has words that work without Egma at all.
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Open the coding agent you use, and paste this into it:");
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(
      "Egma found no coding agent on this machine that it can drive, so it printed what to paste into yours instead.",
    );
  });

  it("says the same thing in the same words wherever the walk noticed", async () => {
    const report = { kind: "no-coding-agent" } as const;
    expect(buildExitNotice(report)).toContain("paste this into it:");
    expect(buildExitLine(report)).toContain("printed what to paste into yours instead");
  });
});

describe("a coding agent that is not logged in", () => {
  it("hands the developer to its own login and carries straight on", async () => {
    const script = await workspace.script({
      // A cold machine: the first session is refused until the client has
      // authenticated, exactly as a real adapter refuses one.
      authRequiredUntilLogin: {},
      steps: FOUND,
      stepsByTask: [WRITES_ONE_TEST],
    });

    const { ui, report } = await walkWith({ script, answers: { "retell-key": KEY } });

    // The login was handed off and the walk resumed on the other side of it.
    const observed = JSON.parse(
      await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
    ) as { loggedInWith: string | null };
    expect(observed.loggedInWith).toBe("own-login");
    expect(ui.record.statuses.join("\n")).toContain("needs you to log in");

    expect(report.kind).toBe("run-started");
    expect(platform.tests.tests).toHaveLength(1);
  });
});

describe("no voice agent anywhere", () => {
  it("asks once where the prompts are, then says plainly to run it elsewhere", async () => {
    const script = await workspace.script({
      steps: [
        { kind: "say", text: "egma:none There is no voice agent in this folder.\n" },
        { kind: "stop", reason: "end_turn" },
      ],
    });

    const { ui, report } = await walkWith({ script });

    // Asked once, and only once: a second question would be Egma hoping.
    expect(ui.record.asked).toEqual(["prompts-pointer"]);
    expect(report).toEqual({ kind: "no-agent-context" });
    expect(buildExitLine(report)).toBe(
      "Egma found no voice agent to test. Run egma again where your agent is defined.",
    );

    // Nothing was registered and no folder was made, because Egma never got as
    // far as knowing what it would have been for. The platform binding is
    // written at the last moment before this repository owns its first
    // platform-issued identifier, and that moment never arrived — so a walk
    // that found nothing leaves the repository exactly as it was.
    expect(platform.registered.agents).toHaveLength(0);
    await expect(readFile(path.join(workspace.dir, "egma", "config.yaml"), "utf8")).rejects.toThrow();
  });
});

describe("a Retell key Retell will not take", () => {
  it("names that failure, asks once more, and stops on the second refusal", async () => {
    const script = await workspace.script({ steps: FOUND });

    const { ui, report } = await walkWith({
      script,
      answers: { "retell-key": WRONG_KEY },
    });

    // Told exactly which failure it was — not "something went wrong" — and
    // asked again with that sentence above the box.
    expect(ui.record.keyAsks).toHaveLength(2);
    expect(ui.record.keyAsks[0]?.problem).toBeNull();
    expect(ui.record.keyAsks[1]?.problem).toBe(INVALID_KEY_LINE);
    expect(ui.record.statuses.filter((line) => line === INVALID_KEY_LINE)).toHaveLength(1);

    expect(report).toEqual({ kind: "failed", reason: "Retell would not take that key." });
    expect(buildExitLine(report)).toBe("Egma could not finish: Retell would not take that key.");

    // Nothing was written anywhere on a key that never worked.
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.registered.sealed).toHaveLength(0);
  });
});

describe("a connection Egma has no adapter for", () => {
  it("prints the platform's refusal in the platform's own words", async () => {
    // The platform refuses the *run*, at creation, before a single simulation
    // is written: a run nothing can conduct must never be queued. Everything
    // before it is untouched — the agent is registered, the tests are written
    // and pushed — and the wizard's whole job here is to hand that one
    // sentence on untouched.
    platform.running.noAdapterFor("retell");

    const script = await workspace.script({ steps: FOUND, stepsByTask: [WRITES_ONE_TEST] });
    const { ui, report } = await walkWith({ script, answers: { "retell-key": KEY } });

    const refusal = platform.running.noAdapterMessage("retell");
    expect(report).toEqual({ kind: "failed", reason: refusal });
    expect(buildExitLine(report)).toBe(`Egma could not finish: ${refusal}`);
    // Verbatim: not summarised, not softened, not swallowed.
    expect(buildExitLine(report)).toContain("no simulator adapter for a retell connection yet");
    expect(ui.record.statuses.join("\n")).toContain(refusal);

    // The work before the run is the developer's either way, and no run was
    // left queued that nothing could ever pick up.
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.tests.tests).toHaveLength(1);
    expect(platform.running.runs).toHaveLength(0);
    expect(ui.record.run).toBeNull();
  });
});
