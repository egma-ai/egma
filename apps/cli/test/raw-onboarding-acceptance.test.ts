/**
 * One complete onboarding through the built, promptless CLI.
 *
 * Login has its own command acceptance tests, so this starts with the exact
 * machine state a successful login leaves: one platform key in the isolated
 * Egma home. Everything after that is the public skills-and-CLI path. No
 * wizard, ACP process, coding-agent selector, or headless compatibility seam
 * participates.
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { expect, it, vi } from "vitest";

import {
  folderPathsIn,
  readConfig,
  readRepository,
} from "../src/folder/egma-folder.ts";
import { serializeTestFile, type FilePersona } from "../src/folder/test-file.ts";
import { startFakeRetell, type FakeRetell } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import { aTestFile, blocking } from "./support/test-file.ts";
import {
  CLI_ENTRY,
  MANIFEST,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

const PLATFORM_KEY = "egma_sk_raw-onboarding-acceptance";
const RETELL_KEY = "key_raw-onboarding-retell-A1B2C3D4";
const PROVIDER_PROMPT =
  "You are the Northside service desk. Confirm the request and never invent availability.";
const PROVIDER_TOOLS = [
  { type: "function", name: "lookup_availability" },
  { type: "end_call" },
] as const;

const AUTHORED_TESTS = [
  {
    file: "confirms-the-request.md",
    name: "Confirms the request",
    scenario: "The caller asks to book a service visit next Tuesday.",
    behavior: "The agent confirms the requested day before ending the call.",
  },
  {
    file: "does-not-invent-a-slot.md",
    name: "Does not invent a slot",
    scenario: "The caller asks for a time that the scheduling tool has not returned.",
    behavior: "The agent does not claim that an unverified time is available.",
  },
  {
    file: "asks-one-follow-up.md",
    name: "Asks one follow-up",
    scenario: "The caller asks for service but gives no preferred day.",
    behavior: "The agent asks which day the caller prefers.",
  },
  {
    file: "ends-after-helping.md",
    name: "Ends after helping",
    scenario: "The caller says that the confirmed appointment answers the request.",
    behavior: "The agent closes the conversation after confirming there is nothing else needed.",
  },
] as const;

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
};

function facts(stdout: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of stdout.trimEnd().split("\n")) {
    const separator = line.indexOf(": ");
    if (separator > 0) found[line.slice(0, separator)] = line.slice(separator + 2);
  }
  return found;
}

function personaFrom(stdout: string): FilePersona {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("persona: "));
  expect(line).toBeDefined();
  const value = JSON.parse(line?.slice("persona: ".length) ?? "null") as {
    readonly id?: unknown;
    readonly name?: unknown;
  } | null;
  expect(value).toEqual({ id: "prs_egma_default", name: "Everyday caller" });
  return {
    id: typeof value?.id === "string" ? value.id : "",
    name: typeof value?.name === "string" ? value.name : "",
  };
}

vi.setConfig({ testTimeout: 45_000, hookTimeout: 30_000 });

it("onboards Retell and follows the first graded run using raw CLI verbs only", async () => {
  let platform: Platform | undefined;
  let retell: FakeRetell | undefined;
  let workspace: Workspace | undefined;
  let grading: ReturnType<typeof gradeEveryRun> | undefined;
  const invocations: string[][] = [];

  try {
    platform = await startPlatform();
    retell = await startFakeRetell({
      keys: [RETELL_KEY],
      agents: [
        {
          agent_id: "agent_northside",
          agent_name: "northside-service-desk",
          channel: "voice",
          voice_id: "fixture-voice",
          response_engine: { type: "retell-llm", llm_id: "llm_northside" },
        },
      ],
      llms: [
        {
          llm_id: "llm_northside",
          general_prompt: PROVIDER_PROMPT,
          general_tools: PROVIDER_TOOLS,
        },
      ],
    });
    workspace = await makeWorkspace({ "package.json": MANIFEST });

    // This is the durable state `egma login` leaves. The login command itself
    // is kept out of this test because its browser/device flow has its own
    // built-command acceptance coverage.
    platform.signedInWith(PLATFORM_KEY);
    await workspace.signIn(platform.url, PLATFORM_KEY);

    const egma = async (
      argv: readonly string[],
      extraEnv: NodeJS.ProcessEnv = {},
    ): Promise<CommandResult> => {
      invocations.push([...argv]);
      const child = spawn(process.execPath, [CLI_ENTRY, ...argv], {
        cwd: workspace?.dir,
        env: workspace?.env({
          EGMA_RETELL_URL: retell?.url,
          ...extraEnv,
        }),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      // An empty, closed pipe lets connect prefer its named environment value
      // and proves no hidden terminal answer is part of the command.
      child.stdin.end();
      return await new Promise<CommandResult>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          resolve({ stdout, stderr, code: code ?? 1 });
        });
      });
    };

    const connected = await egma(
      [
        "connect",
        "--url",
        platform.url,
        "--platform",
        "retell",
        "--show-context",
        "--lanes",
        "text",
      ],
      { EGMA_RETELL_API_KEY: RETELL_KEY },
    );
    expect(connected.code, connected.stderr).toBe(0);
    const connectionFacts = facts(connected.stdout);
    expect(connectionFacts.status).toBe("connected");
    expect(connectionFacts.provider_prompt).toBe(JSON.stringify(PROVIDER_PROMPT));
    expect(JSON.parse(connectionFacts.provider_tools ?? "null")).toEqual(PROVIDER_TOOLS);
    expect(connected.stdout.match(/^provider_prompt: .*$/gmu)).toHaveLength(1);
    expect(connected.stdout.match(/^provider_tools: .*$/gmu)).toHaveLength(1);
    expect(`${connected.stdout}${connected.stderr}`).not.toContain(RETELL_KEY);
    expect(platform.registered.sealed).toEqual([RETELL_KEY]);

    // Every command after connect resolves the committed platform binding and
    // the same signed-in machine key. None repeats --url.
    const listed = await egma(["personas"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(facts(listed.stdout)).toMatchObject({ personas: "1", status: "listed" });
    const persona = personaFrom(listed.stdout);

    const suite = await egma([
      "suite",
      "create",
      "release-gate",
      "--name",
      "Northside release gate",
    ]);
    expect(suite.code, suite.stderr).toBe(0);
    expect(facts(suite.stdout)).toMatchObject({
      directory: "release-gate",
      status: "created",
    });

    const suiteRoot = path.join(
      folderPathsIn(workspace.dir).tests,
      "release-gate",
    );
    for (const authored of AUTHORED_TESTS) {
      await writeFile(
        path.join(suiteRoot, authored.file),
        serializeTestFile(
          aTestFile({
            name: authored.name,
            scenario: authored.scenario,
            expectedBehaviors: blocking(authored.behavior),
            personas: [persona],
          }),
        ),
        "utf8",
      );
    }

    const validated = await egma(["validate"]);
    expect(validated.code, validated.stderr).toBe(0);
    expect(facts(validated.stdout)).toMatchObject({
      suites: "1",
      tests: String(AUTHORED_TESTS.length),
      "persona-references": String(AUTHORED_TESTS.length),
      status: "valid",
    });

    const beforePush = platform.records.length;
    const pushed = await egma(["push"]);
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(facts(pushed.stdout)).toMatchObject({
      suites: "1",
      tests: String(AUTHORED_TESTS.length),
      status: "pushed",
    });
    expect(
      platform.records
        .slice(beforePush)
        .filter((record) => record.method !== "GET")
        .map((record) => `${record.method} ${record.path}`),
    ).toEqual(["POST /v1/repository/change-set"]);
    expect(platform.tests.tests.map((test) => test.name).sort()).toEqual(
      AUTHORED_TESTS.map((test) => test.name).sort(),
    );

    const repository = await readRepository(folderPathsIn(workspace.dir));
    expect(repository.suites).toHaveLength(1);
    expect(repository.suites[0]?.tests).toHaveLength(AUTHORED_TESTS.length);
    expect(
      repository.suites[0]?.tests.every(
        (file) => file.test.version !== null && file.test.identityRevision !== null,
      ),
    ).toBe(true);

    grading = gradeEveryRun(platform);
    const followed = await egma([
      "run",
      "release-gate",
      "--name",
      "Raw onboarding acceptance",
    ]);
    expect(followed.code, `${followed.stderr}\n${followed.stdout}`).toBe(0);
    const runFacts = facts(followed.stdout);
    expect(runFacts.tests).toBe(String(AUTHORED_TESTS.length));
    expect(runFacts.simulations).toBe(String(AUTHORED_TESTS.length));
    expect(runFacts["execution-finished"]).toBe(String(AUTHORED_TESTS.length));
    expect(runFacts["grading-terminal"]).toBe(String(AUTHORED_TESTS.length));
    expect(runFacts["grading-complete"]).toBe(String(AUTHORED_TESTS.length));
    expect(runFacts.status).toBe("completed");
    expect(followed.stdout).toContain("grading: ");
    expect(platform.running.runs).toEqual([
      expect.objectContaining({
        suiteId: platform.suites.suites[0]?.id,
        status: "completed",
        expectedSimulationCount: AUTHORED_TESTS.length,
      }),
    ]);
    expect(platform.running.simulationsOf()).toHaveLength(AUTHORED_TESTS.length);
    expect(
      platform.running
        .simulationsOf()
        .every(
          (simulation) =>
            simulation.status === "completed" &&
            simulation.gradingState === "complete",
        ),
    ).toBe(true);

    const config = await readConfig(folderPathsIn(workspace.dir).config);
    expect(config.platform).toEqual({ origin: platform.url });
    expect(config.project?.id).toBe(platform.projectId);
    expect(config.agents).toHaveLength(1);

    expect(invocations.map((argv) => argv[0])).toEqual([
      "connect",
      "personas",
      "suite",
      "validate",
      "push",
      "run",
    ]);
    const everyArgument = invocations.flat();
    expect(everyArgument).not.toContain("--headless");
    expect(everyArgument).not.toContain("--coding-agent");
    expect(everyArgument).not.toContain("--");
    expect(invocations.slice(1).flat()).not.toContain("--url");
  } finally {
    grading?.stop();
    await Promise.all([
      platform?.close(),
      retell?.close(),
      workspace?.remove(),
    ]);
  }
});
