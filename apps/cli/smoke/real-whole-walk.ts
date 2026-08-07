/**
 * The smoke check: the whole walk, against a fully real egma.
 *
 * One command signs a machine in, registers a voice agent, pushes a suite of
 * tests and starts a run over the exact versions it pushed — every request to
 * a real egma: a real Postgres, a real ClickHouse, the real API application,
 * the real pages, and the built `egma` command in a real process. There is no
 * stand-in for any part of egma anywhere in this file. What the walk reaches is
 * what a self-hoster's own instance answers.
 *
 * **The client is configured here and never edited.** The only things this
 * check tells `egma` are the four a developer tells it: which egma (`--url`),
 * where to keep its key (`EGMA_HOME`), which browser to open (`BROWSER`), and
 * which Retell to talk to (`EGMA_RETELL_URL`). If this walk ever needed a
 * change inside `apps/cli/src` to pass, that would be the API and the client
 * having drifted apart — a thing to stop and say out loud, never a thing to
 * patch here.
 *
 * **The one thing outside egma is the vendor.** With `RETELL_API_KEY` set, the
 * walk registers a real agent off a real Retell account, read-only behind the
 * allow-list gate in `support/retell-gate.ts`. With no key set, a stand-in
 * Retell runs on this machine so that anybody can run this check with nothing
 * but Docker and Node. Which of the two ran is printed, every time.
 *
 * **What waits is named rather than faked.** Nothing on this machine claims a
 * simulation yet, so no verdict lands: the run stays pending and every
 * simulation stays queued. This check says so in its own summary, so a green
 * run of it can never be read as the whole ten-minute walk. It follows the run
 * the way any follower does — one numbered page at a time — and the day the
 * grader and the test-to-simulation bridge land, the first verdict arrives
 * through this same feed with nothing here to change.
 *
 * Run it with two commands, from the repository root:
 *
 *   pnpm db:up
 *   pnpm --filter egma-cli smoke:walk
 *
 * The first starts the Postgres and the ClickHouse; the second builds
 * everything this needs and walks. Set `RETELL_API_KEY` in the environment of
 * the second to register against your own Retell account instead of the
 * stand-in.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "playwright-core";

import { openBrowser } from "../../api/test/support/browser.ts";
import { startInstance, type Instance } from "../../api/test/support/instance.ts";
import { folderPathsIn, updateConfig } from "../src/folder/egma-folder.ts";
import { parseTestFile } from "../src/folder/test-file.ts";
import { startFakeRetell, type FakeRetell } from "../test/support/fake-retell.ts";
import { openGate, type Gate } from "./support/retell-gate.ts";

const CLI_ENTRY = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** The committed name for the key a developer runs this against their own account with. */
const KEY_VARIABLE = "RETELL_API_KEY";

/** A browser egma must not open: this check drives its own. */
const NO_BROWSER = "/usr/bin/true";

const PASSWORD = "a-long-enough-password";

const RULE = "─".repeat(58);

// The API writes a line per request, and one walk makes a great many.
process.env.LOG_LEVEL ??= "silent";

const problems: string[] = [];
/** Everything that must never appear in what this prints. */
const secrets: string[] = [];

/**
 * The text with everything that names somebody's account or machine taken out.
 *
 * A passing run of this gets pasted into reviews. Against a real Retell
 * account the agent's name and its identifier are that account's business, and
 * egma names its own agent after the vendor's — so all of them are collected
 * as they are learned and none of them survives into a line.
 */
function redact(text: string): string {
  return [...new Set(secrets)]
    .filter((one) => one.length > 3)
    .sort((left, right) => right.length - left.length)
    .reduce((held, one) => held.split(one).join("<redacted>"), text);
}

function say(message: string): void {
  process.stdout.write(`${redact(message)}\n`);
}

function check(condition: boolean, what: string): void {
  say(`${condition ? "  ok  " : "FAILED"}  ${what}`);
  if (!condition) problems.push(what);
}

