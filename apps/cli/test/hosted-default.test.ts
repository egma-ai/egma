/**
 * The address a repository with nothing configured reaches, and the fence that
 * keeps the suite away from it.
 *
 * Everything else about the unbound path is proven against a platform standing
 * in for that address. This file is the one place the real one is named, so
 * that "the shipped default is hosted egma" is asserted once, and so that a
 * check which quietly started signing in to production would fail here first.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLATFORM_URL,
  defaultPlatformUrlIn,
  selectPlatform,
  TEST_DEFAULT_URL_VARIABLE,
} from "../src/platform/credentials.ts";

const CLI = fileURLToPath(new URL("..", import.meta.url));

/** Every file under a folder, skipping what is built rather than written. */
async function filesUnder(folder: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const here = path.join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(here)));
    else found.push(here);
  }
  return found;
}

describe("the built-in address", () => {
  it("ships hosted egma", () => {
    expect(DEFAULT_PLATFORM_URL).toBe("https://app.egma.ai");
  });

  /**
   * The fence, and the reason for it: a check that dialled the real hosted
   * platform would sign in to production, create real organizations there, and
   * fail whenever the network did. Every behavioral check stands a platform of
   * its own in that address's place, so the name itself belongs in exactly one
   * source file and one check.
   */
  it("is named nowhere a check could dial it", async () => {
    const hosted = new URL(DEFAULT_PLATFORM_URL).host;
    const written = [
      ...(await filesUnder(path.join(CLI, "test"))),
      ...(await filesUnder(path.join(CLI, "smoke"))),
    ];
    expect(written.length).toBeGreaterThan(20);

    const naming: string[] = [];
    for (const file of written) {
      const held = await readFile(file, "utf8").catch(() => "");
      if (held.includes(hosted)) naming.push(path.relative(CLI, file));
    }
    expect(naming).toEqual(["test/hosted-default.test.ts"]);
  });

  it("is replaced by the test seam whenever the seam names one", () => {
    expect(defaultPlatformUrlIn({})).toBe(DEFAULT_PLATFORM_URL);
    expect(defaultPlatformUrlIn({ [TEST_DEFAULT_URL_VARIABLE]: "  " })).toBe(
      DEFAULT_PLATFORM_URL,
    );
    expect(
      defaultPlatformUrlIn({ [TEST_DEFAULT_URL_VARIABLE]: " http://stood-in.example " }),
    ).toBe("http://stood-in.example");
  });

  /**
   * The seam is not a second way for a developer to select a platform, and it
   * does not behave like one: `EGMA_URL` sits above the built-in address in the
   * order, so a shell that sets both is a shell that uses `EGMA_URL`.
   */
  it("is still the last step, whatever the seam holds", () => {
    expect(
      selectPlatform({
        flag: null,
        env: "http://named-for-this-shell.example",
        binding: null,
        fallback: defaultPlatformUrlIn({
          [TEST_DEFAULT_URL_VARIABLE]: "http://stood-in.example",
        }),
      }),
    ).toEqual({ url: "http://named-for-this-shell.example", source: "EGMA_URL" });
  });

  /**
   * Not documented and not stable — the same treatment `-- <command>` already
   * carries. A seam a developer found written down would become a seam they
   * used, and then a promise egma has to keep. `--help` is checked where every
   * other `--help` claim is, against the built command.
   */
  it("has a seam that is written down nowhere a developer reads", async () => {
    for (const readme of [
      path.join(CLI, "README.md"),
      path.join(CLI, "..", "..", "README.md"),
    ]) {
      expect(await readFile(readme, "utf8"), readme).not.toContain(
        TEST_DEFAULT_URL_VARIABLE,
      );
    }
  });
});
