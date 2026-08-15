import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
 *
 * ## What makes it actually exclusive
 *
 * Three rules, and each one is a way this was wrong before.
 *
 * 1. **The lock file is never seen empty.** Its content is written to a private
 *    path first and the file appears at the lock's own path already holding it,
 *    through `link`, which the kernel refuses when the path exists. Creating an
 *    empty file and filling it in afterwards leaves a window in which the lock
 *    exists but says nothing — and a lock that says nothing was read as one
 *    nobody was behind, and stolen. Four processes racing found that window in
 *    24 rounds out of 30.
 * 2. **Unreadable is not abandoned.** A lock whose content cannot be understood
 *    is refused, never cleared. The only honest thing to say about a file this
 *    code did not write is that somebody has to look at it.
 * 3. **Clearing an abandoned lock is itself serialised, and giving it back is
 *    checked.** Two processes that both decide a lock is abandoned must not
 *    both remove it and both claim — the second would remove the first's fresh
 *    lock. So clearing happens behind a second, briefly-held file, and
 *    `release` removes the lock only when the token in it is still the token it
 *    wrote.
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

/**
 * How long to keep looking while another process is midway through clearing an
 * abandoned lock. That work is a few file operations, so this is generous by
 * three orders of magnitude and still imperceptible.
 */
const ATTEMPTS = 50;
const PAUSE_MILLISECONDS = 2;

export type WebOutputLock = {
  /** Safe to call twice; the second time does nothing. */
  release(): void;
};

type Holder = {
  readonly pid: number;
  readonly who: string;
  readonly since: string;
  /** This holding, told apart from every other. Checked before release. */
  readonly token: string;
};

/** A pause without a promise, because taking the lock is a synchronous act. */
function pause(milliseconds: number): void {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

type Reading =
  | { readonly state: "held"; readonly holder: Holder }
  | { readonly state: "gone" }
  | { readonly state: "unreadable" };

function read(lockPath: string): Reading {
  let text: string;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch (whyNot) {
    if ((whyNot as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "gone" };
    }
    return { state: "unreadable" };
  }

  try {
    const found: unknown = JSON.parse(text);
    if (typeof found !== "object" || found === null) {
      return { state: "unreadable" };
    }
    const { pid, who, since, token } = found as Partial<Holder>;
    if (typeof pid !== "number" || typeof who !== "string") {
      return { state: "unreadable" };
    }
    return {
      state: "held",
      holder: {
        pid,
        who,
        since: typeof since === "string" ? since : "",
        token: typeof token === "string" ? token : "",
      },
    };
  } catch {
    return { state: "unreadable" };
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
 * Put the lock there, already saying who holds it, or answer that somebody
 * beat us to it.
 *
 * `link` is the whole of the mutual exclusion: it creates a second name for a
 * file that already has its content, in one operation the kernel refuses if the
 * name is taken. Nothing ever observes a half-made lock, because the file is
 * complete before it has the lock's name at all.
 */
function claim(lockPath: string, holder: Holder): boolean {
  const written = `${lockPath}.writing-${holder.token}`;
  writeFileSync(written, JSON.stringify(holder));
  try {
    linkSync(written, lockPath);
    return true;
  } catch (whyNot) {
    if ((whyNot as NodeJS.ErrnoException).code !== "EEXIST") throw whyNot;
    return false;
  } finally {
    try {
      unlinkSync(written);
    } catch {
      // Already gone. The lock, if it was made, is a name of its own now.
    }
  }
}

/**
 * Remove a lock nobody is behind — one process at a time.
 *
 * The second file is what makes this safe. Only the process that creates it may
 * clear, and while it exists no other process can be inside this function, so
 * the read and the removal below cannot be split by anybody. Nothing else can
 * change the lock in that moment either: claiming is `link`, which fails while
 * the file is there.
 *
 * Answers whether the caller may now try to claim. `false` means somebody else
 * is doing this, and the caller should look again rather than assume anything.
 */
function clearAbandoned(lockPath: string, abandoned: Holder): boolean {
  const clearing = `${lockPath}.clearing`;
  try {
    closeSync(openSync(clearing, "wx"));
  } catch (whyNot) {
    if ((whyNot as NodeJS.ErrnoException).code !== "EEXIST") throw whyNot;
    return false;
  }

  try {
    const now = read(lockPath);
    if (
      now.state === "held" &&
      now.holder.token === abandoned.token &&
      now.holder.pid === abandoned.pid &&
      !stillRunning(now.holder.pid)
    ) {
      unlinkSync(lockPath);
    }
    return true;
  } finally {
    try {
      unlinkSync(clearing);
    } catch {
      // Nothing else removes this, so there is nothing to lose here.
    }
  }
}

function refusal(who: string, lockPath: string, because: string): Error {
  return new Error(
    `${who} cannot start: ${because} A production web build and the ` +
      "real-browser test write the same generated web output, so they cannot " +
      `run at once in one checkout. Wait for it to finish, or delete ` +
      `${lockPath} if nothing is running.`,
  );
}

/**
 * Take the lock, or refuse and say who has it.
 */
export function holdWebOutputLock(
  who: string,
  lockPath: string = WEB_OUTPUT_LOCK,
): WebOutputLock {
  const token = randomUUID();
  const mine: Holder = {
    pid: process.pid,
    who,
    since: new Date().toISOString(),
    token,
  };

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (claim(lockPath, mine)) {
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          // Only ours. A lock this process no longer holds belongs to whoever
          // holds it now, and removing it would hand the directory to a third.
          const now = read(lockPath);
          if (now.state !== "held" || now.holder.token !== token) return;
          try {
            unlinkSync(lockPath);
          } catch {
            // Already gone, which is the state this asks for.
          }
        },
      };
    }

    const now = read(lockPath);
    if (now.state === "gone") continue; // Released between the two lines.

    if (now.state === "unreadable") {
      throw refusal(
        who,
        lockPath,
        `the lock file at ${lockPath} cannot be read, so who holds the ` +
          "output directory is unknown — and a lock that cannot be read is " +
          "not the same as one nobody is behind, so it is never cleared " +
          "automatically.",
      );
    }

    if (stillRunning(now.holder.pid)) {
      throw refusal(
        who,
        lockPath,
        `${now.holder.who} is writing ${path.dirname(lockPath)}/.next ` +
          `(process ${now.holder.pid}, since ${now.holder.since}).`,
      );
    }

    // Nobody is behind it: a run that was killed before it could tidy up.
    if (!clearAbandoned(lockPath, now.holder)) pause(PAUSE_MILLISECONDS);
  }

  throw refusal(
    who,
    lockPath,
    `${lockPath} could not be taken after ${ATTEMPTS} attempts, which means ` +
      "another process has been clearing an abandoned lock for far longer " +
      "than that takes.",
  );
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
