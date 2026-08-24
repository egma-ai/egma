/**
 * The smoke check: the whole wizard, everything real, nobody at the keyboard.
 *
 * One command drives `npx egma` from its first screen to a live run against the
 * real things it is meant to work against: the developer's own coding agent
 * over the protocol, a whole egma running on this machine — the real API, its
 * real agent, test and run endpoints, a real Postgres and a real ClickHouse —
 * the developer's own repository, and a real Retell account. No fixture agent,
 * no fake provider, and no stand-in for any part of egma.
 *
 * **Nobody types anything.** The wizard's five human moments are answered by
 * this check through a real pseudo-terminal: the keystroke at the intro, the
 * approval in a browser (made against the instance's own API, which is what the
 * page would have called), the provider key, the choice of agent when the
 * account holds several, and the keystroke at the gate.
 *
 * **The walk ends where the verdict would begin, and that is stated rather
 * than hidden.** Nothing on this machine claims a simulation yet, so no verdict
 * lands: the run stays pending and every simulation stays queued. The wizard
 * waits for the first verdict, so this check closes the window itself once the
 * run is live and the screen is drawn from it. That is a thing the product
 * means rather than a way around it — the run carries on on the platform, and
 * closing a terminal over a live run is how a developer leaves. What this
 * asserts in place of a verdict is that no verdict arrived: the feed is open,
 * empty and not done. The grader and the test-to-simulation bridge are what
 * land the rest, and when they do the first verdict comes through the same feed
 * the wizard is already following, with nothing here to change.
 *
 * **The skill offer is never reached**, because the wizard asks it after the
 * first verdict. Nothing here can therefore write outside the repository at
 * all, and this checks that: the developer's own skill file is exactly as it
 * was before the run.
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
 *   --coding-agent <id>   Which installed supported agent to drive.
 *   --again               Walk a second time against the same egma, which is
 *                         what proves a second walk over the same provider
 *                         agent finds the registration the first one made
 *                         rather than minting a second identity for it.
 *   --reach <text|phone>  Which way to take at the choice the wizard offers.
 *                         Default: text. `phone` selects a destination number
 *                         Retell routes to the chosen agent and asserts that
 *                         the connection egma made holds that number and
 *                         nothing else — no provider identifier, no credential.
 *   --retell-agent-name <text>
 *                         Take the agent whose name contains this, rather than
 *                         the first on the account. What pins a walk to one
 *                         agent on an account that holds several.
 *   --phone-number <e164> With --reach phone: which number to dial, when Retell
 *                         routes more than one to the chosen agent.
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
import { discoverCodingAgents, installedCodingAgent } from "../src/acp/coding-agents.ts";
import { folderPathsIn, readRepository } from "../src/folder/egma-folder.ts";
import { parseTestFile } from "../src/folder/test-file.ts";
import { readCredentials } from "../src/platform/credentials.ts";
import { skillPlacesFor } from "../src/skills/install.ts";
import { runInTerminal, type TerminalRun } from "../test/support/pty.ts";
import { NO_BROWSER, PASSWORD } from "./support/approving-person.ts";
import { ask } from "./support/asking.ts";
import { check, problems, redact, RULE, say, secrets } from "./support/report.ts";
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
  reach: 2 * 60_000,
  existing: 2 * 60_000,
  gate: 25 * 60_000,
  run: 5 * 60_000,
  exit: 5 * 60_000,
};

/** Which way this run takes at the choice the wizard offers. */
function reachWanted(): "text" | "phone" {
  return (argumentAfter("--reach") ?? "text").trim() === "phone" ? "phone" : "text";
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

/** How far down a list this check will walk before giving up on a row. */
const MOST_ROWS_WALKED = 200;

/** How long a picker is given to catch up with one keystroke. */
const SETTLES_IN = 600;

/**
 * Moves the highlight down a list until it is on the row this run wants.
 *
 * **One keystroke at a time, and each is waited out.** A terminal UI coalesces
 * renders: press down twice before the first frame is drawn and the selection
 * moves twice while the screen is painted once — so a loop reading the screen
 * between presses walks straight past the row it was looking for without ever
 * seeing it. That is not a hypothetical; it is what this did on a real account
 * of 37 agents before the wait was put in. Waiting after every press is what
 * makes one press worth one row on the screen as well as in the program.
 *
 * Answers whether it had to move at all, which is worth knowing: a run that
 * walked to a row is a run whose first row was not the one it wanted.
 */
async function walkTo(
  terminal: TerminalRun,
  wanted: RegExp,
  rows: number,
  what: string,
): Promise<boolean> {
  let moved = false;
  for (let step = 0; step <= Math.max(rows, 1); step += 1) {
    // Waited for rather than looked at once: a frame can arrive half-drawn, and
    // `waitFor` re-reads the screen on every chunk the terminal parses.
    if (wanted.test(terminal.screen())) return moved;
    if (await terminal.waitFor(() => wanted.test(terminal.screen()), SETTLES_IN)) {
      return moved;
    }
    moved = true;
    terminal.write("\u001B[B");
  }
  if (wanted.test(terminal.screen())) return moved;
  throw new Error(`the list never showed ${what}\n\nlast screen:\n${redact(terminal.screen())}`);
}

/** A string with nothing in it a regular expression would read as syntax. */
function escaped(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
      password: PASSWORD,
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

/**
 * What is never worth copying, and would make the copy enormous.
 *
 * `egma` is in the list for a different reason: this check walks a repository
 * *from nothing*, and a repository that has been walked before carries a
 * committed binding to whichever platform walked it. egma refuses to move a
 * committed binding — correctly — so a copy carrying one could never be walked
 * against the instance this check just started. Leaving it out is what makes
 * every walk here a first walk.
 */
const NOT_COPIED = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "target",
  "egma",
]);

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
  /** Which way this walk took, and what it took it with. */
  readonly reach: "text" | "phone";
  /**
   * Whether the wizard's coding-agent discovery pointed at the prompts this run
   * was aimed at, or had to be corrected at the picker. Real information about
   * the wizard, so it is recorded rather than smoothed over.
   */
  readonly promptsFound: string | null;
  /** Whether the agent had to be picked out of several by name. */
  readonly agentCorrected: boolean;
  /** The run the wizard started, as the run screen named it. */
  readonly runId: string;
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
async function rememberNames(origin: string, home: string): Promise<void> {
  try {
    // Read through egma's own reader rather than by parsing the file here:
    // keys are stored per platform origin, and a check that knew the file's
    // shape for itself would go quietly wrong the day the shape moved — which
    // is exactly what happened to this once.
    const held = await readCredentials(path.join(home, "credentials"), origin);
    if (held === null) return;
    const agents = await ask(origin, held.key, "/v1/agents");
    const items = Array.isArray(agents.body.agents)
      ? (agents.body.agents as Record<string, unknown>[])
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
  readonly instance: Instance;
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
      options.instance.origin,
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
  let promptsFound: string | null = null;
  let agentCorrected = false;
  const reach = reachWanted();
  const wantedAgent = (argumentAfter("--retell-agent-name") ?? "").trim();
  const wantedNumber = (argumentAfter("--phone-number") ?? "").trim();

  try {
    /* [human 1] the keystroke at the intro */
    await showing(terminal, "the intro", BUDGET.intro, "[enter] begin");
    terminal.write("\r");
    took("intro");

    /* [human 2] the approval in a browser */
    const shown = await showing(terminal, "the login code", BUDGET.login, "Code:");
    const userCode = /Code: (\S+)/u.exec(shown)?.[1] ?? "";
    if (userCode === "") throw new Error("the wizard showed no code to approve");
    const status = await approve(options.instance.origin, options.cookie, userCode);
    check(status === "approved", `the instance approved the terminal (it said ${status})`);

    /* [human 3] the provider key */
    await showing(terminal, "the key box", BUDGET.key, "Paste your Retell API key");
    // What the coding agent said it found, before the key box covers it.
    //
    // Recorded rather than acted on: whether discovery pointed at the right
    // prompts is real information about the wizard, and correcting the agent at
    // the picker is what a developer does. It is read off the card the wizard
    // draws, so a card that has already scrolled reads as "nothing reported" —
    // which is a gap in this reading and never a claim about what was found.
    // The whole of what the agent said is in the log the wizard names.
    promptsFound =
      /Prompts\s{2,}(.+?)\s*$/mu.exec(`${terminal.scrollback()}\n${terminal.screen()}`)?.[1]?.trim() ??
      null;
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
      // Which agent is the developer's choice on a real account. Named, this
      // walk walks past the rows until that name is the highlighted one; unnamed,
      // the first is taken and any of them proves the same thing about the walk.
      if (wantedAgent !== "") {
        agentCorrected = await walkTo(
          terminal,
          new RegExp(`\u203a[^\n]*${escaped(wantedAgent)}`, "u"),
          chosenFrom,
          `an agent called ${wantedAgent}`,
        );
      }
      terminal.write("\r");
    }

    /* [human 3c] text or phone, and for the phone the number to dial */
    await showing(terminal, "the choice of reach", BUDGET.reach, "How should Egma reach this agent?");
    if (reach === "phone") {
      terminal.write("\u001B[B");
      await showing(terminal, "the phone row", BUDGET.reach, "\u203a Phone");
    }
    terminal.write("\r");

    if (reach === "phone") {
      // The number screen appears only when Retell routes several to the agent.
      const picked = await terminal.waitFor(
        () =>
          terminal.screen().includes("Which number should Egma dial?") ||
          terminal.screen().includes("Do you already have test cases"),
        BUDGET.reach,
      );
      if (!picked) {
        throw new Error(
          `the wizard never got past the choice of reach\n\nlast screen:\n${redact(terminal.screen())}`,
        );
      }
      if (terminal.screen().includes("Which number should Egma dial?")) {
        if (wantedNumber === "") throw new Error("several numbers reach that agent; name one");
        await walkTo(
          terminal,
          new RegExp(`\u203a\\s*${escaped(wantedNumber)}`, "u"),
          MOST_ROWS_WALKED,
          `the number ${wantedNumber}`,
        );
        terminal.write("\r");
      }
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
    await rememberNames(options.instance.origin, home);

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
    const runScreen = await showing(
      terminal,
      "the run screen",
      BUDGET.run,
      "run run_",
      "simulation",
    );
    took("pushing and starting the run");
    const runId = /\brun_[0-9A-HJKMNP-TV-Z]{26}/u.exec(runScreen)?.[0] ?? "";
    if (runId === "") throw new Error("the run screen named no run");

    const held = await readCredentials(
      path.join(home, "credentials"),
      options.instance.origin,
    );
    if (held === null) throw new Error("the walk stored no key for the platform it signed in to");
    secrets.push(held.key);

    // What arrives in place of a verdict, asked while the wizard is still
    // following: nothing at all. Nothing on this machine claims a simulation,
    // so the feed is open, empty and not finished — and the wizard would wait
    // at this screen for as long as it was left to.
    const feed = await ask(
      options.instance.origin,
      held.key,
      `/v1/runs/${runId}/events?after=0`,
    );
    const arrived = Array.isArray(feed.body.events) ? (feed.body.events as unknown[]) : ["?"];
    check(
      arrived.length === 0 && feed.body.done === false,
      `no verdict arrived while the wizard followed: the feed is open, empty and not done (${arrived.length} events)`,
    );

    // And the window is closed over a live run, which is what a developer does
    // when they have seen enough: the suite carries on on egma, the exit line
    // still says where to open it, and nothing was installed because the offer
    // comes after the first verdict and the first verdict is what waits.
    terminal.write("\u0003");

    const exitCode = await Promise.race([
      terminal.exited,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("the wizard never finished")), BUDGET.exit),
      ),
    ]);
    took("the run, and the window closed over it");

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
      reach,
      promptsFound,
      agentCorrected,
      runId,
    };
  } finally {
    await terminal.kill();
    await rm(home, { recursive: true, force: true });
  }
}

