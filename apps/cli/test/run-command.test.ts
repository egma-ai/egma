/**
 * `egma run` as a coding agent runs it: against a fixture of egma's public HTTP
 * API, with the run's whole lifecycle choreographed step by step.
 *
 * Nothing here is a terminal and nothing here answers a question. What is
 * asserted is what something driving this can act on — the lines it prints, in
 * the order it prints them, and the number it exits with.
 *
 * The lifecycle is scripted rather than waited for. A real run is a simulator
 * dialing a real voice agent; here a control says "this one is running now,
 * this one passed, this one errored", which is what lets a check assert on an
 * exact sequence instead of on whatever a machine happened to produce.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runRunCommand, RUN_EXIT } from "../src/commands/run.ts";
import { createEgmaFolder, folderPathsIn, writeConfig } from "../src/folder/egma-folder.ts";
import type {
  PlatformRun,
  PlatformSimulation,
  RunEvent,
  SimulationStatus,
  Verdict,
} from "../src/platform/runs.ts";
import { RunFollower } from "../src/run/follow.ts";
import { pullTests } from "../src/sync/pull.ts";
import {
  startPlatform,
  type AdvanceStep,
  type Platform,
} from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, makeWorkspace, waitUntil, type Workspace } from "./support/workspace.ts";

const run = promisify(execFile);

// A real server, and for two of these a real subprocess, inside a suite using
// every core: the budget is generous so that only a broken verb can reach it.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** The key this machine holds, as a login would have left it. */
const KEY = "egma_sk_held-by-this-machine";

/** Short, because every check here scripts the changes itself. */
const EVERY_MS = 20;

let platform: Platform;
let workspace: Workspace;

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace();
  await workspace.signIn(platform.url, KEY);
  platform.signedInWith(KEY);
});

afterEach(async () => {
  await platform.close();
  await workspace.remove();
});

type Registered = { readonly agentId: string; readonly connectionId: string };

/**
 * A voice agent and a way to reach it, registered through the public API — the
 * same request `egma connect` makes, so the ids a run names are ids the
 * platform really issued.
 */
async function register(type = "retell"): Promise<Registered> {
  const response = await fetch(`${platform.url}/api/agents`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: "order-line",
      connection: {
        type,
        modality: "voice",
        ...(type === "retell"
          ? {
              config: { retellAgentId: "agent_0001" },
              credentials: { apiKey: "key_2e8a4c6b1d09f735a2c4" },
            }
          : { config: { phoneNumber: "+15551234567" } }),
      },
    }),
  });
  const body = (await response.json()) as {
    agent: { id: string };
    connection: { id: string };
  };
  return { agentId: body.agent.id, connectionId: body.connection.id };
}

/** The folder, pointing at what was registered, as connect would have left it. */
async function makeFolder(registered: Registered | null): Promise<void> {
  const made = await createEgmaFolder({ repository: workspace.dir });
  // Written rather than passed to the maker, because the maker deliberately
  // never rewrites a config that is already there — and a check that changes
  // what the folder points at is exactly the thing that rule protects against.
  await writeConfig(made.paths.config, {
    platform: null,
    agent: registered === null ? null : { name: "order-line", id: registered.agentId },
    connection: registered === null ? null : { name: "retell-1", id: registered.connectionId },
    suite: { name: "first-suite", id: null },
  });
}

const paths = (): ReturnType<typeof folderPathsIn> => folderPathsIn(workspace.dir);

const signedIn = (): { url: string; key: string } => ({ url: platform.url, key: KEY });

/**
 * Tests on the platform, and the files in the folder written from them.
 *
 * Written by `pull` rather than by hand, so every file pins exactly what the
 * platform holds and says exactly what it says — which is the ordinary state a
 * developer runs from, and the one a check has to start from before it can
 * make a file deliberately out of step.
 */
async function seed(names: readonly string[], personas?: readonly string[]): Promise<void> {
  for (const name of names) {
    platform.tests.add({
      name,
      scenario: `Somebody rings the order line about ${name.replaceAll("-", " ")}.`,
      expectedBehaviors: ["The agent says the workshop's name."],
      ...(personas === undefined ? {} : { personas }),
    });
  }
  await pullTests({ signedIn: signedIn(), paths: paths() });
}

