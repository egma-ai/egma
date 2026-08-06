/**
 * The smoke check: real Claude Code, finding a real voice agent's prompts.
 *
 * Nothing here is scripted. egma starts the adapter the agent registry names,
 * hands it the two skills as the task's instructions, and the check passes only
 * if the coding agent comes back with marker lines naming the framework and the
 * prompts — read out of a repository this file has never seen and does not name.
 *
 * The repository is supplied by the developer through EGMA_E2E_TARGET_REPO and
 * is never written down here. Its path is redacted from everything printed, so
 * the output of a passing run can be pasted anywhere.
 *
 * With that variable unset there is nothing to look in, so the check verifies
 * nothing and says so loudly rather than exiting quietly on a zero — a skip
 * that reads like a pass is worse than no check at all. Where a skip must be a
 * failure instead, run it strictly:
 *
 *   node apps/cli/smoke/real-claude-code-discovery.ts --require-target
 *   EGMA_SMOKE_REQUIRE_TARGET=1 node apps/cli/smoke/real-claude-code-discovery.ts
 *
 * Either one turns an unset target into a non-zero exit. That is what CI, and
 * `pnpm smoke` on a machine that is supposed to have a target, should use.
 *
 * Run it with: node apps/cli/smoke/real-claude-code-discovery.ts
 * It needs Claude Code logged in, and the network the first time.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { FACTS } from "../src/wizard/facts.ts";
import { DETAIL_MARK } from "../src/wizard/status.ts";

const CLI_ENTRY = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** The one committed name for the repository this check runs against. */
const TARGET_VARIABLE = "EGMA_E2E_TARGET_REPO";

/** The switch that turns a skip into a failure. */
const STRICT_VARIABLE = "EGMA_SMOKE_REQUIRE_TARGET";
const STRICT_FLAG = "--require-target";

/** npx may have to fetch the adapter the first time, so this is generous. */
const TIMEOUT_MS = 6 * 60_000;

const RULE = "─".repeat(58);

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** Whether an unset target must end this run with a failure. */
function requiresTarget(): boolean {
  if (process.argv.includes(STRICT_FLAG)) return true;
  const set = (process.env[STRICT_VARIABLE] ?? "").trim().toLowerCase();
  return set !== "" && set !== "0" && set !== "false" && set !== "no";
}

/**
 * What is printed when there is no repository to look in.
 *
 * It is loud on purpose. This check sits inside `pnpm smoke`, and a line of
 * polite prose between two passing checks is read as a third passing check.
 */
function nothingWasVerified(strict: boolean): void {
  const headline = strict
    ? "FAILED — nothing was verified, and this run required a target"
    : "SKIPPED — nothing was verified";

  say(RULE);
  say(`  ${headline}`);
  say(RULE);
  say(`  ${TARGET_VARIABLE} is not set, so no repository was read, no coding`);
  say("  agent was started, and nothing at all was checked.");
  say("");
  say(`  Set ${TARGET_VARIABLE} to the folder a real voice agent is`);
  say("  checked out in, then run this again.");
  if (!strict) {
    say("");
    say("  Where a skip must not look like a pass — CI, or a machine that is");
    say(`  supposed to have a target — run this with ${STRICT_FLAG}, or with`);
    say(`  ${STRICT_VARIABLE}=1, and an unset target ends the run`);
    say("  with a failure instead.");
  }
  say(RULE);
}

/** The shortest piece of a path still worth hiding. */
const TELLING = 8;

/**
 * What the target repository is called, replaced everywhere by what it is.
 *
 * Every cut-short form of the path counts too. egma trims a long command to
 * fit one status line, and half a path is still the path. It hides more than
 * it strictly has to, which is the right way round: a redaction that takes an
 * unrelated folder with it costs a reader nothing, and one that stops a
 * character short costs the name this check exists not to print.
 */
function redactor(target: string): (text: string) => string {
  const names = [target, path.resolve(target), path.basename(target)].filter(
    (name) => name.length > 2,
  );

  const parts = new Set<string>();
  for (const name of names) {
    parts.add(name);
    for (let end = name.length - 1; end >= TELLING; end -= 1) parts.add(name.slice(0, end));
  }

  const ordered = [...parts].sort((left, right) => right.length - left.length);
  return (text) => ordered.reduce((held, part) => held.split(part).join("<target repo>"), text);
}

async function main(): Promise<void> {
  const target = process.env[TARGET_VARIABLE];
  if (target === undefined || target.trim() === "") {
    const strict = requiresTarget();
    nothingWasVerified(strict);
    if (strict) process.exitCode = 1;
    return;
  }

  const redact = redactor(target.trim());

  say("Starting: egma, driving the coding agent the registry calls claude-acp.");
  say("Folder:   <target repo>");
  say("");

  const started = Date.now();
  const child = spawn(process.execPath, [CLI_ENTRY, "--headless", "--cwd", target.trim()], {
    cwd: target.trim(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const giveUp = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
  const code = await new Promise<number>((resolve) => {
    child.on("close", (value) => resolve(value ?? 1));
  });
  clearTimeout(giveUp);

  const lines = redact(stdout).trimEnd().split("\n");
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  say("── what egma showed ──────────────────────────────────────");
  for (const line of lines) say(line);
  if (stderr.trim() !== "") {
    say("");
    say("── standard error ────────────────────────────────────────");
    say(redact(stderr).trimEnd());
  }

  // A detail line is not a fact — a command egma showed under a terminal
  // action starts the same way — so the facts are counted by their own names.
  const facts = lines.filter((line) =>
    FACTS.some((fact) => line.startsWith(`${DETAIL_MARK} ${fact.label}`)),
  );
  const prompts = facts.find((line) => line.startsWith(`${DETAIL_MARK} Prompts`));
  const framework = facts.find((line) => line.startsWith(`${DETAIL_MARK} Framework`));

  say("");
  say("── check ─────────────────────────────────────────────────");
  say(`exit code:      ${code}`);
  say(`facts reported: ${facts.length}`);
  say(`elapsed:        ${seconds}s`);

  const problems: string[] = [];
  if (code !== 0) problems.push(`exit code was ${code}, expected 0`);
  if (framework === undefined) problems.push("no framework was reported");
  if (prompts === undefined) problems.push("no prompts were reported");
  else if (prompts.replace("┊ Prompts", "").trim() === "") {
    problems.push("the prompts fact came back empty");
  }
  if (!lines.some((line) => line.includes("egma found your voice agent"))) {
    problems.push("the exit line does not say a voice agent was found");
  }

  if (problems.length > 0) {
    say("");
    for (const problem of problems) say(`FAILED: ${problem}`);
    process.exitCode = 1;
    return;
  }

  say("");
  say("PASSED: real Claude Code read the repository and reported its prompts.");
}

await main();
process.exit(process.exitCode ?? 0);
