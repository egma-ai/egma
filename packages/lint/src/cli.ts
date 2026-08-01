import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { check, format } from "./index.ts";

/**
 * Runs in `pnpm build`, so a change that breaks the data-access boundary fails
 * the build that introduces it.
 */

async function repositoryRoot(): Promise<string> {
  let directory = import.meta.dirname;
  for (;;) {
    try {
      await access(path.join(directory, "pnpm-workspace.yaml"));
      return directory;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw new Error("could not find the repository root");
      }
      directory = parent;
    }
  }
}

const root = process.argv[2] ?? (await repositoryRoot());
const violations = await check(root);

if (violations.length > 0) {
  process.stderr.write(
    `${violations.length} violation${violations.length === 1 ? "" : "s"} of the data-access boundary:\n\n${format(violations)}\n\n`,
  );
  process.exit(1);
}
