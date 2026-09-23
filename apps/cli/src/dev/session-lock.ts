/**
 * One `egma agent dev` session per agent per machine.
 *
 * Two sessions for one agent would each write their own start URL and secret
 * into the same two connections, and simulations would reach whichever wrote
 * last. A lock file under the machine-local Egma folder, holding the session's
 * process id, refuses the second one. A lock whose process is gone is taken over.
 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/** How long an empty lock file is taken for one being written right now. */
const FRESH_EMPTY_LOCK_MS = 5_000;

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

/** The process id a lock file holds, or null when it holds none. */
export async function lockHolder(file: string): Promise<number | null> {
  const text = await readFile(file, "utf8").catch(() => "");
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Whether a lock file is left over: its process is gone, or it names none and
 * is older than a write takes.
 */
export async function lockIsStale(file: string, emptyAfterMs = FRESH_EMPTY_LOCK_MS): Promise<boolean> {
  const pid = await lockHolder(file);
  if (pid !== null) return !processIsAlive(pid);
  const held = await stat(file).catch(() => undefined);
  return held === undefined || Date.now() - held.mtimeMs > emptyAfterMs;
}

export type SessionLock = {
  readonly file: string;
  /** Remove the lock if it is still this process's. */
  release(): Promise<void>;
};

export type HeldSession =
  | { readonly kind: "held"; readonly lock: SessionLock }
  | { readonly kind: "busy"; readonly pid: number | null };

/** Where the session lock for one platform and agent lives. */
export function sessionLockFile(folder: string, platformUrl: string, agentId: string): string {
  const key = createHash("sha256").update(`${platformUrl}\n${agentId}`, "utf8").digest("hex").slice(0, 32);
  return path.join(folder, "dev-sessions", `${key}.lock`);
}

/** Take the session lock for one platform and agent, or say who holds it. */
export async function holdSessionLock(
  folder: string,
  platformUrl: string,
  agentId: string,
): Promise<HeldSession> {
  const file = sessionLockFile(folder, platformUrl, agentId);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const mine = `${String(process.pid)}\n`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(file, mine, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      if (!(await lockIsStale(file))) return { kind: "busy", pid: await lockHolder(file) };
      await rm(file, { force: true });
      continue;
    }

    const onExit = (): void => {
      try {
        rmSync(file, { force: true });
      } catch {
        // Nothing more can be done while the process exits.
      }
    };
    process.once("exit", onExit);
    return {
      kind: "held",
      lock: {
        file,
        async release() {
          process.off("exit", onExit);
          if ((await lockHolder(file)) === process.pid) await rm(file, { force: true });
        },
      },
    };
  }
  return { kind: "busy", pid: await lockHolder(file) };
}
