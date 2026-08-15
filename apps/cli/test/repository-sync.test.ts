/**
 * `egma pull` and `egma push` once a repository is bound to an agent, and once
 * a test carries more than a folder used to be able to write down.
 *
 * `pull-push.test.ts` next door is about the two verbs themselves — what they
 * print, what they exit with, what they leave in the repository. This file is
 * about the seam between one folder and one platform that have both grown:
 *
 * - **One folder, one agent.** Which agents a test applies to is a set the
 *   browser owns. A folder that tried to hold it would be a second source of
 *   truth for links it cannot see, so the folder holds one agent and sees the
 *   tests that apply to it.
 * - **Two tokens, two losses.** A file pins the content a run is judged by and
 *   the live name beside it. Either moving in the browser makes the copy stale,
 *   and each is refused on its own terms — while a link edit moves neither.
 * - **An old file is read, and updates nothing until it is safe.** Every folder
 *   committed before today is in a shape that cannot say what an update has to
 *   say. It still creates, it is still read, and a pull migrates it exactly
 *   when it can do so without guessing whose edit was the real one.
 *
 * Everything here drives the built command in a real subprocess, except where
 * the thing under test is what happens *between* two requests — a link removed
 * after the preflight and before the upload — which no subprocess can be made
 * to do from outside.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bindRepositoryPlatform,
  createEgmaFolder,
  updateConfig,
} from "../src/folder/egma-folder.ts";
import { parseTestFile } from "../src/folder/test-file.ts";
import { runPushCommand } from "../src/commands/push.ts";
import { pushTests } from "../src/sync/push.ts";
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

async function egma(args: readonly string[]): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI_ENTRY, ...args], {
      cwd: workspace.dir,
      env: workspace.env({ EGMA_URL: platform.url }),
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

function valuesOf(stdout: string, key: string): readonly string[] {
  return said(stdout)
    .filter(([name]) => name === key)
    .map(([, value]) => value);
}

function factOf(stdout: string, key: string): string | undefined {
  return valuesOf(stdout, key).at(-1);
}

const testsFolder = (): string => path.join(workspace.dir, "egma", "tests");

async function writeTest(name: string, document: string): Promise<void> {
  await mkdir(testsFolder(), { recursive: true });
  await writeFile(path.join(testsFolder(), name), document, "utf8");
}

async function readTest(name: string): Promise<string> {
  return readFile(path.join(testsFolder(), name), "utf8");
}

/**
 * A repository bound to one registered agent.
 *
 * The agent is registered through the door a developer's `connect` goes
 * through, rather than seeded beside it: the id a folder commits has to be an
 * id the platform issued, and a fixture that let a folder name an agent nobody
 * registered would be kinder than the platform it stands in for.
 */
async function boundRepository(): Promise<{
  readonly agentId: string;
  readonly paths: Awaited<ReturnType<typeof createEgmaFolder>>["paths"];
}> {
  const registered = await fetch(`${platform.url}/api/agents`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Front desk" }),
  });
  const agentId = ((await registered.json()) as { agent: { id: string } }).agent.id;

  const { paths } = await createEgmaFolder({ repository: workspace.dir });
  // Bound to this platform before it holds an identifier this platform issued,
  // which is the order `connect` writes them in and the order egma refuses any
  // other.
  await bindRepositoryPlatform(workspace.dir, {
    origin: platform.url,
    instance: platform.instanceId,
  });
  await updateConfig(paths.config, { agent: { name: "Front desk", id: agentId } });
  return { agentId, paths };
}

/** What a machine that has signed in holds, for the two in-process checks. */
function signedIn(): { readonly url: string; readonly key: string } {
  return { url: platform.url, key: KEY };
}

