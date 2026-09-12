/** Persona settings through the built CLI and a real HTTP boundary. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createEgmaFolder, EMPTY_CONFIG } from "../src/folder/egma-folder.ts";
import { startPlatform } from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, makeWorkspace } from "./support/workspace.ts";

const run = promisify(execFile);
const KEY = "egma_sk_persona-command-acceptance";

it("uses built-in defaults and preserves them through a one-control update", async () => {
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
    expect(useRequest?.body).toMatchObject({
      models: DEFAULT_EXPECTED_MODELS,
      controls: { ...DEFAULT_EXPECTED_CONTROLS, backgroundSoundId: "none", backgroundVolume: 0.0631 },
    });

    const updated = await run(process.execPath, [CLI_ENTRY, "persona", "update", "prs_egma_default", "--background-sound", "rain-v1"], {
      cwd: workspace.dir,
      env: workspace.env(),
    });
    expect(updated.stderr).toBe("");
    const updateRequest = platform.records.find((record) => record.method === "PATCH" && record.path === "/v1/personas/prs_egma_default");
    expect(updateRequest?.body).toMatchObject({
      models: DEFAULT_EXPECTED_MODELS,
      controls: { ...DEFAULT_EXPECTED_CONTROLS, backgroundSoundId: "rain-v1", backgroundVolume: 0.0631 },
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
  emotion: "neutral",
  accent: "voice_default",
  speechVolume: 1,
  interruptionLevel: "none",
};
