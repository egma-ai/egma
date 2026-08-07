/**
 * A platform to try the wizard against, by hand.
 *
 * The end-to-end check walks the wizard with nobody at the keyboard; this is
 * the same platform without the harness, for a person who wants to walk it
 * themselves. Behind it: a real egma API for the login and the key it mints
 * (`docker compose up`, or point `EGMA_REAL_API` at yours), the fixture for
 * the endpoints the public API has not shipped, and a stand-in simulator so a
 * run started by hand receives verdicts — every one of them `passed`, because
 * nothing here conducts a real simulation.
 *
 * Start it, leave it running, and run the wizard with the address it prints,
 * from whatever repository holds the voice agent you want walked.
 *
 * Like `support/half-real-platform.ts`, this file dies the day the public API
 * serves agents, tests and runs for real.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gradeEveryRun } from "../test/support/grading.ts";
import { startHalfRealPlatform } from "./support/half-real-platform.ts";

const api = process.env.EGMA_REAL_API ?? "http://localhost:3100";
const platform = await startHalfRealPlatform(api);
const grading = gradeEveryRun(platform);

const bin = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../dist/bin.js");

console.log("");
console.log("  The platform is up: real sign-in behind it, the fixture for the rest.");
console.log("");
console.log("  From the repository you want walked, in another terminal:");
console.log("");
console.log(`    EGMA_URL=${platform.url} EGMA_HOME=$HOME/.egma-tryout \\`);
console.log(`      node ${bin}`);
console.log("");
console.log("  EGMA_HOME keeps your real credentials file out of it. Ctrl-C here");
console.log("  shuts the platform down; nothing it held survives.");

process.on("SIGINT", () => {
  grading.stop();
  void platform.close().then(() => process.exit(0));
});
await new Promise(() => {});