describe("one repository, one agent", () => {
  it("pulls the tests that apply to its agent, and leaves the rest alone", async () => {
    const { agentId } = await boundRepository();
    platform.tests.add({
      name: "ours",
      scenario: "The caller wants ours.",
      expectedBehaviors: ["b"],
      agents: [agentId],
    });
    platform.tests.add({
      name: "somebody-elses",
      scenario: "The caller wants theirs.",
      expectedBehaviors: ["b"],
      agents: [],
    });

    const pulled = await egma(["pull"]);

    expect(pulled.code).toBe(0);
    expect(valuesOf(pulled.stdout, "written")).toEqual(["ours"]);
    expect(factOf(pulled.stdout, "tests")).toBe("1");
    await expect(readTest("somebody-elses.md")).rejects.toThrow();
  });

  it("links its own agent to every test it creates", async () => {
    const { agentId } = await boundRepository();
    await writeTest(
      "brand-new.md",
      ["---", "name: brand-new", "---", "## Scenario", "s", "## Expected behaviors", "1. b", ""].join("\n"),
    );

    const pushed = await egma(["push"]);

    expect(pushed.code).toBe(0);
    expect(valuesOf(pushed.stdout, "created")).toEqual(["brand-new"]);
    expect(platform.tests.seeded("brand-new").agentIds).toEqual([agentId]);
  });

  /**
   * The whole of what the browser owning the link set means, in one story.
   *
   * The link goes away, the file stays, the pull leaves it exactly where it is,
   * the push refuses without touching either side, and the moment somebody
   * links it again the test comes back. Nothing in the middle deletes anybody's
   * file and nothing in the middle writes anything.
   */
  it("keeps the file, refuses the push, and picks the test back up when it is relinked", async () => {
    const { agentId } = await boundRepository();
    platform.tests.add({
      name: "ours",
      scenario: "The caller wants ours.",
      expectedBehaviors: ["b"],
      agents: [agentId],
    });
    await egma(["pull"]);
    const pulled = await readTest("ours.md");

    // Somebody in the browser takes this repository's agent off the test.
    const other = await fetch(`${platform.url}/api/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Night line" }),
    });
    const otherId = ((await other.json()) as { agent: { id: string } }).agent.id;
    platform.tests.setAgents("ours", [otherId]);

    // A pull never deletes, and there is nothing on this repository's side of
    // the platform to write through the file either.
    const again = await egma(["pull"]);
    expect(again.code).toBe(0);
    expect(factOf(again.stdout, "tests")).toBe("0");
    expect(valuesOf(again.stdout, "kept")).toEqual(["ours"]);
    expect(await readTest("ours.md")).toBe(pulled);

    // The developer edits it anyway, and the push refuses in the words that
    // name both ways out of it.
    await writeTest("ours.md", pulled.replace("1. [P0] b", "1. [P0] b, said better"));
    const refused = await egma(["push"]);

    expect(refused.code).toBe(5);
    expect(factOf(refused.stdout, "status")).toBe("refused");
    expect(valuesOf(refused.stdout, "reason-code")).toEqual(["not-applicable"]);
    expect(factOf(refused.stdout, "uploaded")).toBe("nothing");
    expect(refused.stderr.trim()).toBe(
      `Test ${platform.tests.seeded("ours").id} no longer applies to the ` +
        `agent bound to this repository. Link it to agent ${agentId} in Egma, ` +
        `or remove this local file; egma push changed neither side.`,
    );
    // Neither side. The version on the platform is the one it was, and the
    // file is the one the developer left.
    expect(platform.tests.versionsOf("ours")).toBe(1);
    expect(await readTest("ours.md")).toContain("said better");

    // Relinked in the browser, and the next explicit pull brings it back.
    platform.tests.setAgents("ours", [otherId, agentId]);
    const relinked = await egma(["pull"]);
    expect(relinked.code).toBe(0);
    expect(valuesOf(relinked.stdout, "written")).toEqual(["ours"]);
    expect(await readTest("ours.md")).toBe(pulled);
  });

  /**
   * An archived test is a different fact with a different fix, so it gets a
   * different sentence. Answering both with "it no longer applies to your
   * agent" would send somebody to a link editor for a test that is not in one.
   */
  it("says archived when the test is archived, rather than guessing at the links", async () => {
    const { agentId } = await boundRepository();
    platform.tests.add({
      name: "ours",
      scenario: "s",
      expectedBehaviors: ["b"],
      agents: [agentId],
    });
    await egma(["pull"]);
    const pulled = await readTest("ours.md");
    platform.tests.archiveInDashboard("ours");

    await writeTest("ours.md", pulled.replace("1. [P0] b", "1. [P0] b, said better"));
    const refused = await egma(["push"]);

    expect(refused.code).toBe(5);
    expect(valuesOf(refused.stdout, "reason-code")).toEqual(["archived"]);
    expect(refused.stderr).toContain("is archived, so egma will not write to it");
    expect(refused.stderr).toContain("Restore it in Egma");
  });
});

describe("the file format a test is written in", () => {
  it("writes every field of a test, and a pull straight after changes zero bytes", async () => {
    const { agentId } = await boundRepository();
    const grader = platform.tests.addGrader("says-the-price");
    const rita = platform.tests.addPersona("Impatient Rita");
    const seeded = platform.tests.add({
      name: "reschedules",
      description: "The caller missed Thursday.",
      scenario: "They want any afternoon next week.",
      expectedBehaviors: [
        "verifies who it is speaking to",
        { behavior: "offers two slots", priority: "P1" },
        { behavior: "mentions the cancellation policy", priority: "P2" },
      ],
      personas: ["Impatient Rita"],
      graders: [grader],
      requiredCapabilities: ["dtmf"],
      agents: [agentId],
    });

    const pulled = await egma(["pull"]);
    expect(pulled.code).toBe(0);

    expect(await readTest("reschedules.md")).toBe(
      [
        "---",
        "format: 2",
        "name: reschedules",
        "description: The caller missed Thursday.",
        `version: ${seeded.versionId}`,
        `identity_revision: ${seeded.revision}`,
        `graders: [${grader}]`,
        "required_capabilities: [dtmf]",
        "personas:",
        `  - id: ${rita}`,
        "    name: Impatient Rita",
        "---",
        "## Scenario",
        "They want any afternoon next week.",
        "## Expected behaviors",
        "1. [P0] verifies who it is speaking to",
        "2. [P1] offers two slots",
        "3. [P2] mentions the cancellation policy",
        "",
      ].join("\n"),
    );

    // The round trip, in both directions: a push finds nothing to upload and a
    // pull afterwards finds nothing to write.
    const pushed = await egma(["push"]);
    expect(pushed.code).toBe(0);
    expect(valuesOf(pushed.stdout, "unchanged")).toEqual(["reschedules"]);
    expect(platform.tests.versionsOf("reschedules")).toBe(1);

    const again = await egma(["pull"]);
    expect(valuesOf(again.stdout, "unchanged")).toEqual(["reschedules"]);
  });

  it("sends a priority somebody typed into the file, and mints one version for it", async () => {
    const { agentId } = await boundRepository();
    platform.tests.add({
      name: "reschedules",
      scenario: "s",
      expectedBehaviors: ["verifies who it is speaking to", "offers two slots"],
      agents: [agentId],
    });
    await egma(["pull"]);

    const held = await readTest("reschedules.md");
    await writeTest(
      "reschedules.md",
      held.replace("2. [P0] offers two slots", "2. [P1] offers two slots"),
    );

    const pushed = await egma(["push"]);

    expect(pushed.code).toBe(0);
    expect(valuesOf(pushed.stdout, "updated")).toEqual(["reschedules"]);
    expect(platform.tests.versionsOf("reschedules")).toBe(2);
    // And the file comes back saying the same thing, from the platform's own
    // answer rather than from what was sent.
    expect(await readTest("reschedules.md")).toContain("2. [P1] offers two slots");
  });

  /**
   * The identifier is what a push resolves and the name beside it is for the
   * reader. So a name somebody corrected in the file says nothing about who
   * calls — and a version minted for it would be a version whose whole content
   * is identical to the one before it.
   */
  it("resolves a persona by its identifier, and ignores a display name edited in the file", async () => {
    const { agentId } = await boundRepository();
    const rita = platform.tests.addPersona("Impatient Rita");
    platform.tests.add({
      name: "reschedules",
      scenario: "s",
      expectedBehaviors: ["b"],
      personas: ["Impatient Rita"],
      agents: [agentId],
    });
    await egma(["pull"]);

    const held = await readTest("reschedules.md");
    await writeTest("reschedules.md", held.replace("name: Impatient Rita", "name: Rita"));

    const pushed = await egma(["push"]);

    expect(pushed.code).toBe(0);
    expect(valuesOf(pushed.stdout, "unchanged")).toEqual(["reschedules"]);
    expect(platform.tests.versionsOf("reschedules")).toBe(1);
    // And the platform's own name is written back over the one in the file: the
    // display name is the platform's to say, and a pull refreshes it.
    const after = parseTestFile(await readTest("reschedules.md"), "a.md", "x");
    expect(after.personas).toEqual([{ id: rita, name: "Impatient Rita" }]);
  });

  /**
   * Both lists are content and both are always sent, for the reason the mock
   * tools are: a write that left the field out would keep what the file no
   * longer says, so a grader taken out of the file would come back on the next
   * pull and nobody would be able to say why.
   */
  it("carries a grader and a required capability up as well as down", async () => {
    const { agentId } = await boundRepository();
    const grader = platform.tests.addGrader("says-the-price");
    platform.tests.add({
      name: "reschedules",
      scenario: "s",
      expectedBehaviors: ["b"],
      agents: [agentId],
    });
    await egma(["pull"]);

    // Typed into the file, exactly as a developer or a coding agent would.
    const held = await readTest("reschedules.md");
    await writeTest(
      "reschedules.md",
      held.replace(
        "\n---\n## Scenario",
        `\ngraders: [${grader}]\nrequired_capabilities: [dtmf, barge_in]\n---\n## Scenario`,
      ),
    );

    const pushed = await egma(["push"]);
    expect(pushed.code).toBe(0);
    expect(valuesOf(pushed.stdout, "updated")).toEqual(["reschedules"]);

    const after = parseTestFile(await readTest("reschedules.md"), "a.md", "x");
    expect(after.graders).toEqual([grader]);
    expect(after.requiredCapabilities).toEqual(["dtmf", "barge_in"]);

    // And taking them out again clears them, rather than leaving what the file
    // no longer says.
    await writeTest(
      "reschedules.md",
      (await readTest("reschedules.md"))
        .replace(`graders: [${grader}]\n`, "")
        .replace("required_capabilities: [dtmf, barge_in]\n", ""),
    );
    const cleared = await egma(["push"]);
    expect(cleared.code).toBe(0);
    expect(valuesOf(cleared.stdout, "updated")).toEqual(["reschedules"]);
    const empty = parseTestFile(await readTest("reschedules.md"), "a.md", "x");
    expect(empty.graders).toEqual([]);
    expect(empty.requiredCapabilities).toEqual([]);
  });

  it("keeps a hidden mock tool override across a pull, a push and a pull", async () => {
    const { agentId } = await boundRepository();
    platform.tests.add({
      name: "no-slots",
      scenario: "s",
      expectedBehaviors: ["b"],
      agents: [agentId],
      mockTools: [{ tool: "check_availability", answer: { slots: [] }, delay_ms: 800 }],
    });

    await egma(["pull"]);
    const pulled = await readTest("no-slots.md");
    expect(pulled).toContain("## Mock tools");
    expect(pulled).toContain("check_availability");

    // A scenario edit that says nothing about the mocked world leaves it
    // exactly where it was, on the way up and on the way back down.
    await writeTest("no-slots.md", pulled.replace("s\n## Expected", "s, at length\n## Expected"));
    const pushed = await egma(["push"]);
    expect(pushed.code).toBe(0);
    expect(valuesOf(pushed.stdout, "updated")).toEqual(["no-slots"]);

    const after = parseTestFile(await readTest("no-slots.md"), "a.md", "x");
    expect(after.mockTools).toEqual([
      { tool: "check_availability", says: { answer: { slots: [] }, delay_ms: 800 } },
    ]);
  });
});

