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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEgmaFolder } from "../src/folder/egma-folder.ts";
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

async function egma(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
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
  it("makes a folder whose every file is committable as it stands", async () => {
    const result = await egma([
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
    expect(await readdir(path.join(workspace.dir, "egma"))).toEqual(["config.yaml", "tests"]);

    // git itself is the judge of "committable": every file goes in, and not one
    // of them is ignored.
    const git = async (...args: readonly string[]): Promise<string> =>
      (await run("git", [...args], { cwd: workspace.dir })).stdout;
    await git("init", "--quiet");
    await git("config", "user.email", "check@example.invalid");
    await git("config", "user.name", "check");
    await git("add", "egma");
    const staged = (await git("status", "--porcelain", "--", "egma")).trim().split("\n").sort();
    expect(staged).toEqual(["A  egma/config.yaml"]);

    // Nothing anywhere says to keep any of it out.
    await expect(
      run("git", ["check-ignore", "egma/config.yaml"], { cwd: workspace.dir }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("recognises a folder that is already here, and touches nothing in it", async () => {
    await egma(["init", "--agent", "receptionist"]);
    const before = await readFile(path.join(workspace.dir, "egma", "config.yaml"), "utf8");

    const again = await egma(["init", "--agent", "something-else"]);

    expect(again.code).toBe(0);
    expect(factOf(again.stdout, "status")).toBe("already-there");
    expect(await readFile(path.join(workspace.dir, "egma", "config.yaml"), "utf8")).toBe(before);
  });

  it("needs no key, because nothing in it talks to egma", async () => {
    const nowhere = await makeWorkspace();
    try {
      const result = await run(process.execPath, [CLI_ENTRY, "init"], {
        cwd: nowhere.dir,
        env: nowhere.env(),
      });
      expect(result.stdout).toContain("status: created");
    } finally {
      await nowhere.remove();
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

    // The files are the format, and each one is pinned to the version it holds.
    expect(await readTest("missed-appointment-reschedule.md")).toBe(
      [
        "---",
        "name: missed-appointment-reschedule",
        "personas: [impatient-caller]",
        `version: ${first.versionId}`,
        "---",
        "## Scenario",
        "The caller missed yesterday's appointment and wants to reschedule.",
        "## Expected behaviors",
        "1. The agent acknowledges the missed appointment without blame.",
        "2. The agent offers at least two concrete alternative slots.",
        "",
      ].join("\n"),
    );
    // A test that named nobody takes the default persona, and the file says so
    // rather than saying nothing.
    expect(await readTest("new-patient-insurance-question.md")).toContain(
      "personas: [default-persona]",
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
    expect(held.expected_behaviors).toEqual(["The agent acknowledges it without blame."]);
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

  it("surfaces egma's own words when a test is turned away at the door", async () => {
    await makeFolder();
    await writeTest(
      "unfalsifiable.md",
      ["---", "name: unfalsifiable", "---", "## Scenario", "Something happens.", "## Expected behaviors", ""].join("\n"),
    );

    const result = await egma(["push"]);

    expect(result.code).toBe(6);
    expect(factOf(result.stdout, "status")).toBe("turned-away");
    expect(valuesOf(result.stdout, "turned-away")).toEqual(["unfalsifiable"]);
    // The reason is egma's own, word for word, and not egma's client's.
    expect(factOf(result.stdout, "reason")).toBe(
      "a test needs at least one expected behavior, because a test that cannot fail is not a test",
    );
    expect(platform.tests.tests).toHaveLength(0);
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

describe("both verbs, run with nobody watching", () => {
  it("finish with no standard input at all, which is what promptless means", async () => {
    platform.tests.add({ name: "one", scenario: "s", expectedBehaviors: ["b"] });
    await makeFolder();

    const child = spawn(process.execPath, [CLI_ENTRY, "pull"], {
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
    expect(help.stdout).toContain("5 push refused: egma has moved on, pull first");
    expect(help.stdout).toContain("6 egma turned a test away at its door");
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
    await egma(["init", "--agent", "receptionist"]);
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
    await egma(["init", "--agent", "receptionist"]);
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
