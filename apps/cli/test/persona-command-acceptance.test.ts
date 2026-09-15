/** Persona settings through the built CLI and a real HTTP boundary. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createEgmaFolder, EMPTY_CONFIG } from "../src/folder/egma-folder.ts";
import { startPlatform } from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, makeWorkspace } from "./support/workspace.ts";

const run = promisify(execFile);
const KEY = "egma_sk_persona-command-acceptance";

it("uses built-in defaults and clones changes into a new persona", async () => {
  const [platform, workspace] = await Promise.all([startPlatform(), makeWorkspace()]);
  try {
    platform.signedInWith(KEY);
    await workspace.signIn(platform.url, KEY);
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        ...EMPTY_CONFIG,
        platform: { origin: platform.url },
        project: { id: platform.projectId, name: "Fixture project" },
      },
    });

    const used = await run(process.execPath, [CLI_ENTRY, "persona", "use", "prs_egma_default"], {
      cwd: workspace.dir,
      env: workspace.env(),
    });
    expect(used.stderr).toBe("");
    const useRequest = platform.records.find((record) => record.path === "/v1/personas/prs_egma_default/use");
    expect(useRequest?.body).toEqual({ projectId: platform.projectId });

    const cloned = await run(process.execPath, [CLI_ENTRY, "persona", "clone", "prs_egma_default", "--name", "Rain caller", "--background-sound", "rain-v1"], {
      cwd: workspace.dir,
      env: workspace.env(),
    });
    expect(cloned.stderr).toBe("");
    const cloneRequest = platform.records.find((record) => record.method === "POST" && record.path === "/v1/personas/prs_egma_default/fork");
    expect(cloneRequest?.body).toMatchObject({
      projectId: platform.projectId,
      name: "Rain caller",
      models: DEFAULT_EXPECTED_MODELS,
      controls: { ...DEFAULT_EXPECTED_CONTROLS, backgroundSoundId: "rain-v1" },
    });
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

const DEFAULT_EXPECTED_MODELS = {
  mode: "separate",
  llm: { provider: "openai", model: "gpt-4o" },
  stt: { provider: "deepgram", model: "nova-3" },
  tts: { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "alloy" },
};

const DEFAULT_EXPECTED_CONTROLS = {
  language: "en-US",
  interruptionLevel: "none",
  backgroundSoundId: "none",
};
