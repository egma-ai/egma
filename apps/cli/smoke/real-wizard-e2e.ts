/**
 * The smoke check: the whole wizard, everything real, nobody at the keyboard.
 *
 * One command drives `npx egma` from its first screen to its last against the
 * real things it is meant to work against: the developer's own coding agent
 * over the protocol, a whole egma running on this machine, the developer's own
 * repository, and a real Retell account. No fixture agent, no fake provider, no
 * stubbed adapter. What is not real is named in one place —
 * `support/half-real-platform.ts` — and it is exactly the endpoints the public
 * API has not shipped yet.
 *
 * **Nobody types anything.** The wizard's six human moments are answered by
 * this check through a real pseudo-terminal: the keystroke at the intro, the
 * approval in a browser (made against the instance's own API, which is what the
 * page would have called), the provider key, the choice of agent when the
 * account holds several, the keystroke at the gate, and the answer to the skill
 * offer at the end.
 *
 * **The one thing this machine cannot do is conduct a simulation**, so the
 * verdict the wizard waits for is delivered by the same stand-in simulator the
 * offline checks use, against the same fixture that serves the run endpoints.
 * Everything about the run that egma owns is real: the run is created over the
 * versions the push just pinned, the screen is drawn from what the platform
 * reports, and the wizard leaves on the first verdict rather than on a timer.
 *
 * **The skill offer is answered with skip**, because the only home this check
 * has is the home of whoever ran it. Skip is also the answer that has something
 * to prove: nothing is written anywhere, and this checks the developer's own
 * skill file is exactly as it was before the run.
 *
 * **The Retell account is only ever read.** Every request goes through the
 * allow-list gate in `support/retell-gate.ts`, which forwards the listing and
 * the reads behind it and refuses everything else. The agents on that account
 * answer real telephone numbers; a write would be unacceptable and this makes
 * it impossible rather than unlikely.
 *
 * **The provider key is typed, never exported.** It is taken out of this
 * check's own environment before the wizard is started, so the coding agent
 * egma drives — which inherits that environment — never has it in reach.
 *
 * Run it with:
 *
 *   set -a; . ~/.egma-dev-secrets.env; set +a
 *   node apps/cli/smoke/real-wizard-e2e.ts
 *
 * It needs the Postgres and ClickHouse this repository's compose file brings
 * up, already running; a coding agent installed and logged in; `EGMA_E2E_TARGET_REPO`
 * pointing at a repository with a voice agent in it; and `RETELL_API_KEY`.
 *
 * Useful arguments:
 *
 *   --coding-agent <id>   Which agent to drive, as the registry names it.
 *   --again               Walk a second time against the same egma, which is
 *                         what proves a second run lands beside the first.
 *   --require-target      Turn a skip into a failure, for a machine that is
 *                         supposed to have all of this. `EGMA_SMOKE_REQUIRE_TARGET=1`
 *                         does the same.
 */

import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { startInstance, type Instance } from "../../api/test/support/instance.ts";
import { DEFAULT_DRIVEN_AGENT_ID, launchForId } from "../src/acp/registry.ts";
import { parseTestFile } from "../src/folder/test-file.ts";
import { skillPlacesFor } from "../src/skills/install.ts";
import { gradeEveryRun } from "../test/support/grading.ts";
import { runInTerminal, type TerminalRun } from "../test/support/pty.ts";
import { startHalfRealPlatform, type HalfRealPlatform } from "./support/half-real-platform.ts";
import { openGate, type Gate } from "./support/retell-gate.ts";

const CLI_ENTRY = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** The repository this walks in. Never named in anything committed here. */
const TARGET_VARIABLE = "EGMA_E2E_TARGET_REPO";

/** The one committed name for the key this check runs against. */
const KEY_VARIABLE = "RETELL_API_KEY";

/** The other name the command reads a key from, kept out of its environment. */
const OTHER_KEY_VARIABLES = ["EGMA_RETELL_API_KEY"] as const;

