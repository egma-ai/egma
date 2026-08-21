/**
 * The smoke check: real Claude Code, writing real tests for a real repository.
 *
 * Nothing here is scripted. egma starts the installed Claude Code profile,
 * hands it the writing-tests notes and a task built from what the earlier steps
 * of the walk would have learned, and the check passes only if files land in
 * `egma/tests/` that egma can read back — in the settled format, each with at
 * least one expected behavior, because a test that cannot fail is not a test.
 *
 * The repository is the committed fixture: an invented bookbinding workshop
 * with an invented prompt. So this check needs no secret, no account and no
 * environment variable of any kind, and it therefore never skips — it passes or
 * it fails, and it says which loudly.
 *
 * Generation *quality* is not what this checks. Twelve files with plausible
 * names and one honest expectation each is a pass; whether they are the twelve
 * a good tester would have written is a different question and a later one.
 *
 * Run it with: node apps/cli/smoke/real-claude-code-generation.ts
 * It needs Claude Code logged in, and the network the first time.
 */

import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { discoverCodingAgents, installedCodingAgent } from "../src/acp/coding-agents.ts";
import { withDrivenAgent } from "../src/acp/driven-agent.ts";
import { createEgmaFolder, writeSuiteManifest } from "../src/folder/egma-folder.ts";
import { parseTestFile } from "../src/folder/test-file.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
import { MarkerStream } from "../src/wizard/markers.ts";
import { generateInstructions } from "../src/wizard/test-generation.ts";
import { RETELL_FIXTURE_REPO } from "../test/support/workspace.ts";
import { RULE, say } from "./support/report.ts";

/** How many tests this check asks for. Fewer than a walk, so it is quicker. */
const HOW_MANY = 4;
const SUITE_DIRECTORY = "smoke-generation";
const SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";

/** npx may have to fetch the adapter the first time, so this is generous. */
const TIMEOUT_MS = 8 * 60_000;

/**
 * What the walk would have known by the time it writes tests: what the coding
 * agent found in the repository, and what the provider is running.
 *
 * It is written down here rather than pulled, because pulling it would need a
 * Retell account and this check is the one that needs nothing. The prompt is
 * the fixture repository's own, which is what a real pull of this agent would
 * have answered with.
 */
const FACTS = new Map<string, string>([
  ["framework", "retell-sdk"],
  ["prompts", "prompts/order-line.md (pushed to Retell by scripts/deploy.ts)"],
  ["tools", "src/tools/*.ts (2 definitions)"],
  ["deploy", "Retell-hosted; scripts/deploy.ts updates the agent"],
  ["agent-id", "src/config.ts"],
]);

