import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acceptRepositoryFileClaim } from "../src/wizard/repository-file-claim.ts";

const temporary: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const made = await mkdtemp(path.join(tmpdir(), prefix));
  temporary.push(made);
  return made;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("a file path reported by the coding agent", () => {
  it("accepts a regular file inside the repository without reading its contents", async () => {
    const repository = await temporaryDirectory("egma-file-claim-");
    await mkdir(path.join(repository, "src"));
    await writeFile(path.join(repository, "src", "agent.py"), "not Python at all\n");

    await expect(
      acceptRepositoryFileClaim(repository, "src/agent.py", "the LiveKit worker"),
    ).resolves.toEqual({ kind: "accepted", file: path.join("src", "agent.py") });
  });

  it("accepts an ordinary file whose name begins with two dots", async () => {
    const repository = await temporaryDirectory("egma-file-claim-");
    await writeFile(path.join(repository, "..worker.py"), "ordinary file\n");

    await expect(
      acceptRepositoryFileClaim(repository, "..worker.py", "the LiveKit worker"),
    ).resolves.toEqual({ kind: "accepted", file: "..worker.py" });
  });

  it("refuses a path outside the repository", async () => {
    const repository = await temporaryDirectory("egma-file-claim-");
    const outside = await temporaryDirectory("egma-file-outside-");
    await writeFile(path.join(outside, "agent.py"), "outside\n");

    await expect(
      acceptRepositoryFileClaim(
        repository,
        path.join("..", path.basename(outside), "agent.py"),
        "the LiveKit worker",
      ),
    ).resolves.toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("outside this repository"),
    });
  });

  it("refuses a repository symlink whose target is outside", async () => {
    const repository = await temporaryDirectory("egma-file-claim-");
    const outside = await temporaryDirectory("egma-file-outside-");
    await writeFile(path.join(outside, "agent.py"), "outside\n");
    await symlink(path.join(outside, "agent.py"), path.join(repository, "agent.py"));

    await expect(
      acceptRepositoryFileClaim(repository, "agent.py", "the LiveKit worker"),
    ).resolves.toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("points outside this repository"),
    });
  });

  it("does not accept an environment file as an integration path", async () => {
    const repository = await temporaryDirectory("egma-file-claim-");
    await writeFile(path.join(repository, ".env.example"), "EGMA_API_KEY=example\n");

    await expect(
      acceptRepositoryFileClaim(repository, ".env.example", "the dependency manifest"),
    ).resolves.toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("environment file"),
    });
  });

  it("does not accept a symlink to an environment file", async () => {
    const repository = await temporaryDirectory("egma-file-claim-");
    await writeFile(path.join(repository, ".env.local"), "EGMA_API_KEY=secret\n");
    await symlink(".env.local", path.join(repository, "requirements.txt"));

    await expect(
      acceptRepositoryFileClaim(
        repository,
        "requirements.txt",
        "the dependency manifest",
      ),
    ).resolves.toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("environment file"),
    });
  });
});