async function waitUntil(
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

/* ── the command, as a developer runs it ─────────────────────────────── */

type Ran = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Every `key: value` line, in the order they were printed. */
  readonly said: ReadonlyMap<string, readonly string[]>;
};

/** The `key: value` lines egma prints, gathered by key. */
function factsIn(stdout: string): Map<string, string[]> {
  const said = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf(": ");
    if (at <= 0) continue;
    const key = line.slice(0, at);
    if (key === "" || /[^a-z_-]/u.test(key)) continue;
    said.set(key, [...(said.get(key) ?? []), line.slice(at + 2)]);
  }
  return said;
}

function first(said: ReadonlyMap<string, readonly string[]>, key: string): string {
  return said.get(key)?.[0] ?? "";
}

type Started = {
  /** Everything it has printed so far. */
  out(): string;
  readonly done: Promise<Ran>;
  /** Stops it, for a check that gave up on it before it ended. */
  stop(): void;
};

function start(
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly stdin?: string },
): Started {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // Closed either way: a verb that reads standard input waits on it, and one
  // that does not never looks.
  child.stdin?.end(options.stdin ?? "");

  const done = new Promise<Ran>((resolve) => {
    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr, said: factsIn(stdout) });
    });
  });

  return {
    out: () => stdout,
    done,
    stop: () => {
      child.kill("SIGINT");
    },
  };
}

async function egma(
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly stdin?: string },
): Promise<Ran> {
  return start(args, options).done;
}

/**
 * The number a verb answered with — and, when it is the wrong one, whatever it
 * said about that on standard error.
 *
 * A smoke that failed with a bare number sends whoever reran it looking for the
 * reason egma had already written down.
 */
function exited(ran: Ran, verb: string, wanted = 0): void {
  check(ran.code === wanted, `${verb} exited ${wanted} (it exited ${ran.code})`);
  const said = ran.stderr.trim();
  if (ran.code !== wanted && said !== "") {
    for (const line of said.split("\n")) say(`        ${line}`);
  }
}

/* ── the person in the browser ───────────────────────────────────────── */

/**
 * The signup and the approval, as a person does them.
 *
 * The login smoke beside this one drives these same pages as its subject and
 * asserts what they say; here they are a step on the way to the walk, so this
 * walks them and asserts nothing about them. What matters here is that the key
 * the terminal ends up holding was approved by a real person in a real browser
 * on this instance's own pages.
 */
async function signUpAndApprove(page: Page, approveUrl: string): Promise<void> {
  await page.goto(approveUrl);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/signup\?next=/u);

  await page.fill("#email", "ada@acme.example");
  await page.fill("#password", PASSWORD);
  await page.fill("#organizationName", "Acme");
  await page.fill("#projectName", "Default");
  await page.click('button[type="submit"]');

  await page.waitForURL(/\/device\/approve\?user_code=/u);
  await page.getByRole("button", { name: "Approve" }).click();
  await page.waitForURL(/\/device\/success/u);
}

/* ── the tests this walk pushes ──────────────────────────────────────── */

/**
 * Three tests, written by hand.
 *
 * A coding agent writes these in the real walk, and the wizard's own smoke
 * proves that half against a real one. What this check is about starts where
 * the files exist: they are pushed, frozen into versions, and a run is pinned
 * to exactly those versions. So the files are written here, in the format the
 * folder documents, and nothing about them is generated.
 *
 * No `personas:` line on any of them, deliberately: a test naming nobody takes
 * the project's default persona, which signup seeds — which is what makes a
 * first suite cost no persona authoring at all.
 */