const STRICT_VARIABLE = "EGMA_SMOKE_REQUIRE_TARGET";
const STRICT_FLAG = "--require-target";

/** A browser this check must not open: it approves through the API instead. */
const NO_BROWSER = "/usr/bin/true";

/**
 * How many tests have to land for this to be a pass.
 *
 * Fewer than the suite egma asks for, on purpose. How many a real coding agent
 * writes is the agent's business, and how good the tests are is a different
 * question altogether; what is being proved here is that what it wrote reached
 * the platform as frozen versions and reached the repository as files.
 */
const TESTS_ENOUGH = 6;

/** What the walk is given for each phase, in milliseconds. */
const BUDGET = {
  intro: 3 * 60_000,
  login: 3 * 60_000,
  key: 15 * 60_000,
  agent: 2 * 60_000,
  existing: 2 * 60_000,
  gate: 25 * 60_000,
  run: 5 * 60_000,
  offer: 5 * 60_000,
  exit: 5 * 60_000,
};

const RULE = "─".repeat(58);

const problems: string[] = [];
/** Everything that must never appear in what this prints. */
const secrets: string[] = [];

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

function check(condition: boolean, what: string): void {
  say(`${condition ? "  ok  " : "FAILED"}  ${what}`);
  if (!condition) problems.push(what);
}

/**
 * The text with everything that names the account or the machine taken out.
 *
 * A passing run of this is pasted into reviews, so the account it read and the
 * developer's own paths must not be readable from it. Counts and shapes are the
 * point; contents never were.
 */
function redact(text: string): string {
  return [...new Set(secrets)]
    .filter((one) => one.length > 3)
    .sort((left, right) => right.length - left.length)
    .reduce((held, one) => held.split(one).join("<redacted>"), text);
}

function requiresTarget(): boolean {
  if (process.argv.includes(STRICT_FLAG)) return true;
  const set = (process.env[STRICT_VARIABLE] ?? "").trim().toLowerCase();
  return set !== "" && set !== "0" && set !== "false" && set !== "no";
}

function nothingWasVerified(strict: boolean, missing: readonly string[]): void {
  const headline = strict
    ? "FAILED — nothing was verified, and this run required a target"
    : "SKIPPED — nothing was verified";

  say(RULE);
  say(`  ${headline}`);
  say(RULE);
  say(`  ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set, so no`);
  say("  wizard was started, no request was made, and nothing at all was");
  say("  checked.");
  say("");
  say(`  ${TARGET_VARIABLE} points at a repository with a voice agent in it. It`);
  say("  is copied before anything runs, so the repository itself is never");
  say("  written to.");
  say(`  ${KEY_VARIABLE} is a key for a real Retell account. Nothing on that`);
  say("  account is written to: this check lists agents and reads");
  say("  configuration, and a gate it starts refuses anything else.");
  if (!strict) {
    say("");
    say("  Where a skip must not look like a pass — CI, or a machine that is");
    say(`  supposed to have both — run this with ${STRICT_FLAG}, or with`);
    say(`  ${STRICT_VARIABLE}=1, and a missing one ends the run`);
    say("  with a failure instead.");
  }
  say(RULE);
}

/** The value after a flag, or `null` when it was not given. */
function argumentAfter(flag: string): string | null {
  const at = process.argv.indexOf(flag);
  if (at === -1) return null;
  return process.argv[at + 1] ?? null;
}

/* ── the person in the browser ───────────────────────────────────────── */

/** The cookie header a browser would send back, given what it was just set. */
function cookiesFrom(setCookie: string | null): string {
  return (setCookie ?? "")
    .split(/,(?=[^;]+?=)/u)
    .map((cookie) => cookie.split(";", 1)[0]?.trim() ?? "")
    .filter((cookie) => cookie !== "")
    .join("; ");
}

/**
 * The account this run signs up as, once.
 *
 * Once and not twice: a second walk has to land in the same project as the
 * first for the second registration to mean anything, and a second signup would
 * be a different customer entirely.
 */
