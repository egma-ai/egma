/** The raw persona catalog command, through its folder and HTTP seams. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runPersonasCommand } from "../src/commands/personas.ts";
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
    expect(lines).toContain(`project: ${PROJECT_ID}`);
    expect(lines).toContain(
      'persona: {"id":"prs_01K3XQ7M4E8YB2FVN0H9TZQWER","name":"Everyday caller"}',
    );
    expect(lines).toContain(
      'persona: {"id":"prs_01K3XQ7M4E8YB2FVN0H9TZQWES","name":"Impatient Rita"}',
    );
    expect(lines).toContain("personas: 2");
    expect(lines.at(-1)).toBe("status: listed");
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
    expect(lines).toContain("status: no-project");
    expect(lines).toContain(
      "stderr: This repository does not name its Egma project. Run egma connect here first.",
    );
  });
});