const TESTS: readonly { readonly name: string; readonly body: string }[] = [
  {
    name: "opening-hours",
    body: [
      "## Scenario",
      "The caller asks when the workshop is open on a Saturday.",
      "## Expected behaviors",
      "1. The agent gives the Saturday hours.",
      "2. The agent does not invent a public holiday.",
    ].join("\n"),
  },
  {
    name: "missed-collection-reschedule",
    body: [
      "## Scenario",
      "The caller missed yesterday's collection and wants another slot this week.",
      "They are short of time and already annoyed.",
      "## Expected behaviors",
      "1. The agent acknowledges the missed collection without blaming anyone.",
      "2. The agent offers at least two other times.",
      "3. The agent repeats the new time back before it ends.",
    ].join("\n"),
  },
  {
    name: "price-question",
    body: [
      "## Scenario",
      "The caller asks what a full rebind costs.",
      "## Expected behaviors",
      "1. The agent says a person will confirm the price.",
      "2. The agent never quotes a number of its own.",
    ].join("\n"),
  },
];

function testFile(name: string, body: string): string {
  return `---\nname: ${name}\n---\n${body}\n`;
}

/* ── what the platform holds, asked as any client would ──────────────── */

type Asked = { readonly status: number; readonly body: Record<string, unknown> };

async function ask(
  origin: string,
  key: string,
  at: string,
  method: "GET" | "POST" = "GET",
): Promise<Asked> {
  const answered = await fetch(`${origin}${at}`, {
    method,
    headers: { authorization: `Bearer ${key}` },
  });
  const body = (await answered.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: answered.status, body };
}

function itemsOf(body: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const held = body[key];
  return Array.isArray(held) ? (held as Record<string, unknown>[]) : [];
}

/* ── the walk ────────────────────────────────────────────────────────── */

/** A Retell to register against, and the plain words for which one it is. */
type Vendor = {
  readonly url: string;
  readonly key: string;
  readonly what: string;
  close(): Promise<void>;
};

/**
 * The developer's own Retell account, or a stand-in with one agent on it.
 *
 * Real when a key is in the environment, and read-only when it is: every
 * request goes through the allow-list gate, which forwards the listing and the
 * reads behind it and refuses everything else. The gate is why a check that
 * touches somebody's live account is a thing anybody can run.
 */
async function reachRetell(): Promise<Vendor> {
  const key = (process.env[KEY_VARIABLE] ?? "").trim();
  if (key !== "") {
    secrets.push(key);
    const gate: Gate = await openGate();
    return {
      url: gate.url,
      key,
      what: "the real Retell account in the environment, read-only through a gate",
      close: () => gate.close(),
    };
  }

  const standIn: FakeRetell = await startFakeRetell({
    keys: ["key_a-stand-in-retell-key"],
    agents: [
      {
        agent_id: "agent_stand_in_0001",
        agent_name: "order-line",
        voice_id: "11labs-Adrian",
        response_engine: { type: "retell-llm", llm_id: "llm_stand_in_0001" },
      },
    ],
    llms: [
      {
        llm_id: "llm_stand_in_0001",
        general_prompt: "You answer the order line. Never quote a price.\n",
        general_tools: [{ type: "end_call" }],
      },
    ],
  });
  return {
    url: standIn.url,
    key: "key_a-stand-in-retell-key",
    what: `a stand-in Retell on this machine (set ${KEY_VARIABLE} for your own account)`,
    close: () => standIn.close(),
  };
}

/** Signing in: the device flow, approved by a person in a real browser. */
async function signIn(
  instance: Instance,
  page: Page,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly url: string; readonly key: string }> {
  say("");
  say("── signing in ────────────────────────────────────────────");

  const login = start(["login", "--url", instance.origin], { env });
  await waitUntil(() => login.out().includes("approve_url: "), 120_000, "the address to approve at");
  const approveUrl = /approve_url: (\S+)/u.exec(login.out())?.[1] ?? "";
  check(
    approveUrl.startsWith(instance.origin) && approveUrl.includes("user_code="),
    "egma login printed an address on this instance, with the code already in it",
  );

  await signUpAndApprove(page, approveUrl);

  const ran = await login.done;
  exited(ran, "egma login");
  check(first(ran.said, "status") === "stored", "egma login said it stored a key");

  const file = path.join(String(env.EGMA_HOME), "credentials");
  const held = JSON.parse(await readFile(file, "utf8")) as { url: string; key: string };
  secrets.push(held.key);
  const mode = ((await stat(file)).mode & 0o777).toString(8);
  check(mode === "600", `the credentials file is 0600 (it is 0${mode})`);
  check(held.url === instance.origin, "the key is stored against the egma it signed in to");
  check(held.key.startsWith("egma_sk_"), "the key is one this instance really minted");

  const opened = await ask(instance.origin, held.key, "/api/keys");
  check(opened.status === 200, `the key opens a real door (it answered ${opened.status})`);

  return held;
}

