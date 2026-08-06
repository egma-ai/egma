/**
 * Builds the CLI before the tests that drive it as a real command.
 *
 * The tests that prove what `npx egma` does have to run what `npx egma` runs —
 * the built entry point, not the sources beside it — so the suite builds it
 * once up front. The build is incremental, so this is nearly free after the
 * first run.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function setup(): Promise<void> {
  const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
  await run("node", [path.join(root, "node_modules/typescript/bin/tsc"), "-b", "apps/cli"], {
    cwd: root,
  });
}
