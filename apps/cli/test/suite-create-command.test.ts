import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSuiteCreateCommand } from "../src/commands/suite.ts";
import { EMPTY_CONFIG, createEgmaFolder } from "../src/folder/egma-folder.ts";
import { MAX_PORTABLE_COMPONENT_LENGTH } from "../src/folder/portable-path.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const URL = "https://egma.example";
const SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";
const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";

let workspace: Workspace;

class JsonResponse extends Response {
  constructor(body?: string | null, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    super(body, { ...init, headers });
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

afterEach(async () => {
  await workspace.remove();
});

function platform(calls: string[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const at = new globalThis.URL(url);
    if (at.pathname === "/v1/test-suites" && init?.method === "POST") {
      calls.push(`body ${String(init.body)}`);
      return new JsonResponse(
        JSON.stringify({ id: SUITE_ID, projectId: PROJECT_ID, name: "Release contract" }),
        { status: 201 },
      );
    }
    return new JsonResponse(JSON.stringify({ message: "unexpected" }), { status: 404 });
  };
}

describe("egma suite create", () => {
  it.each([
    ["Windows device name", "cOn"],
    ["overlong component", "a".repeat(MAX_PORTABLE_COMPONENT_LENGTH + 1)],
  ])("does no product write for a %s", async (_case, directory) => {
    const calls: string[] = [];
    const failed: string[] = [];

    const code = await runSuiteCreateCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      directory,
      name: "This display name stays unlimited",
      out: () => undefined,
      fail: (line) => failed.push(line),
      fetchImpl: platform(calls),
    });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(failed.join("\n")).toMatch(/Windows device name|at most 120/i);
  });
});
