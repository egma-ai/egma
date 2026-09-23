/**
 * Lock files beside the CLI's machine-local files.
 *
 * A lock is a file created with `wx` that holds its owner's process id. It is
 * left over, and may be removed, when it was written before this machine last
 * started, when its process is gone, or when that process id now belongs to a
 * program that is not Node. A lock whose owner still runs is waited for.
 */

import { spawnSync } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import path from "node:path";
import process from "node:process";

/** How long an empty lock file is taken for one being written right now. */
const FRESH_EMPTY_LOCK_MS = 5_000;

/** Slack for the boot time, which the clock and uptime give only roughly. */
const BOOT_SLACK_MS = 60_000;

/** Whether a process with this id is running (on this machine, as any user). */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a running process is a Node runtime; undefined where that cannot be told. */
export function processRunsNode(pid: number): boolean | undefined {
  if (process.platform === "win32") return undefined;
  const answer = spawnSync("ps", ["-p", String(pid), "-o", "comm="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (answer.status !== 0 || typeof answer.stdout !== "string") return undefined;
  const command = path.basename(answer.stdout.trim()).toLowerCase();
  if (command === "") return undefined;
  return command === path.basename(process.execPath).toLowerCase() || command.includes("node");
}

/** When this machine last started, in milliseconds since the epoch. */
export function bootTimeMs(): number {
  return Date.now() - uptime() * 1_000;
}

/** The process id a lock file holds, or null when it holds none. */
export async function lockHolder(file: string): Promise<number | null> {
  const text = await readFile(file, "utf8").catch(() => "");
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Whether a lock file is left over and may be removed. */
export async function lockIsStale(file: string, emptyAfterMs = FRESH_EMPTY_LOCK_MS): Promise<boolean> {
  const held = await stat(file).catch(() => undefined);
  if (held === undefined) return true;
  if (held.mtimeMs < bootTimeMs() - BOOT_SLACK_MS) return true;
  const pid = await lockHolder(file);
  if (pid === null) return Date.now() - held.mtimeMs > emptyAfterMs;
  if (!processIsAlive(pid)) return true;
  if (pid === process.pid) return false;
  return processRunsNode(pid) === false;
}

/**
 * Run `work` while holding `lock`. A left-over lock is removed; a living
 * holder is waited for up to `waitMs`, then `busy()` is thrown.
 */
export async function whileFileLocked<T>(
  lock: string,
  work: () => Promise<T>,
  busy: () => Error,
  waitMs = 5_000,
): Promise<T> {
  const until = Date.now() + waitMs;
  // The same holder is judged again only after a second, not on every poll.
  let judged: { readonly pid: number | null; readonly at: number } | null = null;
  for (;;) {
    try {
      await writeFile(lock, `${String(process.pid)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const holder = await lockHolder(lock);
      if (judged === null || judged.pid !== holder || Date.now() - judged.at > 1_000) {
        judged = { pid: holder, at: Date.now() };
        if (await lockIsStale(lock)) {
          await rm(lock, { force: true });
          continue;
        }
      }
      if (Date.now() > until) throw busy();
      await new Promise((resume) => setTimeout(resume, 50));
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}
