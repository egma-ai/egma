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
 * Run it with: node apps/cli/smoke/real-claude-code-discovery.ts
 * It needs Claude Code logged in, and the network the first time.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** The one committed name for the repository this check runs against. */
const TARGET_VARIABLE = "EGMA_E2E_TARGET_REPO";

/** npx may have to fetch the adapter the first time, so this is generous. */
const TIMEOUT_MS = 6 * 60_000;

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** What the target repository is called, replaced everywhere by what it is. */
function redactor(target: string): (text: string) => string {
  const parts = [target, path.resolve(target), path.basename(target)].filter(
    (part) => part.length > 2,
  );
  const ordered = [...new Set(parts)].sort((left, right) => right.length - left.length);
  return (text) =>
    ordered.reduce((held, part) => held.split(part).join("<target repo>"), text);
}

async function main(): Promise<void> {
  const target = process.env[TARGET_VARIABLE];
  if (target === undefined || target.trim() === "") {
    say(`${TARGET_VARIABLE} is not set, so there is no repository to look in.`);
    say("");
    say("This check drives real Claude Code over a real voice agent's repository.");
    say(`Set ${TARGET_VARIABLE} to the folder that repository is checked out in,`);
    say("then run this again. Nothing was started.");
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

  const facts = lines.filter((line) => line.startsWith("┊ "));
  const prompts = facts.find((line) => line.startsWith("┊ Prompts"));
  const framework = facts.find((line) => line.startsWith("┊ Framework"));

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