/** Registering: the agent, and the way egma reaches it, in one request. */
async function register(
  instance: Instance,
  vendor: Vendor,
  repository: string,
  env: NodeJS.ProcessEnv,
  key: string,
): Promise<{ readonly agentId: string; readonly connectionId: string }> {
  say("");
  say("── registering the voice agent ───────────────────────────");

  let ran = await egma(["connect", "--cwd", repository], { env, stdin: `${vendor.key}\n` });

  // A real account may hold several agents, and egma refuses to guess which
  // one. Any of them proves the same thing about the walk, so the first is
  // taken — which is the choice a developer makes at the same screen.
  if (ran.code === 5) {
    const listed = ran.said.get("retell_agent")?.[0]?.split(" ")[0] ?? "";
    secrets.push(listed);
    say(`  (the account holds several agents; the first was taken)`);
    ran = await egma(["connect", "--cwd", repository, "--retell-agent", listed], {
      env,
      stdin: `${vendor.key}\n`,
    });
  }

  // Everything that names the account, before a single line of this is printed.
  for (const name of ["retell_agent_id", "agent_name", "connection_name"]) {
    for (const value of ran.said.get(name) ?? []) secrets.push(value);
  }

  exited(ran, "egma connect");
  check(first(ran.said, "status") === "connected", "egma connect said it connected");
  check(first(ran.said, "registration") === "created", "the registration was a fresh one");
  check(first(ran.said, "connection_type") === "retell", "the connection is a retell one");
  check(
    ["voice", "chat"].includes(first(ran.said, "connection_modality")),
    `the connection names a modality (${first(ran.said, "connection_modality")})`,
  );

  const agentId = first(ran.said, "agent_id");
  const connectionId = first(ran.said, "connection_id");
  check(agentId.startsWith("agt_"), "egma minted an agent id");
  check(connectionId.startsWith("con_"), "egma minted a connection id");

  // And the same thing, read back off the real API rather than off the
  // terminal that printed it.
  const one = await ask(instance.origin, key, `/api/agents/${agentId}`);
  const connections = itemsOf(one.body, "connections");
  check(one.status === 200, `the agent is on the platform (it answered ${one.status})`);
  check(connections.length === 1, `one connection is attached to it (${connections.length})`);
  check(
    connections[0]?.credentials_hint === vendor.key.slice(-4),
    "the vendor key was sealed, and only its last four characters came back",
  );
  check(
    !JSON.stringify(one.body).includes(vendor.key),
    "no read of the agent carries the vendor key",
  );

  return { agentId, connectionId };
}

