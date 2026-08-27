/**
 * The mocked world, written after the tests it has to serve.
 *
 * A LiveKit simulation reaches the developer's real tools unless Egma is
 * standing in front of them, and Egma can only stand there if the SDK is inside
 * the worker. Until this step existed, a wizard-onboarded LiveKit repository ran
 * its first simulations against a live backend with no tool facts, no mock
 * tools and no coverage stamp, and nothing in the walk ever said so.
 *
 * So one dispatch does the two halves of one promise:
 *
 *   **the seam** — `await mockable(agent, ctx, session)` in the worker, put
 *   there by the developer's own coding agent under the public
 *   `integrate-egma` skill's SDK phase, as an edit they watch happen and
 *   approve at the gate with everything else;
 *
 *   **the world** — one grounded answer per real tool in `egma/mock-tools.md`,
 *   read out of the repository's own tool code, and the failure-branch
 *   overrides inside the tests that need one.
 *
 * Tests first and mocks after, deliberately: the developer's attention goes to
 * the situations their agent has to survive, and the mocked world follows the
 * situations rather than leading them.
 *
 * **What is on disk is the truth.** The world this step reports is read back
 * out of the folder, never taken from what the agent said about it, and the
 * gate shows what was read. The seam is held to the same rule: a coding agent
 * that reports the edit is not taken at its word — Egma opens the file it named
 * and looks for the awaited call. An agent that says it wired the worker and
 * did not would otherwise send a developer into a run against their real
 * backend with every screen saying it was isolated, which is the one lie in
 * this walk that costs somebody real money.
 *
 * Nothing here is fatal. A worker whose entrypoint nobody can identify is a
 * repository that gets the lines printed and a run without a coverage stamp —
 * which is exactly the run every LiveKit repository got before this step, and
 * an honest sentence about it beats ending a walk that has tests to run.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { DrivenAgent } from "../acp/driven-agent.ts";
import {
  FOLDER_NAME,
  MOCK_TOOLS_FILE_NAME,
  readMockToolsFile,
  type FolderPaths,
} from "../folder/egma-folder.ts";
import type { MockToolEntry } from "../folder/mock-tools.ts";
import { instructionsWith, publicSkill } from "../skills/index.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import type { Facts } from "./discovery.ts";
import type { DrivenAgentLog } from "./driven-agent-log.ts";
import type { ExitReport } from "./exit-line.ts";
import { FACTS, LABEL_WIDTH } from "./facts.ts";
import { MarkerStream, type ParsedLine } from "./markers.ts";
import { ACTION_MARK, DETAIL_MARK, FAILURE_MARK } from "./status.ts";
import { stopReport } from "./stop.ts";
import { GenerationTally } from "./test-generation.ts";

/** The fact the coding agent reports the edited worker file under. */
const SDK_ENTRY_FACT = "sdk-entry";

/**
 * The awaited call the skill teaches, in the shapes it is really written in.
 *
 * The wait is the load-bearing half — a tool list that has not reached Egma
 * before the model reaches for its first tool serves nothing — so the `await`
 * is required rather than assumed. What is allowed to vary is what a person or
 * a model varies: the whitespace, a line break after `await`, and a module
 * prefix on the name for a worker that imported the package rather than the
 * function.
 *
 * **Where this check stops, on purpose.** It reads the file's code, so an
 * awaited call that is only mentioned — in a comment, a docstring, a string —
 * does not count. It cannot tell whether the code it found is on the path the
 * worker really takes: a real call in a function nothing dispatches would pass
 * here. Proving that is a call graph, which is not something deterministic CLI
 * code has any business doing to somebody's repository, and it is answered for
 * real one step later — the mock-tool coverage stamp on the first simulation is
 * written by the SDK when it actually runs, and it is the verifier that cannot
 * be talked into anything. This check exists to tell an edit that happened from
 * one that did not, which is the failure that really comes up.
 */
