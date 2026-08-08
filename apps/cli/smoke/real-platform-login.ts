/**
 * The smoke check: login against a whole real egma, approved in a real browser.
 *
 * Nothing here is a fixture. A real Postgres, a real ClickHouse, the real API,
 * the real web application with its real pages, a real Chrome, and the built
 * `egma` command in a real terminal. What it proves is the one thing an offline
 * check cannot: that the address egma shows leads to a page that exists, that a
 * person can sign up and approve there, and that the key which lands on disk
 * afterwards opens a door on that instance.
 *
 * It runs twice over, because there are two ways in and both have to work: the
 * wizard, driven through a pseudo-terminal, and `egma login` with nobody
 * watching.
 *
 * Every run uses a throwaway egma folder of its own. The credentials of whoever
 * runs this are never read and never written, and the check says so at the end.
 *
 * Run it with: node apps/cli/smoke/real-platform-login.ts
 * It needs the compose Postgres and ClickHouse already up, and a Chrome.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Browser, Page } from "playwright-core";

import { openBrowser } from "../../api/test/support/browser.ts";
import { startInstance, type Instance } from "../../api/test/support/instance.ts";
import { runInTerminal } from "../test/support/pty.ts";
import {
  approveOnly,
  NO_BROWSER,
  PASSWORD,
  signUpAndApprove,
} from "./support/approving-person.ts";
import { check, problems, say, waitUntil } from "./support/report.ts";

const run = promisify(execFile);

const CLI_ENTRY = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

const MANIFEST = `${JSON.stringify(
  { name: "egma-smoke-repo", version: "1.0.0" },
  null,
  2,
)}\n`;

const FAKE_AGENT = fileURLToPath(new URL("../test/support/fake-agent.ts", import.meta.url));

// The API writes a line per request, and this check makes a great many.
process.env.LOG_LEVEL ??= "silent";

type Home = { readonly folder: string; readonly credentials: string };

async function throwawayHome(label: string): Promise<Home> {
  const folder = await mkdtemp(path.join(tmpdir(), `egma-smoke-${label}-`));
  return { folder, credentials: path.join(folder, "credentials") };
}

function envFor(home: Home): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, EGMA_HOME: home.folder, BROWSER: NO_BROWSER };
  delete env.EGMA_URL;
  return env;
}

/** What is on disk after a login, and what the file is readable by. */
async function heldIn(home: Home): Promise<{ url: string; key: string; mode: string }> {
  const held = JSON.parse(await readFile(home.credentials, "utf8")) as {
    url: string;
    key: string;
  };
  const mode = ((await stat(home.credentials)).mode & 0o777).toString(8);
  return { ...held, mode };
}

/**
 * The words a terminal never says.
 *
 * What egma sets up for a brand-new account is set up in the browser page and
 * named nowhere out here. This is that rule, held against what really reached a
 * screen.
 */
function saysNothingAboutTenancy(shown: string, where: string): void {
  for (const banned of ["organization", "organisation", "project", "tenant"]) {
    check(!new RegExp(`\\b${banned}`, "iu").test(shown), `${where} never says "${banned}"`);
  }
}

