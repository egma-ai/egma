/**
 * First repository onboarding, through the built CLI rather than an injected
 * access object: explicit address, public identity, then a committed binding.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { expect, it, vi } from "vitest";

import {
  folderPathsIn,
  readConfig,
  writeTestFile,
} from "../src/folder/egma-folder.ts";
import { DEFAULT_TEST_COUNT } from "../src/wizard/test-generation.ts";
import { startFakeRetell } from "./support/fake-retell.ts";
import { startPlatform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  makeWorkspace,
} from "./support/workspace.ts";

const PLATFORM_KEY = "egma_sk_for-first-repository-onboarding";
const PROVIDER_KEY = "synthetic-retell-key-for-first-onboarding";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

it("verifies an explicitly selected platform and commits its identity on first onboarding", async () => {
  const [platform, retell, workspace] = await Promise.all([
    startPlatform(),
    startFakeRetell({
      keys: [PROVIDER_KEY],
      agents: [
        {
          agent_id: "synthetic-first-onboarding-agent",
          agent_name: "First receptionist",
          response_engine: { type: "retell-llm", llm_id: "synthetic-first-llm" },
        },
      ],
      llms: [
        {
          llm_id: "synthetic-first-llm",
          general_prompt: "Help each persona move an appointment.",
        },
      ],
    }),
    makeWorkspace(),
  ]);

  try {
    platform.signedInWith(PLATFORM_KEY);
    await workspace.signIn(platform.url, PLATFORM_KEY);

    // Existing tests keep this proof about platform binding, not test
    // generation. There is deliberately no config file and no binding yet.
    const paths = folderPathsIn(workspace.dir);
    await mkdir(paths.tests, { recursive: true });
    for (let number = 1; number <= DEFAULT_TEST_COUNT; number += 1) {
      const name = `first-onboarding-${number}`;
      await writeTestFile(path.join(paths.tests, `${name}.md`), {
        name,
        personas: [],
        version: null,
        scenario: `The persona needs a different appointment time in case ${number}.`,
        expectedBehaviors: ["The agent confirms the new time."],
      });
    }
    await expect(readConfig(paths.config)).rejects.toMatchObject({ code: "ENOENT" });

    const script = await workspace.script({
      steps: [
        { kind: "say", text: "egma:found framework retell-sdk\n" },
        { kind: "stop", reason: "end_turn" },
      ],
    });
    const env = workspace.env({
      EGMA_RETELL_URL: retell.url,
      EGMA_RETELL_API_KEY: PROVIDER_KEY,
    });
    expect(env.EGMA_URL).toBeUndefined();

    const grading = gradeEveryRun(platform);
    let stdout = "";
    let stderr = "";
    let code = 1;
    try {
      const child = spawn(
        process.execPath,
        [
          CLI_ENTRY,
          "--headless",
          "--url",
          platform.url,
          "--",
          process.execPath,
          FAKE_AGENT,
          script,
        ],
        { cwd: workspace.dir, env },
      );
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.stdin.end();
      code = await new Promise<number>((resolve) => {
        child.on("close", (value) => resolve(value ?? 1));
      });
    } finally {
      grading.stop();
    }

    expect(code, stderr).toBe(0);
    expect(stdout).toMatch(/^first-verdict: /mu);
    expect(platform.records[0]).toMatchObject({
      method: "GET",
      path: "/api/platform",
    });
    for (const expectedPath of ["/api/agents", "/api/tests", "/api/runs"]) {
      expect(
        platform.records.some((request) => request.path === expectedPath),
        expectedPath,
      ).toBe(true);
    }

    const config = await readConfig(paths.config);
    expect(config.platform).toEqual({
      origin: platform.url,
      instance: platform.instanceId,
    });
    expect(config.agent?.id).toMatch(/^agt_/u);
    expect(config.connection?.id).toMatch(/^con_/u);
  } finally {
    await Promise.all([platform.close(), retell.close(), workspace.remove()]);
  }
});
