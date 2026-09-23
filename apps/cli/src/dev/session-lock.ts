/**
 * One `egma agent dev` session per agent per machine.
 *
 * Two sessions for one agent would each write their own start URL and secret
 * into the same two connections, and simulations would reach whichever wrote
 * last. A lock file under the machine-local Egma folder, holding the session's
 * process id, refuses the second one. A left-over lock (see `lockIsStale`) is
 * taken over.
 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { lockHolder, lockIsStale } from "../platform/file-lock.ts";

export type SessionLock = {
  readonly file: string;
  /** Remove the lock if it is still this process's. */
  release(): Promise<void>;
};

export type HeldSession =
  | { readonly kind: "held"; readonly lock: SessionLock }
  | { readonly kind: "busy"; readonly pid: number | null; readonly file: string };

/** Session locks this process holds now. */
const heldHere = new Set<string>();

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
      const holder = await lockHolder(file);
      // This process's id on a lock it does not hold: an earlier process had the id.
      const reused = holder === process.pid && !heldHere.has(file);
      if (!reused && !(await lockIsStale(file))) return { kind: "busy", pid: holder, file };
      await rm(file, { force: true });
      continue;
    }
    heldHere.add(file);

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
          heldHere.delete(file);
          if ((await lockHolder(file)) === process.pid) await rm(file, { force: true });
        },
      },
    };
  }
  return { kind: "busy", pid: await lockHolder(file), file };
}