async function signUp(apiOrigin: string): Promise<string> {
  const created = await fetch(`${apiOrigin}/api/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `ada+${Date.now()}@acme.example`,
      password: "a-long-enough-password",
      organizationName: "Acme",
      projectName: "Default",
    }),
  });
  if (created.status !== 201) {
    throw new Error(`the instance would not take a signup (${created.status})`);
  }
  return cookiesFrom(created.headers.get("set-cookie"));
}

/**
 * What the person looking at the approval page would have clicked.
 *
 * It is the request that page makes, made directly. The page itself is a
 * browser check's business and has one of its own; what this needs is for the
 * terminal's code to be approved by a real signed-in account on the real
 * instance, which is what this is.
 */
async function approve(apiOrigin: string, cookie: string, userCode: string): Promise<string> {
  const answered = await fetch(`${apiOrigin}/api/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ user_code: userCode }),
  });
  const held = (await answered.json().catch(() => ({}))) as { status?: unknown };
  return typeof held.status === "string" ? held.status : `http ${answered.status}`;
}

/* ── the repository the walk runs in ─────────────────────────────────── */

/** What is never worth copying, and would make the copy enormous. */
const NOT_COPIED = new Set([".git", "node_modules", "dist", ".next", ".turbo", "target"]);

/**
 * A copy of the developer's repository, so the walk writes into a copy.
 *
 * The wizard makes an `egma/` folder in the repository it runs in, and this
 * check runs several times a day. Copying is what keeps somebody's real
 * checkout out of it — and what is copied is their real code, which is the part
 * that matters to a coding agent reading it.
 */
async function copyOfTheRepository(from: string, label: string): Promise<string> {
  const into = await mkdtemp(path.join(tmpdir(), `egma-e2e-${label}-`));
  await cp(from, into, {
    recursive: true,
    filter: (source) => !NOT_COPIED.has(path.basename(source)),
  });
  return into;
}

/* ── the walk ────────────────────────────────────────────────────────── */

type Timing = { readonly phase: string; readonly seconds: string };

type WalkOutcome = {
  readonly exitCode: number;
  /** Everything left in scrollback, as lines with nothing empty between. */
  readonly exitLine: string;
  readonly leftBehind: readonly string[];
  readonly timings: readonly Timing[];
  readonly credentials: { readonly url: string; readonly key: string };
  readonly repository: string;
  /** Whether the account offered a choice of agents, and how many. */
  readonly chosenFrom: number;
  /** The run the wizard started, as the platform holds it. */
  readonly run: { readonly id: string; readonly simulations: number; readonly graded: number };
};

/** Waits for every one of these to be on screen, or says what was there. */
async function showing(
  terminal: TerminalRun,
  what: string,
  budgetMs: number,
  ...parts: readonly string[]
): Promise<string> {
  let held = "";
  const shown = await terminal.waitFor(() => {
    const screen = terminal.screen();
    if (!parts.every((part) => screen.includes(part))) return false;
    held = screen;
    return true;
  }, budgetMs);
  if (!shown) {
    throw new Error(
      `the wizard never got to ${what}\n\nlast screen:\n${redact(terminal.screen())}`,
    );
  }
  return held;
}

/**
 * Every name the walk has registered so far, held as a thing never to print.
 *
 * It reads the key this walk's own wizard just stored, in this walk's own home,
 * and asks the platform what is under it. Nothing here is a check and a look
 * that fails fails quietly: what it buys is that the screens printed after it
 * are redacted by this script, which is where that decision belongs.
 */
async function rememberNames(platform: HalfRealPlatform, home: string): Promise<void> {
  try {
    const held = JSON.parse(await readFile(path.join(home, "credentials"), "utf8")) as {
      key?: unknown;
    };
    if (typeof held.key !== "string") return;
    const agents = await askThePlatform(platform.url, held.key, "/api/agents");
    const items = Array.isArray(agents.body.items)
      ? (agents.body.items as Record<string, unknown>[])
      : [];
    for (const agent of items) {
      if (typeof agent.name === "string") secrets.push(agent.name);
    }
  } catch {
    // Nothing to add, and nothing that depends on it.
  }
}

