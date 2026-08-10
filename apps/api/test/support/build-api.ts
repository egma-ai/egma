/**
 * Builds the API before the checks that run it as a real deployment's process.
 *
 * Almost every API test drives the routes in process, and those need no build.
 * One does not: the platform-binding acceptance check starts two whole egmas as
 * separate processes, because two platforms cannot share one process's database
 * connection — and what a process starts is the built entry point, not the
 * sources beside it. The build is incremental, so this is nearly free after the
 * first run.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function setup(): Promise<void> {
  const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
  await run("node", [path.join(root, "node_modules/typescript/bin/tsc"), "-b", "apps/api"], {
    cwd: root,
  });
}