describe("a file written before the format grew", () => {
  const OLD_UNPINNED = [
    "---",
    "name: after-hours",
    "personas: [Impatient Rita]",
    "---",
    "## Scenario",
    "The caller has an emergency at 2am.",
    "## Expected behaviors",
    "1. The agent gives the emergency number.",
    "",
  ].join("\n");

  it("still creates a test, with the empty defaults for everything it cannot say", async () => {
    const { agentId } = await boundRepository();
    platform.tests.addPersona("Impatient Rita");
    await writeTest("after-hours.md", OLD_UNPINNED);

    const pushed = await egma(["push"]);

    expect(pushed.code).toBe(0);
    expect(valuesOf(pushed.stdout, "created")).toEqual(["after-hours"]);
    expect(platform.tests.seeded("after-hours").agentIds).toEqual([agentId]);

    // Written back in the current format, with a P0 for the line that carried
    // no marker — which is what every behavior meant before priorities existed.
    const after = parseTestFile(await readTest("after-hours.md"), "a.md", "x");
    expect(after.format).toBe(2);
    expect(after.expectedBehaviors).toEqual([
      { behavior: "The agent gives the emergency number.", priority: "P0" },
    ]);
    expect(after.identityRevision).not.toBeNull();
    expect(after.graders).toEqual([]);
    expect(after.requiredCapabilities).toEqual([]);
  });

  /**
   * The refusal that stops a partial old file erasing browser-authored data.
   *
   * A pinned file with no identity revision has nothing to say about the live
   * half, so an update from it would put an old name back over a rename nobody
   * in the folder ever saw. It is refused before anything uploads, in a
   * sentence that names the file and the one command that fixes it.
   */
  it("cannot update a test until a pull has migrated it", async () => {
    const { agentId } = await boundRepository();
    const seeded = platform.tests.add({
      name: "after-hours",
      scenario: "The caller has an emergency at 2am.",
      expectedBehaviors: ["The agent gives the emergency number."],
      agents: [agentId],
    });

    await writeTest(
      "after-hours.md",
      [
        "---",
        "name: after-hours",
        `version: ${seeded.versionId}`,
        "---",
        "## Scenario",
        "The caller has an emergency at 2am, and is frightened.",
        "## Expected behaviors",
        "1. The agent gives the emergency number.",
        "",
      ].join("\n"),
    );

    const refused = await egma(["push"]);

    expect(refused.code).toBe(5);
    expect(valuesOf(refused.stdout, "reason-code")).toEqual(["format"]);
    expect(refused.stderr.trim()).toBe(
      "Test file egma/tests/after-hours.md has a version pin but no identity " +
        "revision. Run egma pull to migrate it; if Egma keeps the file " +
        "unchanged, copy the draft aside, pull the platform version, and " +
        "reapply the draft.",
    );
    expect(factOf(refused.stdout, "uploaded")).toBe("nothing");
    expect(platform.tests.versionsOf("after-hours")).toBe(1);
  });

  it("is migrated by a pull when it is still a faithful copy of what it pins", async () => {
    const { agentId } = await boundRepository();
    const seeded = platform.tests.add({
      name: "after-hours",
      scenario: "The caller has an emergency at 2am.",
      expectedBehaviors: ["The agent gives the emergency number."],
      agents: [agentId],
    });
    await writeTest(
      "after-hours.md",
      [
        "---",
        "name: after-hours",
        `version: ${seeded.versionId}`,
        "personas: [default-persona]",
        "---",
        "## Scenario",
        "The caller has an emergency at 2am.",
        "## Expected behaviors",
        "1. The agent gives the emergency number.",
        "",
      ].join("\n"),
    );

    const pulled = await egma(["pull"]);

    expect(pulled.code).toBe(0);
    expect(valuesOf(pulled.stdout, "written")).toEqual(["after-hours"]);
    const after = parseTestFile(await readTest("after-hours.md"), "a.md", "x");
    expect(after.format).toBe(2);
    expect(after.identityRevision).toBe(seeded.revision);

    // And now it can update, which is the whole point of migrating it.
    const held = await readTest("after-hours.md");
    await writeTest("after-hours.md", held.replace("2am.", "2am, and is frightened."));
    const pushed = await egma(["push"]);
    expect(pushed.code).toBe(0);
    expect(valuesOf(pushed.stdout, "updated")).toEqual(["after-hours"]);
  });

  /**
   * The draft egma will not touch.
   *
   * A file holding a local edit and no identity revision cannot be rewritten
   * without throwing that edit away, and egma cannot tell a name changed in the
   * browser from one changed in the file. So it stays exactly as it is and the
   * report says what to do by hand.
   */
  it("is left exactly as it is when it holds a draft, with the recovery said out loud", async () => {
    const { agentId } = await boundRepository();
    const seeded = platform.tests.add({
      name: "after-hours",
      scenario: "The caller has an emergency at 2am.",
      expectedBehaviors: ["The agent gives the emergency number."],
      agents: [agentId],
    });
    const draft = [
      "---",
      "name: after-hours",
      `version: ${seeded.versionId}`,
      "personas: [default-persona]",
      "---",
      "## Scenario",
      "The caller has an emergency at 2am, and is frightened.",
      "## Expected behaviors",
      "1. The agent gives the emergency number.",
      "",
    ].join("\n");
    await writeTest("after-hours.md", draft);

    const pulled = await egma(["pull"]);

    expect(pulled.code).toBe(0);
    expect(valuesOf(pulled.stdout, "kept")).toEqual(["after-hours"]);
    expect(factOf(pulled.stdout, "reason")).toContain("its scenario has been edited since");
    expect(factOf(pulled.stdout, "reason")).toContain("Copy the draft aside");
    // Byte for byte. The one file the developer most needs to look at is the
    // one nothing wrote over.
    expect(await readTest("after-hours.md")).toBe(draft);
  });

  /**
   * The common case, and the one an unconditional priority comparison would
   * have broken.
   *
   * A version-1 file could not write a priority down, so every line in a
   * pristine one reads as claiming nothing. The platform meanwhile holds a P1
   * on one of them, set in the browser, which is not a difference the file is
   * responsible for and not a draft anybody typed. Refusing to migrate here
   * would refuse the folders this path exists for: every one written before
   * priorities existed, against any project that has used one since.
   */
  it("still migrates when the platform holds a priority the old shape could not write", async () => {
    const { agentId } = await boundRepository();
    const seeded = platform.tests.add({
      name: "after-hours",
      scenario: "The caller has an emergency at 2am.",
      expectedBehaviors: [
        "The agent gives the emergency number.",
        { behavior: "The agent says how long the wait is.", priority: "P1" },
      ],
      agents: [agentId],
    });
    await writeTest(
      "after-hours.md",
      [
        "---",
        "name: after-hours",
        `version: ${seeded.versionId}`,
        "personas: [default-persona]",
        "---",
        "## Scenario",
        "The caller has an emergency at 2am.",
        "## Expected behaviors",
        "1. The agent gives the emergency number.",
        "2. The agent says how long the wait is.",
        "",
      ].join("\n"),
    );

    const pulled = await egma(["pull"]);

    expect(valuesOf(pulled.stdout, "written")).toEqual(["after-hours"]);
    const after = parseTestFile(await readTest("after-hours.md"), "a.md", "x");
    expect(after.expectedBehaviors.map((one) => one.priority)).toEqual(["P0", "P1"]);
  });

  /**
   * The other half, and the hole the comparison above has to leave open.
   *
   * A marker somebody typed into an old file *is* a claim, and it is a draft:
   * they wrote it, it disagrees with what egma holds, and rewriting the file
   * would delete it with nothing said. That the file could never have pushed
   * that marker — the preflight refuses a pinned version-1 file outright — is a
   * reason to keep their edit safe until they can, not a reason to discard it.
   */
  it("is left alone when somebody typed a priority into it that egma does not hold", async () => {
    const { agentId } = await boundRepository();
    const seeded = platform.tests.add({
      name: "after-hours",
      scenario: "The caller has an emergency at 2am.",
      expectedBehaviors: ["The agent gives the emergency number."],
      agents: [agentId],
    });
    const draft = [
      "---",
      "name: after-hours",
      `version: ${seeded.versionId}`,
      "personas: [default-persona]",
      "---",
      "## Scenario",
      "The caller has an emergency at 2am.",
      "## Expected behaviors",
      "1. [P1] The agent gives the emergency number.",
      "",
    ].join("\n");
    await writeTest("after-hours.md", draft);

    const pulled = await egma(["pull"]);

    expect(pulled.code).toBe(0);
    expect(valuesOf(pulled.stdout, "kept")).toEqual(["after-hours"]);
    expect(factOf(pulled.stdout, "reason")).toContain(
      "a priority written into it is not the one egma holds",
    );
    // Byte for byte: the marker they typed is still there to be reapplied.
    expect(await readTest("after-hours.md")).toBe(draft);
  });

  it("is left alone when the browser renamed the test under it", async () => {
    const { agentId } = await boundRepository();
    const seeded = platform.tests.add({
      name: "after-hours",
      scenario: "The caller has an emergency at 2am.",
      expectedBehaviors: ["The agent gives the emergency number."],
      agents: [agentId],
    });
    const held = [
      "---",
      "name: after-hours",
      `version: ${seeded.versionId}`,
      "personas: [default-persona]",
      "---",
      "## Scenario",
      "The caller has an emergency at 2am.",
      "## Expected behaviors",
      "1. The agent gives the emergency number.",
      "",
    ].join("\n");
    await writeTest("after-hours.md", held);
    platform.tests.renameInDashboard("after-hours", { name: "out-of-hours" });

    const pulled = await egma(["pull"]);

    expect(valuesOf(pulled.stdout, "kept")).toEqual(["after-hours"]);
    expect(factOf(pulled.stdout, "reason")).toContain(
      "the test has been renamed on one side or the other",
    );
    expect(await readTest("after-hours.md")).toBe(held);
  });

  /**
   * A name two living personas answer to has no right answer, and a version-1
   * file has only names to give. The platform's own sentence is relayed word
   * for word, because it is the one that says where the identifier goes.
   */
  it("is refused, in the platform's words, when its persona name matches two people", async () => {
    await boundRepository();
    platform.tests.addPersona("Impatient Rita");
    platform.tests.addSecondPersonaCalled("Impatient Rita");
    await writeTest("after-hours.md", OLD_UNPINNED);

    const refused = await egma(["push"]);

    expect(refused.code).toBe(6);
    expect(factOf(refused.stdout, "status")).toBe("turned-away");
    expect(valuesOf(refused.stdout, "reason")).toEqual([
      "Persona name Impatient Rita matches more than one active persona in " +
        "this project. Put the intended persona's stable ID in the file and " +
        "try again; for a pinned file, egma pull can write the IDs after the " +
        "file is safe to migrate.",
    ]);
  });
});

