import { describe, expect, it } from "vitest";

import { isId, mintedAt, newId } from "./index.ts";

describe("an identifier", () => {
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
  it("holds for identifiers minted inside a single millisecond", () => {
    const minted: string[] = [];
    for (let i = 0; i < 50_000; i += 1) minted.push(newId("run"));

    const byMillisecond = new Map<number, string[]>();
    for (const id of minted) {
      const millisecond = mintedAt(id).getTime();
      const group = byMillisecond.get(millisecond) ?? [];
      group.push(id);
      byMillisecond.set(millisecond, group);
    }

    const largest = [...byMillisecond.values()].sort(
      (a, b) => b.length - a.length,
    )[0];
    // The group has to be a real crowd for this test to mean anything: within
    // one millisecond the timestamp bits are identical, so only the tail keeps
    // the order.
    expect(largest?.length ?? 0).toBeGreaterThan(100);
    expect([...largest!].sort()).toEqual(largest);
    expect([...minted].sort()).toEqual(minted);
  });

  it("keeps the mint time readable out of the identifier itself", () => {
    const before = Date.now();
    const id = newId("run");
    const after = Date.now();
    expect(mintedAt(id).getTime()).toBeGreaterThanOrEqual(before);
    expect(mintedAt(id).getTime()).toBeLessThanOrEqual(after);
  });
});
