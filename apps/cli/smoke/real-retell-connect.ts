/**
 * The smoke check: the built `egma connect`, against the real Retell.
 *
 * The offline checks prove the flow against a fake speaking the shapes Retell's
 * published SDK names. This proves the one thing they cannot: that those shapes
 * are the shapes the real service actually answers with — the addresses, the
 * field names, the two halves an agent is really in.
 *
 * **It is read-only, and the read-only-ness is enforced rather than promised.**
 * Retell is not reached directly: everything goes through the gate in
 * `support/retell-gate.ts`, started here, which forwards the listing and the
 * reads behind it and refuses everything else — so a change that made the CLI
 * write could not do it through this check. The account belongs to somebody and
 * the agents on it answer real telephone numbers.
 *
 * The platform side is the fixture, so nothing is written to a real egma
 * either. What lands there is asserted; the account is never named in what this
 * prints. Every identifier and every name it learns is replaced in the output,
 * so a passing run can be pasted anywhere.
 *
 * Run it with:
 *
 *   set -a; . ~/.egma-dev-secrets.env; set +a
 *   node apps/cli/smoke/real-retell-connect.ts
 *
 * With `RETELL_API_KEY` unset there is no account to read, so the check
 * verifies nothing and says so loudly rather than exiting quietly on a zero — a
 * skip that reads like a pass is worse than no check at all. Where a skip must
 * be a failure instead, run it strictly:
 *
 *   node apps/cli/smoke/real-retell-connect.ts --require-target
 *   EGMA_SMOKE_REQUIRE_TARGET=1 node apps/cli/smoke/real-retell-connect.ts
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { startPlatform, type Platform } from "../test/support/fixture-platform/index.ts";
import { check, problems, RULE, say } from "./support/report.ts";
import { openGate, type Gate } from "./support/retell-gate.ts";

const CLI_ENTRY = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** The one committed name for the key this check runs against. */
const KEY_VARIABLE = "RETELL_API_KEY";

/**
 * The other names the command would read a key from, taken out of its
 * environment so that the key this check holds is the key the command uses.
 */
const OTHER_KEY_VARIABLES = ["EGMA_RETELL_API_KEY"] as const;

/** The switch that turns a skip into a failure. */
const STRICT_VARIABLE = "EGMA_SMOKE_REQUIRE_TARGET";
const STRICT_FLAG = "--require-target";

/** How many agents are tried before giving up on finding one with a prompt. */
const MOST_AGENTS_TRIED = 5;

function requiresTarget(): boolean {
  if (process.argv.includes(STRICT_FLAG)) return true;
  const set = (process.env[STRICT_VARIABLE] ?? "").trim().toLowerCase();
  return set !== "" && set !== "0" && set !== "false" && set !== "no";
}

function nothingWasVerified(strict: boolean): void {
  const headline = strict
    ? "FAILED — nothing was verified, and this run required a target"
    : "SKIPPED — nothing was verified";

  say(RULE);
  say(`  ${headline}`);
  say(RULE);
  say(`  ${KEY_VARIABLE} is not set, so no account was read, no request was`);
  say("  made, and nothing at all was checked.");
  say("");
  say(`  Set ${KEY_VARIABLE} to a key for a real Retell account, then run this`);
  say("  again. Nothing on that account is written to: this check lists agents");
  say("  and reads configuration, and a gate it starts refuses anything else.");
  if (!strict) {
    say("");
    say("  Where a skip must not look like a pass — CI, or a machine that is");
    say(`  supposed to have a key — run this with ${STRICT_FLAG}, or with`);
    say(`  ${STRICT_VARIABLE}=1, and an unset key ends the run`);
    say("  with a failure instead.");
  }
  say(RULE);
}

/* ── running the command ─────────────────────────────────────────────── */

type Run = { readonly stdout: string; readonly stderr: string; readonly code: number };

function egma(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<Run> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], { cwd, env });
  child.stdin.end("");

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

  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

/** The printed lines, read the way something driving the command reads them. */
function facts(stdout: string): Record<string, string> {
  const read: Record<string, string> = {};
  for (const line of stdout.trimEnd().split("\n")) {
    const at = line.indexOf(": ");
    if (at > 0) read[line.slice(0, at)] = line.slice(at + 2);
  }
  return read;
}

