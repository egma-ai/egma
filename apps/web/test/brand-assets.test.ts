/**
 * Every file under `public/` that the application names, held against what is
 * actually there.
 *
 * **The one class of fault nothing else in this suite can see.** A component
 * test renders in jsdom, which fetches no images; the real-browser walk reads
 * a link by its accessible name rather than by whether the picture behind it
 * arrived; and Next's `<Image>` asks for a file at request time, so a missing
 * one is a 404 in the network panel and a blank rectangle on the page. Every
 * test stays green and every page in the product is wrong.
 *
 * A brand-asset migration exposed this gap: source could keep naming a deleted
 * image while component tests stayed green. This file is the guard that would
 * have reported the missing file. The public authentication Brand gives the
 * scan a real asset to hold; the signed-in shell intentionally starts with
 * project context and has no logo.
 *
 * It reads the source rather than a list, so an asset added tomorrow is
 * covered the day it is written, and it deliberately says nothing about which
 * files `public/` holds: an unused file is not a fault, and demanding that
 * every asset be referenced would fail on a favicon a browser asks for by
 * convention.
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
 * `/api/graders` and `/projects/prj_1/tests` carry no dot in their last
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
    // the logo belongs; the signed-in shell starts with project context.
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
