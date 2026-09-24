/** The raw persona catalog command, through its folder and HTTP seams. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  it("creates a GPT Live persona without STT or TTS fields", async () => {
    let body: Record<string, unknown> | undefined;
    const code = await runPersonaActionCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile }, cwd: workspace.dir,
      out: () => undefined, fail: () => undefined,
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new JsonResponse({ id: "prs_live" });
      },
    }, "create", { positionals: [], values: { "--name": "Live caller", "--identity-name": "Morgan", "--personality": "Direct and patient.", "--speech-mode": "live", "--llm-provider": "openai", "--llm-model": "gpt-5.6-sol", "--voice": "coral" } });

    expect(code).toBe(0);
    expect(body?.models).toEqual({ mode: "live", llm: { provider: "openai", model: "gpt-5.6-sol" }, live: { provider: "openai", model: "gpt-live-1", adapter: "openai_live", voiceId: "coral" } });
    expect(body?.models).not.toHaveProperty("stt");
    expect(body?.models).not.toHaveProperty("tts");
    expect(body?.controls).toEqual({ language: "en-US", backgroundSoundId: "none" });
  });

  it("rejects separate speech flags for a saved Live persona", async () => {
    const failures: string[] = [];
    let writes = 0;
    const code = await runPersonaActionCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile }, cwd: workspace.dir,
      out: () => undefined, fail: (message) => failures.push(message),
      fetchImpl: async (_input, init) => {
        if ((init?.method ?? "GET") !== "GET") writes += 1;
        return new JsonResponse({
          id: "prs_live", name: "Live", description: null, identityName: "Morgan", personality: "Direct.", parameterContract: [], language: null,
          settings: {
            models: { mode: "live", llm: { provider: "openai", model: "gpt-5.6-sol" }, live: { provider: "openai", model: "gpt-live-1", adapter: "openai_live", voiceId: "coral" } },
            controls: { language: "en-US", backgroundSoundId: "none" },
          },
        });
      },
    }, "clone", { positionals: ["prs_live"], values: { "--stt-provider": "deepgram" } });

    expect(code).toBe(1);
    expect(writes).toBe(0);
    expect(failures).toEqual(["STT and TTS flags cannot be used with --speech-mode live."]);
  });

  it("clones with one authored control and keeps the reduced settings", async () => {
    const bodies: Record<string, unknown>[] = [];
    const code = await runPersonaActionCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile }, cwd: workspace.dir,
      out: () => undefined, fail: () => undefined,
      fetchImpl: async (_input, init) => {
        if ((init?.method ?? "GET") === "GET") return new JsonResponse({
          id: "prs_saved", name: "Saved", description: null, identityName: "Morgan", personality: "Direct.", parameterContract: [], language: null,
          settings: {
            models: { mode: "separate", llm: { provider: "openai", model: "gpt-4o" }, stt: { provider: "deepgram", model: "nova-3" }, tts: { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "alloy" } },
            controls: { language: "es-ES", backgroundSoundId: "cafe-v1", interruptionLevel: "occasional" },
          },
        });
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new JsonResponse({ id: "prs_saved" });
      },
    }, "clone", { positionals: ["prs_saved"], values: { "--background-sound": "rain-v1" } });

    expect(code).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      name: "Saved",
      models: { mode: "separate", llm: { provider: "openai", model: "gpt-4o" }, stt: { provider: "deepgram", model: "nova-3" }, tts: { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "alloy" } },
      controls: { language: "es-ES", backgroundSoundId: "rain-v1", interruptionLevel: "occasional" },
    });
  });

  it("deletes a custom persona through the public command", async () => {
    const requests: string[] = [];
    const code = await runPersonaActionCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile }, cwd: workspace.dir,
      out: () => undefined, fail: () => undefined,
      fetchImpl: async (_input, init) => {
        requests.push(init?.method ?? "GET");
        return new Response(null, { status: 204 });
      },
    }, "delete", { positionals: ["prs_saved"], values: {} });

    expect(code).toBe(0);
    expect(requests).toEqual(["DELETE"]);
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