/** Every `retell_agent: <id> <name>` line, as ids. */
function agentIdsIn(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("retell_agent: "))
    .map((line) => line.slice("retell_agent: ".length).split(" ")[0] ?? "")
    .filter((id) => id !== "");
}

/**
 * Everything printed that names somebody's account: agent identifiers and the
 * names their customers gave them.
 *
 * A passing run of this is pasted into reviews and issues, so the account it
 * ran against must not be readable from it. Counts and shapes are the point;
 * contents never were.
 */
function accountValues(stdout: string): string[] {
  const values: string[] = [];
  for (const line of stdout.split("\n")) {
    for (const prefix of ["retell_agent: ", "retell_agent_id: ", "agent_name: "]) {
      if (!line.startsWith(prefix)) continue;
      const rest = line.slice(prefix.length).trim();
      values.push(rest);
      const [id, ...named] = rest.split(" ");
      if (id !== undefined) values.push(id);
      const name = named.join(" ").trim();
      if (name !== "") values.push(name);
    }
  }
  return values;
}

/** The listing lines dropped, because a list of names is a list of names. */
function withoutTheListing(stdout: string): string {
  const lines = stdout.split("\n");
  const listed = lines.filter((line) => line.startsWith("retell_agent: ")).length;
  const kept = lines.filter((line) => !line.startsWith("retell_agent: "));
  return listed === 0
    ? kept.join("\n")
    : [...kept, `(${listed} retell_agent: lines, not printed)`].join("\n");
}

