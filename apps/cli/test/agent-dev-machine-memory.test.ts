/**
 * This machine's memory of its `egma agent dev` connections: entries are
 * merged by platform + agent + modality, and a lock is broken only when the
 * process that holds it is gone.
 */

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  machineConnectionFor,
  readMachineConnections,
  rememberMachineConnections,
} from "../src/dev/machine-connections.ts";
import { lockIsStale, processIsAlive } from "../src/dev/session-lock.ts";

let folder: string;
let file: string;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "egma-dev-memory-"));
  file = path.join(folder, "dev-connections.json");
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid as number;
}

describe("this machine's dev connections", () => {
  it("merges entries by platform, agent and modality, readable by this user only", async () => {
    await rememberMachineConnections(file, [
      { platformUrl: "https://egma.example", agentId: "agt_a", modality: "voice", connectionId: "con_1" },
    ]);
    await rememberMachineConnections(file, [
      { platformUrl: "https://egma.example", agentId: "agt_a", modality: "chat", connectionId: "con_2" },
      { platformUrl: "http://localhost:3101", agentId: "agt_a", modality: "voice", connectionId: "con_3" },
    ]);
    await rememberMachineConnections(file, [
      { platformUrl: "https://egma.example", agentId: "agt_a", modality: "voice", connectionId: "con_4" },
    ]);

    const entries = await readMachineConnections(file);
    expect(machineConnectionFor(entries, { platformUrl: "https://egma.example", agentId: "agt_a", modality: "voice" })).toBe(
      "con_4",
    );
    expect(machineConnectionFor(entries, { platformUrl: "https://egma.example", agentId: "agt_a", modality: "chat" })).toBe(
      "con_2",
    );
    expect(machineConnectionFor(entries, { platformUrl: "http://localhost:3101", agentId: "agt_a", modality: "voice" })).toBe(
      "con_3",
    );
    expect(machineConnectionFor(entries, { platformUrl: "https://egma.example", agentId: "agt_b", modality: "voice" })).toBeNull();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("breaks a lock whose process is gone", async () => {
    await writeFile(`${file}.lock`, `${String(deadPid())}\n`, "utf8");

    await rememberMachineConnections(file, [
      { platformUrl: "https://egma.example", agentId: "agt_a", modality: "voice", connectionId: "con_1" },
    ]);

    expect(await readMachineConnections(file)).toHaveLength(1);
    await expect(readFile(`${file}.lock`, "utf8")).rejects.toThrow();
  });

  it("waits for a living holder and does not break its lock", async () => {
    await mkdir(folder, { recursive: true });
    await writeFile(`${file}.lock`, `${String(process.pid)}\n`, "utf8");

    await expect(
      rememberMachineConnections(file, [
        { platformUrl: "https://egma.example", agentId: "agt_a", modality: "voice", connectionId: "con_1" },
      ]),
    ).rejects.toThrow(/held .*dev-connections\.json\.lock for too long/u);
    expect(await readFile(`${file}.lock`, "utf8")).toBe(`${String(process.pid)}\n`);
  }, 15_000);

  it("tells a living process from a gone one", async () => {
    expect(processIsAlive(process.pid)).toBe(true);
    expect(processIsAlive(deadPid())).toBe(false);
    expect(processIsAlive(0)).toBe(false);
    await writeFile(path.join(folder, "empty.lock"), "", "utf8");
    expect(await lockIsStale(path.join(folder, "empty.lock"))).toBe(false);
    expect(await lockIsStale(path.join(folder, "empty.lock"), -1)).toBe(true);
  });
});