async function walkOnce(options: {
  readonly label: string;
  readonly platform: HalfRealPlatform;
  readonly gate: Gate;
  readonly cookie: string;
  readonly drivenAgentId: string;
  readonly targetRepo: string;
  readonly key: string;
}): Promise<WalkOutcome> {
  const repository = await copyOfTheRepository(options.targetRepo, options.label);
  const home = await mkdtemp(path.join(tmpdir(), `egma-e2e-home-${options.label}-`));
  secrets.push(repository, home);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EGMA_HOME: home,
    BROWSER: NO_BROWSER,
    EGMA_RETELL_URL: options.gate.url,
  };
  // The key is typed at the screen that asks for it and is in nothing the
  // wizard — or the coding agent it starts, which inherits this — can read.
  delete env[KEY_VARIABLE];
  for (const other of OTHER_KEY_VARIABLES) delete env[other];
  delete env.EGMA_URL;
  delete env.EGMA_RETELL_AGENT_ID;
  delete env[TARGET_VARIABLE];

  const timings: Timing[] = [];
  let since = Date.now();
  const took = (phase: string): void => {
    timings.push({ phase, seconds: ((Date.now() - since) / 1000).toFixed(1) });
    since = Date.now();
  };

  const terminal = runInTerminal({
    command: process.execPath,
    args: [
      CLI_ENTRY,
      "--cwd",
      repository,
      "--url",
      options.platform.url,
      "--coding-agent",
      options.drivenAgentId,
    ],
    cwd: repository,
    env,
    // Wide, because the block the wizard leaves behind is lines rather than
    // sentences, and each of them has to survive whole into scrollback for a
    // triple-click to take it. A terminal wraps whatever will not fit, and a
    // check that read a wrapped line as two would be checking the width of the
    // window and not what egma wrote.
    cols: 200,
    rows: 34,
  });

  let chosenFrom = 1;

  try {
    /* [human 1] the keystroke at the intro */
    await showing(terminal, "the intro", BUDGET.intro, "[enter] begin");
    terminal.write("\r");
    took("intro");

    /* [human 2] the approval in a browser */
    const shown = await showing(terminal, "the login code", BUDGET.login, "Code:");
    const userCode = /Code: (\S+)/u.exec(shown)?.[1] ?? "";
    if (userCode === "") throw new Error("the wizard showed no code to approve");
    const status = await approve(options.platform.apiOrigin, options.cookie, userCode);
    check(status === "approved", `the instance approved the terminal (it said ${status})`);

    /* [human 3] the provider key */
    await showing(terminal, "the key box", BUDGET.key, "Paste your Retell API key");
    took("login and finding the agent");
    terminal.write(`${options.key}\r`);

    /* [human 3b, only when the account holds several] which agent */
    const nextScreen = await terminal.waitFor(
      () =>
        terminal.screen().includes("Which one do you want tested?") ||
        terminal.screen().includes("Do you already have test cases"),
      BUDGET.agent,
    );
    if (!nextScreen) {
      throw new Error(
        `the wizard never got past the key\n\nlast screen:\n${redact(terminal.screen())}`,
      );
    }
    if (terminal.screen().includes("Which one do you want tested?")) {
      const listed = /reaches (\d+) agents/u.exec(terminal.screen())?.[1] ?? "0";
      chosenFrom = Number(listed);
      // The first of them. Which agent is the developer's choice on a real
      // account, and any of them proves the same thing about the walk.
      terminal.write("\r");
    }
    took("connecting");

    /* [human 4] no, there are no test cases written down already */
    await showing(terminal, "the question about prior work", BUDGET.existing, "Do you already have");
    terminal.write("n");

    // Everything registered so far becomes a secret before the first screen is
    // printed. Whose agents these were is not worth printing and the line that
    // names them is filtered out below anyway — but a screen that is clean
    // because one filter happened to match is clean by luck, and this makes it
    // clean by redaction, which is the only kind that survives a wording change.
    await rememberNames(options.platform, home);

    /* [human 5] the keystroke at the gate */
    await showing(terminal, "the gate", BUDGET.gate, "[enter] run");
    const listing = terminal.screen();
    took("writing the tests");
    say("");
    say("── the gate, as it was drawn ─────────────────────────────");
    // Every line but the one naming the account's own agent: what is worth
    // printing is that a suite was written and what it covers.
    say(
      redact(
        listing
          .split("\n")
          .filter((line) => !line.includes("Run these against"))
          .join("\n"),
      ),
    );
    terminal.write("\r");

    /* the run: pushed, created, and every simulation on screen */
    await showing(terminal, "the run screen", BUDGET.run, "run run_", "simulation");
    took("pushing and starting the run");

    // The one thing this machine cannot do. Exactly one verdict is delivered,
    // because that is what the wizard waits for and the count in the exit line
    // has to be a number this check can name.
    const grading = gradeEveryRun(options.platform, { atMost: 1 });
    let offerShown: string;
    try {
      /* [human 6] the answer to the skill offer */
      offerShown = await showing(
        terminal,
        "the skill offer",
        BUDGET.offer,
        "Install the egma skill into",
        "[s] skip",
      );
    } finally {
      grading.stop();
    }
    took("the first verdict");

    // Where each key said it would write, before either key is pressed. Skip
    // is answered below, and nothing at either place may exist afterwards that
    // did not exist before.
    check(
      offerShown.includes("writes nothing at all"),
      "the offer said what skip does before it was answered",
    );

    terminal.write("s");

    const exitCode = await Promise.race([
      terminal.exited,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("the wizard never finished")), BUDGET.exit),
      ),
    ]);
    took("the offer and the exit");

    const held = JSON.parse(await readFile(path.join(home, "credentials"), "utf8")) as {
      url: string;
      key: string;
    };
    secrets.push(held.key);

    const started = options.platform.running.runs.at(-1);
    const simulations = options.platform.running.simulationsOf(started?.id);

    return {
      exitCode,
      exitLine: terminal.scrollback().trim(),
      leftBehind: terminal
        .scrollback()
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line !== ""),
      timings,
      credentials: held,
      repository,
      chosenFrom,
      run: {
        id: started?.id ?? "",
        simulations: simulations.length,
        graded: simulations.filter((one) => one.verdict !== null).length,
      },
    };
  } finally {
    await terminal.kill();
    await rm(home, { recursive: true, force: true });
  }
}

