import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withInitLock } from "../src/receipt.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function repository(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "egma-init-lock-"));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, ".egma"));
  return directory;
}

describe("the init lock", () => {
  it("recovers a lock left by a process that no longer exists", async () => {
    const root = await repository();
    const lock = path.join(root, ".egma", "init.lock");
    await writeFile(lock, "2147483647\n", "utf8");

    await expect(withInitLock(root, async () => "applied")).resolves.toBe(
      "applied",
    );
    await expect(readFile(lock, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not take a lock owned by a running process", async () => {
    const root = await repository();
    const lock = path.join(root, ".egma", "init.lock");
    await writeFile(lock, `${process.pid}\n`, "utf8");

    await expect(withInitLock(root, async () => undefined)).rejects.toThrow(
      "owned by a running process",
    );
    await expect(readFile(lock, "utf8")).resolves.toBe(`${process.pid}\n`);
  });
});