/** Whether a key opens a door on this instance. */
async function keyWorks(origin: string, key: string): Promise<boolean> {
  const used = await fetch(`${origin}/api/keys`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return used.status === 200;
}

/* ── the wizard, in a real terminal ──────────────────────────────────── */

async function theWizard(instance: Instance, page: Page): Promise<void> {
  say("");
  say("── the wizard, driven through a real terminal ────────────");

  const home = await throwawayHome("wizard");
  const repo = await mkdtemp(path.join(tmpdir(), "egma-smoke-repo-"));
  await writeFile(path.join(repo, "package.json"), MANIFEST, "utf8");

  // The coding agent here is the scripted one: what is being checked is login
  // against a real instance, and a real agent would only add minutes to it.
  const script = path.join(repo, "agent-script.json");
  await writeFile(
    script,
    JSON.stringify({
      steps: [
        { kind: "say", text: "It is a package manifest." },
        { kind: "stop", reason: "end_turn" },
      ],
    }),
    "utf8",
  );

  const terminal = runInTerminal({
    command: process.execPath,
    args: [
      CLI_ENTRY,
      "--cwd",
      repo,
      "--url",
      instance.origin,
      "--",
      process.execPath,
      FAKE_AGENT,
      script,
    ],
    cwd: repo,
    env: envFor(home),
    cols: 120,
  });

  try {
    await waitUntil(() => terminal.screen().includes("[enter] begin"), 60_000, "the intro");
    terminal.write("\r");

    await waitUntil(() => terminal.screen().includes("Code:"), 60_000, "the code");
    const screen = terminal.screen();
    say("");
    say(screen);
    say("");

    const code = /Code: (\S+)/u.exec(screen)?.[1] ?? "";
    const approveUrl =
      screen
        .split("\n")
        .map((line) => line.replaceAll("│", "").trim())
        .find((line) => line.startsWith(instance.origin)) ?? "";

    check(code !== "", "the wizard showed a code");
    saysNothingAboutTenancy(screen, "the login screen");
    check(
      approveUrl.startsWith(instance.origin) && approveUrl.includes("user_code="),
      "the address is on a line of its own and points at this instance",
    );

    await signUpAndApprove(page, approveUrl);

    const exited = await Promise.race([
      terminal.exited,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("the wizard never finished")), 120_000),
      ),
    ]);

    check(exited === 0, `the wizard exited 0 (it exited ${exited})`);
    say("");
    say(`scrollback: ${terminal.scrollback().trim()}`);

    const held = await heldIn(home);
    check(held.url === instance.origin, "the key is stored against this instance");
    check(held.key.startsWith("egma_sk_"), "the key is a real minted key");
    check(held.mode === "600", `the credentials file is 0600 (it is 0${held.mode})`);
    check(await keyWorks(instance.origin, held.key), "the stored key works on a real request");
  } finally {
    terminal.kill();
    await rm(home.folder, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
}

/* ── egma login, with nobody watching ────────────────────────────────── */

async function theVerb(instance: Instance, page: Page): Promise<void> {
  say("");
  say("── egma login, headless ──────────────────────────────────");

  const home = await throwawayHome("verb");

  try {
    const child = execFile(process.execPath, [CLI_ENTRY, "login", "--url", instance.origin], {
      env: envFor(home),
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    await waitUntil(() => stdout.includes("approve_url: "), 60_000, "the address to approve at");
    const approveUrl = /approve_url: (\S+)/u.exec(stdout)?.[1] ?? "";
    check(approveUrl.startsWith(instance.origin), "egma login printed an address on this instance");

    // Ada's browser still holds the sign-in from the wizard's approval, which
    // is the whole reason the results page opens signed in later.
    await approveOnly(page, approveUrl);

    const exited = await new Promise<number>((resolve) => {
      child.on("close", (value) => resolve(value ?? 0));
    });

    say("");
    say(stdout.trimEnd());
    say("");

    check(exited === 0, `egma login exited 0 (it exited ${exited})`);
    check(stdout.includes("status: stored"), "egma login said it stored a key");
    saysNothingAboutTenancy(stdout, "egma login");

    const held = await heldIn(home);
    check(held.mode === "600", `the credentials file is 0600 (it is 0${held.mode})`);
    check(await keyWorks(instance.origin, held.key), "the stored key works on a real request");

    // The second run needs nothing said at all: the address rode along with the
    // key, and a key already held is not minted twice.
    const again = await run(process.execPath, [CLI_ENTRY, "login"], { env: envFor(home) });
    check(
      again.stdout.includes("status: already-stored") &&
        again.stdout.includes(`url: ${instance.origin}`),
      "a second run found the instance and the key with nothing said",
    );
  } finally {
    await rm(home.folder, { recursive: true, force: true });
  }
}

/* ── the check itself ────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const real = path.join(process.env.HOME ?? "", ".egma", "credentials");
  const before = await stat(real).then(
    (found) => `${found.mtimeMs}`,
    () => "absent",
  );

  say("Starting a whole egma: Postgres, ClickHouse, the API and the pages.");
  let instance: Instance | undefined;
  let browser: Browser | undefined;

  try {
    instance = await startInstance("cli-login");
    say(`Instance: ${instance.origin}`);

    browser = await openBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);

    await theWizard(instance, page);
    await theVerb(instance, page);

    const after = await stat(real).then(
      (found) => `${found.mtimeMs}`,
      () => "absent",
    );
    say("");
    check(before === after, "nothing touched the credentials of whoever ran this");
  } finally {
    await browser?.close();
    await instance?.close();
  }

  say("");
  if (problems.length > 0) {
    for (const problem of problems) say(`FAILED: ${problem}`);
    process.exitCode = 1;
    return;
  }
  say("PASSED: a real login, approved in a real browser, leaves a key that works.");
}

await main();

// A pseudo-terminal can outlive the command that ran in it, and an open one
// keeps Node running — so this leaves on its own answer once what it printed
// has really gone out.
await new Promise<void>((resolve) => {
  process.stdout.write("", () => resolve());
});
process.exit(process.exitCode ?? 0);
