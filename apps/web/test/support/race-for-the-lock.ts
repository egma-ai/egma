import { openSync, closeSync, unlinkSync } from "node:fs";
import process from "node:process";

import { holdWebOutputLock } from "../../tools/output-lock.ts";

/**
 * One of several processes all trying to hold the same lock at once.
 *
 * The lock is a claim about what happens between processes, so nothing but
 * processes can test it. This is the child: it races for the lock over and over
 * and reports, on stdout, how often it got in and how often somebody else was
 * already inside when it did.
 *
 * **The witness is a second file, not the lock.** Inside the critical section
 * this creates a marker with `wx` — the kernel's own answer to "does this path
 * already exist" — so the check does not lean on the code under test to decide
 * whether the code under test worked. A marker that is already there means two
 * processes were inside at the same moment, which is the whole thing the lock
 * exists to prevent.
 *
 *   node race-for-the-lock.ts <lock path> <marker path> <attempts>
 */

const [lockPath, markerPath, attempts] = process.argv.slice(2);
if (lockPath === undefined || markerPath === undefined || attempts === undefined) {
  throw new Error("usage: race-for-the-lock.ts <lock> <marker> <attempts>");
}

/** Busy rather than asleep: a held lock has to be held for a real moment. */
function hold(milliseconds: number): void {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    // Spinning on purpose.
  }
}

const violations: string[] = [];
let acquired = 0;
let refused = 0;

for (let attempt = 0; attempt < Number(attempts); attempt += 1) {
  let lock;
  try {
    lock = holdWebOutputLock(`racer ${process.pid}`, lockPath);
  } catch {
    // Somebody else has it, which is the lock working.
    refused += 1;
    hold(1);
    continue;
  }

  acquired += 1;
  let marked = false;
  try {
    closeSync(openSync(markerPath, "wx"));
    marked = true;
  } catch {
    violations.push(
      `process ${process.pid} was inside the lock on attempt ${attempt} while somebody else was`,
    );
  }

  hold(1 + (attempt % 4));

  if (marked) {
    try {
      unlinkSync(markerPath);
    } catch {
      // Another process inside the section removed it. Already a violation.
    }
  }
  lock.release();
}

process.stdout.write(JSON.stringify({ acquired, refused, violations }));