/* ── the check itself ────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const key = process.env[KEY_VARIABLE];
  if (key === undefined || key.trim() === "") {
    const strict = requiresTarget();
    nothingWasVerified(strict);
    if (strict) process.exitCode = 1;
    return;
  }

  const home = await mkdtemp(path.join(tmpdir(), "egma-smoke-retell-"));
  const workdir = await mkdtemp(path.join(tmpdir(), "egma-smoke-repo-"));
  let platform: Platform | undefined;
  let gate: Gate | undefined;

  try {
    platform = await startPlatform();
    gate = await openGate();
    // Said on every invocation below, because that is the only way to name an
    // egma: one explicit address per command, and no shell that names one.
    const platformUrl = platform.url;

    // A key this fixture accepts, written where a login would have put it. No
    // real egma is touched and the credentials of whoever runs this are not
    // read.
    await writeFile(
      path.join(home, "credentials"),
      `${JSON.stringify({ url: platform.url, key: platform.device.mint() })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EGMA_HOME: home,
      EGMA_RETELL_URL: gate.url,
      [KEY_VARIABLE]: key.trim(),
    };
    delete env.EGMA_RETELL_AGENT_ID;
    // The command reads EGMA_RETELL_API_KEY before RETELL_API_KEY, so a shell
    // holding both would have it run on a key this check never saw — and every
    // sentence below about where that key did not appear would be about the
    // wrong string. One key, held here, used there.
    for (const other of OTHER_KEY_VARIABLES) delete env[other];

    say("Starting: the built egma connect, against a real Retell account.");
    say("Reads only: list agents, retrieve an agent, retrieve its response engine.");
    say("");

    // First run with nothing said about which agent. One agent on the account
    // connects straight away; several are listed and refused, which is the
    // promptless surface behaving exactly as it should.
    //
    // The reach is said, because egma will not choose between text and phone
    // on anybody's behalf. Text here: this check has no platform to dial from
    // and no business registering somebody's telephone number.
    const first = await egma(["connect", "--url", platformUrl, "--reach", "text"], env, workdir);
    const listed = agentIdsIn(first.stdout);

    let connected = first;
    let chosen = 0;

    if (first.code === 5) {
      check(listed.length > 1, `the account holds ${listed.length} agents, so a choice was offered`);
      // A real account holds agents of every shape, and one whose model the
      // customer runs themselves keeps its prompt out of Retell. That is a
      // real answer rather than a failure, so this looks for one that has a
      // prompt to keep.
      for (const id of listed.slice(0, MOST_AGENTS_TRIED)) {
        chosen += 1;
        connected = await egma(
          ["connect", "--url", platformUrl, "--reach", "text", "--retell-agent", id],
          env,
          workdir,
        );
        if (connected.code === 0 && Number(facts(connected.stdout).prompt_characters ?? 0) > 0) {
          break;
        }
      }
    } else {
      check(first.code === 0, `one agent on the account connected on its own (exit ${first.code})`);
    }

    const result = facts(connected.stdout);

    // Everything either run learned about the account is hidden from here on,
    // and the listing itself is not printed at all.
    const named = [
      key.trim(),
      ...listed,
      ...accountValues(first.stdout),
      ...accountValues(connected.stdout),
    ].filter((one) => one.length > 3);
    const redact = (text: string): string =>
      [...new Set(named)]
        .sort((left, right) => right.length - left.length)
        .reduce((held, one) => held.split(one).join("<redacted>"), text);

    say("");
    say("── what egma connect answered ────────────────────────────");
    say(redact(withoutTheListing(connected.stdout)).trimEnd());
    if (connected.stderr.trim() !== "") {
      say("");
      say("── standard error ────────────────────────────────────────");
      say(redact(withoutTheListing(connected.stderr)).trimEnd());
    }

    say("");
    say("── what was read, and what was refused ───────────────────");
    for (const shape of [...new Set(gate.forwarded)]) {
      say(`  ${shape}  ×${gate.forwarded.filter((one) => one === shape).length}`);
    }
    say(`  refused: ${gate.refused.length}`);

    /* the assertions */

    say("");
    say("── check ─────────────────────────────────────────────────");
    check(connected.code === 0, `egma connect exited 0 (it exited ${connected.code})`);
    check(gate.refused.length === 0, "nothing but reads was asked of Retell");
    check(
      Number(result.retell_agents ?? 0) >= 1,
      `the account listed ${result.retell_agents ?? 0} agents`,
    );
    check(
      Number(result.prompt_characters ?? 0) > 0,
      `a prompt was pulled (${result.prompt_characters ?? 0} characters${chosen > 1 ? `, on agent ${chosen} of those tried` : ""})`,
    );
    check(
      ["retell-llm", "conversation-flow", "custom-llm"].includes(result.retell_response_engine ?? ""),
      `the response engine is one Retell names (${result.retell_response_engine ?? "none"})`,
    );

    // egma read both halves from Retell and kept neither of them.
    //
    // That absence is the check. What the provider is running lives at the
    // provider: egma keeps the identity and the sealed way back, and reads the
    // content fresh through it, because a stored copy would start rotting the
    // moment it was written. So there is nothing here to compare byte for byte
    // — there is only what Retell answered, and what egma read out of it.
    const agent = platform.registered.agents.at(-1);
    check(
      agent !== undefined && !("pulled" in agent),
      "nothing egma stored holds a copy of what the provider is running",
    );

    // Retell keeps voice agents and chat agents at two addresses, and one of
    // them is where this agent is. Which one is a fact about the *agent* and
    // not about the connection egma made for it: reaching a voice agent by
    // text is an ordinary choice, so the connection's modality says which way
    // egma will talk to it and never which door Retell keeps it behind.
    const answeredWith =
      gate.answered(`/get-agent/${result.retell_agent_id ?? ""}`) ??
      gate.answered(`/get-chat-agent/${result.retell_agent_id ?? ""}`) ??
      "";
    check(
      answeredWith.length > 0,
      `Retell answered for the agent egma took (${answeredWith.length} bytes)`,
    );
    // A custom engine is the customer's own service and has no address at
    // Retell, so it is the one engine with no second half to read. Saying "the
    // engine was read" over an engine nothing read would be a line that passes
    // by being about nothing, which is worse than no line at all — so this
    // prints the claim it can actually make, and says which one it made.
    if (result.retell_response_engine === "custom-llm") {
      say(
        "  --    the response engine is the customer's own service, so there was " +
          "no second half at Retell to read",
      );
    } else {
      check(
        gate.forwarded.some(
          (one) => one.includes("/get-retell-llm") || one.includes("/get-conversation-flow"),
        ),
        "the response engine was read as its own half, not guessed at",
      );
    }

    // The agent and the way to reach it are on the platform.
    check(platform.registered.agents.length >= 1, "an agent landed on the platform");
    const connection = platform.registered.connections.at(-1);
    check(connection?.type === "retell", `the connection is a retell one (${connection?.type})`);
    check(
      connection?.modality === "voice" || connection?.modality === "chat",
      `the connection names a modality (${connection?.modality})`,
    );
    check(
      /^retell-\d+$/u.test(connection?.name ?? ""),
      `the connection was named by the platform (${connection?.name})`,
    );
    check(
      connection?.credentialsHint === key.trim().slice(-4),
      "the key was sealed, and only its last characters came back",
    );

    /* the numbers, read the way the phone path reads them */

    // The other half of the flow, against the same real account: which numbers
    // Retell routes to the agent egma just took.
    //
    // What this proves is that the shapes the phone path reads are the shapes
    // the real service answers with. Where it ends is the account's business
    // rather than this check's: an agent with several numbers ends at "nobody
    // said which", an agent with none ends there, and an agent with exactly one
    // registers a phone connection for it. That last ending really does write
    // somebody's telephone number down — on the fixture platform this check
    // starts and throws away, which is nowhere and nobody's, and it is the only
    // way the confirming read gets exercised at all.
    const numbered = await egma(
      [
        "connect",
        "--url",
        platformUrl,
        "--reach",
        "phone",
        "--retell-agent",
        result.retell_agent_id ?? "",
      ],
      env,
      workdir,
    );
    const dialling = facts(numbered.stdout);
    const offered = numbered.stdout
      .split("\n")
      .filter((line) => line.startsWith("retell_number: "))
      .map((line) => line.slice("retell_number: ".length).split(" ")[0] ?? "");
    for (const number of offered) named.push(number);

    say("");
    say("── what the phone path read ──────────────────────────────");
    say(`  status:  ${dialling.status ?? "none"}`);
    say(`  numbers: ${offered.length}`);

    // Three endings are all correct answers about a real account, and each says
    // something different: one number was taken, several were offered and none
    // named, or Retell routes none to this agent at all. What would not be
    // correct is a fourth.
    const dialled = dialling.phone_number ?? "";
    check(
      ["connected", "unchosen-number", "no-numbers"].includes(dialling.status ?? ""),
      `the phone path ended in a way it has a word for (${dialling.status ?? "none"})`,
    );
    if (dialling.status === "connected") {
      check(
        /^\+[1-9]\d{1,14}$/u.test(dialled),
        "the number egma took is E.164, read from the account",
      );
      check(
        gate.forwarded.some((one) => one.includes("/get-phone-number")),
        "the number egma took was confirmed at its own address before it was written",
      );
    }
    check(
      gate.forwarded.includes("GET /list-phone-numbers"),
      "the account's numbers were listed, and only listed",
    );
    check(gate.refused.length === 0, "and nothing but reads was asked for them");

    // And the key is nowhere it should not be.
    const printed = `${connected.stdout}${connected.stderr}${first.stdout}${first.stderr}`;
    check(!printed.includes(key.trim()), "the key is in nothing the command printed");
    check(
      !(await readFile(path.join(home, "credentials"), "utf8")).includes(key.trim()),
      "the key is not in the credentials file",
    );
    check(
      gate.forwarded.every((shape) => !shape.includes(key.trim())),
      "the key is in no address that was asked for",
    );
    check(
      !`${redact(connected.stdout)}${redact(first.stdout)}`.includes(result.agent_name ?? " "),
      "nothing this printed names the account it read",
    );
  } finally {
    await gate?.close();
    await platform?.close();
    await rm(home, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }

  say("");
  if (problems.length > 0) {
    for (const problem of problems) say(`FAILED: ${problem}`);
    process.exitCode = 1;
    return;
  }
  say("PASSED: a real Retell account was read, and what it answered was kept whole.");
}

await main();
process.exit(process.exitCode ?? 0);
