import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  A_PRODUCTION_WEB_BUILD,
  holdWebOutputLock,
  releaseAfter,
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

/** Every temporary directory a case asked for, so all of them are swept. */
const scratch: string[] = [];

async function aLockPath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "egma-web-output-lock-"));
  scratch.push(directory);
  return path.join(directory, ".next.lock");
}

/** A process id that certainly belongs to nobody: one that has already gone. */
async function aFinishedProcessId(): Promise<number> {
  const gone = spawn(process.execPath, ["-e", ""]);
  await new Promise((finished) => gone.on("exit", finished));
  return gone.pid ?? 0;
}

afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
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
        token: "the-holder-that-went",
        // Any value: the number answers to nobody, so nothing is compared.
        startedAt: "1",
      }),
    );

    const build = holdWebOutputLock(A_PRODUCTION_WEB_BUILD, lockPath);

    expect(JSON.parse(await readFile(lockPath, "utf8")).who).toBe(
      A_PRODUCTION_WEB_BUILD,
    );
    build.release();
  });
});

describe("several processes racing for it at once", () => {
  /**
   * The one case the six above cannot make: contention.
   *
   * Every sequential test passes against a lock that excludes nobody, because
   * a lock is only wrong in the moment two processes want it. So this starts
   * real processes, on a path nothing has touched, and asks the only question
   * that matters — was anybody ever inside it at the same time as somebody
   * else. `support/race-for-the-lock.ts` is the child, and it witnesses with a
   * marker file of its own rather than with the lock it is testing.
   */
  it("lets exactly one of them in at a time", async () => {
    const lockPath = await aLockPath();
    const marker = path.join(path.dirname(lockPath), "inside");
    const RACERS = 4;
    const ATTEMPTS = 40;

    const raced = await Promise.all(
      Array.from({ length: RACERS }, async () => {
        const child = spawn(process.execPath, [
          path.join(import.meta.dirname, "support/race-for-the-lock.ts"),
          lockPath,
          marker,
          String(ATTEMPTS),
        ]);
        let said = "";
        child.stdout.on("data", (chunk: Buffer) => {
          said += chunk.toString("utf8");
        });
        const code = await new Promise((exited) => child.on("exit", exited));
        expect(code, `a racer exited with ${code}`).toBe(0);
        return JSON.parse(said) as {
          acquired: number;
          violations: readonly string[];
        };
      }),
    );

    expect(raced.flatMap((racer) => racer.violations)).toEqual([]);
    // A lock nobody could ever take would also report no violations.
    expect(
      raced.reduce((total, racer) => total + racer.acquired, 0),
    ).toBeGreaterThan(RACERS);
    expect(existsSync(lockPath)).toBe(false);
  }, 60_000);
});

describe("a process id the operating system has given to somebody else", () => {
  /**
   * The way a lock used to become permanent.
   *
   * A holder that is killed leaves its file behind. Operating systems reuse
   * process numbers, so sooner or later something unrelated is given that
   * number, `kill(pid, 0)` answers yes, and every build and browser test after
   * that is refused by a process that never held anything. The lock records
   * when its holder started as well as which number it had, so a number
   * wearing a different start time is a different process.
   *
   * The number below is this very process, so it is genuinely running — which
   * is the whole point. Only the start time says it is not the holder.
   */
  it("is not mistaken for the holder that has gone", async () => {
    const lockPath = await aLockPath();
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        who: THE_REAL_BROWSER_TEST,
        since: new Date().toISOString(),
        token: "the-killed-holder",
        startedAt: "17", // Long before this process, whatever the machine says.
      }),
    );

    const build = holdWebOutputLock(A_PRODUCTION_WEB_BUILD, lockPath);

    expect(JSON.parse(await readFile(lockPath, "utf8")).who).toBe(
      A_PRODUCTION_WEB_BUILD,
    );
    build.release();
  });

  /**
   * The same defect, reached through a lock file this code did not write.
   *
   * A `.next.lock` left by the version before start times were recorded carries
   * a process number and nothing to confirm the number is still that process.
   * Reading the missing field as an empty string and comparing it with another
   * empty string is how two unknowns became a match — and how an unrelated
   * process wearing a recycled number became the holder forever.
   *
   * Refused, not stolen. Unreadable is not abandoned, and a record this version
   * cannot verify is unreadable in every way that matters.
   */
  it("is refused, not matched, when the lock predates start times", async () => {
    const shapes = [
      { token: "no-startedAt-at-all" },
      { token: "an-empty-startedAt", startedAt: "" },
    ];

    for (const shape of shapes) {
      const lockPath = await aLockPath();
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid, // Genuinely running, which is what made it stick.
          who: THE_REAL_BROWSER_TEST,
          since: new Date().toISOString(),
          ...shape,
        }),
      );

      expect(() =>
        holdWebOutputLock(A_PRODUCTION_WEB_BUILD, lockPath),
      ).toThrow(/cannot be read, or does not carry the identity/);

      // And it is still there: refusing must not become a second way to steal.
      expect(JSON.parse(await readFile(lockPath, "utf8")).token).toBe(
        shape.token,
      );
    }
  });

  it("still refuses a holder that really is this process", async () => {
    const lockPath = await aLockPath();
    const held = holdWebOutputLock(THE_REAL_BROWSER_TEST, lockPath);

    expect(() => holdWebOutputLock(A_PRODUCTION_WEB_BUILD, lockPath)).toThrow(
      new RegExp(THE_REAL_BROWSER_TEST),
    );

    held.release();
  });
});

describe("handing the directory back", () => {
  /**
   * `kill` is a signal, not a departure.
   *
   * The child below takes a moment to go after it is asked to, which is what a
   * Next development server closing its watchers does — and it is still writing
   * `apps/web/.next` for all of that moment. So the question is not whether the
   * lock is eventually released; it is whether the lock was still held at the
   * instant the child died. That is read off the file system from inside the
   * child's own `exit` event, not inferred afterwards.
   */
  it("keeps the lock until the process writing the directory has gone", async () => {
    const lockPath = await aLockPath();
    const lock = holdWebOutputLock(THE_REAL_BROWSER_TEST, lockPath);

    const child = spawn(process.execPath, [
      "-e",
      // Polite, but not quick: exactly the shape that made this a defect.
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 400));" +
        "setInterval(() => {}, 1000);",
    ]);
    await new Promise((running) => child.once("spawn", running));

    let heldWhenItDied: boolean | undefined;
    child.once("exit", () => {
      heldWhenItDied = existsSync(lockPath);
    });

    await releaseAfter(child, lock);

    expect(heldWhenItDied, "the lock was already free when the child died").toBe(
      true,
    );
    expect(existsSync(lockPath)).toBe(false);
  }, 20_000);

  it("stops insisting on politeness, so one wedged process cannot hold a suite open", async () => {
    const lockPath = await aLockPath();
    const lock = holdWebOutputLock(THE_REAL_BROWSER_TEST, lockPath);

    const deaf = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    ]);
    await new Promise((running) => deaf.once("spawn", running));

    const started = Date.now();
    await releaseAfter(deaf, lock, 300);

    expect(deaf.exitCode !== null || deaf.signalCode !== null).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(lockPath)).toBe(false);
  }, 20_000);
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
