/**
 * Check literal public-asset references found by the source scan. jsdom does
 * not fetch images, so component tests can miss broken paths. This covers
 * the configured source directories and reference pattern, not dynamic URLs.
 * Unused public files are allowed, including convention-based browser assets.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const PUBLIC = path.join(WEB, "public");

/** Where the application's own source lives, excluding what it did not write. */
const SOURCE = ["app", "ui", "lib"];

const SKIP = new Set(["node_modules", ".next", "dist", "build"]);

function sourceFiles(from: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const here = path.join(from, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(here));
    else if (/\.tsx?$/u.test(entry.name)) found.push(here);
  }
  return found;
}

/**
 * A root-relative path to a file with an extension, which is what a reference
 * into `public/` looks like and what an API route or a page address does not:
 * `/v1/graders` and `/projects/prj_1/tests` carry no dot in their last
 * segment, so they never reach the check below.
 */
const ASSET = /["'`](\/[A-Za-z0-9._/-]*\/[A-Za-z0-9._-]+\.[A-Za-z0-9]{2,4})["'`]/gu;

/** What the application would serve out of `public/`, never out of a route. */
const SERVED_FROM_PUBLIC = /\.(svg|png|jpg|jpeg|gif|webp|ico|avif|woff2?|mp3|wav)$/iu;

describe("what the application asks the browser to fetch", () => {
  it("names only files that public/ actually holds", () => {
    const missing: string[] = [];

    for (const file of SOURCE.flatMap((where) =>
      sourceFiles(path.join(WEB, where)),
    )) {
      const source = readFileSync(file, "utf8");
      for (const [, referenced] of source.matchAll(ASSET)) {
        const asset = referenced as string;
        if (!SERVED_FROM_PUBLIC.test(asset)) continue;

        const on = path.join(PUBLIC, asset);
        const there = ((): boolean => {
          try {
            return statSync(on).isFile();
          } catch {
            return false;
          }
        })();

        if (!there) {
          missing.push(`${path.relative(WEB, file)} names ${asset}`);
        }
      }
    }

    expect(
      missing.sort(),
      "these pages point at a file public/ does not hold, so the browser gets " +
        "a 404 and the page draws a blank where the picture goes — which no " +
        "jsdom render and no browser walk can see:\n" +
        missing.join("\n"),
    ).toEqual([]);
  });

  it("finds the brand asset the public authentication Brand draws", () => {
    // A guard that matches nothing passes for ever. The public Brand is where
    // the full logo belongs; the signed-in shell uses the compact mark.
    const authentication = readFileSync(path.join(WEB, "app", "ui.tsx"), "utf8");
    expect(authentication).toContain("export function Brand()");
    const marks = [...authentication.matchAll(ASSET)]
      .map(([, referenced]) => referenced as string)
      .filter((asset) => SERVED_FROM_PUBLIC.test(asset));

    expect(
      marks.length,
      "the public Brand names no asset for this test to hold",
    ).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(statSync(path.join(PUBLIC, mark)).isFile()).toBe(true);
    }
  });
});
