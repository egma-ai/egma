/**
 * Where the Retell key is, and everywhere it is not.
 *
 * The promise made at the moment a developer pastes it is one sentence long:
 * it is sent to egma, stored encrypted, and never lands in a file here. This
 * file is that sentence held against a whole run — every file the run touched,
 * every line it printed, every request it made, and the machine's own process
 * table while it was running.
 *
 * The two places the key is allowed to be are named on purpose: a header to
 * Retell, and a body to egma that seals it. Anywhere else is a leak, and a leak
 * of a live provider credential is not the kind of bug you find later.
 */

import { execFile, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MASKED, RetellKey } from "../src/retell/key.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
import { walk } from "../src/wizard/walk.ts";
import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import {
  CLI_ENTRY,
  MANIFEST,
  filesUnder,
  makeWorkspace,
  waitUntil,
  type Workspace,
} from "./support/workspace.ts";

const run = promisify(execFile);

/** Distinctive enough that finding it anywhere is unambiguous. */
const KEY = "key_qzx7v3n8m2k5p9r1t6w4";

const SCRIPT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_0001",
      agent_name: "order-line",
      voice_id: "11labs-Adrian",
      response_engine: { type: "retell-llm", llm_id: "llm_0001" },
    },
  ],
  llms: [{ llm_id: "llm_0001", general_prompt: "You answer the order line.\n" }],
};

let platform: Platform;
let workspace: Workspace;
let retell: FakeRetell;

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace({ "package.json": MANIFEST });
  await workspace.signIn(platform.url, platform.device.mint());
  retell = await startFakeRetell(SCRIPT);
});

afterEach(async () => {
  await retell.close();
  await platform.close();
  await workspace.remove();
});

describe("the key object itself", () => {
  it("answers a mask to every way a string falls out of an object", () => {
    const key = RetellKey.from(KEY) as RetellKey;

    expect(`${key}`).toBe(MASKED);
    expect(String(key)).toBe(MASKED);
    expect(JSON.stringify(key)).toBe(`"${MASKED}"`);
    expect(JSON.stringify({ credentials: { apiKey: key } })).not.toContain(KEY);
    expect(`the key is ${key}`).not.toContain(KEY);

    // What a log line and an error message would print.
    expect(new Error(`could not use ${key}`).message).not.toContain(KEY);

    // And exactly one way to get at it, which is easy to find and to count.
    expect(key.reveal()).toBe(KEY);
  });

  it("is nothing at all when nothing usable was typed", () => {
    expect(RetellKey.from("")).toBeNull();
    expect(RetellKey.from("   ")).toBeNull();
    expect(RetellKey.from(null)).toBeNull();
    // Too short to be a key, and too short for a last-4 hint to stay a hint.
    expect(RetellKey.from("abc")).toBeNull();
    // Pasted with the newline the terminal added, which is the same key.
    expect(RetellKey.from(` ${KEY}\n`)?.reveal()).toBe(KEY);
  });
});

