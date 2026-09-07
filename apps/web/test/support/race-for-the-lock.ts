import { openSync, closeSync, unlinkSync } from "node:fs";
import process from "node:process";

import { holdWebOutputLock } from "../../tools/output-lock.ts";

/**
 * Compete for a lock and report acquisitions and overlaps on stdout. Inside
 * the critical section, create a separate marker with wx so overlap detection
 * does not depend on the lock implementation.
 *
 * Usage: node race-for-the-lock.ts <lock path> <marker path> <attempts>
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