/** The folder, the files in it, and the push that freezes them into versions. */
async function pushTheTests(
  instance: Instance,
  repository: string,
  env: NodeJS.ProcessEnv,
  key: string,
  registered: { readonly agentId: string; readonly connectionId: string },
): Promise<void> {
  say("");
  say("── the folder, and the tests pushed ──────────────────────");

  const made = await egma(["init", "--cwd", repository, "--suite", "onboarding"], { env });
  exited(made, "egma init");
  check(first(made.said, "status") === "created", "egma init made the folder");

  // The two ids egma connect printed, written into the folder that points at
  // them. It is the one step the verbs leave to whoever is driving — the
  // wizard does it for you — and it is the developer's own committed file.
  const paths = folderPathsIn(repository);
  await updateConfig(paths.config, {
    agent: { name: "agent-under-test", id: registered.agentId },
    connection: { name: "retell-1", id: registered.connectionId },
  });

  for (const test of TESTS) {
    await writeFile(path.join(paths.tests, `${test.name}.md`), testFile(test.name, test.body), "utf8");
  }

  const pushed = await egma(["push", "--cwd", repository], { env });
  exited(pushed, "egma push");
  check(first(pushed.said, "status") === "pushed", "egma push said it pushed");
  check(
    first(pushed.said, "tests") === String(TESTS.length),
    `egma push says it uploaded ${TESTS.length} tests (it said ${first(pushed.said, "tests")})`,
  );

  const versions = pushed.said.get("version") ?? [];
  check(
    versions.length === TESTS.length && versions.every((one) => one.startsWith("tstv_")),
    `every test came back with a frozen version (${versions.length} of ${TESTS.length})`,
  );

  // The files now pin what the platform froze, which is the whole point of
  // them being files: what ran is readable in the repository afterwards.
  const files = (await readdir(paths.tests)).filter((name) => name.endsWith(".md")).sort();
  let pinned = 0;
  for (const name of files) {
    const file = parseTestFile(
      await readFile(path.join(paths.tests, name), "utf8"),
      name,
      name.replace(/\.md$/u, ""),
    );
    if (file.version !== null && versions.includes(file.version)) pinned += 1;
  }
  check(
    pinned === TESTS.length,
    `${pinned} of the ${files.length} files pin a version the platform answered with`,
  );

  const listed = await ask(instance.origin, key, "/api/tests");
  const items = itemsOf(listed.body, "items");
  check(
    items.length === TESTS.length,
    `the platform lists ${items.length} tests under this key (wanted ${TESTS.length})`,
  );
  check(
    items.every((test) => versions.includes(String(test.version_id))),
    "every test the platform lists is at the version the push pinned",
  );
}

/**
 * The run: created over those exact versions, then followed live.
 *
 * Two halves, and the second is the one worth reading. First the run exists
 * and the terminal says what it pinned. Then `egma run` follows it — and
 * because nothing on this machine claims a simulation, the honest thing to
 * prove is both sides of that: the feed stays empty while the run is queued,
 * and a change that really does happen arrives through it and is applied. The
 * only change this machine can make to a run is to cancel it, so that is the
 * one used — and a cancel is judged as `canceled`, never as anything passing.
 */