type Said = { readonly lines: readonly string[]; readonly code: number };

/** Everything the verb printed, in order, and what it answered with. */
async function egmaRun(
  options: {
    readonly noFollow?: boolean;
    readonly signal?: AbortSignal;
    readonly during?: () => Promise<void>;
  } = {},
): Promise<Said> {
  const lines: string[] = [];
  const failures: string[] = [];

  const running = runRunCommand({
    access: { url: platform.url, credentialsFile: workspace.credentialsFile },
    cwd: workspace.dir,
    out: (line) => lines.push(line),
    fail: (line) => failures.push(line),
    everyMs: EVERY_MS,
    ...(options.noFollow === undefined ? {} : { noFollow: options.noFollow }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (options.during !== undefined) await options.during();
  const code = await running;
  return { lines: [...lines, ...failures.map((line) => `stderr: ${line}`)], code };
}

/** Every value printed under one key, in order. */
function valuesOf(lines: readonly string[], key: string): readonly string[] {
  return lines.flatMap((line) => (line.startsWith(`${key}: `) ? [line.slice(key.length + 2)] : []));
}

/** The last value printed under one key — how a single fact is read. */
function factOf(lines: readonly string[], key: string): string | undefined {
  return valuesOf(lines, key).at(-1);
}

/**
 * Wait until the run exists on the platform, then script it.
 *
 * The budget is generous on purpose: on the other side of this is a command
 * signing in, reading a folder, listing tests and creating a run, inside a
 * suite using every core. A budget a busy machine could reach would make this
 * a check on how loaded the machine is.
 */
async function scriptOnceStarted(steps: readonly AdvanceStep[]): Promise<void> {
  const started = await waitUntil(() => platform.running.runs.length > 0, 30_000);
  if (!started) throw new Error("the command never created a run to script");
  for (const step of steps) platform.running.advance(step);
}

describe("egma run", () => {
  it("pins the version of every test it runs, and says which", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price", "lost-the-order-number"]);

    const said = await egmaRun({ noFollow: true });

    expect(said.code).toBe(RUN_EXIT.done);
    expect(factOf(said.lines, "status")).toBe("started");

    // What the platform stored is what the terminal said it pinned, and it is
    // every version the platform currently holds for those tests.
    const pinned = valuesOf(said.lines, "pin").map((line) => line.split(" ")[1]);
    const onEgma = platform.running.runs[0];
    expect(onEgma?.testVersionIds).toEqual(pinned);
    expect([...(onEgma?.testVersionIds ?? [])].sort()).toEqual(
      platform.tests.tests.map((test) => test.versionId).sort(),
    );
    for (const version of pinned) expect(version).toMatch(/^tstv_/u);

    expect(factOf(said.lines, "run")).toMatch(/^run_/u);
    expect(factOf(said.lines, "tests")).toBe("2");
    expect(factOf(said.lines, "simulations")).toBe("2");
  });

  /**
   * A run produces one simulation per test per persona. Two personas on every
   * test is four simulations from two tests, and the count the platform stamps
   * at creation is the count the terminal prints.
   */
  it("produces one simulation per test per persona", async () => {
    const registered = await register();
    await makeFolder(registered);
    platform.tests.addPersona("in-a-hurry");
    platform.tests.addPersona("never-rings-off");
    await seed(["quoted-a-price", "open-on-sunday"], ["in-a-hurry", "never-rings-off"]);

    const said = await egmaRun({ noFollow: true });

    expect(factOf(said.lines, "tests")).toBe("2");
    expect(factOf(said.lines, "simulations")).toBe("4");
    expect(platform.running.simulationsOf().map((one) => one.personaName)).toEqual([
      "in-a-hurry",
      "never-rings-off",
      "in-a-hurry",
      "never-rings-off",
    ]);
  });

  it("streams every status change, in the order the platform reported it", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price"]);

    const said = await egmaRun({
      during: () =>
        scriptOnceStarted([
          { simulation: "quoted-a-price", status: "claimed" },
          { simulation: "quoted-a-price", status: "running" },
          { simulation: "quoted-a-price", status: "completed", verdict: "passed" },
        ]),
    });

    expect(valuesOf(said.lines, "simulation")).toEqual([
      "quoted-a-price default-persona queued",
      "quoted-a-price default-persona claimed",
      "quoted-a-price default-persona running",
      "quoted-a-price default-persona completed",
    ]);
    expect(valuesOf(said.lines, "verdict")).toEqual(["quoted-a-price default-persona passed"]);
    expect(said.code).toBe(RUN_EXIT.done);
  });

  it("marks the first verdict, once, whichever simulation gets there first", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price", "open-on-sunday", "rang-off-halfway"]);

    const said = await egmaRun({
      during: () =>
        scriptOnceStarted([
          { simulation: "open-on-sunday", status: "claimed" },
          { simulation: "open-on-sunday", status: "running" },
          { simulation: "open-on-sunday", status: "completed", verdict: "failed" },
          { simulation: "quoted-a-price", status: "claimed" },
          { simulation: "quoted-a-price", status: "running" },
          { simulation: "quoted-a-price", status: "completed", verdict: "passed" },
          { simulation: "rang-off-halfway", status: "claimed" },
          { simulation: "rang-off-halfway", status: "running" },
          { simulation: "rang-off-halfway", status: "completed", verdict: "passed" },
        ]),
    });

    // The second test in the folder finished first, and it is the one marked.
    expect(valuesOf(said.lines, "first-verdict")).toEqual([
      "open-on-sunday default-persona failed",
    ]);
  });

  /**
   * The glossary rule, end to end. A test that could not run is not a test that
   * failed, and neither the lines nor the counts nor the exit number may say it
   * was.
   */
  it("keeps skipped and errored as themselves, never folded into failed", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price", "open-on-sunday", "rang-off-halfway", "lost-the-order-number"]);

    const said = await egmaRun({
      during: () =>
        scriptOnceStarted([
          { simulation: "quoted-a-price", status: "claimed" },
          { simulation: "quoted-a-price", status: "running" },
          { simulation: "quoted-a-price", status: "completed", verdict: "passed" },
          { simulation: "open-on-sunday", status: "claimed" },
          { simulation: "open-on-sunday", status: "running" },
          {
            simulation: "open-on-sunday",
            status: "completed",
            verdict: "skipped",
            reason: "this test needs DTMF, and this connection has none",
          },
          { simulation: "rang-off-halfway", status: "claimed" },
          {
            simulation: "rang-off-halfway",
            status: "failed",
            verdict: "errored",
            reason: "the agent never joined",
          },
          { simulation: "lost-the-order-number", status: "claimed" },
          { simulation: "lost-the-order-number", status: "running" },
          { simulation: "lost-the-order-number", status: "completed", verdict: "failed" },
        ]),
    });

    expect(valuesOf(said.lines, "verdict")).toEqual([
      "quoted-a-price default-persona passed",
      "open-on-sunday default-persona skipped",
      "rang-off-halfway default-persona errored",
      "lost-the-order-number default-persona failed",
    ]);
    // The platform's own words about each ending, kept.
    expect(valuesOf(said.lines, "reason")).toEqual([
      "this test needs DTMF, and this connection has none",
      "the agent never joined",
    ]);
    // Four counts, four names, and every one of them printed even at zero.
    expect(factOf(said.lines, "passed")).toBe("1");
    expect(factOf(said.lines, "failed")).toBe("1");
    expect(factOf(said.lines, "skipped")).toBe("1");
    expect(factOf(said.lines, "errored")).toBe("1");
    expect(factOf(said.lines, "pending")).toBe("0");
    expect(factOf(said.lines, "simulations")).toBe("4");
  });

  /**
   * The run, written down beside the tests it ran.
   *
   * What is asserted is what a reviewer would open: the platform's own document,
   * one line per simulation, and a summary somebody reads in a diff. The verb
   * names every file it wrote, because a file nobody was told about is a file
   * nobody commits.
   */
  it("writes the run into egma/runs, and names every file it wrote", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price", "open-on-sunday"]);

    const said = await egmaRun({
      during: () =>
        scriptOnceStarted([
          { simulation: "quoted-a-price", status: "claimed" },
          { simulation: "quoted-a-price", status: "running" },
          { simulation: "quoted-a-price", status: "completed", verdict: "passed" },
          { simulation: "open-on-sunday", status: "claimed" },
          { simulation: "open-on-sunday", status: "running" },
          { simulation: "open-on-sunday", status: "completed", verdict: "failed" },
        ]),
    });

    const runId = factOf(said.lines, "run");
    expect(runId).toMatch(/^run_/u);
    expect(valuesOf(said.lines, "wrote")).toEqual([
      `egma/runs/${runId}/run.json`,
      `egma/runs/${runId}/results.jsonl`,
      `egma/runs/${runId}/summary.md`,
    ]);

    const directory = path.join(paths().runs, runId as string);

    // The platform's whole account of the run, as the platform wrote it.
    const document = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8")) as {
      id: string;
      simulations: readonly { test_name: string; verdict: string | null }[];
    };
    expect(document.id).toBe(runId);
    expect(document.simulations.map((one) => one.test_name).sort()).toEqual([
      "open-on-sunday",
      "quoted-a-price",
    ]);

    // One line per simulation, so the file greps and pipes into jq.
    const results = (await readFile(path.join(directory, "results.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { test_name: string; verdict: string | null });
    expect(results.map((one) => [one.test_name, one.verdict]).sort()).toEqual([
      ["open-on-sunday", "failed"],
      ["quoted-a-price", "passed"],
    ]);

    // And the same facts as something a person reads in a pull request.
    const summary = await readFile(path.join(directory, "summary.md"), "utf8");
    expect(summary).toContain(`# Run ${runId}`);
    expect(summary).toContain("quoted-a-price");
    expect(summary).toContain("open-on-sunday");
  });

  /**
   * A run somebody stopped watching still happened, and what it decided before
   * they walked away is worth having on disk.
   */
  it("writes the run down even when the developer stops watching", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price"]);

    const stopping = new AbortController();
    const said = await egmaRun({
      signal: stopping.signal,
      during: async () => {
        await scriptOnceStarted([
          { simulation: "quoted-a-price", status: "claimed" },
          { simulation: "quoted-a-price", status: "running" },
        ]);
        stopping.abort("interrupt");
      },
    });

    expect(said.code).toBe(RUN_EXIT.interrupted);
    expect(factOf(said.lines, "status")).toBe("left-running");
    const runId = factOf(said.lines, "run");
    expect(valuesOf(said.lines, "wrote")).toContain(`egma/runs/${runId}/summary.md`);
  });

  it("answers with the red-suite number when a test failed", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price", "open-on-sunday"]);

    const said = await egmaRun({
      during: () =>
        scriptOnceStarted([
          { simulation: "quoted-a-price", status: "claimed" },
          { simulation: "quoted-a-price", status: "running" },
          { simulation: "quoted-a-price", status: "completed", verdict: "failed" },
          { simulation: "open-on-sunday", status: "claimed" },
          {
            simulation: "open-on-sunday",
            status: "failed",
            verdict: "errored",
            reason: "the simulator broke",
          },
        ]),
    });

    // A failing test is the louder fact: something in the voice agent is wrong,
    // and that is what a suite is watched for.
    expect(said.code).toBe(RUN_EXIT.failed);
    expect(factOf(said.lines, "failed")).toBe("1");
    expect(factOf(said.lines, "errored")).toBe("1");
  });

  it("answers with a different number when nothing failed and something errored", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price"]);

    const said = await egmaRun({
      during: () =>
        scriptOnceStarted([
          { simulation: "quoted-a-price", status: "claimed" },
          {
            simulation: "quoted-a-price",
            status: "failed",
            verdict: "errored",
            reason: "the simulator broke",
          },
        ]),
    });

    // Nothing failed, because nothing was judged. A caller that treated this as
    // a red suite would go looking for a bug in the voice agent that is not
    // there — which is the whole reason the two are different numbers.
    expect(said.code).toBe(RUN_EXIT.errored);
    expect(factOf(said.lines, "failed")).toBe("0");
    expect(factOf(said.lines, "errored")).toBe("1");
  });

  /**
   * The failure branch the transcript names: a connection whose adapter has not
   * shipped. The platform refuses at creation and the terminal repeats what it
   * said, word for word, because egma neither made that decision nor knows a
   * better way to explain it.
   */
  it("repeats egma's refusal to start the run, word for word", async () => {
    const registered = await register("phone");
    await makeFolder(registered);
    await seed(["quoted-a-price"]);
    platform.running.noAdapterFor("phone");

    const said = await egmaRun();

    expect(said.code).toBe(RUN_EXIT.refused);
    expect(factOf(said.lines, "status")).toBe("refused");
    expect(factOf(said.lines, "reason")).toBe(platform.running.noAdapterMessage("phone"));
    expect(factOf(said.lines, "stderr")).toBe(platform.running.noAdapterMessage("phone"));
    // And nothing was queued that could never happen.
    expect(platform.running.runs).toHaveLength(0);
  });

  it("starts and returns at once when told not to follow", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price"]);

    const said = await egmaRun({ noFollow: true });

    expect(said.code).toBe(RUN_EXIT.done);
    expect(factOf(said.lines, "status")).toBe("started");
    // Nothing was waited for: every simulation is where the platform left it.
    expect(valuesOf(said.lines, "verdict")).toEqual([]);
    expect(platform.running.simulationsOf().map((one) => one.status)).toEqual(["queued"]);
  });

  it("refuses when a file in the folder is not on egma, and starts nothing", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price"]);
    await writeFile(
      path.join(paths().tests, "never-pushed.md"),
      [
        "---",
        "name: never-pushed",
        "---",
        "## Scenario",
        "Somebody rings about something egma has never heard of.",
        "## Expected behaviors",
        "1. The agent says the workshop's name.",
        "",
      ].join("\n"),
      "utf8",
    );

    const said = await egmaRun();

    expect(said.code).toBe(RUN_EXIT.nothing);
    expect(valuesOf(said.lines, "unknown")).toEqual(["never-pushed"]);
    // Its own word: `refused` is the platform saying no, and it comes with a
    // number of its own. One status line, one number.
    expect(factOf(said.lines, "status")).toBe("not-on-egma");
    expect(factOf(said.lines, "stderr")).toContain("Run egma push");
    expect(platform.running.runs).toHaveLength(0);
  });

  /**
   * The hard gate, and the case it exists for.
   *
   * A developer edits a test this morning, forgets to push, and runs. egma
   * holds last week's wording; the file says this morning's. A run over what
   * egma holds would look completely ordinary and would come back green — about
   * content nobody executed. The developer, or the coding agent reading that
   * green, would then report an edit verified that never ran.
   *
   * So the run is refused, and the refusal names the one verb that fixes it.
   * Nothing was started.
   */
  it("refuses a run over a file it edited and never pushed, and names the push", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price"]);
    const file = path.join(paths().tests, "quoted-a-price.md");
    const pinned = platform.tests.tests[0]?.versionId as string;

    // The edit a developer makes and forgets to push. The pin does not move —
    // which is exactly why a version number could never answer this question.
    const held = await readFile(file, "utf8");
    await writeFile(
      file,
      held.replace(
        "1. The agent says the workshop's name.",
        "1. The agent says the workshop's name.\n2. The agent never quotes a price.",
      ),
      "utf8",
    );

    const said = await egmaRun({ noFollow: true });

    expect(said.code).toBe(RUN_EXIT.nothing);
    expect(valuesOf(said.lines, "not-pushed")).toEqual(["quoted-a-price"]);
    // Its own word, and never `refused`: `refused` is the platform saying no to
    // a run it will not conduct, and it answers with its own number.
    expect(factOf(said.lines, "status")).toBe("not-pushed");
    expect(factOf(said.lines, "stderr")).toBe(
      "egma holds something other than what this file says: quoted-a-price. Run egma " +
        "push to put your edit on egma, then run this again. Nothing was started.",
    );
    // Nothing was started, and nothing was pinned.
    expect(platform.running.runs).toHaveLength(0);
    expect(valuesOf(said.lines, "pin")).toEqual([]);
    // And egma still holds exactly what it held: a refused run writes nothing.
    expect(platform.tests.tests[0]?.versionId).toBe(pinned);
  });

  /**
   * The other direction, refused for the same reason: somebody moved the test
   * on the platform and this folder has not pulled it. The file says something
   * egma does not hold, and which side is behind changes nothing about that.
   */
  it("refuses a run over a file egma has moved past", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price"]);
    const before = platform.tests.tests[0]?.versionId;

    // The QA lead edits it in the dashboard while the developer is looking at
    // their own copy.
    const after = platform.tests.editInDashboard("quoted-a-price", {
      expectedBehaviors: ["The agent says the workshop's name.", "The agent repeats the price."],
    });
    expect(after.versionId).not.toBe(before);

    const said = await egmaRun({ noFollow: true });

    expect(said.code).toBe(RUN_EXIT.nothing);
    expect(factOf(said.lines, "status")).toBe("not-pushed");
    expect(valuesOf(said.lines, "not-pushed")).toEqual(["quoted-a-price"]);
    expect(factOf(said.lines, "stderr")).toContain("Run egma push");
    expect(platform.running.runs).toHaveLength(0);
  });

  /**
   * And the ordinary folder, which is the whole point of the two refusals
   * above: when the two agree, nothing changed at all.
   */
  it("runs a folder that agrees with egma, exactly as it always did", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price", "asked-for-a-refund"]);
    const versions = platform.tests.tests.map((test) => test.versionId);

    const said = await egmaRun({ noFollow: true });

    expect(said.code).toBe(RUN_EXIT.done);
    expect(factOf(said.lines, "status")).toBe("started");
    expect(valuesOf(said.lines, "not-pushed")).toEqual([]);
    // Every test in the folder, each pinned at the version egma holds for it.
    // The order is the folder's, so the two lists are compared as sets.
    expect([...(platform.running.runs[0]?.testVersionIds ?? [])].sort()).toEqual(
      [...versions].sort(),
    );
  });

  it("says which of the things it needs is missing, and does nothing about it", async () => {
    // No folder at all.
    const noFolder = await egmaRun();
    expect(noFolder.code).toBe(RUN_EXIT.nothing);
    expect(factOf(noFolder.lines, "status")).toBe("no-folder");

    // A folder that has never been connected to anything.
    await makeFolder(null);
    const notConnected = await egmaRun();
    expect(notConnected.code).toBe(RUN_EXIT.nothing);
    expect(factOf(notConnected.lines, "status")).toBe("not-connected");
    expect(factOf(notConnected.lines, "stderr")).toContain("egma connect");

    // A folder pointing at something, with no tests in it.
    const registered = await register();
    await makeFolder(registered);
    await mkdir(paths().tests, { recursive: true });
    const noTests = await egmaRun();
    expect(noTests.code).toBe(RUN_EXIT.nothing);
    expect(factOf(noTests.lines, "status")).toBe("no-tests");
  });

  /**
   * Stopping a terminal is not stopping a run. The run is on egma, and a verb
   * that said it had stopped one would be saying something that did not happen
   * — and would send whoever read it looking for a run that is still going.
   */
  it("says the run is still going when it is stopped part way", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price", "open-on-sunday"]);

    const stopping = new AbortController();
    const said = await egmaRun({
      signal: stopping.signal,
      during: async () => {
        await scriptOnceStarted([
          { simulation: "quoted-a-price", status: "claimed" },
          { simulation: "quoted-a-price", status: "running" },
          { simulation: "quoted-a-price", status: "completed", verdict: "passed" },
        ]);
        await waitUntil(() => false, EVERY_MS * 4);
        stopping.abort("interrupt");
      },
    });

    expect(said.code).toBe(RUN_EXIT.interrupted);
    expect(factOf(said.lines, "status")).toBe("left-running");
    // What had landed by then is still counted honestly, and the rest is named
    // as what it is: not judged yet.
    expect(factOf(said.lines, "passed")).toBe("1");
    expect(factOf(said.lines, "pending")).toBe("1");
    // Nothing is blamed on egma: the stop was the developer's.
    expect(said.lines.join("\n")).not.toContain("unreachable");
  });

  it("refuses without a key, and names the command that gets one", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price"]);

    const lines: string[] = [];
    const failures: string[] = [];
    const code = await runRunCommand({
      // A credentials file with nothing in it, which is a machine that has
      // never logged in.
      access: {
        url: platform.url,
        credentialsFile: path.join(workspace.dir, "no-such-credentials"),
      },
      cwd: workspace.dir,
      out: (line) => lines.push(line),
      fail: (line) => failures.push(line),
    });

    expect(code).toBe(RUN_EXIT.notSignedIn);
    expect(factOf(lines, "status")).toBe("not-signed-in");
    expect(failures.join("\n")).toContain("egma login");
    expect(platform.running.runs).toHaveLength(0);
  });
});

