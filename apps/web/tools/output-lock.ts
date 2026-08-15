import { spawn } from "node:child_process";
import { openSync, readFileSync, unlinkSync, writeSync, closeSync } from "node:fs";
import path from "node:path";

/**
 * One writer at a time for `apps/web/.next`.
 *
 * Two things in this repository write that directory. `next build` writes the
 * production build into it, and the real-browser test starts `next dev`, which
 * compiles into the same place. Run both in one checkout at once and each ends
 * up reading half of the other's output: the build ships pages it did not
 * compile, or the browser test fails somewhere deep inside Next with a message
 * about a missing chunk, and neither failure names the cause.
 *
 * Pointing the two at different output directories does work and costs more
 * than it buys — Next writes the directory it is using back into the checked-in
 * `tsconfig.json` and `next-env.d.ts`, so running the suite would leave the
 * repository dirty. So instead there is one lock file beside the directory, and
 * whoever is second is **refused with a sentence** rather than left to find out.
 *
 * Refused, not queued. A build that waited would look like a build that had
 * hung, and the honest answer to "these two cannot run at once" is to say so
 * while somebody is still watching the terminal.
 *
 * The lock is per checkout, which is exactly the scope of the problem: two
 * worktrees have two `.next` directories and never collide.
 */

/** The two holders, named once so both sides say the same words. */
export const A_PRODUCTION_WEB_BUILD = "a production web build";
export const THE_REAL_BROWSER_TEST = "the real-browser test";

/** Beside the output directory rather than inside it: `next build` clears it. */
export const WEB_OUTPUT_LOCK = path.join(
  import.meta.dirname,
  "..",
  ".next.lock",
);

export type WebOutputLock = {
  /** Safe to call twice; the second time does nothing. */
  release(): void;
};

type Holder = {
  readonly pid: number;
  readonly who: string;
  readonly since: string;
};

function holderIn(lockPath: string): Holder | undefined {
  try {
    const read: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof read !== "object" || read === null) return undefined;
    const { pid, who, since } = read as Partial<Holder>;
    if (typeof pid !== "number" || typeof who !== "string") return undefined;
    return { pid, who, since: typeof since === "string" ? since : "" };
  } catch {
    // No lock file, or one half-written by a process that died mid-write.
    return undefined;
  }
}

/** Whether the process that wrote the lock is still there to release it. */
function stillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (whyNot) {
    // EPERM means somebody else's process, which is still a running one.
    return (whyNot as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the lock, or refuse and say who has it.
 *
 * `wx` is the whole of the mutual exclusion: the file is created and claimed in
 * one operation the kernel does not interleave, so two processes racing for it
 * cannot both win.
 */
export function holdWebOutputLock(
  who: string,
  lockPath: string = WEB_OUTPUT_LOCK,
): WebOutputLock {
  const claim = (): number => openSync(lockPath, "wx");

  let handle: number;
  try {
    handle = claim();
  } catch (whyNot) {
    if ((whyNot as NodeJS.ErrnoException).code !== "EEXIST") throw whyNot;

    const holder = holderIn(lockPath);
    if (holder !== undefined && stillRunning(holder.pid)) {
      throw new Error(
        `${who} cannot start: ${holder.who} is writing ${path.dirname(lockPath)}/.next ` +
          `(process ${holder.pid}, since ${holder.since}). A production web build and ` +
          "the real-browser test write the same generated web output, so they cannot " +
          `run at once in one checkout. Wait for it to finish, or delete ${lockPath} ` +
          "if nothing is running.",
        { cause: whyNot },
      );
    }

    // Nobody is behind it: a run that was killed before it could tidy up.
    unlinkSync(lockPath);
    handle = claim();
  }

  const holder: Holder = {
    pid: process.pid,
    who,
    since: new Date().toISOString(),
  };
  writeSync(handle, JSON.stringify(holder));
  closeSync(handle);

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        unlinkSync(lockPath);
      } catch {
        // Already gone, which is the state this asks for.
      }
    },
  };
}

export type GuardedRun = {
  readonly who: string;
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly lockPath?: string;
};

/**
 * Run a command holding the lock, and answer with the code it exited on.
 *
 * The refusal happens before the command is spawned, so a build that cannot run
 * has not half-run. The lock is given back however the command ends.
 */
export async function runHoldingWebOutputLock(
  run: GuardedRun,
): Promise<number> {
  const lock = holdWebOutputLock(run.who, run.lockPath ?? WEB_OUTPUT_LOCK);
  try {
    return await new Promise<number>((finished, failed) => {
      const child = spawn(run.command, [...run.argv], {
        cwd: run.cwd ?? process.cwd(),
        stdio: "inherit",
      });
      child.on("error", failed);
      child.on("exit", (code, signal) => {
        finished(code ?? (signal === null ? 1 : 128));
      });
    });
  } finally {
    lock.release();
  }
}