async function runAndFollow(
  instance: Instance,
  repository: string,
  env: NodeJS.ProcessEnv,
  key: string,
): Promise<void> {
  say("");
  say("── the run, created and followed ─────────────────────────");

  const running = start(["run", "--cwd", repository], { env });
  try {
    await waitUntil(
      () => /^run: run_\S+$/mu.test(running.out()) && /^results: \S+$/mu.test(running.out()),
      120_000,
      "the run to be created",
    );
  } catch (cause) {
    // A follower left polling an instance that is about to be torn down would
    // outlive this check and print into somebody's terminal afterwards.
    running.stop();
    throw cause;
  }

  const runId = /^run: (\S+)$/mu.exec(running.out())?.[1] ?? "";
  const results = /^results: (\S+)$/mu.exec(running.out())?.[1] ?? "";
  const pins = (running.out().match(/^pin: .+$/gmu) ?? []).length;

  check(runId.startsWith("run_"), "a run was created");
  check(pins === TESTS.length, `it pinned ${pins} versions, and said which (${TESTS.length} tests)`);
  check(
    results.startsWith(`${instance.origin}/runs/`) && results.endsWith(runId),
    "the run came back with a results address on this instance",
  );
  check(new URL(results).search === "", "no token rides the results address");

  const created = await ask(instance.origin, key, `/api/runs/${runId}`);
  const simulations = itemsOf(created.body, "simulations");
  check(created.status === 200, `the run is on the platform (it answered ${created.status})`);
  check(
    created.body.expected_simulation_count === TESTS.length,
    `the run expects one simulation per test (${String(created.body.expected_simulation_count)})`,
  );
  check(
    simulations.length === TESTS.length && simulations.every((one) => one.status === "queued"),
    `every simulation is queued (${simulations.filter((one) => one.status === "queued").length} of ${simulations.length})`,
  );
  check(created.body.status === "pending", `the run is pending (${String(created.body.status)})`);

  // The follower's own view of the same thing: nothing to report, not done,
  // and a cursor that has not moved. This is what waiting for a verdict that
  // nothing writes actually looks like.
  const empty = await ask(instance.origin, key, `/api/runs/${runId}/events?after=0`);
  check(
    itemsOf(empty.body, "events").length === 0 && empty.body.next === 0 && empty.body.done === false,
    "the events feed is open and empty: nothing has happened to this run yet",
  );

  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const still = await ask(instance.origin, key, `/api/runs/${runId}/events?after=0`);
  check(
    itemsOf(still.body, "events").length === 0 && still.body.done === false,
    "and three seconds later it is still empty — nothing claims a simulation on this machine",
  );
  check(
    /^simulation: \S+ \S+ queued$/mu.test(running.out()) && !running.out().includes("verdict: "),
    "the terminal is showing queued simulations and no verdict at all",
  );

  // The one change this machine can make to a live run, made while a follower
  // is watching. What it proves is the feed: the change is numbered, it
  // arrives at the client that was already following, and the client acts on
  // it without being restarted.
  const canceled = await ask(instance.origin, key, `/api/runs/${runId}/cancel`, "POST");
  check(canceled.status === 200, `the run was canceled through the API (${canceled.status})`);

  const ran = await Promise.race([
    running.done,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("the follower never noticed the run had finished")), 30_000),
    ),
  ]);

  exited(ran, "egma run, when the run finished,");
  check(
    first(ran.said, "status") === "canceled",
    `the follower ended on the run's own status (${first(ran.said, "status")})`,
  );
  const moved = (ran.stdout.match(/^simulation: \S+ \S+ canceled$/gmu) ?? []).length;
  check(
    moved === TESTS.length,
    `it drew every simulation moving to canceled, live, off the feed (${moved} of ${TESTS.length})`,
  );
  check(
    first(ran.said, "passed") === "0" && first(ran.said, "failed") === "0",
    "nothing passed and nothing failed: a canceled run counts as neither",
  );

  const after = await ask(instance.origin, key, `/api/runs/${runId}/events?after=0`);
  const events = itemsOf(after.body, "events");
  const numbers = events.map((one) => Number(one.seq));
  check(
    numbers.length === TESTS.length + 1 &&
      numbers.every((seq, index) => seq === index + 1),
    `the feed numbered every change densely, one per change (${numbers.join(",")})`,
  );
  check(after.body.done === true, "the feed says the run is finished");

  const resumed = await ask(
    instance.origin,
    key,
    `/api/runs/${runId}/events?after=${numbers.at(-1) ?? 0}`,
  );
  check(
    itemsOf(resumed.body, "events").length === 0 &&
      resumed.body.next === numbers.at(-1) &&
      resumed.body.done === true,
    "a follower asking again from where it got to is told nothing new, and told it is done",
  );
}

/* ── the check itself ────────────────────────────────────────────────── */

