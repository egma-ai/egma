import { access, readdir } from "node:fs/promises";
import path from "node:path";

import { chromium, type Browser } from "playwright-core";

/**
 * A real Chrome, found rather than downloaded.
 *
 * `playwright-core` deliberately ships no browser, which is the right trade for
 * a repository whose test suite is mostly Postgres and ClickHouse: two browser
 * tests are not worth a three-hundred-megabyte install on every checkout. The
 * cost of that trade is this file — the library knows exactly one place to look
 * and names the build it was compiled against, so on a machine that has a
 * browser under a different build number it reports that nothing is installed
 * while a working Chrome sits beside it.
 *
 * So: the browser somebody already has, in the order of how likely it is to be
 * the one they meant.
 *
 * 1. **A real Chrome installed on the machine**, which is what a developer
 *    running the suite on their laptop has.
 * 2. **The build Playwright downloaded for itself**, if the version in the
 *    lockfile is the version that downloaded it.
 * 3. **Any Chromium under `PLAYWRIGHT_BROWSERS_PATH`**, which is how a CI image
 *    and a prepared container carry one: the directory is Playwright's own
 *    layout, and the only thing wrong with it is the build number in the name.
 *
 * Nothing here is a fallback to a stub. If none of the three is there, the
 * launch fails and the test says so, because a browser test that quietly did
 * not use a browser would prove nothing at all.
 */

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(
    () => true,
    () => false,
  );
}

/** Playwright's own directory layout, read rather than computed from a version. */
async function chromiumAlreadyHere(): Promise<string | undefined> {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root === undefined || root === "") return undefined;

  const entries = await readdir(root).catch(() => [] as string[]);
  const candidates = [
    // Some images leave a symlink at a stable name beside the versioned ones.
    path.join(root, "chromium"),
    ...entries
      .filter((entry) => entry.startsWith("chromium"))
      .flatMap((entry) => [
        path.join(root, entry, "chrome-linux", "chrome"),
        path.join(root, entry, "chrome-linux", "headless_shell"),
        path.join(
          root,
          entry,
          "chrome-headless-shell-linux64",
          "chrome-headless-shell",
        ),
      ]),
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

export async function openBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    // No Chrome on the machine. Playwright's own, then.
  }

  try {
    return await chromium.launch({ headless: true });
  } catch (whyNot) {
    const found = await chromiumAlreadyHere();
    if (found === undefined) throw whyNot;
    return chromium.launch({ headless: true, executablePath: found });
  }
}