/* ── what landed ─────────────────────────────────────────────────────── */

type Asked = { readonly status: number; readonly body: Record<string, unknown> };

async function askThePlatform(
  url: string,
  key: string,
  at: string,
): Promise<Asked> {
  const answered = await fetch(`${url}${at}`, { headers: { authorization: `Bearer ${key}` } });
  const body = (await answered.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: answered.status, body };
}

async function assertWhatLanded(options: {
  readonly platform: HalfRealPlatform;
  readonly outcome: WalkOutcome;
  readonly key: string;
  readonly walk: number;
}): Promise<string> {
  const { platform, outcome } = options;
  const held = outcome.credentials;

  say("");
  say(`── what walk ${options.walk} left on the platform ─────────────────`);

  check(outcome.exitCode === 0, `the wizard exited 0 (it exited ${outcome.exitCode})`);
  check(held.url === platform.url, "the key is stored against the egma it signed in to");
  check(held.key.startsWith("egma_sk_"), "the key is one the instance really minted");

  // The real half: the key opens a real door on a real instance.
  const opened = await fetch(`${platform.apiOrigin}/api/keys`, {
    headers: { authorization: `Bearer ${held.key}` },
  });
  check(opened.status === 200, `the key works on the real instance (it answered ${opened.status})`);

  const agents = await askThePlatform(platform.url, held.key, "/api/agents");
  const items = Array.isArray(agents.body.items) ? (agents.body.items as Record<string, unknown>[]) : [];
  check(items.length === options.walk, `the platform holds ${items.length} agent(s) after walk ${options.walk}`);

  const agent = items.at(-1);
  const agentId = typeof agent?.id === "string" ? agent.id : "";
  const agentName = typeof agent?.name === "string" ? agent.name : "";
  secrets.push(agentName);
  check(agentId !== "", "the agent egma registered has an id");

  const one = await askThePlatform(platform.url, held.key, `/api/agents/${agentId}`);
  const connections = Array.isArray(one.body.connections)
    ? (one.body.connections as Record<string, unknown>[])
    : [];
  const connection = connections.at(-1);
  check(connections.length >= 1, `a connection is attached to it (${connections.length})`);
  check(connection?.type === "retell", `the connection is a retell one (${String(connection?.type)})`);
  check(
    connection?.modality === "voice" || connection?.modality === "chat",
    `the connection names a modality (${String(connection?.modality)})`,
  );
  check(
    connection?.credentialsHint === options.key.slice(-4),
    "the key was sealed on the platform, and only its last characters came back",
  );

  const tests = await askThePlatform(platform.url, held.key, "/api/tests");
  const landed = Array.isArray(tests.body.tests)
    ? (tests.body.tests as Record<string, unknown>[])
    : [];
  const pinned = landed.filter((test) => String(test.version_id).startsWith("tstv_"));
  check(
    pinned.length >= TESTS_ENOUGH * options.walk,
    `${pinned.length} tests are on the platform as frozen versions (wanted at least ${TESTS_ENOUGH * options.walk})`,
  );

  // And the same tests are files in the repository, each pinned to the version
  // the platform answered with.
  const folder = path.join(outcome.repository, "egma", "tests");
  const files = (await readdir(folder).catch(() => [] as string[])).filter((name) =>
    name.endsWith(".md"),
  );
  const versions = new Set(landed.map((test) => String(test.version_id)));
  let pinnedFiles = 0;
  for (const name of files) {
    const test = parseTestFile(
      await readFile(path.join(folder, name), "utf8"),
      name,
      name.replace(/\.md$/u, ""),
    );
    if (test.version !== null && versions.has(test.version)) pinnedFiles += 1;
  }
  check(
    pinnedFiles >= TESTS_ENOUGH,
    `${pinnedFiles} of the ${files.length} files in the repository pin a version the platform answered with`,
  );

  /* the run the walk ended in, and what it was over */

  const run = await askThePlatform(platform.url, held.key, `/api/runs/${outcome.run.id}`);
  const inTheRun = Array.isArray(run.body.simulations)
    ? (run.body.simulations as Record<string, unknown>[])
    : [];
  check(outcome.run.id.startsWith("run_"), "a run was created");
  check(
    inTheRun.length === pinnedFiles && inTheRun.length > 0,
    `the run holds one simulation per pushed test (${inTheRun.length} for ${pinnedFiles} files)`,
  );
  check(
    outcome.run.graded === 1,
    `one verdict landed, and the wizard left on it rather than on the suite (${outcome.run.graded})`,
  );
  check(
    outcome.run.simulations - outcome.run.graded > 0,
    `the suite was still going when the wizard closed (${outcome.run.simulations - outcome.run.graded} not judged)`,
  );

  /* the block it left in scrollback, each line whole */

  const address = `${platform.url}/runs/${outcome.run.id}`;
  const lines = outcome.leftBehind;
  check(
    lines.some((line) => line.startsWith("✓ Your first run is live")),
    "the headline says the run is live",
  );
  check(lines.includes(address), "the results address is a line, and the whole of it");
  check(
    !lines.some((line) => line.includes(address) && line !== address),
    "nothing shares the line the address is on",
  );
  check(new URL(address).search === "", "no token rides the address");
  check(!outcome.exitLine.includes("egma_sk_"), "no key is anywhere in what survived the screen");
  check(
    lines.includes("Tests are code now: egma/tests/ (committed). Edit them, then egma push."),
    "the line that says where the tests are survived whole",
  );
  check(
    lines.includes(
      'Hand your coding agent this: "Read egma/config.yaml, then egma --help — you can pull, push, and trigger runs from here."',
    ),
    "the handoff sentence survived whole",
  );
  check(
    lines.some((line) => line.startsWith("Nothing was installed.")),
    "skipping the offer was said out loud rather than passed over",
  );

  return agentName;
}

