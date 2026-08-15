import path from "node:path";
import process from "node:process";

import {
  A_PRODUCTION_WEB_BUILD,
  runHoldingWebOutputLock,
} from "./output-lock.ts";

/**
 * `next build`, holding the lock on the output directory it writes.
 *
 * This is what `pnpm --filter @egma/web build` runs, so the guard is on the
 * command everybody already uses rather than on a second one somebody has to
 * remember. `output-lock.ts` says what the guard is for.
 */

const WEB = path.join(import.meta.dirname, "..");

runHoldingWebOutputLock({
  who: A_PRODUCTION_WEB_BUILD,
  command: path.join(WEB, "node_modules/.bin/next"),
  argv: ["build", ...process.argv.slice(2)],
  cwd: WEB,
}).then(
  (code) => {
    process.exit(code);
  },
  (whyNot: unknown) => {
    process.stderr.write(
      `${whyNot instanceof Error ? whyNot.message : String(whyNot)}\n`,
    );
    process.exit(1);
  },
);
