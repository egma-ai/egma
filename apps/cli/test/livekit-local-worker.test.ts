import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LIVEKIT_WORKER_READY_MARK,
  localLiveKitWorkerFileIssue,
  startLocalLiveKitWorker,
  windowsTreeKillArguments,
  windowsTreeKillFailed,
} from "../src/livekit/local-worker.ts";
import { liveKitKeyPair } from "../src/livekit/connect.ts";

const temporary: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((folder) => rm(folder, { recursive: true })));
});

async function helper(source: string): Promise<{ readonly dir: string; readonly file: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "egma-livekit-worker-"));
  temporary.push(dir);
  const file = path.join(dir, "helper.mjs");
  await writeFile(file, source, "utf8");
  return { dir, file };
}

describe("the local LiveKit worker", () => {
  it("checks launcher file compatibility without reading customer source", () => {
    expect(
      localLiveKitWorkerFileIssue("src/agent.py", "pyproject.toml"),
    ).toBeNull();
    expect(
      localLiveKitWorkerFileIssue("service/..worker.py", "service/requirements.txt"),
    ).toBeNull();
    expect(localLiveKitWorkerFileIssue("agent.py", "setup.cfg")).toContain(
      "supports only pyproject.toml or requirements.txt",
    );
    expect(
      localLiveKitWorkerFileIssue("agent.py", "service/requirements.txt"),
    ).toContain("must be in the LiveKit worker project directory");
  });

  it("keeps credentials in the child environment and redacts relayed output", async () => {
    const apiKey = "livekit-secret";
    const apiSecret = "livekit-secret-value";
    const made = await helper("");
    const record = path.join(made.dir, "record.json");
    await writeFile(
      made.file,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), url: process.env.LIVEKIT_URL, key: process.env.LIVEKIT_API_KEY, secret: process.env.LIVEKIT_API_SECRET }));`,
        `console.log(process.env.LIVEKIT_API_KEY + " " + process.env.LIVEKIT_API_SECRET);`,
        `console.log(${JSON.stringify(LIVEKIT_WORKER_READY_MARK)});`,
        'process.on("SIGTERM", () => process.exit(0));',
        "setInterval(() => undefined, 1000);",
      ].join("\n"),
      "utf8",
    );

    let output = "";
    const started = await startLocalLiveKitWorker({
      cwd: made.dir,
      url: "wss://project.livekit.cloud",
      credentials: liveKitKeyPair(apiKey, apiSecret),
      dispatchName: "appointment-scheduling",
      entrypoint: "src/agent.py",
      dependencyManifest: "pyproject.toml",
      signal: new AbortController().signal,
      helperFile: made.file,
      startupTimeoutMs: 1_000,
      onOutput: (chunk) => {
        output += chunk;
      },
    });

    expect(started.kind).toBe("started");
    if (started.kind !== "started") return;
    const seen = JSON.parse(await readFile(record, "utf8")) as {
      argv: string[];
      url: string;
      key: string;
      secret: string;
    };
    expect(seen).toEqual({
      argv: [
        "--cwd",
        made.dir,
        "--entrypoint",
        "src/agent.py",
        "--dependency-manifest",
        "pyproject.toml",
        "--dispatch-name",
        "appointment-scheduling",
      ],
      url: "wss://project.livekit.cloud",
      key: apiKey,
      secret: apiSecret,
    });
    expect(seen.argv.join(" ")).not.toContain(apiKey);
    expect(seen.argv.join(" ")).not.toContain(apiSecret);
    expect(output).toContain("<redacted> <redacted>");
    expect(output).not.toContain(apiKey);
    expect(output).not.toContain(apiSecret);
    expect(output).not.toContain("-value");

    await started.worker.stop();
    await expect(started.worker.ended).resolves.toEqual({ kind: "stopped" });
  });

  it("reports a helper that exits before worker registration", async () => {
    const made = await helper('process.stderr.write("lk is unavailable\\n"); process.exit(2);\n');
    let output = "";
    const started = await startLocalLiveKitWorker({
      cwd: made.dir,
      url: "wss://project.livekit.cloud",
      credentials: liveKitKeyPair("API-key", "secret-value"),
      dispatchName: "appointment-scheduling",
      entrypoint: "agent.py",
      dependencyManifest: "requirements.txt",
      signal: new AbortController().signal,
      helperFile: made.file,
      startupTimeoutMs: 1_000,
      onOutput: (chunk) => {
        output += chunk;
      },
    });

    expect(started).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("before it registered"),
    });
    expect(started).toMatchObject({
      reason: expect.stringContaining("lk is unavailable"),
    });
    expect(output).toContain("lk is unavailable");
  });

  it("uses Windows' recursive process-tree command for graceful and forced stops", () => {
    expect(windowsTreeKillArguments(4321, "SIGTERM")).toEqual([
      "/pid",
      "4321",
      "/t",
    ]);
    expect(windowsTreeKillArguments(4321, "SIGKILL")).toEqual([
      "/pid",
      "4321",
      "/t",
      "/f",
    ]);
    expect(windowsTreeKillFailed({ status: 0 })).toBe(false);
    expect(windowsTreeKillFailed({ status: 1 })).toBe(true);
    expect(windowsTreeKillFailed({ status: null })).toBe(true);
    expect(windowsTreeKillFailed({ status: 0, error: new Error("not found") })).toBe(true);
  });
});