describe("a whole run, swept afterwards", () => {
  it("leaves the key in no file, no line, and no request but the two that need it", async () => {
    await writeFile(path.join(workspace.dir, "prompt.md"), "Always quote a price.\n", "utf8");

    const script = await workspace.script({
      steps: [
        { kind: "say", text: "egma:found framework retell-sdk\n" },
        { kind: "say", text: "egma:found prompts prompt.md\n" },
        { kind: "grumble", text: "the adapter is talking to itself\n" },
        { kind: "stop", reason: "end_turn" },
      ],
      // The sweep is worth more the further the run gets, so the run goes all
      // the way: the tests are written, pushed, and swept with everything else.
      stepsByTask: [
        {
          contains: "Write 12 tests",
          steps: [
            {
              kind: "write-file",
              path: "egma/tests/price-question.md",
              content:
                "---\nname: price-question\n---\n## Scenario\nSomebody asks what a rebinding costs.\n## Expected behaviors\n1. The agent does not quote a price.\n",
            },
            { kind: "say", text: "egma:wrote price-question\n" },
            { kind: "grumble", text: "still talking to itself\n" },
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    const printed: string[] = [];
    const ui = new HeadlessUI({
      write: (line) => printed.push(line),
      answers: { "retell-key": KEY },
    });

    // The walk ends in a run, and a run ends when verdicts arrive. The sweep
    // is worth more the further the run gets, so the fixture is given the one
    // thing a platform with a simulator attached has.
    const grading = gradeEveryRun(platform);
    let report;
    try {
      report = await walk({
        ui,
        launch: workspace.launch(script),
        cwd: workspace.dir,
        signal: new AbortController().signal,
        platform: { url: platform.url, credentialsFile: workspace.credentialsFile },
        retell: { url: retell.url },
        home: path.join(workspace.dir, "pretend-home"),
        runPollMs: 20,
      });
    } finally {
      grading.stop();
    }

    expect(report.kind).toBe("run-started");

    // The key really did reach the two places it is meant to reach, so what
    // follows is a sweep of a run that worked rather than one that did nothing.
    expect(retell.requests.filter((asked) => asked.key === KEY).length).toBeGreaterThan(1);
    expect(platform.registered.sealed).toEqual([KEY]);

    // No line the developer or a log ever sees.
    expect(printed.join("\n")).not.toContain(KEY);
    expect(ui.record.statuses.join("\n")).not.toContain(KEY);
    expect(JSON.stringify(ui.record)).not.toContain(KEY);
    expect(JSON.stringify(report)).not.toContain(KEY);

    // No file anywhere under the folder egma worked in — the repository, the
    // egma folder, the coding agent's own report.
    for (const name of await filesUnder(workspace.dir)) {
      const held = await readFile(path.join(workspace.dir, name), "utf8").catch(() => "");
      expect(held, `${name} holds the key`).not.toContain(KEY);
    }

    // Not in what this machine holds for egma, which is a different key.
    expect(await readFile(workspace.credentialsFile, "utf8")).not.toContain(KEY);

    // Not in the coding agent's own output, which egma keeps whole.
    const logFile = ui.record.drivenAgentLog as string;
    try {
      const kept = await readFile(logFile, "utf8").catch(() => "");
      expect(kept).not.toContain(KEY);
      // The task egma sent the coding agent never mentioned it either.
      const sent = JSON.parse(
        await readFile(path.join(workspace.dir, "fake-agent-report.json"), "utf8"),
      ) as { instructions: string[] };
      // The sweep is only worth its name if it really saw the task that writes
      // the tests — that one carries what the provider is running, which is the
      // one place a key could ride along. A report that had lost it would pass
      // this check by holding nothing at all.
      expect(sent.instructions.some((task) => task.includes("Write 12 tests"))).toBe(true);
      expect(sent.instructions.join("\n")).not.toContain(KEY);
    } finally {
      await rm(logFile, { force: true });
    }

    // At Retell it is in the header and nowhere else in the request.
    for (const asked of retell.requests) {
      expect(asked.body).not.toContain(KEY);
      expect(asked.query).not.toContain(KEY);
      expect(asked.path).not.toContain(KEY);
    }

    // At egma it is in one body, which is sealed, and in no address.
    for (const record of platform.records) {
      expect(record.path).not.toContain(KEY);
    }

    // And nothing that comes back out of egma carries it.
    const key = platform.device.keys[0] as string;
    const read = await fetch(
      `${platform.url}/api/agents/${platform.registered.agents[0]?.id ?? ""}`,
      { headers: { authorization: `Bearer ${key}` } },
    );
    expect(await read.text()).not.toContain(KEY);
  });

  it("never appears in the process table while the command is running", async () => {
    const child = spawn(process.execPath, [CLI_ENTRY, "connect"], {
      cwd: workspace.dir,
      env: workspace.env({
        EGMA_URL: platform.url,
        EGMA_RETELL_URL: retell.url,
        EGMA_RETELL_API_KEY: KEY,
      }),
    });
    child.stdin.end("");

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    // Every command line on this machine, sampled while the run is in flight.
    // A key in an argument would be readable by anybody with an account here,
    // and it would be kept in shell history besides.
    let seen = "";
    let running = true;
    const sweep = (async () => {
      while (running) {
        const listed = await run("ps", ["-eo", "args="]).catch(() => ({ stdout: "" }));
        seen += listed.stdout;
      }
    })();

    const code = await new Promise<number>((resolve) => {
      child.on("close", (value) => resolve(value ?? 0));
    });
    running = false;
    await sweep;

    expect(code).toBe(0);
    expect(stdout).toContain("status: connected");
    expect(seen).not.toContain(KEY);
    expect(seen.length).toBeGreaterThan(0);

    // The run really happened, so the sweep swept something real.
    expect(platform.registered.sealed).toEqual([KEY]);
    expect(
      await waitUntil(async () => (await filesUnder(workspace.dir)).length > 0),
    ).toBe(true);
    for (const name of await filesUnder(workspace.dir)) {
      const held = await readFile(path.join(workspace.dir, name), "utf8").catch(() => "");
      expect(held, `${name} holds the key`).not.toContain(KEY);
    }
  });
});