describe("what makes a repository copy stale, and what does not", () => {
  it("refuses a push after a rename nobody in the folder could have seen", async () => {
    const { agentId } = await boundRepository();
    platform.tests.add({
      name: "reschedules",
      scenario: "s",
      expectedBehaviors: ["b"],
      agents: [agentId],
    });
    await egma(["pull"]);
    const held = await readTest("reschedules.md");

    // A rename mints no version, so the file's content pin is still current.
    // Only the live half moved, and only the second token can catch it.
    platform.tests.renameInDashboard("reschedules", { name: "reschedules a clean" });
    await writeTest("reschedules.md", held.replace("1. [P0] b", "1. [P0] b, said better"));

    const refused = await egma(["push"]);

    expect(refused.code).toBe(5);
    expect(valuesOf(refused.stdout, "reason-code")).toEqual(["identity-moved"]);
    expect(refused.stderr).toContain("has been renamed or redescribed in Egma");
    expect(factOf(refused.stdout, "uploaded")).toBe("nothing");
    // Under its new name, because the rename is what the file did not know
    // about — and the version behind it never moved.
    expect(platform.tests.versionsOf("reschedules a clean")).toBe(1);
  });

  it("lets a push through after a link edit, which moves neither token", async () => {
    const { agentId } = await boundRepository();
    platform.tests.add({
      name: "reschedules",
      scenario: "s",
      expectedBehaviors: ["b"],
      agents: [agentId],
    });
    await egma(["pull"]);
    const held = await readTest("reschedules.md");

    const other = await fetch(`${platform.url}/api/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Night line" }),
    });
    const otherId = ((await other.json()) as { agent: { id: string } }).agent.id;
    platform.tests.setAgents("reschedules", [agentId, otherId]);

    await writeTest("reschedules.md", held.replace("1. [P0] b", "1. [P0] b, said better"));
    const pushed = await egma(["push"]);

    expect(pushed.code).toBe(0);
    expect(valuesOf(pushed.stdout, "updated")).toEqual(["reschedules"]);
    // And the push said nothing about the links: both are still there.
    expect(platform.tests.seeded("reschedules").agentIds).toEqual([agentId, otherId]);
  });

  it("uploads nothing at all when one file in the folder cannot be written", async () => {
    const { agentId } = await boundRepository();
    for (const name of ["first", "second"]) {
      platform.tests.add({
        name,
        scenario: `${name} happens`,
        expectedBehaviors: ["b"],
        agents: [agentId],
      });
    }
    await egma(["pull"]);

    for (const name of ["first", "second"]) {
      const held = await readTest(`${name}.md`);
      await writeTest(`${name}.md`, held.replace("1. [P0] b", "1. [P0] b, said better"));
    }
    platform.tests.renameInDashboard("second", { description: "moved under them" });

    const refused = await egma(["push"]);

    // First, because it is the whole of what the preflight buys: a folder that
    // landed half its work and then refused would leave nobody able to say
    // what state they were in.
    expect(platform.tests.versionsOf("first")).toBe(1);
    expect(platform.tests.versionsOf("second")).toBe(1);
    expect(refused.code).toBe(5);
    expect(valuesOf(refused.stdout, "conflict")).toEqual(["second"]);
    expect(factOf(refused.stdout, "uploaded")).toBe("nothing");
  });
});

/**
 * The race the preflight cannot close, reported honestly.
 *
 * Nothing here spans several files in one transaction and nothing pretends to.
 * A link removed after the check and before one file's upload is refused at the
 * platform's own door, and what the report has to do is name every file that
 * landed and every file that did not — never "pushed", and never "nothing was
 * uploaded" when four tests went up.
 *
 * It is driven in process because the thing under test is what happens between
 * two requests, which no subprocess can be made to do from outside.
 */
describe("a link removed after the preflight", () => {
  it("refuses that one file and names what did land, without claiming success", async () => {
    const { agentId, paths } = await boundRepository();
    for (const name of ["first", "second"]) {
      platform.tests.add({
        name,
        scenario: `${name} happens`,
        expectedBehaviors: ["b"],
        agents: [agentId],
      });
    }
    await egma(["pull"]);
    for (const name of ["first", "second"]) {
      const held = await readTest(`${name}.md`);
      await writeTest(`${name}.md`, held.replace("1. [P0] b", "1. [P0] b, said better"));
    }

    // The link comes off the moment the first upload has landed — after the
    // preflight said both files were writable, and before the second one goes.
    let uploads = 0;
    const racing: typeof fetch = async (input, init) => {
      const address = new URL(typeof input === "string" ? input : String(input));
      const write = init?.method === "PATCH" && address.pathname.startsWith("/api/tests/");
      const answer = await fetch(input, init);
      if (write) {
        uploads += 1;
        if (uploads === 1) platform.tests.setAgents("second", []);
      }
      return answer;
    };

    const report = await pushTests({
      signedIn: signedIn(),
      paths,
      fetchImpl: racing as never,
    });

    expect(uploads).toBe(2);
    // One landed, and the report says which.
    expect(report.tests.map((test) => test.name)).toEqual(["first"]);
    expect(report.uploadedNothing).toBe(false);
    // One did not — and in the client's own words rather than the platform's,
    // because the platform's end by saying push changed neither side and by
    // now it has changed one. Same fact, same fix, no claim about the run.
    expect(report.conflicts).toEqual([
      {
        name: "second",
        shown: "egma/tests/second.md",
        reason: "not-applicable",
        said:
          "egma/tests/second.md names a test that no longer applies to the " +
          "agent bound to this repository — the link went away while this " +
          "push was running, so this file was not written. Link the test to " +
          `agent ${agentId} in Egma, or remove this local file.`,
      },
    ]);
    expect(platform.tests.versionsOf("first")).toBe(2);
    expect(platform.tests.versionsOf("second")).toBe(1);
  });

  /**
   * The sentence beside the count, and it has to agree with it.
   *
   * The preflight's refusal ends "Nothing was uploaded", which is its whole
   * worth. Said over a push that has already written a test, it is a refusal
   * telling somebody something untrue about what just happened — and the
   * recovery they build on it is the wrong one. So the late path counts what
   * landed and says so, and neither it nor the per-file sentence beside it
   * claims either side is untouched.
   */
  it("says what landed rather than claiming nothing was sent", async () => {
    const { agentId, paths } = await boundRepository();
    for (const name of ["first", "second"]) {
      platform.tests.add({
        name,
        scenario: `${name} happens`,
        expectedBehaviors: ["b"],
        agents: [agentId],
      });
    }
    await egma(["pull"]);
    for (const name of ["first", "second"]) {
      const held = await readTest(`${name}.md`);
      await writeTest(`${name}.md`, held.replace("1. [P0] b", "1. [P0] b, said better"));
    }

    let uploads = 0;
    // The real one, captured before the global is replaced, so the wrapper
    // cannot call itself.
    const reallyFetch = globalThis.fetch;
    const racing: typeof fetch = async (input, init) => {
      const address = new URL(typeof input === "string" ? input : String(input));
      const write = init?.method === "PATCH" && address.pathname.startsWith("/api/tests/");
      const answer = await reallyFetch(input, init);
      if (write) {
        uploads += 1;
        if (uploads === 1) platform.tests.setAgents("second", []);
      }
      return answer;
    };

    // Through the verb itself, with the race set up around the global `fetch`
    // the command really uses — because what is under test is which sentence
    // the command *chooses*, and a check that composed the sentence itself
    // would pass whichever one it picked.
    const held = globalThis.fetch;
    globalThis.fetch = racing as typeof fetch;
    const out: string[] = [];
    const failed: string[] = [];
    let code: number;
    try {
      code = await runPushCommand({
        access: { url: platform.url, credentialsFile: workspace.credentialsFile },
        cwd: workspace.dir,
        out: (line) => out.push(line),
        fail: (line) => failed.push(line),
      });
    } finally {
      globalThis.fetch = held;
    }
    const printed = out.join("\n");
    const spoken = failed.join("\n");

    expect(code).toBe(5);
    expect(factOf(printed, "status")).toBe("refused");
    expect(factOf(printed, "uploaded")).toBe("1");

    // What actually happened, in the sentence beside that count: one went up,
    // one did not, and the pull is the real next move.
    expect(spoken).toContain("egma uploaded 1 of these and then refused second");
    expect(spoken).toContain("What has landed has landed — first");
    expect(spoken).toContain("Run egma pull");
    // And nothing in it says the opposite of the count printed beside it.
    expect(spoken).not.toContain("Nothing was uploaded");
    expect(spoken).not.toContain("changed neither side");
    expect(spoken).toContain(
      "the link went away while this push was running, so this file was not written",
    );
    expect(platform.tests.versionsOf("first")).toBe(2);
  });

  /**
   * The count is a promise about the platform, so it counts writes.
   *
   * A file that already says what egma holds is never sent — it is in the
   * report because the push looked at it, and its version did not move. Adding
   * it to "egma uploaded 3 of these" sends somebody to check three tests and
   * find one untouched, which is the same mistake as the sentence this one
   * replaced, made one decimal place further in.
   *
   * Three files, in the order the folder reads them: one settled, one edited
   * that lands, and one edited that the platform refuses after the check.
   */
  it("counts what it wrote, not what it looked at", async () => {
    const { agentId, paths } = await boundRepository();
    for (const name of ["a-settled", "b-edited", "c-refused"]) {
      platform.tests.add({
        name,
        scenario: `${name} happens`,
        expectedBehaviors: ["b"],
        agents: [agentId],
      });
    }
    await egma(["pull"]);
    // Two of the three are edited. `a-settled` is left exactly as the pull
    // wrote it, so the push finds it already saying what egma holds.
    for (const name of ["b-edited", "c-refused"]) {
      const held = await readTest(`${name}.md`);
      await writeTest(`${name}.md`, held.replace("1. [P0] b", "1. [P0] b, said better"));
    }

    const reallyFetch = globalThis.fetch;
    let uploads = 0;
    const racing: typeof fetch = async (input, init) => {
      const address = new URL(typeof input === "string" ? input : String(input));
      const write = init?.method === "PATCH" && address.pathname.startsWith("/api/tests/");
      const answer = await reallyFetch(input, init);
      if (write) {
        uploads += 1;
        // The first upload is b-edited's, because the folder reads in file-name
        // order. c-refused loses its link between that write and its own.
        if (uploads === 1) platform.tests.setAgents("c-refused", []);
      }
      return answer;
    };

    globalThis.fetch = racing as typeof fetch;
    const out: string[] = [];
    const failed: string[] = [];
    let code: number;
    try {
      code = await runPushCommand({
        access: { url: platform.url, credentialsFile: workspace.credentialsFile },
        cwd: workspace.dir,
        out: (line) => out.push(line),
        fail: (line) => failed.push(line),
      });
    } finally {
      globalThis.fetch = reallyFetch;
    }
    const printed = out.join("\n");
    const spoken = failed.join("\n");

    expect(code).toBe(5);
    // What the platform actually holds: one test moved, and two did not.
    expect(platform.tests.versionsOf("a-settled")).toBe(1);
    expect(platform.tests.versionsOf("b-edited")).toBe(2);
    expect(platform.tests.versionsOf("c-refused")).toBe(1);

    // So the count is one, on the line and in the sentence alike.
    expect(factOf(printed, "uploaded")).toBe("1");
    expect(spoken).toContain("egma uploaded 1 of these and then refused c-refused");
    expect(spoken).toContain("What has landed has landed — b-edited");
    // And the settled test is named in neither, because nothing was sent for it.
    expect(spoken).not.toContain("a-settled");
    // It is still reported, under the word for what happened to it, because the
    // push did look at it and its file was rewritten.
    expect(valuesOf(printed, "unchanged")).toEqual(["a-settled"]);
  });
});

/**
 * The promise this project makes about the surface a repository writes through:
 * the CLI and the platform ship together, and a mismatch is one sentence.
 *
 * `/api/tests` is internal — not `/api/v1`, and nothing outside egma is invited
 * to build on it — so it is free to change shape. What it is not free to do is
 * change quietly. The cost of that was measured rather than imagined: a client
 * that read behaviors as bare text against a platform that answers objects
 * pulled a folder of tests with no behaviors in it, and what stopped the empty
 * folder being written back was a falsifiability rule somewhere else entirely.
 * Real protection, arrived at by accident, reporting the wrong problem.
 */
describe("two egmas that read different shapes", () => {
  it("refuse both verbs, name which side is behind, and read nothing", async () => {
    const { agentId } = await boundRepository();
    platform.tests.add({
      name: "ours",
      scenario: "s",
      expectedBehaviors: ["b"],
      agents: [agentId],
    });
    platform.speaking.speaksContract(99);

    for (const verb of ["pull", "push"]) {
      const refused = await egma([verb]);

      expect(refused.code, verb).toBe(7);
      expect(factOf(refused.stdout, "status"), verb).toBe("outdated");
      expect(refused.stderr, verb).toContain("This copy of egma is older than the platform");
      expect(refused.stderr, verb).toContain("npx egma@latest");
      expect(refused.stderr, verb).toContain("Nothing was read and nothing was uploaded.");
    }

    // And nothing was: the folder is as empty as it was, and the platform holds
    // the version it held.
    await expect(readTest("ours.md")).rejects.toThrow();
    expect(platform.tests.versionsOf("ours")).toBe(1);
  });

  it("point at the platform when the platform is the older of the two", async () => {
    await boundRepository();
    // A platform from before the field existed answers no number at all, and
    // that is contract 1 rather than an unknown.
    platform.speaking.speaksContract(1);

    const refused = await egma(["pull"]);

    expect(refused.code).toBe(7);
    expect(refused.stderr).toContain("The platform is older than this copy of egma");
    expect(refused.stderr).not.toContain("npx egma@latest");
  });
});
