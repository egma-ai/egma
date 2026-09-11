/** The raw persona catalog command, through its folder and HTTP seams. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPersonaActionCommand, runPersonasCommand } from "../src/commands/personas.ts";
import { EMPTY_CONFIG, createEgmaFolder } from "../src/folder/egma-folder.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const URL = "https://egma.example";
const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";

let workspace: Workspace;

class JsonResponse extends Response {
  constructor(body: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    super(JSON.stringify(body), { ...init, headers });
  }
}

beforeEach(async () => {
  workspace = await makeWorkspace();
  await workspace.signIn(URL);
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      project: { id: PROJECT_ID, name: "Northside" },
    },
  });
});

afterEach(async () => workspace.remove());

describe("runPersonasCommand", () => {
  it("aborts the active Preview request when the command is interrupted", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null = null;
    const failures: string[] = [];
    const running = runPersonaActionCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile }, cwd: workspace.dir,
      out: () => undefined, fail: (line) => failures.push(line), signal: controller.signal,
      fetchImpl: async (_input, init) => {
        receivedSignal = init?.signal ?? null;
        return await new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener("abort", () => reject(receivedSignal?.reason), { once: true });
        });
      },
    }, "preview", {
      positionals: [],
      values: { "--stt-provider": "openai", "--stt-model": "gpt-live-transcribe", "--tts-provider": "openai", "--tts-model": "gpt-4o-mini-tts", "--llm-provider": "openai", "--llm-model": "gpt-4o", "--voice": "alloy" },
    });

    await vi.waitFor(() => expect(receivedSignal).not.toBeNull());
    controller.abort("interrupt");

    await expect(running).resolves.toBe(130);
    expect((receivedSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(failures).toEqual(["The command was interrupted before it finished."]);
  });

  it("uses the provider voice accent when a preview omits --accent", async () => {
    let body: Record<string, unknown> | undefined;
    const lines: string[] = [];
    const code = await runPersonaActionCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile }, cwd: workspace.dir,
      out: (line) => lines.push(line), fail: (line) => lines.push(`stderr: ${line}`),
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new JsonResponse({ audioBase64: "AA==", contentType: "audio/mpeg", expiresAt: null, interruptionNotice: "Use a full simulation." });
      },
    }, "preview", {
      positionals: [],
      values: { "--stt-provider": "openai", "--stt-model": "gpt-live-transcribe", "--tts-provider": "openai", "--tts-model": "gpt-4o-mini-tts", "--llm-provider": "openai", "--llm-model": "gpt-4o", "--voice": "alloy" },
    });
    expect(code).toBe(0);
    expect(body).toMatchObject({ controls: { language: "en-US", emotion: "neutral", accent: "voice_default", speechVolume: 1, backgroundSoundId: "none", backgroundVolume: 0.0631, interruptionLevel: "off" } });
  });

  it("uses a predefined persona with its built-in defaults", async () => {
    const requests: Array<{ method: string; body?: Record<string, unknown> }> = [];
    const code = await runPersonaActionCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile }, cwd: workspace.dir,
      out: () => undefined, fail: () => undefined,
      fetchImpl: async (_input, init) => {
        const method = init?.method ?? "GET";
        requests.push({ method, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as Record<string, unknown> }) });
        if (method === "GET") return new JsonResponse({
          id: "prs_default", language: null, settings: null,
          parameterContract: [
            ["llm_provider", "openai"], ["llm_model", "gpt-4o"], ["stt_provider", "deepgram"], ["stt_model", "nova-3"],
            ["tts_provider", "openai"], ["tts_model", "gpt-4o-mini-tts"], ["tts_voice_id", "alloy"], ["tts_speed", 1],
            ["language", "en-US"], ["emotion", "neutral"], ["accent", "voice_default"], ["speech_volume", 1], ["background_sound_id", "none"], ["background_volume", 0.0631], ["interruption_level", "off"],
          ].map(([key, defaultValue]) => ({ key, defaultValue })),
        });
        return new JsonResponse({ id: "prs_default" });
      },
    }, "use", { positionals: ["prs_default"], values: {} });

    expect(code).toBe(0);
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(requests[1]?.body).toMatchObject({
      projectId: PROJECT_ID,
      models: { llm: { provider: "openai", model: "gpt-4o" }, stt: { provider: "deepgram", model: "nova-3" }, tts: { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "alloy", speed: 1 } },
      controls: { language: "en-US", emotion: "neutral", accent: "voice_default", speechVolume: 1, backgroundSoundId: "none", backgroundVolume: 0.0631, interruptionLevel: "off" },
    });
  });

  it("merges one updated control into all saved persona settings", async () => {
    const bodies: Record<string, unknown>[] = [];
    const code = await runPersonaActionCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile }, cwd: workspace.dir,
      out: () => undefined, fail: () => undefined,
      fetchImpl: async (_input, init) => {
        if ((init?.method ?? "GET") === "GET") return new JsonResponse({
          id: "prs_saved", parameterContract: [], language: null,
          settings: {
            models: { llm: { provider: "openai", model: "gpt-4o" }, stt: { provider: "deepgram", model: "nova-3" }, tts: { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "alloy", speed: 0.9 } },
            controls: { language: "es-ES", emotion: "happy", accent: "voice_default", speechVolume: 0.8, backgroundSoundId: "cafe-v1", backgroundVolume: 0.1, interruptionLevel: "occasional", executionPolicyVersion: 1 },
          },
        });
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new JsonResponse({ id: "prs_saved" });
      },
    }, "update", { positionals: ["prs_saved"], values: { "--speech-volume": "1.2" } });

    expect(code).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      models: { llm: { provider: "openai", model: "gpt-4o" }, stt: { provider: "deepgram", model: "nova-3" }, tts: { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "alloy", speed: 0.9 } },
      controls: { language: "es-ES", emotion: "happy", accent: "voice_default", speechVolume: 1.2, backgroundSoundId: "cafe-v1", backgroundVolume: 0.1, interruptionLevel: "occasional" },
    });
    expect((bodies[0]?.controls as Record<string, unknown>).executionPolicyVersion).toBeUndefined();
  });

  it("updates one background control without resetting the saved level", async () => {
    const bodies: Record<string, unknown>[] = [];
    const code = await runPersonaActionCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile }, cwd: workspace.dir,
      out: () => undefined, fail: () => undefined,
      fetchImpl: async (_input, init) => {
        if ((init?.method ?? "GET") === "GET") return new JsonResponse({
          id: "prs_saved", parameterContract: [], language: null,
          settings: {
            models: { llm: { provider: "openai", model: "gpt-4o" }, stt: { provider: "deepgram", model: "nova-3" }, tts: { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "alloy", speed: 1 } },
            controls: { language: "en-US", emotion: "neutral", accent: "voice_default", speechVolume: 1, backgroundSoundId: "none", backgroundVolume: 0.04, interruptionLevel: "off", executionPolicyVersion: 1 },
          },
        });
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new JsonResponse({ id: "prs_saved" });
      },
    }, "update", { positionals: ["prs_saved"], values: { "--background-sound": "office-v1" } });

    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({ controls: { backgroundSoundId: "office-v1", backgroundVolume: 0.04, speechVolume: 1 } });
  });

  it("lists every valid persona id and name from the bound project", async () => {
    const requested: URL[] = [];
    const lines: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const requestedUrl = new globalThis.URL(
        typeof input === "string" || input instanceof globalThis.URL
          ? String(input)
          : input.url,
      );
      requested.push(requestedUrl);
      if (requestedUrl.searchParams.get("pageToken") === null) {
        return new JsonResponse({
          personas: [
            {
              id: "prs_01K3XQ7M4E8YB2FVN0H9TZQWER",
              name: "Everyday caller",
            },
          ],
          nextPageToken: "prs_01K3XQ7M4E8YB2FVN0H9TZQWES",
        });
      }
      return new JsonResponse({
        personas: [
          {
            id: "prs_01K3XQ7M4E8YB2FVN0H9TZQWES",
            name: "Impatient Rita",
          },
        ],
        nextPageToken: null,
      });
    };

    const code = await runPersonasCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      out: (line) => lines.push(line),
      fail: (line) => lines.push(`stderr: ${line}`),
      fetchImpl,
    });

    expect(code, lines.join("\n")).toBe(0);
    expect(requested).toHaveLength(2);
    expect(requested[0]?.pathname).toBe("/v1/personas");
    expect(requested[0]?.searchParams.get("projectId")).toBe(PROJECT_ID);
    expect(requested[1]?.searchParams.get("pageToken")).toBe(
      "prs_01K3XQ7M4E8YB2FVN0H9TZQWES",
    );
    expect(lines).toContain(`Personas for Project ${PROJECT_ID}:`);
    expect(lines).toContain(
      "- Everyday caller (prs_01K3XQ7M4E8YB2FVN0H9TZQWER)",
    );
    expect(lines).toContain(
      "- Impatient Rita (prs_01K3XQ7M4E8YB2FVN0H9TZQWES)",
    );
    expect(lines.at(-1)).toBe("Listed 2 personas.");
    expect(lines.join("\n")).not.toContain("status:");
  });

  it("does not ask the platform when the folder has no bound project", async () => {
    // `createEgmaFolder` keeps an existing config, so this case needs a fresh
    // repository rather than rewriting the one made in `beforeEach`.
    await workspace.remove();
    workspace = await makeWorkspace();
    await workspace.signIn(URL);
    await createEgmaFolder({ repository: workspace.dir });
    let requests = 0;
    const lines: string[] = [];

    const code = await runPersonasCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      out: (line) => lines.push(line),
      fail: (line) => lines.push(`stderr: ${line}`),
      fetchImpl: async () => {
        requests += 1;
        return new JsonResponse({});
      },
    });

    expect(code).toBe(1);
    expect(requests).toBe(0);
    expect(lines).toContain(
      "stderr: This repository does not name its Egma Project. Run egma init here first.",
    );
    expect(lines.join("\n")).not.toContain("status:");
  });

  it("keeps remote Persona fields from writing terminal control characters", async () => {
    const lines: string[] = [];
    const code = await runPersonasCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      out: (line) => lines.push(line),
      fail: (line) => lines.push(`stderr: ${line}`),
      fetchImpl: async () =>
        new JsonResponse({
          personas: [
            {
              id: "prs_01K3XQ7M4E8YB2FVN0H9TZQWER",
              name: "Everyday\ncaller\u001b[2J",
            },
          ],
          nextPageToken: null,
        }),
    });

    expect(code).toBe(0);
    expect(lines).toContain(
      "- Everydaycaller[2J (prs_01K3XQ7M4E8YB2FVN0H9TZQWER)",
    );
    expect(lines.join("\n")).not.toContain("\u001b");
  });
});
