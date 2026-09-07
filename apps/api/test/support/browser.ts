import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { chromium, type Browser } from "playwright-core";

/**
 * Find Chrome without downloading it: prefer an installed Chrome, then the
 * Playwright-managed executable, then Chromium under PLAYWRIGHT_BROWSERS_PATH.
 * If none is available, fail browser startup instead of substituting a stub.
 */

/**
 * A file, rather than merely a path that resolves.
 *
 * `chromium` beside the versioned directories is a symlink on some images and a
 * *directory* on others, and `executablePath` handed a directory fails deep
 * inside the launcher with a message about the browser having closed. Asking
 * whether it is a file — through `stat`, so a symlink is judged by what it
 * points at — rules that out here, where the error can still say what is wrong.
 */
async function isExecutableFile(candidate: string): Promise<boolean> {
  return stat(candidate).then(
    (found) => found.isFile(),
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
    if (await isExecutableFile(candidate)) return candidate;
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
    if (found !== undefined) {
      return chromium.launch({ headless: true, executablePath: found });
    }

    // Playwright's own message here advises `npx playwright install`, which is
    // advice for a repository that depends on `playwright`. This one depends on
    // `playwright-core` and deliberately downloads nothing, so following it
    // would install a browser under a directory nothing above looks in. Say
    // what actually works instead, and keep the launcher's reason underneath.
    throw new Error(
      "no browser found. Install Google Chrome, or set " +
        "PLAYWRIGHT_BROWSERS_PATH to a directory holding a Playwright " +
        "Chromium.",
      { cause: whyNot },
    );
  }
}
