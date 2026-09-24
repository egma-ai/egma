/**
 * The address a repository with nothing configured reaches, and the fence that
 * keeps the suite away from it.
 *
 * Everything else about the unbound path is proven against a platform standing
 * in for that address. This file is the one place the real one is named, so
 * that "the shipped default is hosted egma" is asserted once, and so that a
 * check which quietly started signing in to production would fail here first.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_PLATFORM_URL } from "../src/platform/credentials.ts";

describe("the built-in address", () => {
  it("ships hosted egma", () => {
    expect(DEFAULT_PLATFORM_URL).toBe("https://app.egma.ai");
  });
});
