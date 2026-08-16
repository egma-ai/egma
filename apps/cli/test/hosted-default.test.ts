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
import { makeWorkspace, NO_DEFAULT_PLATFORM } from "./support/workspace.ts";

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

  /**
   * The fence above scans text, and text is a proxy. **This is the guard.**
   *
   * What actually keeps the suite away from hosted egma is that every workspace
   * hands the command a closed port in the built-in address's place. A check
   * that resolved a platform without going through a workspace would dial
   * production, and the scan above would still pass — it names no host, because
   * it names no address at all. So the mechanism is asserted, not assumed.
   */
  it("is stood aside by every workspace, which is what really keeps the suite off it", async () => {
    const workspace = await makeWorkspace();
    try {
      expect(workspace.env()[TEST_DEFAULT_URL_VARIABLE]).toBe(NO_DEFAULT_PLATFORM);
      expect(defaultPlatformUrlIn(workspace.env())).toBe(NO_DEFAULT_PLATFORM);
      expect(defaultPlatformUrlIn(workspace.env())).not.toBe(DEFAULT_PLATFORM_URL);
      // And a check that names its own platform still never reaches the real
      // one: what it names replaces the stand-in, not the fence.
      expect(
        defaultPlatformUrlIn(workspace.env({ [TEST_DEFAULT_URL_VARIABLE]: "http://own.example" })),
      ).toBe("http://own.example");
    } finally {
      await workspace.remove();
    }
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
   * The seam is not a way for a developer to select a platform, and it does not
   * behave like one: it stands in for the last step of the order rather than
   * joining it, so both steps above it still win over whatever it holds.
   */
  it("is still the last step, whatever the seam holds", () => {
    const seam = defaultPlatformUrlIn({
      [TEST_DEFAULT_URL_VARIABLE]: "http://stood-in.example",
    });

    expect(
      selectPlatform({
        flag: "http://named-on-this-command.example",
        binding: null,
        fallback: seam,
      }),
    ).toEqual({ url: "http://named-on-this-command.example", source: "--url" });

    expect(
      selectPlatform({ flag: null, binding: "http://committed.example", fallback: seam }),
    ).toEqual({ url: "http://committed.example", source: "binding" });
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
