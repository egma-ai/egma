/** Build the same entry point the grader container runs before its test lane. */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function setup(): Promise<void> {
  const root = path.resolve(
    fileURLToPath(new URL("../../../..", import.meta.url)),
  );
  await run(
    "node",
    [path.join(root, "node_modules/typescript/bin/tsc"), "-b", "apps/grader"],
    { cwd: root },
  );
}
