/** Ctrl-C stops a repository push with the shell-standard exit code. */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import process from "node:process";

import { expect, it } from "vitest";

import {
  createEgmaFolder,
  EMPTY_CONFIG,
  folderPathsIn,
  serializeSuiteManifest,
} from "../src/folder/egma-folder.ts";
import { serializeTestFile } from "../src/folder/test-file.ts";
import { aTestFile, blocking } from "./support/test-file.ts";
import { CLI_ENTRY, makeWorkspace } from "./support/workspace.ts";

const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
const SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";

function sendJson(answer: ServerResponse, status: number, body: unknown): void {
  if (answer.destroyed) return;
  answer.writeHead(status, { "content-type": "application/json" });
  answer.end(JSON.stringify(body));
}

it("turns Ctrl-C during push into process exit 130", async () => {
  let interrupt: (() => void) | undefined;
  const server = createServer((request, answer) => {
    request.resume();
    if (
      request.method === "POST" &&
      request.url?.startsWith("/v1/repository/change-set?") === true
    ) {
      interrupt?.();
      setTimeout(() => {
        sendJson(answer, 503, { error: "still-running" });
      }, 50);
      return;
    }
    sendJson(answer, 404, { error: "not-found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const workspace = await makeWorkspace();
  await workspace.signIn(url);
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      platform: { origin: url },
      project: { id: PROJECT_ID, name: "Northside" },
      agents: [],
    },
  });
  const suite = path.join(folderPathsIn(workspace.dir).tests, "release");
  await mkdir(suite);
  await writeFile(
    path.join(suite, "suite.yaml"),
    serializeSuiteManifest({ id: SUITE_ID, name: "Release" }),
  );
  await writeFile(
    path.join(suite, "books-a-visit.md"),
    serializeTestFile(
      aTestFile({
        name: "Books a visit",
        scenario: "The caller asks for Tuesday.",
        expectedBehaviors: blocking("The agent books Tuesday."),
      }),
    ),
  );

  try {
    const result = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stderr: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_ENTRY, "push"], {
        cwd: workspace.dir,
        env: workspace.env(),
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      interrupt = () => child.kill("SIGINT");

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("egma push did not stop after Ctrl-C"));
      }, 5_000);
      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal, stderr });
      });
    });

    expect(result.signal).toBeNull();
    expect(result.code).toBe(130);
    expect(result.stderr).toContain(
      "The command was interrupted before it received a complete answer.",
    );
    expect(result.stderr).toContain("Run egma pull before you try again.");
  } finally {
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      workspace.remove(),
    ]);
  }
});
