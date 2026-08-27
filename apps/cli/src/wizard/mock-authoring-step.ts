/**
 * The mocked world, written after the tests it has to serve.
 *
 * A LiveKit simulation reaches the developer's real tools unless Egma is
 * standing in front of them, and Egma can only stand there if the SDK is inside
 * the worker. Until this step existed, a wizard-onboarded LiveKit repository ran
 * its first simulations against a live backend with no tool facts, no mock
 * tools and no coverage stamp, and nothing in the walk ever said so.
 *
 * This dispatch owns one grounded answer per real tool in
 * `egma/mock-tools.md`, read out of the repository's own tool code, and the
 * failure-branch overrides inside the tests that need one. The worker and its
 * dependency manifest belong to the earlier worker-integration step and are
 * outside this task's authority.
 *
 * Tests first and mocks after, deliberately: the developer's attention goes to
 * the situations their agent has to survive, and the mocked world follows the
 * situations rather than leading them.
 *
 * **What is on disk is the truth.** The world this step reports is read back
 * out of the folder, never taken from what the agent said about it, and the
 * gate shows what was read.
 */

import type { DrivenAgent } from "../acp/driven-agent.ts";
import {
  FOLDER_NAME,
  MOCK_TOOLS_FILE_NAME,
  readMockToolsFile,
  type FolderPaths,
} from "../folder/egma-folder.ts";
import type { MockToolEntry } from "../folder/mock-tools.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import type { Facts } from "./discovery.ts";
import type { DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
import { FACTS, LABEL_WIDTH } from "./facts.ts";
import { MarkerStream, type ParsedLine } from "./markers.ts";
import { ACTION_MARK, DETAIL_MARK, FAILURE_MARK } from "./status.ts";
import { stopReport } from "./stop.ts";
import { GenerationTally } from "./test-generation.ts";
import { supportsLiveKitSdk } from "./worker-integration-step.ts";

/** What this step knows before it dispatches anything. */
export type MockAuthoringContext = {
  /** The folder the agent works in, and the whole of what it may touch. */
  readonly cwd: string;
  /** The suite whose tests were just written, for the override half. */
  readonly suiteDirectory: string;
  /** What the find-the-agent step reported, by fact name. */
  readonly facts: Facts;
  /** What the agent is called on Egma. */
  readonly agentName: string;
  /** The tests already in the folder, which are the only ones to edit. */
  readonly tests: readonly string[];
};

/** The facts card, as a block a task can carry. */
function contextBlock(facts: Facts): readonly string[] {
  const lines: string[] = [];
  for (const fact of FACTS) {
    const value = facts.get(fact.name);
    if (value === undefined) continue;
    lines.push(`  ${fact.label.padEnd(LABEL_WIDTH)}  ${value}`);
  }
  return lines.length === 0 ? ["  Nothing was reported about the repository."] : lines;
}

function testsBlock(tests: readonly string[]): readonly string[] {
  if (tests.length === 0) return ["There are no test files to edit."];
  return [
    "These tests were just written, and they are the only files you may edit",
    "under egma/tests/:",
    "",
    ...tests.map((name) => `- ${name}`),
  ];
}

/** What Egma asks the coding agent to do. */
function mockAuthoringTask(context: MockAuthoringContext): string {
  return [
    "# Your task",
    "",
    `Write the mocked world for ${context.agentName}'s first simulations.`,
    "",
    "## Where you may write",
    "",
    `Work in ${context.cwd}. You may write exactly two kinds of file and`,
    "nothing else:",
    "",
    "- `egma/mock-tools.md`, the project's mocked world;",
    `- the test files in egma/tests/${context.suiteDirectory}/ that already exist.`,
    "",
    "Read whatever committed source you need. Run no command that reaches the",
    "network and install nothing.",
    "",
    "## What Egma knows about this repository",
    "",
    ...contextBlock(context.facts),
    "",
    "## 1. Write the mocked world",
    "",
    "Read the agent's real tool definitions in this repository. For **each real",
    "tool**, write one answer into `egma/mock-tools.md` under the `## Mock tools`",
    "heading that is already in that file:",
    "",
    "````markdown",
    "### check_availability",
    "```json",
    '{ "answer": { "slots": ["Wednesday 15:00", "Thursday 11:00"] } }',
    "```",
    "````",
    "",
    "Rules for the answers, and every one of them matters:",
    "",
    "- The `###` heading is the tool's own name, spelt exactly as the tool code",
    "  spells it. Matching is by name and nothing else.",
    "- `answer` is the same JSON shape that real tool returns. Read the tool's",
    "  code and its return type; do not copy the shape from the example above.",
    "- Make each answer an ordinary, successful, plausible one. This file is the",
    "  world every test starts in, so it is the happy path.",
    "- Keep the answers consistent with each other: one invented customer, one",
    "  invented booking, one set of invented times, across every tool.",
    "- Leave the prose Egma wrote at the top of the file exactly as it is.",
    "",
    "## 2. Write the failure branches into the tests that need them",
    "",
    ...testsBlock(context.tests),
    "",
    "A test that depends on a specific backend state — nothing free in the",
    "calendar, a lookup that fails, an answer that takes three seconds — gets its",
    "own `## Mock tools` section at the end of its file, overriding one tool for",
    "that test alone. A test that does not depend on one gets no section: the",
    "project's world already covers it. Read each test before you decide, and",
    "leave everything else in the file exactly as it is.",
    "",
    "## Say what you are doing, as you do it",
    "",
    "This is not optional and it is not decoration. Egma turns these lines into",
    "the list the developer watches fill in while you work. Write each one on a",
    "line of its own, at the very start of the line, with no bullet and no code",
    "fence:",
    "",
    "- one `egma:plan <tool>, <tool>, …` line, first, naming every real tool you",
    "  found;",
    "- an `egma:writing <tool>` line immediately before writing each answer;",
    "- an `egma:wrote <tool>` line after each answer is in the file;",
    "- an `egma:note <what you did>` line for each test you gave an override to;",
    "- an `egma:abort <reason>` line only when something prevents the work; stop",
    "  after it.",
    "",
    "## When you are done",
    "",
    "Stop once every real tool has an answer and every test that needed an",
    "override has one. Report nothing else.",
  ].join("\n");
}

/** The run-specific task. Worker integration already has its own owner. */
export function mockAuthoringInstructions(context: MockAuthoringContext): string {
  return mockAuthoringTask(context);
}

export type MockAuthoringOptions = {
  readonly ui: WizardUI;
  readonly drivenAgent: DrivenAgent;
  readonly signal: AbortSignal;
  readonly log: DrivenAgentLog;
  readonly paths: FolderPaths;
  readonly context: MockAuthoringContext;
};

export type MockAuthored = {
  /** Set only when the walk cannot carry on from here. */
  readonly halted: ExitReport | null;
};

/**
 * One dispatch, and then the folder read back.
 *
 * The result says only whether the walk can carry on. What was authored is
 * read from the folder and shown at the gate.
 */
export async function mockAuthoringStep(
  options: MockAuthoringOptions,
): Promise<MockAuthored> {
  const { ui, drivenAgent, signal, log } = options;

  // A Node worker cannot serve these answers with the Python-only SDK. The
  // integration owner already said that once, so this step stays silent.
  if (!supportsLiveKitSdk(options.context.facts)) {
    return { halted: null };
  }

  const tally = new GenerationTally("mocking", 0);
  const markers = new MarkerStream();
  ui.setGeneration(tally.progress);

  const take = (lines: readonly ParsedLine[]): string | null => {
    let abort: string | null = null;
    let moved = false;
    for (const line of lines) {
      if (line.kind === "prose") {
        log.write(`${line.text}\n`);
        continue;
      }
      const marker = line.marker;
      log.write(`${JSON.stringify(marker)}\n`);
      switch (marker.kind) {
        case "plan": {
          tally.plan(marker.names);
          ui.pushStatus(
            `${ACTION_MARK} Planned ${String(marker.names.length)} ${marker.names.length === 1 ? "mock tool" : "mock tools"}`,
          );
          moved = true;
          break;
        }
        case "writing":
          tally.writing(marker.name);
          ui.pushStatus(`${ACTION_MARK} Writing mock tool ${marker.name}`);
          moved = true;
          break;
        case "wrote":
          tally.wrote(marker.name);
          ui.pushStatus(`${ACTION_MARK} Wrote mock tool ${marker.name}`);
          moved = true;
          break;
        case "note":
          ui.pushStatus(`${ACTION_MARK} ${marker.text}`);
          break;
        case "found":
        case "none":
          break;
        case "abort":
          // Said on the screen, and never fatal here: whatever was written
          // before the agent stopped is on disk, and the folder is read either
          // way.
          abort = marker.reason;
          ui.pushStatus(
            `${FAILURE_MARK} ${marker.reason === "" ? `${drivenAgent.name} stopped, and did not say why.` : marker.reason}`,
          );
          break;
      }
    }
    if (moved) ui.setGeneration(tally.progress);
    return abort;
  };

  ui.taskStarted();
  let result;
  try {
    result = await drivenAgent.run({
      instructions: mockAuthoringInstructions(options.context),
      watch: (chunk) => take(markers.push(chunk)),
    });
    take(markers.flush());
  } finally {
    ui.setGeneration(null);
    ui.taskFinished();
  }

  const halted = ((): ExitReport | null => {
    switch (result.kind) {
      case "interrupted":
        return stopReport(signal, drivenAgent.name);
      case "unreachable":
        return { kind: "no-coding-agent" };
      case "needs-login":
        return {
          kind: "failed",
          reason: `${result.drivenAgentName} is not logged in, and Egma could not hand you to its login. Log in to it, then run egma again.`,
        };
      case "failed":
        ui.pushStatus(`What ${drivenAgent.name} printed is in ${log.file}`);
        return { kind: "failed", reason: result.reason };
      case "done":
      case "aborted":
        return null;
    }
  })();

  const mockTools = await readMockToolsFile(options.paths.mockTools).catch(
    () => [] as readonly MockToolEntry[],
  );

  if (halted === null) {
    if (mockTools.length === 0) {
      ui.pushStatus(
        `${DETAIL_MARK} No mock tools were written, so every tool this agent has runs for real.`,
      );
    } else {
      ui.pushStatus(
        `${ACTION_MARK} ${mockTools.length} mock ${mockTools.length === 1 ? "tool" : "tools"} in ${FOLDER_NAME}/${MOCK_TOOLS_FILE_NAME}`,
      );
    }
  }

  return { halted };
}
