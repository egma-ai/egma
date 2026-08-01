import { describe, expect, it } from "vitest";

import {
  CROCKFORD_ALPHABET,
  ID_BODY_LENGTH,
  ID_PREFIXES,
  idCheckPattern,
  isId,
  mintedAt,
  newId,
  prefixOf,
} from "./index.ts";

describe("an identifier", () => {
  it("is its prefix, an underscore, and 26 Crockford base32 characters", () => {
    for (const prefix of ID_PREFIXES) {
      const id = newId(prefix);
      expect(id).toMatch(new RegExp(idCheckPattern(prefix)));
      expect(id.slice(prefix.length + 1)).toHaveLength(ID_BODY_LENGTH);
    }
  });

  it("uses no character Crockford base32 excludes", () => {
    const body = newId("run").slice("run_".length);
    for (const character of body) {
      expect(CROCKFORD_ALPHABET).toContain(character);
    }
    expect(CROCKFORD_ALPHABET).not.toMatch(/[ILOU]/);
  });

  it("carries a prefix that identifies what it points at", () => {
    expect(prefixOf(newId("org"))).toBe("org");
    expect(prefixOf(newId("prj"))).toBe("prj");
    expect(prefixOf("prj_not-a-real-body")).toBeNull();
    expect(prefixOf("nope_0123456789ABCDEFGHJKMNPQ")).toBeNull();
  });

  it("belongs to exactly one prefix", () => {
    const id = newId("usr");
    expect(isId("usr", id)).toBe(true);
    expect(isId("org", id)).toBe(false);
  });

  it("is never repeated", () => {
    const minted = new Set<string>();
    for (let i = 0; i < 100_000; i += 1) minted.add(newId("run"));
    expect(minted.size).toBe(100_000);
  });
});

describe("sorting identifiers as plain strings", () => {
  it("puts two identifiers minted in order in that order", () => {
    const first = newId("run");
    const second = newId("run");
    expect(first < second).toBe(true);
  });

  it("holds for a burst minted inside a single millisecond", () => {
    const burst: string[] = [];
    const start = Date.now();
    while (Date.now() === start && burst.length < 50_000) {
      burst.push(newId("run"));
    }
    // The burst has to actually be a burst for this test to mean anything.
    expect(burst.length).toBeGreaterThan(100);
    expect([...burst].sort()).toEqual(burst);
  });

  it("holds across a millisecond boundary", async () => {
    const before = newId("run");
    await new Promise((resolve) => setTimeout(resolve, 3));
    const after = newId("run");
    expect(before < after).toBe(true);
    expect([after, before].sort()).toEqual([before, after]);
  });

  it("equals sorting by mint time", () => {
    const sample: string[] = [];
    for (let i = 0; i < 5_000; i += 1) sample.push(newId("run"));

    const byString = [...sample].sort();
    const byTime = [...sample].sort(
      (a, b) => mintedAt(a).getTime() - mintedAt(b).getTime(),
    );

    // Identical timestamps make the time sort non-strict, so compare the
    // timestamp sequences rather than the identifier sequences.
    expect(byString.map((id) => mintedAt(id).getTime())).toEqual(
      byTime.map((id) => mintedAt(id).getTime()),
    );
    expect(byString).toEqual(sample);
  });

  it("keeps the mint time readable out of the identifier itself", () => {
    const before = Date.now();
    const id = newId("run");
    const after = Date.now();
    expect(mintedAt(id).getTime()).toBeGreaterThanOrEqual(before);
    expect(mintedAt(id).getTime()).toBeLessThanOrEqual(after);
  });
});