function proven(): void {
  say("");
  say(RULE);
  say("  PASSED — the whole walk, against a fully real egma");
  say(RULE);
  say("  Proven here, every step of it against the real API on a real");
  say("  Postgres and a real ClickHouse, with the client configured and");
  say("  never edited:");
  say("");
  say("    · signing in — the device flow, approved by a person in a real");
  say("      browser, leaving a key that opens a real door");
  say("    · registering the voice agent and the way egma reaches it, with");
  say("      the vendor key sealed on arrival");
  say("    · the tests pushed, each file pinned to the version egma froze");
  say("    · the run created over exactly those versions");
  say("    · the run followed live through the numbered events feed, and a");
  say("      change applied by the follower as it arrived");
  say("");
  say("  Waiting, and deliberately not faked here:");
  say("");
  say("    · no verdict. Nothing claims a simulation on this machine yet, so");
  say("      every simulation stays queued and the run stays pending. The");
  say("      grader and the test-to-simulation bridge are what land that.");
  say("      When they do, the first verdict arrives through this same feed");
  say("      and nothing in this check changes — it already follows the way");
  say("      any follower follows.");
  say("    · the page the results address opens is still being built. The");
  say("      address itself is real, token-free, and on this instance.");
  say("");
  say("  So a green run of this is NOT the whole ten-minute walk. It is");
  say("  everything up to the moment a verdict lands.");
  say(RULE);
}

async function main(): Promise<void> {
  if (!(await stat(CLI_ENTRY).then((found) => found.isFile(), () => false))) {
    say(`FAILED: ${CLI_ENTRY} is not built. Run pnpm --filter egma-cli smoke:walk.`);
    process.exitCode = 1;
    return;
  }

  // The credentials of whoever runs this are never read and never written, and
  // this is the proof rather than the promise.
  const own = path.join(process.env.HOME ?? "", ".egma", "credentials");
  const before = await stat(own).then((found) => `${found.mtimeMs}`, () => "absent");

  const home = await mkdtemp(path.join(tmpdir(), "egma-walk-home-"));
  const repository = await mkdtemp(path.join(tmpdir(), "egma-walk-repo-"));
  secrets.push(home, repository);

  let instance: Instance | undefined;
  let browser: Browser | undefined;
  let vendor: Vendor | undefined;

  try {
    vendor = await reachRetell();

    say(RULE);
    say("  The whole walk, against a fully real egma");
    say(RULE);
    say(`  egma:    a whole one, started here — Postgres, ClickHouse, API, pages`);
    say(`  Retell:  ${vendor.what}`);
    say(`  command: ${CLI_ENTRY}`);
    say("");

    const bootedAt = Date.now();
    instance = await startInstance("cli-walk");
    say(`Instance up in ${((Date.now() - bootedAt) / 1000).toFixed(1)}s: ${instance.origin}`);

    browser = await openBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);

    // What egma is told, and the whole of it: which egma, where its key goes,
    // which browser to open, which Retell to talk to. Everything else about
    // this walk is egma's own behavior.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EGMA_HOME: home,
      BROWSER: NO_BROWSER,
      EGMA_RETELL_URL: vendor.url,
    };
    delete env.EGMA_URL;
    delete env[KEY_VARIABLE];
    delete env.EGMA_RETELL_API_KEY;
    delete env.EGMA_RETELL_AGENT_ID;

    const held = await signIn(instance, page, env);
    const registered = await register(instance, vendor, repository, env, held.key);
    await pushTheTests(instance, repository, env, held.key, registered);
    await runAndFollow(instance, repository, env, held.key);

    say("");
    const after = await stat(own).then((found) => `${found.mtimeMs}`, () => "absent");
    check(before === after, "nothing touched the credentials of whoever ran this");
  } finally {
    await browser?.close();
    await vendor?.close();
    await instance?.close();
    await rm(home, { recursive: true, force: true });
    await rm(repository, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    say("");
    for (const problem of problems) say(`FAILED: ${problem}`);
    process.exitCode = 1;
    return;
  }
  proven();
}

try {
  await main();
} catch (problem) {
  // The last place a path or a key could get out: a failure deep in a step
  // throws with whatever it was working on in the message, so the whole stack
  // goes through the same redaction as every line above it.
  say("");
  say(redact(problem instanceof Error ? (problem.stack ?? problem.message) : String(problem)));
  process.exitCode = 1;
}

// A browser and an instance can both outlive what started them, and either
// keeps Node alive. This leaves on its own answer once what it printed has
// really gone out.
await new Promise<void>((resolve) => {
  process.stdout.write("", () => resolve());
});
process.exit(process.exitCode ?? 0);