async function main(): Promise<void> {
  const claude = installedCodingAgent(await discoverCodingAgents(), "claude");
  if (claude === null) throw new Error("Claude Code is not installed on this machine.");
  const dir = await mkdtemp(path.join(tmpdir(), "egma-smoke-generate-"));
  // A secret in the folder, so the fence has something real to stand in front
  // of while the agent works.
  await cp(RETELL_FIXTURE_REPO, dir, { recursive: true });
  await writeFile(path.join(dir, ".env"), "SMOKE_SECRET=never-read-this\n", "utf8");

  const { paths } = await createEgmaFolder({ repository: dir });
  const suiteRoot = path.join(paths.tests, SUITE_DIRECTORY);
  await mkdir(suiteRoot);
  await writeSuiteManifest(path.join(suiteRoot, "suite.yaml"), {
    id: SUITE_ID,
    name: "Smoke generation",
  });
  const prompt = await readFile(path.join(dir, "prompts", "order-line.md"), "utf8");

  say(`Folder: ${dir}`);
  say(`Starting: egma, driving ${claude.name} (${claude.id}).`);
  say(`Asking for: ${HOW_MANY} tests in egma/tests/${SUITE_DIRECTORY}/.`);
  say("");

  const ui = new HeadlessUI({ write: (line) => say(line) });
  const markers = new MarkerStream();
  /**
   * What the agent said it wrote.
   *
   * Reported and never required. The pane a developer watches is drawn from
   * the folder as well as from these lines, precisely because a real coding
   * agent writes the files and forgets to announce them — so this number is
   * how well the notes are landing, not whether the wizard works.
   */
  const announced: string[] = [];

  const started = Date.now();
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort("interrupt"), TIMEOUT_MS);

  const result = await withDrivenAgent(
    {
      launch: claude.launch,
      cwd: dir,
      ui,
      signal: giveUp.signal,
    },
    (agent) =>
      agent.run({
        instructions: generateInstructions(
          {
            cwd: dir,
            suiteDirectory: SUITE_DIRECTORY,
            facts: FACTS,
            prompt,
            toolCount: 2,
            agentName: "order-line",
            taken: [],
            personas: [],
          },
          HOW_MANY,
        ),
        watch: (chunk) => {
          for (const line of markers.push(chunk)) {
            if (line.kind === "marker" && line.marker.kind === "wrote") {
              announced.push(line.marker.name);
            }
          }
          return null;
        },
      }),
  );
  clearTimeout(timer);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  // What is on disk is the account of what happened, whatever anybody said.
  const names = (await readdir(suiteRoot).catch(() => [])).filter((name) =>
    name.endsWith(".md"),
  );
  const problems: string[] = [];
  let valid = 0;

  say("");
  say("── what landed ───────────────────────────────────────────");
  for (const name of names.sort()) {
    const held = await readFile(path.join(suiteRoot, name), "utf8");
    const test = parseTestFile(held, name, name.replace(/\.md$/u, ""));
    const behaviors = test.expectedBehaviors.length;
    const ok = test.name !== "" && test.scenario.trim() !== "" && behaviors > 0;
    if (ok) valid += 1;
    else problems.push(`${name} is not a test egma could push`);
    say(
      `${ok ? "◼" : "✗"} ${name.padEnd(40)} ${behaviors} expected ${behaviors === 1 ? "behavior" : "behaviors"}`,
    );
    if (test.version !== null) problems.push(`${name} carries a version egma never issued`);
  }
  if (names.length === 0) say("nothing");

  // One file, whole, so a reader can judge for themselves what came back.
  const first = names.sort()[0];
  if (first !== undefined) {
    say("");
    say("── the first of them ─────────────────────────────────────");
    say((await readFile(path.join(suiteRoot, first), "utf8")).trimEnd());
  }

  say("");
  say("── check ─────────────────────────────────────────────────");
  say(`task ended:      ${result.kind}`);
  say(`files written:   ${names.length}`);
  say(`egma can push:   ${valid}`);
  say(`announced:       ${announced.length}  (marker lines, for information)`);
  say(`elapsed:         ${seconds}s`);

  if (result.kind !== "done") problems.push(`the task ended as ${result.kind}`);
  if (valid < HOW_MANY) problems.push(`${valid} usable tests, expected ${HOW_MANY}`);
  // The fence stood, whatever the agent asked for.
  const kept = await readFile(path.join(dir, ".env"), "utf8");
  if (kept !== "SMOKE_SECRET=never-read-this\n") problems.push("the .env file was changed");

  await rm(dir, { recursive: true, force: true });

  say(RULE);
  if (problems.length > 0) {
    for (const problem of problems) say(`  FAILED: ${problem}`);
    say(RULE);
    process.exitCode = 1;
    return;
  }
  say(`  PASSED — real Claude Code wrote ${valid} tests egma can push.`);
  say(RULE);
}

await main();

// Nothing is left to wait for, and an adapter's own process tree can keep Node
// alive after the task is over. This leaves on its own answer, once what it
// printed has really gone out.
await new Promise<void>((resolve) => {
  process.stdout.write("", () => resolve());
});
process.exit(process.exitCode ?? 0);