const AWAITED_MOCKABLE = /\bawait\s+(?:[A-Za-z_]\w*\s*\.\s*)*mockable\s*\(/u;

/** The two ways a Python string opens and the text it runs to. */
const TRIPLE_QUOTES = ['"""', "'''"] as const;

/**
 * A line that is only a `//` comment, which is not Python at all.
 *
 * Kept as a second pass rather than taught to the scanner, because `//` inside
 * Python is floor division and blanking from it to the end of the line would
 * take real code with it. A line that *starts* with it is another language's
 * comment in a file somebody named by mistake, and blanking that costs nothing.
 */
const FOREIGN_COMMENT_LINE = /^\s*\/\//u;

/**
 * The file with everything that is not Python code blanked out.
 *
 * A model that has been asked to add one line writes it in more places than the
 * one that runs: pasted above the call site as a comment, quoted in the
 * docstring it wrote to explain itself, left in a string while it worked
 * something else out. Every one of those puts the exact words in the file, so
 * anything that only searched the text would say the worker was wired when it
 * is not — and the developer would run a whole suite against their real backend
 * with every screen telling them it was isolated.
 *
 * So the file is read character by character first, tracking one piece of state
 * — what, if anything, is being read through to its end — and comments and
 * string bodies are replaced by spaces. Newlines survive, so a line number is
 * still a line number and a call written across two lines still reads as one
 * thing.
 *
 * This is a scanner and not a parser, and the difference is deliberate: it
 * knows quotes, escapes and `#`, and it knows nothing about what any of it
 * means. A quote that never closes on its own line hands reading back to code
 * at the newline rather than swallowing the rest of the file, which is what
 * keeps a file that is not Python at all from turning into one long string.
 */
function pythonCode(source: string): string {
  const out: string[] = new Array<string>(source.length);
  /** What is being read through to its end, or `null` while reading code. */
  let closes: string | null = null;
  let inComment = false;
  let at = 0;

  const keep = (): void => {
    out[at] = source[at] as string;
    at += 1;
  };
  const blank = (howMany: number): void => {
    for (let taken = 0; taken < howMany && at < source.length; taken += 1) {
      out[at] = source[at] === "\n" ? "\n" : " ";
      at += 1;
    }
  };

  while (at < source.length) {
    const here = source[at] as string;

    if (inComment) {
      if (here === "\n") {
        inComment = false;
        keep();
      } else blank(1);
      continue;
    }

    if (closes !== null) {
      // An escape takes the character after it with it, whatever that is — a
      // quote that does not close the string, or the newline of a continuation.
      if (here === "\\") {
        blank(2);
        continue;
      }
      if (source.startsWith(closes, at)) {
        blank(closes.length);
        closes = null;
        continue;
      }
      if (here === "\n" && closes.length === 1) {
        closes = null;
        keep();
        continue;
      }
      blank(1);
      continue;
    }

    if (here === "#") {
      inComment = true;
      blank(1);
      continue;
    }
    // Tried before the single quotes, so `"""` opens a docstring rather than an
    // empty string followed by one.
    const triple = TRIPLE_QUOTES.find((quotes) => source.startsWith(quotes, at));
    if (triple !== undefined) {
      closes = triple;
      blank(triple.length);
      continue;
    }
    if (here === '"' || here === "'") {
      closes = here;
      blank(1);
      continue;
    }
    keep();
  }

  return out
    .join("")
    .split("\n")
    .map((line) => (FOREIGN_COMMENT_LINE.test(line) ? "" : line))
    .join("\n");
}

/**
 * What the coding agent said it did, once Egma has looked for itself.
 *
 * A marker is a claim. Everywhere else in this walk a claim is checked against
 * the disk before it is acted on — the gate is built from the folder rather
 * than from what an agent said it wrote — and this claim carries more than
 * most: it decides whether the developer is told their worker is wired, whether
 * the gate names an edit, and whether the instruction block for doing it by
 * hand is printed at all. An agent that reports the marker and edits nothing
 * would send somebody into a run against their real backend with Egma saying
 * everything was isolated.
 */
type ReportedEntry =
  | { readonly kind: "verified"; readonly file: string }
  | { readonly kind: "unverified"; readonly reason: string };

/**
 * Whether a path the coding agent named is really inside this repository.
 *
 * Twice over, because there are two ways out of a folder. The lexical check
 * catches `../../etc/passwd`, and the resolved check catches a link inside the
 * repository pointing somewhere else — and the root is resolved too, because a
 * repository reached through a link is an ordinary thing on a Mac.
 */
async function insideRepository(repository: string, file: string): Promise<boolean> {
  const held = (root: string, candidate: string): boolean => {
    const below = path.relative(root, candidate);
    return below !== "" && !below.startsWith("..") && !path.isAbsolute(below);
  };
  if (!held(path.resolve(repository), path.resolve(repository, file))) return false;
  try {
    return held(await realpath(repository), await realpath(path.resolve(repository, file)));
  } catch {
    // Nothing there to resolve, which the read below reports in its own words.
    return true;
  }
}

/**
 * The reported worker file, read and held to what the skill teaches.
 *
 * Three ways to fail and each is said plainly, because each sends the developer
 * somewhere different: a path that is not in their repository at all, a file
 * that is not there, and a file that is there without the line in it.
 */
async function reportedEntry(
  repository: string,
  claimed: string,
): Promise<ReportedEntry> {
  const shown = claimed.trim();
  if (shown === "") {
    return { kind: "unverified", reason: "No file was named for Egma's testing entry." };
  }
  if (!(await insideRepository(repository, shown))) {
    return {
      kind: "unverified",
      reason: `${shown} is outside this repository, so Egma did not read it.`,
    };
  }

  const file = path.resolve(repository, shown);
  let source: string;
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    source = await readFile(file, "utf8");
  } catch {
    return {
      kind: "unverified",
      reason: `Egma looked for its testing entry in ${shown}, and there is no such file here.`,
    };
  }

  if (!AWAITED_MOCKABLE.test(pythonCode(source))) {
    return {
      kind: "unverified",
      reason: `Egma read ${shown} and found no awaited mockable() in it.`,
    };
  }
  return { kind: "verified", file: shown };
}