/* ── what landed ─────────────────────────────────────────────────────── */

async function assertWhatLanded(options: {
  readonly instance: Instance;
  readonly outcome: WalkOutcome;
  readonly key: string;
  readonly walk: number;
}): Promise<string> {
  const { outcome } = options;
  const origin = options.instance.origin;
  const held = outcome.credentials;

  say("");
  say(`── what walk ${options.walk} left on the platform ─────────────────`);

  check(outcome.exitCode === 0, `the wizard exited 0 (it exited ${outcome.exitCode})`);
  // Read back for this origin and no other, which is the whole of what "stored
  // per platform" means: a key filed under a different platform would not have
  // come back at all.
  check(held.url === origin, "the key is stored against the egma it signed in to");
  check(held.key.startsWith("egma_sk_"), "the key is one the instance really minted");

  const opened = await fetch(`${origin}/api/keys`, {
    headers: { authorization: `Bearer ${held.key}` },
  });
  check(opened.status === 200, `the key works on the real instance (it answered ${opened.status})`);

  const agents = await ask(origin, held.key, "/v1/agents");
  const items = Array.isArray(agents.body.agents) ? (agents.body.agents as Record<string, unknown>[]) : [];
  // One, however many times this has walked: registering the same provider
  // agent again answers the registration that already exists rather than
  // minting a second identity for it, which is the rule a retry depends on.
  check(items.length === 1, `the platform holds ${items.length} agent(s) after walk ${options.walk}`);

  const agent = items.at(-1);
  const agentId = typeof agent?.id === "string" ? agent.id : "";
  const agentName = typeof agent?.name === "string" ? agent.name : "";
  secrets.push(agentName);
  check(agentId !== "", "the agent egma registered has an id");

  const one = await ask(origin, held.key, `/v1/agents/${agentId}`);
  const connections = Array.isArray(one.body.connections)
    ? (one.body.connections as Record<string, unknown>[])
    : [];
  const connection = connections.at(-1);
  check(connections.length >= 1, `a connection is attached to it (${connections.length})`);

  if (outcome.reach === "phone") {
    // **Only the connection that was chosen.** Creating both is the bug the
    // choice exists to kill, so the count is asserted rather than the last row.
    check(
      connections.length === 1 &&
        connection?.agentPlatform === "retell" &&
        connection?.connectionType === "phone_number" &&
        connection?.accessVariant === "phone_number.public_e164",
      `the walk created exactly one connection and it is the phone one (${connections
        .map((one) => String(one.productLabel))
        .join(", ")})`,
    );
    check(
      connection?.modality === "voice",
      `the phone connection is a voice one (${String(connection?.modality)})`,
    );

    // The number, and nothing else at all. No Retell, Twilio, LiveKit, SIP or
    // OpenAI credential, and no provider identifier — a phone connection is
    // provider-blind, which is what makes it the same connection whoever
    // answers.
    const config = (connection?.config ?? {}) as Record<string, unknown>;
    check(
      Object.keys(config).length === 1 && typeof config.phoneNumber === "string",
      `the phone connection holds only a number (${Object.keys(config).join(", ")})`,
    );
    check(
      /^\+[1-9]\d{1,14}$/u.test(String(config.phoneNumber)),
      `the number is E.164 (${String(config.phoneNumber)})`,
    );
    check(
      connection?.credentials_hint === null || connection?.credentials_hint === undefined,
      "no credential was sealed against the phone connection",
    );
    check(
      !JSON.stringify(one.body).includes(options.key),
      "the provider key is nowhere in what the platform holds for this agent",
    );
  } else {
    check(
      connections.length === 1 &&
        connection?.agent_platform === "retell" &&
        connection?.connection_type === "retell_chat_api" &&
        connection?.access_variant === "retell_chat_api.api_key",
      `the walk created exactly one connection and it is the retell one (${connections
        .map((one) => String(one.product_label))
        .join(", ")})`,
    );
    check(
      connection?.modality === "chat",
      `the text connection is a chat one (${String(connection?.modality)})`,
    );
    check(
      connection?.credentials_hint === options.key.slice(-4),
      "the key was sealed on the platform, and only its last characters came back",
    );
  }

  /* the committed file, which is the whole of what this repository points at */

  const written = await readRepository(folderPathsIn(outcome.repository));
  check(
    written.config.platform?.origin === origin,
    `the repository is bound to the platform it walked against (${String(written.config.platform?.origin)})`,
  );
  check(
    written.config.agent?.id === agentId &&
      written.config.connection?.id === String(connection?.id),
    "the agent and the connection egma made are the ones the file names",
  );
  const localSuite = written.suites.at(-1);
  check(
    localSuite !== undefined,
    `the repository holds a direct test suite (${String(localSuite?.manifest.name)})`,
  );
  check(
    !JSON.stringify(written).includes(options.key),
    "and no supplied secret is anywhere in it",
  );

  const tests = await ask(
    origin,
    held.key,
    `/v1/tests?projectId=${encodeURIComponent(String(agent?.projectId))}&suiteId=${encodeURIComponent(String(localSuite?.manifest.id))}`,
  );
  const landed = Array.isArray(tests.body.tests)
    ? (tests.body.tests as Record<string, unknown>[])
    : [];
  const pinned = landed.filter((test) => String(test.versionId).startsWith("tstv_"));
  check(
    pinned.length >= TESTS_ENOUGH,
    `${pinned.length} tests are on the platform as frozen versions (wanted at least ${TESTS_ENOUGH})`,
  );

  // And the same tests are files in the repository, each pinned to the version
  // the platform answered with.
  const folder = localSuite?.root ?? path.join(outcome.repository, "egma", "tests", "missing");
  const files = (await readdir(folder).catch(() => [] as string[])).filter((name) =>
    name.endsWith(".md"),
  );
  const versions = new Set(landed.map((test) => String(test.versionId)));
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

  const run = await ask(origin, held.key, `/v1/runs/${outcome.runId}`);
  const inTheRun: Record<string, unknown>[] = [];
  let simulationCursor = "";
  do {
    const query = simulationCursor === ""
      ? ""
      : `?pageToken=${encodeURIComponent(simulationCursor)}`;
    const page = await ask(
      origin,
      held.key,
      `/v1/runs/${outcome.runId}/simulations${query}`,
    );
    if (Array.isArray(page.body.simulations)) {
      inTheRun.push(...(page.body.simulations as Record<string, unknown>[]));
    }
    simulationCursor = typeof page.body.nextPageToken === "string"
      ? page.body.nextPageToken
      : "";
  } while (simulationCursor !== "");
  check(outcome.runId.startsWith("run_"), "a run was created");
  check(
    inTheRun.length === pinnedFiles && inTheRun.length > 0,
    `the run holds one simulation per pushed test (${inTheRun.length} for ${pinnedFiles} files)`,
  );
  // What waits, stated as a check rather than as a comment: nothing claims a
  // simulation on this machine, so the run is still pending and not one
  // simulation has been judged. The day the grader and the bridge land, these
  // two lines are the ones that change.
  check(
    run.body.status === "pending",
    `the run is pending, because nothing conducts a simulation yet (${String(run.body.status)})`,
  );
  check(
    inTheRun.every((one) => one.status === "queued" && one.verdict === null),
    `every simulation is queued and unjudged (${inTheRun.filter((one) => one.status === "queued").length} of ${inTheRun.length})`,
  );

  /* the block it left in scrollback, each line whole */

  // The address the platform issued, not one built here out of its parts. A
  // reconstruction would be this check agreeing with itself about where a run
  // lives; what a developer triple-clicks is whatever came back on the run.
  const address = String(run.body.resultsUrl ?? "");
  const lines = outcome.leftBehind;
  check(address.startsWith("http"), `the run came back with an address (${address})`);
  check(
    lines.some((line) =>
      line.startsWith(`✓ Your first run is live — ${inTheRun.length} simulations, none graded yet.`),
    ),
    "the headline says the run is live, and says plainly that nothing is graded yet",
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
  // Nothing about the skill is in what survived, because the offer comes after
  // the first verdict and the first verdict is what waits. A line about it
  // here would mean the wizard had offered something this walk never reached.
  check(
    !lines.some((line) => line.includes("Egma skill")),
    "nothing was offered or installed: the walk closed before the offer",
  );

  return agentId;
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

  const drivenAgentId = argumentAfter("--coding-agent") ?? "claude";
  const walks = process.argv.includes("--again") ? 2 : 1;

  // A name and a launch this machine can really start, before anything else is
  // brought up: a typo in the agent id should cost a second, not a boot.
  const selectedAgent = installedCodingAgent(await discoverCodingAgents(), drivenAgentId);
  if (selectedAgent === null) {
    throw new Error(`The supported coding agent "${drivenAgentId}" is not installed.`);
  }
  const launch = selectedAgent.launch;

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
  // The installer decides where a skill lands, so what is watched here is the
  // one place every agent's global install goes through: the canonical skills
  // store under the home of whoever ran this.
  const globalSkills = (at: string): string => path.join(at, ".agents", "skills");
  const skillBefore = places === null ? "absent" : await stamp(globalSkills(places.home));

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
  say(`  reach:         ${reachWanted()}`);
  say(`  Retell:        read-only, through a gate on this machine`);
  say("");

  let instance: Instance | undefined;
  let gate: Gate | undefined;
  const walked: WalkOutcome[] = [];
  const registered: string[] = [];

  try {
    const bootedAt = Date.now();
    // The pages are left out: the CLI speaks the HTTP API and opens no page,
    // and a development server would put two minutes in front of every run.
    instance = await startInstance("cli-e2e", { web: false });
    gate = await openGate();
    const cookie = await signUp(instance.origin);
    say(`Instance up in ${((Date.now() - bootedAt) / 1000).toFixed(1)}s.`);

    for (let walk = 1; walk <= walks; walk += 1) {
      say("");
      say(RULE);
      say(`  walk ${walk} of ${walks}`);
      say(RULE);

      const outcome = await walkOnce({
        label: `walk${walk}`,
        instance,
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
        say(
          `  (the account listed ${outcome.chosenFrom} agents, and the one taken ${
            outcome.agentCorrected ? "was picked out by name" : "was the first"
          })`,
        );
      }
      say("");
      say("── what the coding agent found, and which way was taken ──");
      say(`  reach:    ${outcome.reach}`);
      say(`  prompts:  ${redact(outcome.promptsFound ?? "nothing reported")}`);
      say(
        `  agent:    ${outcome.agentCorrected ? "corrected at the picker" : "taken as discovery left it"}`,
      );

      registered.push(await assertWhatLanded({ instance, outcome, key, walk }));
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

    if (walks > 1) {
      // A second walk over the same platform agent finds the registration the
      // first one made. Two identities for one voice agent would split a
      // team's results history in half, so a retry has to land on the first.
      const [first, second] = registered;
      check(
        second !== undefined && first !== undefined && second === first,
        `the second walk found the first walk's registration (${redact(String(first))} then ${redact(String(second))})`,
      );
    }

    const after = await stat(real).then((found) => `${found.mtimeMs}`, () => "absent");
    check(before === after, "nothing touched the credentials of whoever ran this");

    const skillAfter = places === null ? "absent" : await stamp(globalSkills(places.home));
    check(skillBefore === skillAfter, "nothing was written into the home of whoever ran this");
    for (const outcome of walked) {
      const here = skillPlacesFor(drivenAgentId, {
        repository: outcome.repository,
        home: process.env.HOME ?? "",
      });
      const written =
        here === null
          ? false
          : (await stamp(path.join(here.repository, "skills-lock.json"))) !== "absent";
      check(!written, "and nothing was written into the repository either");
    }
  } finally {
    for (const outcome of walked) {
      await rm(outcome.repository, { recursive: true, force: true });
    }
    await gate?.close();
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
  say("  egma, started a run over them, and followed it live, with the");
  say("  files in the repository and nothing written outside it.");
  say("");
  say("  What is not proven here, and is not faked: the verdict. Nothing");
  say("  claims a simulation on this machine, so the run stays pending and");
  say("  every simulation stays queued. When the grader and the");
  say("  test-to-simulation bridge land, the first verdict arrives through");
  say("  the feed this walk was already following, and the wizard's last");
  say("  two screens — the offer and the graded exit line — are what this");
  say("  check gains.");
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
