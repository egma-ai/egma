import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  A_PRODUCTION_WEB_BUILD,
  holdWebOutputLock,
  runHoldingWebOutputLock,
  THE_REAL_BROWSER_TEST,
} from "../tools/output-lock.ts";

/**
 * The one thing that must never happen twice at once in a checkout.
 *
 * A production web build and the real-browser test both write
 * `apps/web/.next`, and a run where both did is a build that half belongs to
 * the other one. Everything below is real: a real lock file, real processes,
 * and a real command run under the lock.
 */

let scratch: string | undefined;

async function aLockPath(): Promise<string> {
  scratch = await mkdtemp(path.join(tmpdir(), "egma-web-output-lock-"));
  return path.join(scratch, ".next.lock");
}

/** A process id that certainly belongs to nobody: one that has already gone. */
async function aFinishedProcessId(): Promise<number> {
  const gone = spawn(process.execPath, ["-e", ""]);
  await new Promise((finished) => gone.on("exit", finished));
  return gone.pid ?? 0;
}

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("holding the web output directory", () => {
  it("refuses a second holder, and says who has it", async () => {
    const lockPath = await aLockPath();
    const held = holdWebOutputLock(THE_REAL_BROWSER_TEST, lockPath);

    expect(() => holdWebOutputLock(A_PRODUCTION_WEB_BUILD, lockPath)).toThrow(
      new RegExp(THE_REAL_BROWSER_TEST),
    );

    held.release();
  });

  it("lets the next one in once the first has released it", async () => {
    const lockPath = await aLockPath();

    holdWebOutputLock(THE_REAL_BROWSER_TEST, lockPath).release();
    const build = holdWebOutputLock(A_PRODUCTION_WEB_BUILD, lockPath);

    expect(existsSync(lockPath)).toBe(true);
    build.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("takes over a lock left behind by a process that has gone", async () => {
    const lockPath = await aLockPath();
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: await aFinishedProcessId(),
        who: THE_REAL_BROWSER_TEST,
        since: new Date().toISOString(),
      }),
    );

    const build = holdWebOutputLock(A_PRODUCTION_WEB_BUILD, lockPath);

    expect(JSON.parse(await readFile(lockPath, "utf8")).who).toBe(
      A_PRODUCTION_WEB_BUILD,
    );
    build.release();
  });
});

describe("running a command under the lock", () => {
  const wrote = (marker: string): readonly string[] => [
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
  ];

  it("runs the command and gives the lock back afterwards", async () => {
    const lockPath = await aLockPath();
    const marker = path.join(path.dirname(lockPath), "ran");

    const code = await runHoldingWebOutputLock({
      who: A_PRODUCTION_WEB_BUILD,
      command: process.execPath,
      argv: wrote(marker),
      lockPath,
    });

    expect(code).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("never starts the command while somebody else holds it", async () => {
    const lockPath = await aLockPath();
    const marker = path.join(path.dirname(lockPath), "ran");
    const test = holdWebOutputLock(THE_REAL_BROWSER_TEST, lockPath);

    await expect(
      runHoldingWebOutputLock({
        who: A_PRODUCTION_WEB_BUILD,
        command: process.execPath,
        argv: wrote(marker),
        lockPath,
      }),
    ).rejects.toThrow(new RegExp(THE_REAL_BROWSER_TEST));

    expect(existsSync(marker)).toBe(false);
    test.release();
  });

  it("answers with what the command answered, and still gives the lock back", async () => {
    const lockPath = await aLockPath();

    const code = await runHoldingWebOutputLock({
      who: A_PRODUCTION_WEB_BUILD,
      command: process.execPath,
      argv: ["-e", "process.exit(3)"],
      lockPath,
    });

    expect(code).toBe(3);
    expect(existsSync(lockPath)).toBe(false);
  });
});