/**
 * The Node LiveKit package, which discovery reports by its own name.
 *
 * `livekit-agents` is the Python package and `@livekit/agents` is the Node one.
 * Both are LiveKit and only one of them has an Egma SDK to put inside it.
 */
const NODE_LIVEKIT = /@livekit\/agents/iu;

/**
 * Whether the worker this repository runs is the Node one.
 *
 * Read off the framework discovery reported rather than guessed at from the
 * repository: it is the same fact the platform route was chosen by. A LiveKit
 * repository that named neither flavour is treated as the Python one, which is
 * the flavour the SDK ships for and the flavour every instruction here is
 * written in — and a worker whose entrypoint nobody can identify falls back to
 * printed lines either way.
 */
function isNodeLiveKitWorker(facts: Facts): boolean {
  return NODE_LIVEKIT.test(facts.get("framework") ?? "");
}

/**
 * What a Node worker is told instead, since there is nothing to wire into it.
 *
 * Said plainly and never fatally. The Egma SDK ships for Python today, so a
 * Node LiveKit repository gets the run every LiveKit repository got before this
 * step existed: real tools, no mock tools, no coverage stamp. Writing a mocked
 * world for it would be writing answers nothing can serve, and wiring a Python
 * import into a TypeScript worker would be worse than either.
 */
function nodeWorkerLines(): readonly string[] {
  return [
    "This is a Node LiveKit worker, and the Egma SDK is Python only today, so nothing was wired into it.",
    "This run serves no mock tools: every tool this agent has runs for real.",
  ];
}

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

/** What Egma asks the coding agent to do, on top of the public skill. */
function mockAuthoringTask(context: MockAuthoringContext): string {
  return [
    "# Your task",
    "",
    `Make ${context.agentName}'s first simulations run isolated from its real`,
    "backend. Two things, in this order.",
    "",
    "## Where you may write",
    "",
    `Work in ${context.cwd}. You may write exactly four kinds of file and`,
    "nothing else:",
    "",
    "- `egma/mock-tools.md`, the project's mocked world;",
    `- the test files in egma/tests/${context.suiteDirectory}/ that already exist;`,
    "- the one worker file where the LiveKit job entrypoint is;",
    "- the dependency manifest that already manages the worker's Python packages.",
    "",
    "Read whatever committed source you need. Run no command that reaches the",
    "network and install nothing.",
    "",
    "## What Egma knows about this repository",
    "",
    ...contextBlock(context.facts),
    "",
    "## 1. Put the Egma testing entry in the worker",
    "",
    "Follow the skill above and add **only the testing entry**. Do not add the",
    "monitoring entry: this repository has not asked for production monitoring,",
    "and adding it would export traffic nobody agreed to export.",
    "",
    "When the edit is done, report the file on one line:",
    "",
    "```text",
    `egma:found ${SDK_ENTRY_FACT} src/agent.py`,
    "```",
    "",
    "If you cannot identify one job entrypoint, edit nothing and write",
    "`egma:none <what you looked at>`. Egma prints the lines for the developer",
    "to add by hand. Do not guess at a file.",
    "",
    "## 2. Write the mocked world",
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
    "## 3. Write the failure branches into the tests that need them",
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
    "- an `egma:note <what you did>` line for the worker edit and for each test",
    "  you gave an override to;",
    "- an `egma:abort <reason>` line only when something prevents the work; stop",
    "  after it.",
    "",
    "## When you are done",
    "",
    "Stop once the worker is edited or reported as not found, every real tool has",
    "an answer, and every test that needed an override has one. Report nothing",
    "else.",
  ].join("\n");
}