/* ── the check itself ────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const targetRepo = (process.env[TARGET_VARIABLE] ?? "").trim();
  const key = (process.env[KEY_VARIABLE] ?? "").trim();

  const missing = [
    ...(targetRepo === "" ? [TARGET_VARIABLE] : []),
    ...(key === "" ? [KEY_VARIABLE] : []),
  ];
  if (missing.length > 0) {
    const strict = requiresTarget();
    nothingWasVerified(strict, missing);
    if (strict) process.exitCode = 1;
    return;
  }
  secrets.push(key, targetRepo);

  if (!(await stat(targetRepo).then((found) => found.isDirectory(), () => false))) {
    say(`FAILED: ${TARGET_VARIABLE} does not point at a folder.`);
    process.exitCode = 1;
    return;
  }

  const drivenAgentId = argumentAfter("--coding-agent") ?? DEFAULT_DRIVEN_AGENT_ID;
  const walks = process.argv.includes("--again") ? 2 : 1;

  // A name and a launch this machine can really start, before anything else is
  // brought up: a typo in the agent id should cost a second, not a boot.
  const launch = launchForId(drivenAgentId);

  const real = path.join(process.env.HOME ?? "", ".egma", "credentials");
  const before = await stat(real).then((found) => `${found.mtimeMs}`, () => "absent");

  // The global scope of the skill offer is the home of whoever ran this, and
  // there is no throwaway one to point it at without taking the coding agent's
  // own login away from it. So the offer is skipped and this is the proof: the
  // developer's own skill file, exactly as it was before and after. Where that
  // file would be is asked of the same code the wizard asks, so a convention
  // that moves cannot leave this check watching the wrong path.
  const places = skillPlacesFor(drivenAgentId, {
    repository: targetRepo,
    home: process.env.HOME ?? "",
  });
  const stamp = async (file: string): Promise<string> =>
    stat(file).then((found) => `${found.mtimeMs}:${found.size}`, () => "absent");
  const skillBefore = places === null ? "absent" : await stamp(places.global);

  // The API writes a line per request, and one walk makes a great many.
  process.env.LOG_LEVEL ??= "silent";

  say(RULE);
  say("  The whole wizard, everything real, nobody at the keyboard");
  say(RULE);
  say(`  coding agent:  ${launch.name} (${launch.id})`);
  say(`  starts with:   ${launch.command} ${launch.args.join(" ")}`);
  say(
    `  its own env:   ${Object.keys(launch.env).length === 0 ? "nothing added" : Object.entries(launch.env).map(([name, value]) => `${name}=${value}`).join(", ")}`,
  );
  say(`  walks:         ${walks}`);
  say(`  Retell:        read-only, through a gate on this machine`);
  say("");

  let instance: Instance | undefined;
  let platform: HalfRealPlatform | undefined;
  let gate: Gate | undefined;
  const walked: WalkOutcome[] = [];
  const names: string[] = [];

  try {
    const bootedAt = Date.now();
    // The pages are left out: the CLI speaks the HTTP API and opens no page,
    // and a development server would put two minutes in front of every run.
    instance = await startInstance("cli-e2e", { web: false });
    gate = await openGate();
    platform = await startHalfRealPlatform(instance.origin);
    const cookie = await signUp(instance.origin);
    say(`Instance up in ${((Date.now() - bootedAt) / 1000).toFixed(1)}s.`);

    for (let walk = 1; walk <= walks; walk += 1) {
      say("");
      say(RULE);
      say(`  walk ${walk} of ${walks}`);
      say(RULE);

      const outcome = await walkOnce({
        label: `walk${walk}`,
        platform,
        gate,
        cookie,
        drivenAgentId,
        targetRepo,
        key,
      });
      walked.push(outcome);

      say("");
      say("── what it left behind ───────────────────────────────────");
      say(redact(outcome.exitLine));
      say("");
      say("── how long each phase took ──────────────────────────────");
      for (const timing of outcome.timings) {
        say(`  ${timing.phase.padEnd(28)} ${timing.seconds.padStart(7)}s`);
      }
      if (outcome.chosenFrom > 1) {
        say(`  (the account listed ${outcome.chosenFrom} agents, and the first was taken)`);
      }

      names.push(await assertWhatLanded({ platform, outcome, key, walk }));
    }

    say("");
    say("── what was asked of Retell, and what was refused ────────");
    for (const shape of [...new Set(gate.forwarded)]) {
      say(`  ${shape}  ×${gate.forwarded.filter((one) => one === shape).length}`);
    }
    say(`  refused: ${gate.refused.length}`);

    say("");
    say("── check ────────────────────────────────────────────────");
    check(gate.refused.length === 0, "nothing but reads was asked of Retell");
    check(
      platform.served.real > 0 && platform.served.fixture > 0,
      `the walk spoke to the real instance ${platform.served.real} times and to the endpoints it does not serve yet ${platform.served.fixture} times`,
    );

    if (walks > 1) {
      // A second walk against an egma that already holds the first one's
      // registration lands beside it rather than refusing.
      const [first, second] = names;
      check(
        second !== undefined && first !== undefined && second !== first,
        `the second walk registered a second agent (${redact(String(first))} then ${redact(String(second))})`,
      );
      check(
        second !== undefined && /-\d+$/u.test(second),
        "the second agent took the next free name rather than the taken one",
      );
    }

    const after = await stat(real).then((found) => `${found.mtimeMs}`, () => "absent");
    check(before === after, "nothing touched the credentials of whoever ran this");

    const skillAfter = places === null ? "absent" : await stamp(places.global);
    check(skillBefore === skillAfter, "skip wrote nothing into the home of whoever ran this");
    for (const outcome of walked) {
      const here = skillPlacesFor(drivenAgentId, {
        repository: outcome.repository,
        home: process.env.HOME ?? "",
      });
      const written = here === null ? false : (await stamp(here.project)) !== "absent";
      check(!written, "skip wrote nothing into the repository either");
    }
  } finally {
    for (const outcome of walked) {
      await rm(outcome.repository, { recursive: true, force: true });
    }
    await gate?.close();
    await platform?.close();
    await instance?.close();
  }

  say("");
  if (problems.length > 0) {
    for (const problem of problems) say(`FAILED: ${redact(problem)}`);
    process.exitCode = 1;
    return;
  }
  say(RULE);
  say("  PASSED — the whole wizard, driven end to end with nobody at the");
  say("  keyboard, put an agent, a connection and a suite of tests on a real");
  say("  egma, ran them, showed the first verdict, and left on it with the");
  say("  files in the repository and nothing written outside it.");
  say(RULE);
}

try {
  await main();
} catch (problem) {
  // The last place a path could get out. A copy that fails throws with the
  // folder it was copying in the message, and Node would print that whole
  // stack — so the stack goes through the same redaction as everything else
  // and the run ends as a failure rather than as an unhandled rejection.
  say("");
  say(redact(problem instanceof Error ? (problem.stack ?? problem.message) : String(problem)));
  process.exitCode = 1;
}

// A pseudo-terminal and an adapter's own process tree can both outlive what
// started them, and either keeps Node alive. This leaves on its own answer once
// what it printed has really gone out.
await new Promise<void>((resolve) => {
  process.stdout.write("", () => resolve());
});
process.exit(process.exitCode ?? 0);
