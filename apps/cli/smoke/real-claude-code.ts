/**
 * The smoke check: one task on the real Claude Code adapter, on this machine.
 *
 * Nothing here is scripted or faked. egma starts the adapter the agent registry
 * names, drives a real task on the developer's own Claude login, and the check
 * passes only if the run finishes after exactly one keystroke — which is the
 * proof that no permission question was ever raised, because a question would
 * have left the wizard waiting for a second one that never comes.
 *
 * Run it with: node apps/cli/smoke/real-claude-code.ts
 * It needs Claude Code logged in, and it needs the network the first time.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runInTerminal } from "../test/support/pty.ts";

const CLI_ENTRY = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

const MANIFEST = `${JSON.stringify(
  {
    name: "egma-smoke-repo",
    version: "1.0.0",
    description: "A tiny repository that exists so an agent has something to read.",
  },
  null,
  2,
)}\n`;

/** npx may have to fetch the adapter the first time, so this is generous. */
const OVERALL_TIMEOUT_MS = 6 * 60_000;

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "egma-smoke-"));
  await writeFile(path.join(dir, "package.json"), MANIFEST, "utf8");
  // A secret in the folder, so the fence has something real to stand in front of.
  await writeFile(path.join(dir, ".env"), "SMOKE_SECRET=never-read-this\n", "utf8");

  say(`Folder: ${dir}`);
  say("Starting: egma, driving the coding agent the registry calls claude-acp.");

  const started = Date.now();
  const terminal = runInTerminal({
    command: process.execPath,
    args: [CLI_ENTRY, "--cwd", dir],
    cwd: dir,
    cols: 100,
    rows: 30,
  });

  let intro = "";
  let working = "";
  let keystrokes = 0;

  try {
    await waitFor(
      () => terminal.screen().includes("[enter] begin"),
      60_000,
      "the intro screen",
    );
    intro = terminal.screen();

    // The one and only keystroke of the whole run.
    terminal.write("\r");
    keystrokes += 1;

    await waitFor(
      () => terminal.screen().includes("◆"),
      OVERALL_TIMEOUT_MS,
      "the first action to stream",
    );
    // Give the agent a moment to say which file it means, so the captured
    // frame shows the whole action rather than only its first line.
    await waitFor(() => terminal.screen().includes("┊"), 15_000, "the file").catch(
      () => undefined,
    );
    working = terminal.screen();

    const code = await Promise.race([
      terminal.exited,
      new Promise<number>((_, reject) =>
        setTimeout(
          () => reject(new Error("the run never finished — something asked a question")),
          OVERALL_TIMEOUT_MS,
        ),
      ),
    ]);

    const scrollback = terminal.scrollback().trim();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    say("");
    say("── intro screen ──────────────────────────────────────────");
    say(intro);
    say("");
    say("── while it worked ───────────────────────────────────────");
    say(working);
    say("");
    say("── what is left in scrollback ────────────────────────────");
    say(scrollback);
    say("");
    say("── check ─────────────────────────────────────────────────");
    say(`exit code:            ${code}`);
    say(`keystrokes sent:      ${keystrokes}`);
    say(`scrollback lines:     ${scrollback === "" ? 0 : scrollback.split("\n").length}`);
    say(`elapsed:              ${seconds}s`);

    const problems: string[] = [];
    if (code !== 0) problems.push(`exit code was ${code}, expected 0`);
    if (keystrokes !== 1) problems.push(`${keystrokes} keystrokes were needed, expected 1`);
    if (scrollback.split("\n").length !== 1) problems.push("scrollback is not one line");
    if (!scrollback.includes("read package.json for egma")) {
      problems.push("the exit line does not say the task was done");
    }
    if (!working.includes("◆")) problems.push("no action streamed while the agent worked");

    if (problems.length > 0) {
      say("");
      for (const problem of problems) say(`FAILED: ${problem}`);
      process.exitCode = 1;
      return;
    }

    say("");
    say("PASSED: one keystroke, no question asked, one line left behind.");
  } finally {
    terminal.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

await main();

// The pseudo-terminal the command ran in can outlive the command itself, and
// an open terminal keeps Node running — so a check that has printed its verdict
// would sit there forever, and the check after it in `pnpm smoke` would never
// start. Nothing is left to wait for here, so this leaves on its own answer,
// once what it printed has really gone out.
await new Promise<void>((resolve) => {
  process.stdout.write("", () => resolve());
});
process.exit(process.exitCode ?? 0);
