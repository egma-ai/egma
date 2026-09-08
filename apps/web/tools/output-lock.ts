import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
 * Serialize writers to this checkout's .next directory. A build and browser
 * test cannot share generated output; a live holder causes an immediate refusal.
 *
 * Write complete metadata before claiming the path with an exclusive hard link.
 * Refuse unreadable locks. Serialize abandoned-lock cleanup with a second file
 * and verify the recorded holder again before removal. Release only the matching
 * token. Record PID and process start time to detect PID reuse.
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
  /**
   * What the operating system says about when process {@link pid} started —
   * the half of a holder's identity a recycled number cannot bring with it.
   *
   * **Never empty, and never absent.** A record without it is not a record this
   * code can vouch for, and it is refused rather than read: an absent value
   * that compares equal to another absent value is how a lock written by an
   * older version of this file would have matched any process at all.
   */
  readonly startedAt: string;
};

/**
 * How long a process that was asked to stop is given before it is made to.
 * A Next development server takes a moment to close its watchers; a wedged one
 * must not hold a suite open for longer than a person will wait.
 */
export const STOP_MILLISECONDS = 10_000;

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
    const { pid, who, since, token, startedAt } = found as Partial<Holder>;
    if (typeof pid !== "number" || typeof who !== "string") {
      return { state: "unreadable" };
    }
    // Two unknowns are not a match. A lock file written before this field
    // existed carries a process number and nothing that can confirm the number
    // is still the same process, so it is neither evidence that the holder
    // lives nor evidence that it has gone — which is exactly the state
    // `unreadable` already names, and gets the same refusal.
    if (typeof startedAt !== "string" || startedAt === "") {
      return { state: "unreadable" };
    }
    return {
      state: "held",
      holder: {
        pid,
        who,
        since: typeof since === "string" ? since : "",
        token: typeof token === "string" ? token : "",
        startedAt,
      },
    };
  } catch {
    return { state: "unreadable" };
  }
}

/** Whether anything at all answers to this number. */
function numberInUse(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (whyNot) {
    // EPERM means somebody else's process, which is still a running one.
    return (whyNot as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read process start identity from Linux /proc, falling back to ps. Acquisition
 * also reads this process's identity. Unknown identity prevents reclaiming a live
 * holder and prevents this process from creating a new lock.
 */
function processIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command's own name sits in brackets and may hold spaces and
    // brackets of its own, so the fields are counted from after the last one.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // `state` is the third field of the line, so `starttime`, the
    // twenty-second, is nineteen along from there.
    const startedAt = fields[19];
    if (startedAt !== undefined && startedAt !== "") return startedAt;
  } catch {
    // No /proc on this machine, or no such process any more.
  }

  const asked = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (asked.status !== 0) return undefined;
  const said = (asked.stdout ?? "").trim();
  return said === "" ? undefined : said;
}

/**
 * Whether the process that wrote the lock is still there to release it.
 *
 * Both halves have to agree. A number nothing answers to is gone; a number
 * something else has been given since is gone too, and that second case is the
 * one that used to strand a lock forever.
 */
function stillHolding(holder: Holder): boolean {
  if (!numberInUse(holder.pid)) return false;

  const nowRunning = processIdentity(holder.pid);
  // Something answers to the number, but this machine will not say what. That
  // is not a match — it is an unknown, and the safe unknown is the one that
  // costs a person a deleted file rather than a corrupted build.
  if (nowRunning === undefined) return true;
  return nowRunning === holder.startedAt;
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
 * Serialize abandoned-lock removal with an exclusive cleanup file. Recheck
 * the holder token, PID, and liveness before unlinking. Return false when
 * another process is clearing so the caller retries.
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
      !stillHolding(now.holder)
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
/**
 * This process's own identity, or a refusal to lock at all.
 *
 * Every lock file this code writes carries one, because a record without it
 * cannot be verified by anybody — including by this process, at release. A
 * machine with neither `/proc` nor `ps` cannot tell two processes apart, and
 * the honest thing to say there is so, rather than to write a lock that will
 * quietly match whatever is given the number next.
 */
function identityOfThisProcess(): string {
  const startedAt = processIdentity(process.pid);
  if (startedAt === undefined) {
    throw new Error(
      "this machine will not say when a process started — neither /proc nor " +
        "ps answered — so the web output lock cannot tell one process from " +
        "another and will not pretend to.",
    );
  }
  return startedAt;
}

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
    startedAt: identityOfThisProcess(),
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
        `the lock file at ${lockPath} cannot be read, or does not carry the ` +
          "identity this version records, so who holds the output directory " +
          "is unknown — and a lock that cannot be read is not the same as one " +
          "nobody is behind, so it is never cleared automatically.",
      );
    }

    if (stillHolding(now.holder)) {
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

/** Whether something finished before the clock ran out. */
function before(finished: Promise<void>, milliseconds: number): Promise<boolean> {
  return new Promise((answered) => {
    const clock = setTimeout(() => {
      answered(false);
    }, milliseconds);
    const stop = (): void => {
      clearTimeout(clock);
      answered(true);
    };
    finished.then(stop, stop);
  });
}

/**
 * Send SIGTERM and wait for exit, then try SIGKILL with another bounded wait.
 * This can return after the second timeout even without a confirmed exit.
 */
export async function stopped(
  child: ChildProcess,
  within: number = STOP_MILLISECONDS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const gone = new Promise<void>((exited) => {
    child.once("exit", () => {
      exited();
    });
  });

  child.kill("SIGTERM");
  if (await before(gone, within)) return;

  child.kill("SIGKILL");
  await before(gone, within);
}

/**
 * Give the output directory back — but not before whoever was writing it has
 * gone.
 *
 * This is the whole of a holder's shutdown, in one call, because the order is
 * the thing being promised and an order kept in two places is an order half
 * kept.
 */
export async function releaseAfter(
  child: ChildProcess | undefined,
  lock: WebOutputLock | undefined,
  within: number = STOP_MILLISECONDS,
): Promise<void> {
  if (child !== undefined) await stopped(child, within);
  lock?.release();
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
