/**
 * `egma init`, `egma pull` and `egma push` as a coding agent runs them: the
 * built command, in a real subprocess, against a fixture of egma's public HTTP
 * API.
 *
 * Nothing here is a terminal and nothing here answers a question. What is
 * asserted is what something driving these can act on — the lines they print,
 * the number they exit with, and the files they leave in the repository.
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import {
  LARGEST_MOCK_TOOL_ANSWER_BYTES,
  LONGEST_MOCK_TOOL_DELAY_MILLISECONDS,
} from "@egma/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEgmaFolder,
  parseMockToolsFile,
  readConfig,
} from "../src/folder/egma-folder.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, makeWorkspace, type Workspace } from "./support/workspace.ts";

const run = promisify(execFile);

/** The key this machine holds, as a login would have left it. */
const KEY = "egma_sk_held-by-this-machine";

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

type Result = { stdout: string; stderr: string; code: number };

/** The built command, exactly as the words are given, ended rather than thrown. */
async function runEgma(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI_ENTRY, ...args], {
      cwd: workspace.dir,
      env: workspace.env(env),
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

/**
 * The same command, pointed at the fixture platform on every invocation.
 *
 * `--url` on each one rather than a shell that names it once: one explicit way
 * to name a platform per invocation is the whole order, so a check that reached
 * this platform any other way would be checking something egma does not offer.
 */
async function egma(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return runEgma(["--url", platform.url, ...args], env);
}

/** Every printed line as the pair it is, in order, repeats and all. */
function said(stdout: string): readonly (readonly [string, string])[] {
  return stdout
    .trimEnd()
    .split("\n")
    .flatMap((line) => {
      const at = line.indexOf(": ");
      return at > 0 ? [[line.slice(0, at), line.slice(at + 2)] as const] : [];
    });
}

/** Every value printed under one key, in order. */
function valuesOf(stdout: string, key: string): readonly string[] {
  return said(stdout)
    .filter(([name]) => name === key)
    .map(([, value]) => value);
}

/** The last value printed under one key — how a single fact is read. */
function factOf(stdout: string, key: string): string | undefined {
  return valuesOf(stdout, key).at(-1);
}

/**
 * The folder, made the way `egma init` makes it but without a subprocess.
 *
 * `init` is checked as a command of its own above. Everywhere else the folder
 * is only the ground a `pull` or a `push` stands on, and spawning a whole
 * command to lay it is time every other check in the suite pays for.
 */
async function makeFolder(): Promise<void> {
  await createEgmaFolder({ repository: workspace.dir });
}

const testsFolder = (): string => path.join(workspace.dir, "egma", "tests");

async function writeTest(name: string, document: string): Promise<void> {
  await mkdir(testsFolder(), { recursive: true });
  await writeFile(path.join(testsFolder(), name), document, "utf8");
}

async function readTest(name: string): Promise<string> {
  return readFile(path.join(testsFolder(), name), "utf8");
}

const mockToolsFile = (): string => path.join(workspace.dir, "egma", "mock-tools.md");

async function readMockTools(): Promise<string> {
  return readFile(mockToolsFile(), "utf8");
}

/** The section as somebody types it, above whatever prose the file opens with. */
function mockToolSection(
  entries: readonly (readonly [string, Record<string, unknown>])[],
): string {
  return [
    "## Mock tools",
    ...entries.flatMap(([tool, says]) => [
      `### ${tool}`,
      "```json",
      JSON.stringify(says),
      "```",
    ]),
    "",
  ].join("\n");
}

async function writeMockTools(
  entries: readonly (readonly [string, Record<string, unknown>])[],
): Promise<void> {
  await writeFile(mockToolsFile(), mockToolSection(entries), "utf8");
}

/** The mock tools one file holds, as `push` and `pull` leave them. */
function mockToolsIn(document: string): readonly { tool: string; says: unknown }[] {
  return parseMockToolsFile(document, "egma/mock-tools.md").map((entry) => ({
    tool: entry.tool,
    says: entry.says,
  }));
}

/** Every test file in the folder, as bytes, for comparing before and after. */
async function folderBytes(): Promise<Record<string, string>> {
  const held: Record<string, string> = {};
  for (const name of (await readdir(testsFolder())).sort()) {
    held[name] = await readTest(name);
  }
  return held;
}

function freshFile(input: {
  readonly name: string;
  readonly personas?: readonly string[];
  readonly scenario: string;
  readonly behaviors: readonly string[];
}): string {
  return [
    "---",
    `name: ${input.name}`,
    ...(input.personas === undefined ? [] : [`personas: [${input.personas.join(", ")}]`]),
    "---",
    "## Scenario",
    input.scenario,
    "## Expected behaviors",
    ...input.behaviors.map((behavior, index) => `${index + 1}. ${behavior}`),
    "",
  ].join("\n");
}

describe("egma init", () => {
  const configFile = (): string => path.join(workspace.dir, "egma", "config.yaml");

  it("makes a folder whose every file is committable as it stands", async () => {
    const result = await runEgma([
      "init",
      "--agent",
      "receptionist",
      "--connection",
      "retell-1",
      "--suite",
      "first-suite",
    ]);

    expect(result.code).toBe(0);
    expect(factOf(result.stdout, "status")).toBe("created");
    expect(factOf(result.stdout, "agent")).toBe("receptionist");
    expect(factOf(result.stdout, "connection")).toBe("retell-1");
    expect(factOf(result.stdout, "suite")).toBe("first-suite");
    expect(factOf(result.stdout, "committable")).toBe("yes");
    // The memory directory is named as reserved and is not made.
    expect(factOf(result.stdout, "reserved")).toBe("memory");
    expect(factOf(result.stdout, "mock-tools")).toContain(
      path.join("egma", "mock-tools.md"),
    );
    expect(await readdir(path.join(workspace.dir, "egma"))).toEqual([
      "config.yaml",
      "mock-tools.md",
      "tests",
    ]);

    // git itself is the judge of "committable": every file goes in, and not one
    // of them is ignored.
    const git = async (...args: readonly string[]): Promise<string> =>
      (await run("git", [...args], { cwd: workspace.dir })).stdout;
    await git("init", "--quiet");
    await git("config", "user.email", "check@example.invalid");
    await git("config", "user.name", "check");
    await git("add", "egma");
    const staged = (await git("status", "--porcelain", "--", "egma")).trim().split("\n").sort();
    expect(staged).toEqual(["A  egma/config.yaml", "A  egma/mock-tools.md"]);

    // Nothing anywhere says to keep any of it out.
    await expect(
      run("git", ["check-ignore", "egma/config.yaml"], { cwd: workspace.dir }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("recognises a folder that is already here, and touches nothing in it", async () => {
    await runEgma(["init", "--agent", "receptionist"]);
    const before = await readFile(configFile(), "utf8");

    const again = await runEgma(["init", "--agent", "something-else"]);

    expect(again.code).toBe(0);
    expect(factOf(again.stdout, "status")).toBe("already-there");
    expect(await readFile(configFile(), "utf8")).toBe(before);
  });

  it("needs no key and no network, because on its own it talks to nobody", async () => {
    const nowhere = await makeWorkspace();
    try {
      const result = await run(process.execPath, [CLI_ENTRY, "init"], {
        cwd: nowhere.dir,
        // Every stand-in this workspace holds is a closed port, so a command
        // that reached for any address at all would fail here rather than pass.
        env: nowhere.env(),
      });
      expect(result.stdout).toContain("status: created");
      // And it names no platform, which is what makes the folder above safe to
      // make before anybody has decided which egma this repository is on.
      expect(
        (await readConfig(path.join(nowhere.dir, "egma", "config.yaml"))).platform,
      ).toBeNull();
      expect(platform.records).toEqual([]);
    } finally {
      await nowhere.remove();
    }
  });

  /**
   * The one binding a repository can gain before anybody has signed in.
   *
   * The identity contract is unauthenticated by design, so `init` can ask an
   * address who it is and commit the answer with no key in existence — which is
   * what lets a developer who knows their platform's address say it once, here,
   * instead of on every command afterwards.
   */
  it("writes the whole binding when the command names an address", async () => {
    const result = await runEgma(["init", "--url", platform.url, "--agent", "receptionist"]);

    expect(result.code, result.stderr).toBe(0);
    expect(factOf(result.stdout, "url")).toBe(platform.url);
    expect(factOf(result.stdout, "platform")).toBe(platform.instanceId);
    expect(factOf(result.stdout, "status")).toBe("created");
    expect((await readConfig(configFile())).platform).toEqual({
      origin: platform.url,
      instance: platform.instanceId,
    });

    // One question, and it is the public one that carries nothing. No key
    // exists yet and none was needed.
    expect(platform.records.map((record) => `${record.method} ${record.path}`)).toEqual([
      "GET /api/platform",
    ]);
  });

  it("leaves the committed binding byte for byte the same when it is run again", async () => {
    await runEgma(["init", "--url", platform.url, "--agent", "receptionist"]);
    const before = await readFile(configFile(), "utf8");

    const again = await runEgma(["init", "--url", platform.url, "--agent", "receptionist"]);

    expect(again.code, again.stderr).toBe(0);
    expect(factOf(again.stdout, "status")).toBe("already-there");
    expect(await readFile(configFile(), "utf8")).toBe(before);
    expect((await readConfig(configFile())).platform).toEqual({
      origin: platform.url,
      instance: platform.instanceId,
    });
  });

  /**
   * What the `platform:` line is a fact about, which is the repository.
   *
   * A developer — or a coding agent — running `init` in a folder somebody else
   * committed is asking what this repository points at, and whether it is bound
   * is part of the answer whether or not this run had anything to do with it.
   * The `url:` line is the other half and stays absent: this run reached no
   * address, and a command that talked to nobody must not print one.
   */
  it("reports the binding a bound folder already had, and reaches nothing", async () => {
    await runEgma(["init", "--url", platform.url]);
    const before = platform.records.length;

    const again = await runEgma(["init"]);

    expect(again.code, again.stderr).toBe(0);
    expect(factOf(again.stdout, "platform")).toBe(platform.instanceId);
    expect(factOf(again.stdout, "url")).toBeUndefined();
    expect(platform.records.slice(before)).toEqual([]);
  });

  /**
   * The one thing a second run does change, and the reason it has to.
   *
   * A folder somebody else committed before this repository was on any platform
   * is how a teammate ordinarily arrives: the folder is there, nothing in it
   * names an egma, and `init --url` is what they are told to run. Recognising
   * the folder and dropping the flag would be the silent no-op this command
   * used to be, moved one case along.
   */
  it("binds a folder that was already here and named no platform", async () => {
    await runEgma(["init", "--agent", "receptionist"]);
    expect((await readConfig(configFile())).platform).toBeNull();

    const bound = await runEgma(["init", "--url", platform.url]);

    expect(bound.code, bound.stderr).toBe(0);
    expect(factOf(bound.stdout, "status")).toBe("already-there");
    expect(factOf(bound.stdout, "platform")).toBe(platform.instanceId);

    const held = await readConfig(configFile());
    expect(held.platform).toEqual({
      origin: platform.url,
      instance: platform.instanceId,
    });
    // And nothing else in the file moved: the name the first run wrote is the
    // name that is still there.
    expect(held.agent).toEqual({ name: "receptionist", id: null });
    // Said out loud, because "already-there" on its own would read as a run
    // that changed nothing.
    expect(bound.stdout).toContain("note: the folder was already here, and gained the platform");
  });

  /**
   * `init` is safe to run again, and that is not a licence to rebind.
   *
   * The flag naming another platform is how somebody says they want to move,
   * and no command performs that move — so this is the same refusal every other
   * verb answers it with, met here because `init --url` resolves through the
   * same path they do rather than through one of its own.
   */
  it("refuses to move a folder that is already bound somewhere else", async () => {
    const elsewhere = await startPlatform();
    try {
      await runEgma(["init", "--url", platform.url]);
      const before = await readFile(configFile(), "utf8");

      const refused = await runEgma(["init", "--url", elsewhere.url]);

      expect(refused.code).toBe(4);
      expect(refused.stdout).toContain("status: refused");
      expect(refused.stderr).toContain("Egma does not move a repository between platforms");
      expect(await readFile(configFile(), "utf8")).toBe(before);
      // Neither platform was asked so much as who it is: the file decided.
      expect(elsewhere.records).toEqual([]);
    } finally {
      await elsewhere.close();
    }
  });

  /**
   * **Never a partial binding.** `bound` has to keep meaning `verified`, so an
   * address that cannot say who it is leaves nothing behind at all — not an
   * origin waiting for an instance, and not an empty folder either. Anything
   * less would be a state somebody has to reason about for the rest of the
   * product's life.
   */
  it("refuses an address that does not answer, and leaves no folder behind", async () => {
    const dead = "http://127.0.0.1:1";

    const refused = await runEgma(["init", "--url", dead]);

    expect(refused.code).toBe(4);
    expect(refused.stdout).toContain("status: unreachable");
    expect(refused.stderr).toContain(dead);
    await expect(stat(path.join(workspace.dir, "egma"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  /**
   * The address-check refusal, met at the one moment it costs nothing.
   *
   * A platform that answers to an address other than the one it was asked at is
   * a service door — the API's own origin, or a deployment whose `EGMA_BASE_URL`
   * is not the address people reach it at. Binding to it would commit an origin
   * every teammate who clones this repository would fail to reach.
   */
  it("refuses a platform that names an address other than the one asked", async () => {
    const canonicalOrigin = "https://canonical.egma.example";
    const alias = await startPlatform({ canonicalOrigin });
    try {
      const refused = await runEgma(["init", "--url", alias.url]);

      expect(refused.code).toBe(4);
      expect(refused.stdout).toContain("status: refused");
      expect(refused.stderr).toContain(canonicalOrigin);
      expect(refused.stderr).toContain("EGMA_BASE_URL");
      expect(refused.stderr).toContain("Nothing was sent");
      await expect(stat(path.join(workspace.dir, "egma"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await alias.close();
    }
  });
});

describe("egma pull", () => {
  it("writes egma's current versions into files and pins the version ids", async () => {
    const first = platform.tests.add({
      name: "missed-appointment-reschedule",
      scenario: "The caller missed yesterday's appointment and wants to reschedule.",
      expectedBehaviors: [
        "The agent acknowledges the missed appointment without blame.",
        "The agent offers at least two concrete alternative slots.",
      ],
      personas: ["impatient-caller"],
    });
    const second = platform.tests.add({
      name: "new-patient-insurance-question",
      scenario: "A new patient asks whether their insurance is taken.",
      expectedBehaviors: ["The agent says which plans are taken."],
    });

    await makeFolder();
    const result = await egma(["pull"]);

    expect(result.code).toBe(0);
    expect(factOf(result.stdout, "status")).toBe("pulled");
    expect(factOf(result.stdout, "tests")).toBe("2");
    expect(valuesOf(result.stdout, "written")).toEqual([
      "missed-appointment-reschedule",
      "new-patient-insurance-question",
    ]);
    expect(valuesOf(result.stdout, "version")).toEqual([first.versionId, second.versionId]);

    // The files are the format, and each one pins both halves of the test: the
    // content a run is judged by, and the live name and description beside it.
    // A persona is written by identity with the display name for the reader.
    expect(await readTest("missed-appointment-reschedule.md")).toBe(
      [
        "---",
        "format: 3",
        "name: missed-appointment-reschedule",
        `version: ${first.versionId}`,
        `identity_revision: ${first.revision}`,
        "personas:",
        `  - id: ${platform.tests.addPersona("impatient-caller")}`,
        "    name: impatient-caller",
        "---",
        "## Scenario",
        "The caller missed yesterday's appointment and wants to reschedule.",
        "## Expected behaviors",
        // No priority marker on any line: format 3 writes the sentence and
        // nothing else, because every expected behavior has to hold.
        "1. The agent acknowledges the missed appointment without blame.",
        "2. The agent offers at least two concrete alternative slots.",
        "",
      ].join("\n"),
    );
    // A test that named nobody takes the default persona, and the file says so
    // rather than saying nothing.
    expect(await readTest("new-patient-insurance-question.md")).toContain(
      "    name: default-persona",
    );
  });

  it("finds nothing to do the second time, and reports it", async () => {
    platform.tests.add({
      name: "one",
      scenario: "s",
      expectedBehaviors: ["b"],
    });
    await makeFolder();
    await egma(["pull"]);

    const again = await egma(["pull"]);

    expect(again.code).toBe(0);
    expect(valuesOf(again.stdout, "unchanged")).toEqual(["one"]);
    expect(valuesOf(again.stdout, "written")).toEqual([]);
  });

  /**
   * Nothing read off the wire can move a cursor or split a printed fact.
   *
   * Both are the same rule as the login end of this seam: what comes back is
   * drawn on somebody's terminal and parsed by somebody's coding agent, and a
   * terminal reads a control character as an instruction rather than as text.
   */
  it("prints one fact per line however the far end names a test", async () => {
    platform.tests.add({
      name: "quiet[2Jhours\nand more",
      scenario: "The caller rings after hours.",
      expectedBehaviors: ["The agent gives the emergency number."],
    });
    await makeFolder();

    const result = await egma(["pull"]);

    expect(result.code).toBe(0);
    // The escape is gone, so what is left is text and not an instruction; the
    // line break is gone, so one test is still one printed fact.
    expect(result.stdout).not.toContain("");
    expect(valuesOf(result.stdout, "written")).toEqual(["quiet[2Jhoursand more"]);
    expect(await readTest("quiet-2jhoursand-more.md")).toContain(
      "name: quiet[2Jhoursand more",
    );
  });

  it("keeps a draft nobody has pushed, and never lands a test on top of it", async () => {
    await makeFolder();
    const draft = freshFile({
      name: "after-hours-emergency",
      scenario: "The caller has an emergency at 2am.",
      behaviors: ["The agent gives the emergency number."],
    });
    await writeTest("after-hours-emergency.md", draft);
    platform.tests.add({
      name: "after-hours-emergency",
      scenario: "Somebody else's test of the same name.",
      expectedBehaviors: ["The agent does something else."],
    });

    const result = await egma(["pull"]);

    expect(result.code).toBe(0);
    expect(valuesOf(result.stdout, "kept")).toEqual(["after-hours-emergency"]);
    // The draft is exactly as it was, and the platform's test landed beside it.
    expect(await readTest("after-hours-emergency.md")).toBe(draft);
    expect(await readTest("after-hours-emergency-2.md")).toContain(
      "Somebody else's test of the same name.",
    );
  });
});

describe("egma push", () => {
  it("creates versions on egma for fresh files and pins them back", async () => {
    await makeFolder();
    await writeTest(
      "missed-appointment-reschedule.md",
      freshFile({
        name: "missed-appointment-reschedule",
        personas: ["impatient-caller"],
        scenario: "The caller missed yesterday's appointment.",
        behaviors: ["The agent acknowledges it without blame."],
      }),
    );
    await writeTest(
      "after-hours-emergency.md",
      freshFile({
        name: "after-hours-emergency",
        scenario: "The caller has an emergency at 2am.",
        behaviors: ["The agent gives the emergency number."],
      }),
    );
    platform.tests.addPersona("impatient-caller");

    const result = await egma(["push"]);

    expect(result.code).toBe(0);
    expect(factOf(result.stdout, "status")).toBe("pushed");
    expect(factOf(result.stdout, "tests")).toBe("2");
    expect([...valuesOf(result.stdout, "created")].sort()).toEqual([
      "after-hours-emergency",
      "missed-appointment-reschedule",
    ]);

    // Every file now pins the version egma minted for it, in egma's own id
    // shape rather than in one this end invented.
    const pins = valuesOf(result.stdout, "version");
    expect(pins).toHaveLength(2);
    for (const pin of pins) expect(pin).toMatch(/^tstv_[0-9A-HJKMNP-TV-Z]{26}$/u);

    expect(platform.tests.tests.map((test) => test.name).sort()).toEqual([
      "after-hours-emergency",
      "missed-appointment-reschedule",
    ]);
    for (const test of platform.tests.tests) {
      expect(pins).toContain(test.versionId);
      expect(await readTest(`${test.name}.md`)).toContain(`version: ${test.versionId}`);
      expect(test.version).toBe(1);
    }
  });

  it("makes a new version on an edit, leaves the old one where it was, and re-pins", async () => {
    const seeded = platform.tests.add({
      name: "missed-appointment-reschedule",
      scenario: "The caller missed yesterday's appointment.",
      expectedBehaviors: ["The agent acknowledges it without blame."],
    });
    await makeFolder();
    await egma(["pull"]);

    const before = await readTest("missed-appointment-reschedule.md");
    await writeTest(
      "missed-appointment-reschedule.md",
      before.replace(
        "1. The agent acknowledges it without blame.",
        "1. The agent acknowledges it without blame.\n2. The agent offers two slots.",
      ),
    );

    const result = await egma(["push"]);

    expect(result.code).toBe(0);
    expect(valuesOf(result.stdout, "updated")).toEqual(["missed-appointment-reschedule"]);
    expect(platform.tests.versionsOf("missed-appointment-reschedule")).toBe(2);

    const pinned = factOf(result.stdout, "version") as string;
    expect(pinned).not.toBe(seeded.versionId);
    expect(await readTest("missed-appointment-reschedule.md")).toContain(`version: ${pinned}`);

    // The version the file used to pin is still there, unchanged, because a run
    // that pinned it has to stay readable.
    const old = await fetch(`${platform.url}/api/test-versions/${seeded.versionId}`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(old.status).toBe(200);
    const held = (await old.json()) as { current: boolean; expected_behaviors: string[] };
    expect(held.current).toBe(false);
    // Sentences both ways. A frozen version is read past rather than
    // rewritten, so a version stored before the ladder retired still holds the
    // priority beside each sentence — but the wire answers the sentence.
    expect(held.expected_behaviors).toEqual([
      "The agent acknowledges it without blame.",
    ]);
  });

  it("uploads nothing when the files say what egma already holds", async () => {
    platform.tests.add({ name: "one", scenario: "s", expectedBehaviors: ["b"] });
    await makeFolder();
    await egma(["pull"]);

    const result = await egma(["push"]);

    expect(result.code).toBe(0);
    expect(valuesOf(result.stdout, "unchanged")).toEqual(["one"]);
    expect(platform.tests.versionsOf("one")).toBe(1);
  });

  it("turns an unfalsifiable test away before anything is uploaded", async () => {
    await makeFolder();
    await writeTest(
      "unfalsifiable.md",
      ["---", "name: unfalsifiable", "---", "## Scenario", "Something happens.", "## Expected behaviors", ""].join("\n"),
    );

    const result = await egma(["push"]);

    expect(result.code).toBe(6);
    expect(factOf(result.stdout, "status")).toBe("turned-away");
    expect(valuesOf(result.stdout, "turned-away")).toEqual(["unfalsifiable"]);
    // egma can see this refusal coming without asking, so the reason is its
    // own belt, said before any upload. The door's sentence is proven where
    // the door is reached directly.
    expect(factOf(result.stdout, "reason")).toBe(
      "no expected behaviors, so it could never fail. Add one, then run egma push.",
    );
    expect(platform.tests.tests).toHaveLength(0);
  });

  it("lands the folder's good tests while the empty one is named, never uploaded ahead of it", async () => {
    await makeFolder();
    await writeTest(
      "kept.md",
      [
        "---",
        "name: kept",
        "---",
        "## Scenario",
        "Something happens.",
        "## Expected behaviors",
        "1. The agent says so.",
      ].join("\n"),
    );
    await writeTest(
      "unfalsifiable.md",
      ["---", "name: unfalsifiable", "---", "## Scenario", "Something happens.", "## Expected behaviors", ""].join("\n"),
    );

    const result = await egma(["push"]);

    expect(result.code).toBe(6);
    expect(valuesOf(result.stdout, "turned-away")).toEqual(["unfalsifiable"]);
    expect(valuesOf(result.stdout, "created")).toEqual(["kept"]);
    // The platform holds exactly the valid test — the empty one was decided
    // before the first upload, not discovered at the door after it.
    expect(platform.tests.tests.map((test) => test.name)).toEqual(["kept"]);
    expect(platform.tests.versionsOf("kept")).toBe(1);
  });

  /**
   * A file egma cannot read is still the developer's file. It is named and left
   * alone, and the folder's other tests are not forfeit over it — a verb that
   * ended on the first broken file would be the one that most needs saying.
   */
  it("names a file it cannot read, and uploads the tests it can", async () => {
    await makeFolder();
    await writeTest(
      "good.md",
      ["---", "name: good", "---", "## Scenario", "Something happens.", "## Expected behaviors", "1. It is handled."].join("\n"),
    );
    const broken = ["---", "name: half-written", "personas: [never-closed", "---", "## Scenario", "x"].join("\n");
    await writeTest("half-written.md", broken);

    const result = await egma(["push"]);

    expect(valuesOf(result.stdout, "turned-away")).toEqual(["half-written"]);
    expect(factOf(result.stdout, "reason")).toContain("half-written.md, line 2");
    expect(platform.tests.tests.map((test) => test.name)).toEqual(["good"]);
    // Untouched, byte for byte, so the developer can see what they wrote.
    expect(await readTest("half-written.md")).toBe(broken);
  });

  it("refuses when egma has moved, names exactly the tests that moved, and uploads nothing", async () => {
    for (const name of ["first", "second", "third"]) {
      platform.tests.add({ name, scenario: `${name} happens`, expectedBehaviors: ["b"] });
    }
    await makeFolder();
    await egma(["pull"]);

    // A QA lead edits two of them in the dashboard while the developer works.
    platform.tests.editInDashboard("first", { expectedBehaviors: ["b", "and one more"] });
    platform.tests.editInDashboard("third", { scenario: "third happens differently" });

    // The developer, meanwhile, has changed all three files.
    for (const name of ["first", "second", "third"]) {
      const held = await readTest(`${name}.md`);
      await writeTest(`${name}.md`, held.replace("1. b", "1. b, said better"));
    }

    const refused = await egma(["push"]);

    expect(refused.code).toBe(5);
    expect(factOf(refused.stdout, "status")).toBe("refused");
    expect([...valuesOf(refused.stdout, "conflict")].sort()).toEqual(["first", "third"]);
    expect(factOf(refused.stdout, "uploaded")).toBe("nothing");
    expect(refused.stderr).toContain("egma pull");

    // Nothing was uploaded — not even the test that had no conflict.
    expect(platform.tests.versionsOf("second")).toBe(1);
    expect(platform.tests.versionsOf("first")).toBe(2);
    expect(platform.tests.versionsOf("third")).toBe(2);

    // Pull, then push, and it goes through. Pull writes egma's current version
    // into every file it does not already match — including the one the
    // developer had edited, which is why the refusal above came first and why
    // the folder is committed.
    const pulled = await egma(["pull"]);
    expect(pulled.code).toBe(0);
    expect([...valuesOf(pulled.stdout, "written")].sort()).toEqual(["first", "second", "third"]);
    expect(await readTest("first.md")).toContain("2. and one more");

    const second = await readTest("second.md");
    await writeTest("second.md", second.replace("1. b", "1. b, said better"));

    const pushed = await egma(["push"]);
    expect(pushed.code).toBe(0);
    expect(factOf(pushed.stdout, "status")).toBe("pushed");
    expect(valuesOf(pushed.stdout, "updated")).toEqual(["second"]);
    expect(platform.tests.versionsOf("second")).toBe(2);
  });

  it("refuses a pin egma has never issued, and says what to do about it", async () => {
    await makeFolder();
    await writeTest(
      "from-somewhere-else.md",
      [
        "---",
        "name: from-somewhere-else",
        "version: tstv_01K3XQ7M4E8YB2FVN0H9TZQWER",
        "---",
        "## Scenario",
        "s",
        "## Expected behaviors",
        "1. b",
        "",
      ].join("\n"),
    );

    const result = await egma(["push"]);

    expect(result.code).toBe(5);
    expect(valuesOf(result.stdout, "conflict")).toEqual(["from-somewhere-else"]);
    expect(result.stderr).toContain("egma pull");
    expect(platform.tests.tests).toHaveLength(0);
  });

  it("leaves the working tree alone: a pull straight after a push changes zero bytes", async () => {
    await makeFolder();
    await writeTest(
      "one.md",
      freshFile({ name: "one", scenario: "one happens", behaviors: ["the agent does a thing"] }),
    );
    // A file somebody hand-formatted: the same test, written differently.
    await writeTest(
      "two.md",
      ["## scenario", "", "two happens", "", "## Expected behaviours", "- the agent does another thing", ""].join("\n"),
    );

    const pushed = await egma(["push"]);
    expect(pushed.code).toBe(0);

    const after = await folderBytes();
    const pulled = await egma(["pull"]);

    expect(pulled.code).toBe(0);
    expect(await folderBytes()).toEqual(after);
    expect(valuesOf(pulled.stdout, "written")).toEqual([]);
    expect([...valuesOf(pulled.stdout, "unchanged")].sort()).toEqual(["one", "two"]);
  });
});

/**
 * The mocked world, between the folder and egma.
 *
 * A mock tool answers for one of the agent's tools while a simulation runs, and
 * it is authored where every other authored thing is: in the folder, synced
 * with the two verbs already here. Two halves, and they behave differently on
 * purpose — the project's own mock tools are the one authored thing egma does
 * not version, so an edit overwrites; a test's overrides are test content, so
 * an edit to one mints the test's next version exactly as an edit to an
 * expected behavior does.
 */
describe("the folder carries mock tools", () => {
  it("pulls what egma answers with into the folder, and a fresh push changes nothing", async () => {
    platform.mocking.add({ tool: "check_availability", answer: { slots: [] } });
    platform.mocking.add({
      tool: "book_appointment",
      error: "the booking service is unreachable",
      delayMilliseconds: 800,
    });
    platform.tests.add({
      name: "calendar-is-full",
      scenario: "Nothing is free next week.",
      expectedBehaviors: ["The agent offers to take a message."],
      mockTools: [{ tool: "check_availability", answer: { slots: [], full: true } }],
    });

    await makeFolder();
    const pulled = await egma(["pull"]);

    expect(pulled.code).toBe(0);
    // Named one per line, under a key of their own — a mock tool is not a test.
    expect(valuesOf(pulled.stdout, "mock-tool")).toEqual([
      "book_appointment",
      "check_availability",
    ]);
    expect(factOf(pulled.stdout, "mock-tools")).toBe("2");

    // The project's own live in a file of their own, the tool named in the
    // heading and the answer in the block below it.
    const file = await readMockTools();
    expect(file).toContain("### check_availability");
    expect(mockToolsIn(file)).toEqual([
      {
        tool: "book_appointment",
        says: { error: "the booking service is unreachable", delay_ms: 800 },
      },
      { tool: "check_availability", says: { answer: { slots: [] } } },
    ]);

    // A test's own overrides live inside that test, under the same heading,
    // because an override is the test's content.
    expect(await readTest("calendar-is-full.md")).toContain(
      [
        "## Mock tools",
        "### check_availability",
        "```json",
        "{",
        '  "answer": {',
        '    "slots": [],',
        '    "full": true',
        "  }",
        "}",
        "```",
      ].join("\n"),
    );

    // And the folder as it now stands is a folder egma has nothing to do about.
    const before = { ...(await folderBytes()), "mock-tools.md": file };
    const pushed = await egma(["push"]);

    expect(pushed.code).toBe(0);
    expect(factOf(pushed.stdout, "status")).toBe("pushed");
    expect(valuesOf(pushed.stdout, "mock-tool-unchanged")).toEqual([
      "book_appointment",
      "check_availability",
    ]);
    expect(valuesOf(pushed.stdout, "unchanged")).toEqual(["calendar-is-full"]);
    expect({ ...(await folderBytes()), "mock-tools.md": await readMockTools() }).toEqual(before);
    expect(platform.tests.versionsOf("calendar-is-full")).toBe(1);
  });

  it("lands a mock tool authored in the folder, and overwrites one edited there", async () => {
    await makeFolder();
    await writeMockTools([["check_availability", { answer: { slots: ["09:00"] } }]]);

    const created = await egma(["push"]);

    expect(created.code).toBe(0);
    expect(valuesOf(created.stdout, "mock-tool-created")).toEqual(["check_availability"]);
    expect(platform.mocking.mockTools).toEqual([
      {
        id: expect.stringMatching(/^mck_/u),
        tool: "check_availability",
        answer: { answer: { slots: ["09:00"] } },
        delayMilliseconds: 0,
        agents: [],
      },
    ]);
    const [first] = platform.mocking.mockTools;

    // Edited in the folder and pushed again: the same mock tool, written over.
    // There is no version chain here and no second row — the one authored thing
    // egma does not version.
    await writeMockTools([["check_availability", { answer: { slots: [] }, delay_ms: 250 }]]);
    const edited = await egma(["push"]);

    expect(edited.code).toBe(0);
    expect(valuesOf(edited.stdout, "mock-tool-updated")).toEqual(["check_availability"]);
    expect(platform.mocking.mockTools).toEqual([
      {
        id: first?.id,
        tool: "check_availability",
        answer: { answer: { slots: [] } },
        delayMilliseconds: 250,
        agents: [],
      },
    ]);

    // And the file egma wrote back is the file a pull would have written.
    const after = await readMockTools();
    expect(await egma(["pull"])).toMatchObject({ code: 0 });
    expect(await readMockTools()).toBe(after);
  });

  it("pushes an override authored inside a test as that test's next version", async () => {
    platform.tests.add({
      name: "calendar-is-full",
      scenario: "Nothing is free next week.",
      expectedBehaviors: ["The agent offers to take a message."],
    });
    await makeFolder();
    await egma(["pull"]);

    // The developer writes the override into the test's own markdown.
    const held = await readTest("calendar-is-full.md");
    await writeTest(
      "calendar-is-full.md",
      `${held.trimEnd()}\n${mockToolSection([["check_availability", { answer: { slots: [] } }]])}`,
    );

    const result = await egma(["push"]);

    expect(result.code).toBe(0);
    // A new version of the test, because a test versions — and no free-standing
    // mock tool anywhere, because an override is content and not an entity.
    expect(valuesOf(result.stdout, "updated")).toEqual(["calendar-is-full"]);
    expect(platform.tests.versionsOf("calendar-is-full")).toBe(2);
    expect(platform.mocking.mockTools).toEqual([]);
    expect(factOf(result.stdout, "mock-tools")).toBe("0");

    // The version the test now stands on carries it, and reads it back.
    const version = factOf(result.stdout, "version") as string;
    const read = await fetch(`${platform.url}/api/test-versions/${version}`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect((await read.json()) as { mock_tools: unknown }).toMatchObject({
      mock_tools: [{ tool: "check_availability", answer: { slots: [] }, delay_ms: 0 }],
    });

    // Pushed again with nothing changed, it mints nothing.
    expect(await egma(["push"])).toMatchObject({ code: 0 });
    expect(platform.tests.versionsOf("calendar-is-full")).toBe(2);
  });

  it("refuses on drift when a teammate moved a test's mock tools, and uploads nothing", async () => {
    platform.tests.add({
      name: "calendar-is-full",
      scenario: "Nothing is free next week.",
      expectedBehaviors: ["The agent offers to take a message."],
      mockTools: [{ tool: "check_availability", answer: { slots: [] } }],
    });
    await makeFolder();
    await egma(["pull"]);

    // A teammate changes the mocked world of that test in the dashboard.
    platform.tests.editInDashboard("calendar-is-full", {
      mockTools: [{ tool: "check_availability", error: "the calendar is unreachable" }],
    });

    // The developer, meanwhile, has changed the same test and authored a new
    // project mock tool beside it.
    const held = await readTest("calendar-is-full.md");
    await writeTest("calendar-is-full.md", held.replace('"slots": []', '"slots": ["09:00"]'));
    await writeMockTools([["send_sms", { answer: { sent: true } }]]);

    const refused = await egma(["push"]);

    expect(refused.code).toBe(5);
    expect(factOf(refused.stdout, "status")).toBe("refused");
    expect(valuesOf(refused.stdout, "conflict")).toEqual(["calendar-is-full"]);
    expect(factOf(refused.stdout, "uploaded")).toBe("nothing");
    expect(refused.stderr).toContain("egma pull");

    // Nothing at all was uploaded — not the test, and not the mocked world it
    // was pushed beside. "Nothing was uploaded" has to be true of the whole
    // folder or it is not worth saying.
    expect(platform.tests.versionsOf("calendar-is-full")).toBe(2);
    expect(platform.mocking.mockTools).toEqual([]);
  });

  it("relays egma's own refusal for an answer or a delay egma cannot carry", async () => {
    await makeFolder();
    const tooLong = LONGEST_MOCK_TOOL_DELAY_MILLISECONDS + 1;
    const tooBig = "x".repeat(LARGEST_MOCK_TOOL_ANSWER_BYTES);
    await writeMockTools([
      ["book_appointment", { answer: { booked: true }, delay_ms: tooLong }],
      ["read_notes", { answer: tooBig }],
      ["send_sms", { answer: { sent: true } }],
    ]);

    const result = await egma(["push"]);

    expect(result.code).toBe(6);
    expect(factOf(result.stdout, "status")).toBe("turned-away");
    expect(valuesOf(result.stdout, "turned-away")).toEqual(["book_appointment", "read_notes"]);
    expect(valuesOf(result.stdout, "file")).toContain("egma/mock-tools.md");

    // egma's own sentences, word for word, arithmetic included. Nothing out
    // here holds a second copy of either ceiling — the numbers in these
    // sentences are the platform's own, which is why they can be trusted to
    // still be right the day the budget moves.
    expect(valuesOf(result.stdout, "reason")).toEqual([
      `delay_ms is ${tooLong}, and a mock tool may delay its answer by at most ` +
        `${LONGEST_MOCK_TOOL_DELAY_MILLISECONDS} milliseconds — the budget the exchange ` +
        `carrying it is given. Send a smaller delay_ms.`,
      // The bare string is two bytes of quotes; the wire adds `{"answer":` and
      // the closing brace, which is eleven more and the whole point of the
      // number being counted this way.
      `answer is ${tooBig.length + 13} bytes once serialized and tagged for the wire, ` +
        `and the exchange that carries it holds at most ` +
        `${LARGEST_MOCK_TOOL_ANSWER_BYTES}. An answer that needs more than that is a ` +
        `document rather than a tool answer.`,
    ]);

    // The one egma could take, landed; the two it could not, left in the file
    // exactly as they were written, so the author is looking at what the
    // refusal is about.
    expect(platform.mocking.mockTools.map((one) => one.tool)).toEqual(["send_sms"]);
    const file = await readMockTools();
    expect(file).toContain(String(tooLong));
    expect(mockToolsIn(file)).toHaveLength(3);
  });

  it("takes a delay and a scope out when the file stops saying them", async () => {
    // Registered through the door a developer's connect uses, because that is
    // the only way an agent exists for a mock tool to be scoped to.
    await fetch(`${platform.url}/api/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "front-desk" }),
    });
    platform.mocking.add({
      tool: "check_availability",
      answer: { slots: [] },
      delayMilliseconds: 800,
      agents: ["front-desk"],
    });
    await makeFolder();
    await egma(["pull"]);

    // The pulled file says both, and the developer takes both out.
    expect(mockToolsIn(await readMockTools())).toEqual([
      {
        tool: "check_availability",
        says: { answer: { slots: [] }, delay_ms: 800, agents: ["front-desk"] },
      },
    ]);
    await writeMockTools([["check_availability", { answer: { slots: [] } }]]);

    const result = await egma(["push"]);

    expect(result.code).toBe(0);
    expect(valuesOf(result.stdout, "mock-tool-updated")).toEqual(["check_availability"]);
    // What the file stopped saying, egma stopped answering. A field left out of
    // an edit is one egma keeps, so a folder that only sent what it still said
    // would never be able to take anything back.
    expect(platform.mocking.mockTools).toEqual([
      {
        id: expect.stringMatching(/^mck_/u),
        tool: "check_availability",
        answer: { answer: { slots: [] } },
        delayMilliseconds: 0,
        agents: [],
      },
    ]);

    // And it settles: the next push has nothing left to do.
    const again = await egma(["push"]);
    expect(valuesOf(again.stdout, "mock-tool-unchanged")).toEqual(["check_availability"]);
  });

  it("names a mock tools file it cannot read on a pull too, and leaves it alone", async () => {
    // The verb a refusal tells a developer to run is the last one allowed to
    // fall over on a half-typed file. It writes nothing rather than merging
    // what it cannot read, because the mock tools somebody is drafting in there
    // are invisible to it and the platform's answer would land on top of them.
    platform.mocking.add({ tool: "check_availability", answer: { slots: [] } });
    await makeFolder();
    const broken = ["## Mock tools", "### send_sms", "```json", "{sent: true", "```", ""].join(
      "\n",
    );
    await writeFile(mockToolsFile(), broken, "utf8");

    const result = await egma(["pull"]);

    expect(result.code).toBe(0);
    expect(factOf(result.stdout, "status")).toBe("pulled");
    expect(valuesOf(result.stdout, "kept")).toEqual(["mock-tools"]);
    expect(factOf(result.stdout, "reason")).toContain("send_sms");
    expect(factOf(result.stdout, "mock-tools")).toBe("0");
    expect(await readMockTools()).toBe(broken);
    // Every printed line is still a fact somebody can act on: no stack trace,
    // and nothing that is not `key: value`.
    expect(result.stderr).toBe("");
    for (const line of result.stdout.trimEnd().split("\n")) {
      expect(line, line).toMatch(/^[a-z-]+: /u);
    }
  });

  it("says nothing changed when a file only put the same keys in another order", async () => {
    platform.mocking.add({
      tool: "check_availability",
      answer: { slots: [] },
      delayMilliseconds: 250,
    });
    platform.tests.add({
      name: "calendar-is-full",
      scenario: "Nothing is free next week.",
      expectedBehaviors: ["The agent offers to take a message."],
      mockTools: [{ tool: "check_availability", answer: { slots: [] }, delay_ms: 250 }],
    });
    await makeFolder();
    await egma(["pull"]);

    // The order somebody types `delay_ms` and `answer` in is not something they
    // said — egma has one order it writes them in. A folder that thought
    // otherwise would report an edit that edited nothing, every time.
    await writeMockTools([["check_availability", { delay_ms: 250, answer: { slots: [] } }]]);
    const held = await readTest("calendar-is-full.md");
    await writeTest(
      "calendar-is-full.md",
      held.replace(
        /## Mock tools[\s\S]*$/u,
        `${mockToolSection([["check_availability", { delay_ms: 250, answer: { slots: [] } }]])}`,
      ),
    );

    const result = await egma(["push"]);

    expect(result.code).toBe(0);
    expect(valuesOf(result.stdout, "mock-tool-unchanged")).toEqual(["check_availability"]);
    expect(valuesOf(result.stdout, "unchanged")).toEqual(["calendar-is-full"]);
    expect(platform.tests.versionsOf("calendar-is-full")).toBe(1);
  });

  it("keeps a mock tool nobody has pushed, and never writes over it", async () => {
    platform.mocking.add({ tool: "check_availability", answer: { slots: [] } });
    await makeFolder();
    await writeMockTools([["send_sms", { answer: { sent: true } }]]);

    const pulled = await egma(["pull"]);

    expect(pulled.code).toBe(0);
    expect(valuesOf(pulled.stdout, "mock-tool")).toEqual(["check_availability", "send_sms"]);
    expect(mockToolsIn(await readMockTools())).toEqual([
      { tool: "check_availability", says: { answer: { slots: [] } } },
      { tool: "send_sms", says: { answer: { sent: true } } },
    ]);
  });

  it("names a mock tools file it cannot read, and uploads the tests it can", async () => {
    await makeFolder();
    await writeTest(
      "good.md",
      freshFile({ name: "good", scenario: "Something happens.", behaviors: ["It is handled."] }),
    );
    const broken = [
      "## Mock tools",
      "### check_availability",
      "```json",
      "{slots: []",
      "```",
      "",
    ].join("\n");
    await writeFile(mockToolsFile(), broken, "utf8");

    const result = await egma(["push"]);

    expect(result.code).toBe(6);
    expect(valuesOf(result.stdout, "turned-away")).toEqual(["mock-tools"]);
    expect(factOf(result.stdout, "reason")).toContain("check_availability");
    // The tests are not forfeit over it, and the file is untouched byte for
    // byte so the developer can see what they wrote.
    expect(platform.tests.tests.map((test) => test.name)).toEqual(["good"]);
    expect(await readMockTools()).toBe(broken);
  });
});

describe("both verbs, run with nobody watching", () => {
  it("finish with no standard input at all, which is what promptless means", async () => {
    platform.tests.add({ name: "one", scenario: "s", expectedBehaviors: ["b"] });
    await makeFolder();

    const child = spawn(process.execPath, [CLI_ENTRY, "pull", "--url", platform.url], {
      cwd: workspace.dir,
      env: workspace.env(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const code = await new Promise<number>((resolve) => {
      child.on("close", (value) => resolve(value ?? 0));
    });

    expect(code).toBe(0);
    expect(factOf(stdout, "status")).toBe("pulled");
  });

  it("answer 1 and say where they are when there is no egma folder", async () => {
    for (const verb of ["pull", "push"]) {
      const result = await egma([verb]);
      expect(result.code, verb).toBe(1);
      expect(factOf(result.stdout, "status")).toBe("no-folder");
      expect(result.stderr).toContain("egma init");
    }
  });

  it("answer 2 and point at egma login when this machine holds no key", async () => {
    const stranger = await makeWorkspace();
    try {
      await makeFolder();
      const result = await run(process.execPath, [CLI_ENTRY, "pull", "--url", platform.url], {
        cwd: workspace.dir,
        env: { ...workspace.env(), EGMA_HOME: stranger.dir },
      }).then(
        ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
        (error: { stdout?: string; stderr?: string; code?: number }) => ({
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? "",
          code: error.code ?? 1,
        }),
      );

      expect(result.code).toBe(2);
      expect(factOf(result.stdout, "status")).toBe("not-signed-in");
      expect(result.stderr).toContain("egma login");
    } finally {
      await stranger.remove();
    }
  });

  it("answer 4 and name the address when egma does not answer", async () => {
    await makeFolder();
    await writeTest(
      "one.md",
      freshFile({ name: "one", scenario: "s", behaviors: ["the agent does a thing"] }),
    );
    // Nothing listens here, and the address is in the message rather than in a
    // stack trace.
    await workspace.signIn("http://127.0.0.1:1", KEY);

    for (const verb of ["pull", "push"]) {
      const result = await egma([verb, "--url", "http://127.0.0.1:1"]);
      expect(result.code, verb).toBe(4);
      expect(factOf(result.stdout, "status")).toBe("unreachable");
      expect(factOf(result.stdout, "reason")).toContain("127.0.0.1:1");
      expect(result.stderr).toContain("127.0.0.1:1");
    }
  });

  it("are offered in the help, with what they print and what they answer", async () => {
    const help = await egma(["--help"]);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("egma init");
    expect(help.stdout).toContain("egma pull");
    expect(help.stdout).toContain("egma push");
    expect(help.stdout).toContain("5 push refused: Egma has moved on, pull first");
    expect(help.stdout).toContain("6 Egma turned a test or a mock tool away at its door");
    expect(help.stdout).toContain(
      "7 this Egma instance and this platform read different shapes: upgrade one of them",
    );
  });

  /**
   * The key this machine holds never leaves the home folder it is kept in.
   *
   * It rides every request these verbs make, so the one place it could escape
   * to is a printed line or a written file — and the folder is committed, so a
   * key that reached it would be a key in somebody's public repository. Every
   * path is walked: the one that works, the one that is refused, and the two
   * that fail.
   */
  it("never print the key, and never write it into the folder", async () => {
    platform.tests.add({ name: "one", scenario: "s", expectedBehaviors: ["b"] });
    // The folder, and deliberately no binding with it: what is under check
    // below includes an egma that does not answer, and a bound repository
    // would be refused for naming another address before it ever got there.
    await runEgma(["init", "--agent", "receptionist"]);
    await egma(["pull"]);

    // A conflict, a refusal at the door, and an egma that does not answer.
    platform.tests.editInDashboard("one", { scenario: "s, changed" });
    const held = await readTest("one.md");
    await writeTest("one.md", held.replace("1. b", "1. b, said better"));
    await writeTest(
      "nothing-to-check.md",
      ["---", "name: nothing-to-check", "---", "## Scenario", "s", "## Expected behaviors", ""].join("\n"),
    );

    const runs = [
      await egma(["push"]),
      await egma(["pull"]),
      await egma(["push"]),
      await egma(["pull", "--url", "http://127.0.0.1:1"]),
    ];

    for (const [index, result] of runs.entries()) {
      expect(result.stdout + result.stderr, `run ${index}`).not.toContain(KEY);
      expect(result.stdout + result.stderr, `run ${index}`).not.toContain("egma_sk_");
    }

    // And nothing in the folder holds it either — not the config, not a test.
    for (const name of await readdir(path.join(workspace.dir, "egma"), { recursive: true })) {
      const file = path.join(workspace.dir, "egma", String(name));
      if (!(await stat(file)).isFile()) continue;
      expect(await readFile(file, "utf8"), String(name)).not.toContain("egma_sk_");
    }
  });

  /**
   * What egma set up for a new account is settled in the browser and said
   * nowhere out here. A relayed message is the one way those words could reach
   * a terminal from the far end of an HTTP request, so every path that relays
   * one is held against the list.
   */
  it("never say the words a terminal does not say", async () => {
    const BANNED = ["organization", "organisation", "project", "tenant"];

    platform.tests.add({ name: "one", scenario: "s", expectedBehaviors: ["b"] });
    // The folder alone: `init` needs no platform, so it is given none.
    await runEgma(["init", "--agent", "receptionist"]);
    await egma(["pull"]);
    platform.tests.editInDashboard("one", { scenario: "s, changed" });

    await writeTest("nothing-to-check.md", ["---", "name: nothing-to-check", "---", "## Scenario", "s", "## Expected behaviors", ""].join("\n"));
    const held = await readTest("one.md");
    await writeTest("one.md", held.replace("1. b", "1. b, said better"));

    const refused = await egma(["push"]);
    const pulled = await egma(["pull"]);
    const turnedAway = await egma(["push"]);

    for (const result of [refused, pulled, turnedAway]) {
      const shown = result.stdout + result.stderr;
      for (const banned of BANNED) {
        expect(new RegExp(`\\b${banned}`, "iu").test(shown), `said "${banned}"`).toBe(false);
      }
    }
  });
});