describe("egma run, as the built command", () => {
  it("prints one fact per line and answers with a number", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price", "open-on-sunday"]);

    const { stdout } = await run(process.execPath, [CLI_ENTRY, "run", "--no-follow"], {
      cwd: workspace.dir,
      env: workspace.env({ EGMA_URL: platform.url }),
    });

    const lines = stdout.trimEnd().split("\n");
    expect(factOf(lines, "url")).toBe(platform.url);
    expect(factOf(lines, "agent")).toBe(registered.agentId);
    expect(factOf(lines, "connection")).toBe(registered.connectionId);
    expect(factOf(lines, "run")).toMatch(/^run_/u);
    expect(factOf(lines, "status")).toBe("started");

    // The address a person opens, with nothing on it but the run.
    const results = factOf(lines, "results") ?? "";
    expect(results).toBe(`${platform.url}/runs/${factOf(lines, "run") ?? ""}`);
    expect(results).not.toContain("?");
    expect(results).not.toContain(KEY);
  });

  it("follows to the end and answers with what happened", async () => {
    const registered = await register();
    await makeFolder(registered);
    await seed(["quoted-a-price", "open-on-sunday"]);

    const command = run(process.execPath, [CLI_ENTRY, "run"], {
      cwd: workspace.dir,
      env: workspace.env({ EGMA_URL: platform.url }),
    });

    await scriptOnceStarted([
      { simulation: "quoted-a-price", status: "claimed" },
      { simulation: "quoted-a-price", status: "running" },
      { simulation: "quoted-a-price", status: "completed", verdict: "passed" },
      { simulation: "open-on-sunday", status: "claimed" },
      { simulation: "open-on-sunday", status: "running" },
      {
        simulation: "open-on-sunday",
        status: "completed",
        verdict: "skipped",
        reason: "this test needs DTMF, and this connection has none",
      },
    ]);

    const { stdout } = await command;
    const lines = stdout.trimEnd().split("\n");

    expect(valuesOf(lines, "first-verdict")).toEqual(["quoted-a-price default-persona passed"]);
    expect(factOf(lines, "passed")).toBe("1");
    expect(factOf(lines, "failed")).toBe("0");
    expect(factOf(lines, "skipped")).toBe("1");
    expect(factOf(lines, "errored")).toBe("0");
    expect(factOf(lines, "status")).toBe("completed");
  });
});

