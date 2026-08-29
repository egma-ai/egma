/**
 * First repository onboarding, through the built CLI rather than an injected
 * access object: explicit address, then a committed URL-only binding.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";

import { expect, it, vi } from "vitest";

import {
  folderPathsIn,
  readConfig,
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

it("uses an explicitly selected platform and commits its URL on first onboarding", async () => {
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

    // There is deliberately no config file and no binding yet.
    const paths = folderPathsIn(workspace.dir);
    await expect(readConfig(paths.config)).rejects.toMatchObject({ code: "ENOENT" });

    const script = await workspace.script({
      steps: [
        { kind: "say", text: "egma:found framework retell-sdk\n" },
        { kind: "stop", reason: "end_turn" },
      ],
      stepsByTask: [
        {
          contains: `Write ${DEFAULT_TEST_COUNT} tests`,
          steps: [
            ...Array.from({ length: DEFAULT_TEST_COUNT }, (_, index) => {
              const number = index + 1;
              return {
                kind: "write-file" as const,
                path: `egma/tests/first-receptionist-tests/first-onboarding-${number}.md`,
                content: `---\nformat: 4\nname: first-onboarding-${number}\n---\n## Scenario\nThe caller needs a different appointment time in case ${number}.\n## Expected behaviors\n1. The agent confirms the new time.\n`,
              };
            }),
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });
    const env = workspace.env({
      EGMA_RETELL_URL: retell.url,
      EGMA_RETELL_API_KEY: PROVIDER_KEY,
      EGMA_LANES: "text",
    });

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
    expect(stdout).toMatch(/^first-result: .* complete$/mu);
    expect(platform.records.some((request) => request.path === "/api/platform")).toBe(
      false,
    );
    for (const expectedPath of [
      "/v1/agents",
      "/v1/test-suites",
      "/v1/repository/change-set",
      "/v1/runs",
    ]) {
      expect(
        platform.records.some((request) => request.path === expectedPath),
        expectedPath,
      ).toBe(true);
    }

    const config = await readConfig(paths.config);
    expect(config.platform).toEqual({ origin: platform.url });
    expect(config.agents[0]?.id).toMatch(/^agt_/u);
    expect(config.agents[0]?.connections[0]?.id).toMatch(/^con_/u);

    // The binding is committed, so what is written beside it is read by
    // everybody who clones this repository. It carries the URL and no key:
    // not the key this machine signs in to egma with, and not the provider key
    // the wizard was handed on the way through.
    const committed = await readFile(paths.config, "utf8");
    for (const secret of [PLATFORM_KEY, PROVIDER_KEY]) {
      expect(committed).not.toContain(secret);
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    }

    // And the run address the developer is handed is on the platform this
    // repository just bound itself to, with no key in it.
    const runId = platform.running.runs[0]?.id ?? "";
    expect(runId).not.toBe("");
    expect(stdout).toContain(
      `${platform.url}/projects/${platform.projectId}/runs/${runId}`,
    );
  } finally {
    await Promise.all([platform.close(), retell.close(), workspace.remove()]);
  }
});