/** The public integration skill, then the run-specific task. */
export function mockAuthoringInstructions(context: MockAuthoringContext): string {
  return instructionsWith(
    [publicSkill("integrate-egma")],
    mockAuthoringTask(context),
  );
}

/**
 * The lines a developer adds themselves when no entrypoint could be found.
 *
 * Deterministic and Egma's own, rather than whatever the coding agent chose to
 * print: this is the fallback for a step that did not work, and a fallback that
 * depends on the thing that did not work is not one.
 */
export function sdkEntryInstructions(): readonly string[] {
  return [
    "Egma could not wire its SDK into your LiveKit worker, so this run has no mock tools.",
    "Add these yourself and the next run will be isolated and coverage-stamped:",
    "",
    '  1. Add "egma" to your Python dependencies.',
    "  2. In your job entrypoint, after the agent and the AgentSession object",
    "     exist and before AgentSession.start, add:",
    "",
    "         from egma import mockable",
    "",
    "         await mockable(agent, ctx, session)",
  ];
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
  /** Where the testing entry landed, or `null` when nothing was edited. */
  readonly sdkEntry: string | null;
};

/**
 * One dispatch, and then the folder read back.
 *
 * The result is deliberately thin: whether the walk can carry on, where the
 * seam landed, and what the mocked world says now. Everything else about what
 * happened is on the screen as it happened and in the log afterwards.
 */
export async function mockAuthoringStep(
  options: MockAuthoringOptions,
): Promise<MockAuthored> {
  const { ui, drivenAgent, signal, log } = options;
  const cwd = options.context.cwd;

  // Nothing to wire and nothing worth authoring, so nothing is dispatched. The
  // walk carries straight on to the gate with one honest sentence behind it.
  if (isNodeLiveKitWorker(options.context.facts)) {
    for (const line of nodeWorkerLines()) ui.pushStatus(line);
    return { halted: null, sdkEntry: null };
  }

  const tally = new GenerationTally("mocking", 0);
  const markers = new MarkerStream();
  ui.setGeneration(tally.progress);

  /** What the agent said it edited. Nothing is claimed from it until it is read. */
  let claimedEntry: string | null = null;
  let couldNotFindEntry = "";

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
          // Kept, not believed, and not said on screen yet: the file is read
          // once the agent has stopped writing, and what it says decides
          // whether there is anything to tell the developer about.
          if (marker.field === SDK_ENTRY_FACT) claimedEntry = marker.value;
          break;
        case "none":
          couldNotFindEntry = marker.reason;
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

  // What is on disk is the truth, whatever the agent said about it. That holds
  // for the seam exactly as it holds for the mocked world: a reported edit is
  // read back before anything is said about it, and a claim Egma cannot find in
  // the file is not an edit — it is the fallback, and it takes the same path a
  // coding agent that admitted it found no entrypoint takes.
  const reported = claimedEntry === null ? null : await reportedEntry(cwd, claimedEntry);
  const sdkEntry = reported?.kind === "verified" ? reported.file : null;
  const mockTools = await readMockToolsFile(options.paths.mockTools).catch(
    () => [] as readonly MockToolEntry[],
  );

  if (halted === null) {
    if (sdkEntry === null) {
      const why =
        reported?.kind === "unverified" ? reported.reason : couldNotFindEntry;
      if (why.trim() !== "") ui.pushStatus(`${DETAIL_MARK} ${why}`);
      for (const line of sdkEntryInstructions()) ui.pushStatus(line);
    } else {
      ui.pushStatus(`${ACTION_MARK} Egma's testing entry is in ${sdkEntry}`);
    }
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

  return { halted, sdkEntry };
}
