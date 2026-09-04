import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSuiteCreateCommand } from "../src/commands/suite.ts";
import {
  EMPTY_CONFIG,
  createEgmaFolder,
  folderPathsIn,
} from "../src/folder/egma-folder.ts";
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
    ["another Windows device name", "PrN"],
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

  it("creates the platform suite before it writes the stable local manifest", async () => {
    const calls: string[] = [];
    const out: string[] = [];
    const failed: string[] = [];

    const code = await runSuiteCreateCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      directory: "release-contract",
      name: "Release contract",
      out: (line) => out.push(line),
      fail: (line) => failed.push(line),
      fetchImpl: platform(calls),
    });

    expect(code, `${failed.join("\n")}\n${calls.join("\n")}`).toBe(0);
    expect(failed).toEqual([]);
    expect(calls).toEqual([
      `POST ${URL}/v1/test-suites?projectId=${PROJECT_ID}`,
      'body {"name":"Release contract"}',
    ]);
    expect(out.join("\n")).toContain(SUITE_ID);
    expect(out.join("\n")).toContain("egma/tests/release-contract");
    expect(out.join("\n")).not.toMatch(/^(?:suite|name|directory|status):/mu);
    expect(
      await readFile(
        path.join(folderPathsIn(workspace.dir).tests, "release-contract", "suite.yaml"),
        "utf8",
      ),
    ).toBe(`id: ${SUITE_ID}\nname: Release contract\n`);
  });

  it("does no platform write when any existing suite is malformed", async () => {
    const broken = path.join(folderPathsIn(workspace.dir).tests, "broken");
    await mkdir(broken);
    await writeFile(path.join(broken, "suite.yaml"), "name: Broken\n");
    const calls: string[] = [];
    const failed: string[] = [];

    const code = await runSuiteCreateCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      directory: "new-suite",
      name: "New suite",
      out: () => undefined,
      fail: (line) => failed.push(line),
      fetchImpl: platform(calls),
    });

    expect(code).toBe(1);
    expect(calls.filter((call) => call.startsWith("POST "))).toEqual([]);
    expect(failed.join("\n")).toMatch(/repository is invalid/i);
  });

  it("prints the stable suite id and pull recovery when the local manifest write fails", async () => {
    const calls: string[] = [];
    const out: string[] = [];
    const failed: string[] = [];
    const root = path.join(folderPathsIn(workspace.dir).tests, "release-contract");

    const code = await runSuiteCreateCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      directory: "release-contract",
      name: "Release contract",
      out: (line) => out.push(line),
      fail: (line) => failed.push(line),
      fetchImpl: platform(calls),
      writeManifest: async () => {
        throw new Error("the disk is read-only");
      },
    });

    expect(code, `${failed.join("\n")}\n${calls.join("\n")}`).toBe(1);
    expect(calls).toEqual([
      `POST ${URL}/v1/test-suites?projectId=${PROJECT_ID}`,
      'body {"name":"Release contract"}',
    ]);
    expect(out.join("\n")).toContain(SUITE_ID);
    expect(out.join("\n")).not.toMatch(/^(?:suite|name|directory|status):/mu);
    expect(failed.join("\n")).toContain(`Egma created suite ${SUITE_ID}`);
    expect(failed.join("\n")).toContain(
      "Run egma pull to recover this remote-only Suite.",
    );
    await expect(readFile(path.join(root, "suite.yaml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