/**
 * The cursor, on its own.
 *
 * The whole of a follower's resumption story is one number: every ask names
 * where the last one got to. Two things have to be true of it and neither can
 * be seen from the outside of a run that went smoothly — so they are checked
 * here, with the pages handed over by hand rather than by a platform.
 *
 * A run's simulations are laid out when it is created and their number is
 * stamped there, so a change about a simulation the follower has never heard
 * of is a change about somebody else's run. It is ignored rather than invented.
 */
describe("the cursor a follower resumes from", () => {
  const SIMULATION = (id: string, position: number): PlatformSimulation => ({
    id,
    position,
    testName: `test-${position}`,
    testVersionId: `tstv_${position}`,
    personaName: "default-persona",
    status: "queued",
    verdict: null,
    reason: null,
  });

  const RUN: PlatformRun = {
    id: "run_01",
    status: "running",
    agentId: "agt_01",
    connectionId: "con_01",
    connectionType: "retell",
    modality: "voice",
    testVersionIds: ["tstv_1", "tstv_2"],
    expectedSimulationCount: 2,
    resultsUrl: "https://app.egma.example/runs/run_01",
    simulations: [SIMULATION("sim_1", 1), SIMULATION("sim_2", 2)],
  };

  const moved = (
    seq: number,
    simulationId: string,
    status: SimulationStatus,
    verdict: Verdict | null = null,
  ): RunEvent => ({
    kind: "simulation",
    seq,
    simulationId,
    testName: simulationId === "sim_1" ? "test-1" : "test-2",
    personaName: "default-persona",
    status,
    verdict,
    reason: null,
  });

  it("moves forward with the platform, and never backwards", () => {
    const follower = new RunFollower(RUN);
    expect(follower.at).toBe(0);

    follower.take([moved(1, "sim_1", "claimed")], 1);
    expect(follower.at).toBe(1);

    // A page that carried nothing leaves the cursor where it was, so the next
    // ask covers exactly the same ground rather than stepping over it.
    follower.take([], 1);
    expect(follower.at).toBe(1);

    // And a platform that answered with an older cursor cannot rewind one: a
    // follower that went backwards would hand every change over twice.
    follower.take([moved(2, "sim_1", "running")], 0);
    expect(follower.at).toBe(1);
  });

  it("hands a change over once, however many times a page carries it", () => {
    const follower = new RunFollower(RUN);
    const page = [
      moved(1, "sim_1", "claimed"),
      moved(2, "sim_1", "running"),
      moved(3, "sim_1", "completed", "skipped"),
    ];

    const first = follower.take(page, 3);
    expect(first.filter((change) => change.verdictLanded)).toHaveLength(1);
    expect(first.filter((change) => change.first)).toHaveLength(1);

    // The same page again, which is what a platform that re-sent one would
    // look like. The verdict is not news a second time and the mark does not
    // move — a run has one first verdict, whatever arrives twice.
    const again = follower.take(page, 3);
    expect(again.filter((change) => change.verdictLanded)).toHaveLength(0);
    expect(again.filter((change) => change.first)).toHaveLength(0);
    expect(follower.firstVerdict?.id).toBe("sim_1");
    expect(follower.rows.filter((row) => row.first)).toHaveLength(1);
    expect(follower.tally).toMatchObject({ skipped: 1, graded: 1, pending: 1, total: 2 });
  });

  /**
   * The first verdict is the first one that landed, whatever it was. `skipped`
   * and `errored` are verdicts, and a wizard that waited past one of them for
   * something greener would be waiting for the suite it promised not to wait
   * for.
   */
  it("marks a first verdict of skipped or errored exactly as it marks passed", () => {
    for (const verdict of ["skipped", "errored"] as const) {
      const follower = new RunFollower(RUN);
      const changes = follower.take(
        [moved(1, "sim_1", verdict === "errored" ? "failed" : "completed", verdict)],
        1,
      );

      expect(changes[0]?.first).toBe(true);
      expect(follower.firstVerdict?.verdict).toBe(verdict);
      expect(follower.tally.graded).toBe(1);
      expect(follower.tally.failed).toBe(0);
    }
  });

  it("ignores a change about a simulation this run never laid out", () => {
    const follower = new RunFollower(RUN);

    const changes = follower.take([moved(1, "sim_from_another_run", "completed", "passed")], 1);

    expect(changes).toEqual([]);
    expect(follower.firstVerdict).toBeNull();
    expect(follower.tally).toMatchObject({ graded: 0, total: 2 });
    // The cursor still moves: the page was read, and asking for it again would
    // be asking for the same answer forever.
    expect(follower.at).toBe(1);
  });
});
