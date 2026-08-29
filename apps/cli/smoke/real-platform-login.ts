/** A real browser approval for the promptless `egma login` command. */

import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Browser, Page } from "playwright-core";

import { openBrowser } from "../../api/test/support/browser.ts";
import { startInstance, type Instance } from "../../api/test/support/instance.ts";
import { readCredentials } from "../src/platform/credentials.ts";
import { NO_BROWSER, signUpAndApprove } from "./support/approving-person.ts";
import { check, problems, say, waitUntil } from "./support/report.ts";

const run = promisify(execFile);
const CLI_ENTRY = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

type Home = { readonly folder: string; readonly credentials: string };

async function throwawayHome(): Promise<Home> {
  const folder = await mkdtemp(path.join(tmpdir(), "egma-smoke-login-"));
  return { folder, credentials: path.join(folder, "credentials") };
}

function envFor(home: Home): NodeJS.ProcessEnv {
  return { ...process.env, EGMA_HOME: home.folder, BROWSER: NO_BROWSER };
}

async function heldIn(
  home: Home,
  origin: string,
): Promise<{ url: string; key: string; mode: string }> {
  const held = await readCredentials(home.credentials, origin);
  if (held === null) throw new Error(`no credential was stored for ${origin}`);
  const mode = ((await stat(home.credentials)).mode & 0o777).toString(8);
  return { ...held, mode };
}

async function keyWorks(origin: string, key: string): Promise<boolean> {
  const used = await fetch(`${origin}/v1/keys`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return used.status === 200;
}

function saysNothingAboutTenancy(shown: string): void {
  for (const banned of ["organization", "organisation", "project", "tenant"]) {
    check(!new RegExp(`\\b${banned}`, "iu").test(shown), `login never says "${banned}"`);
  }
}

async function login(instance: Instance, page: Page): Promise<void> {
  const home = await throwawayHome();
  try {
    const child = execFile(process.execPath, [CLI_ENTRY, "login", "--url", instance.origin], {
      env: envFor(home),
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    await waitUntil(() => stdout.includes("approve_url: "), 60_000, "the approval address");
    const approveUrl = /approve_url: (\S+)/u.exec(stdout)?.[1] ?? "";
    check(approveUrl.startsWith(instance.origin), "login printed this instance's address");
    await signUpAndApprove(page, approveUrl);

    const exited = await new Promise<number>((resolve) => {
      child.on("close", (value) => resolve(value ?? 0));
    });
    say(stdout.trimEnd());
    check(exited === 0, `egma login exited 0 (it exited ${exited})`);
    check(stdout.includes("status: stored"), "egma login said it stored a key");
    saysNothingAboutTenancy(stdout);

    const held = await heldIn(home, instance.origin);
    check(held.mode === "600", `the credentials file is 0600 (it is 0${held.mode})`);
    check(await keyWorks(instance.origin, held.key), "the stored key works");

    const again = await run(
      process.execPath,
      [CLI_ENTRY, "login", "--url", instance.origin],
      { env: envFor(home) },
    );
    check(
      again.stdout.includes("status: already-stored") &&
        again.stdout.includes(`url: ${instance.origin}`),
      "a second login reused the stored key",
    );
  } finally {
    await rm(home.folder, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const real = path.join(process.env.HOME ?? "", ".egma", "credentials");
  const before = await stat(real).then(
    (found) => `${found.mtimeMs}`,
    () => "absent",
  );

  let instance: Instance | undefined;
  let browser: Browser | undefined;
  try {
    instance = await startInstance("cli-login");
    browser = await openBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);
    await login(instance, page);

    const after = await stat(real).then(
      (found) => `${found.mtimeMs}`,
      () => "absent",
    );
    check(before === after, "the smoke test did not touch the developer's credentials");
  } finally {
    await browser?.close();
    await instance?.close();
  }

  if (problems.length > 0) {
    for (const problem of problems) say(`FAILED: ${problem}`);
    process.exitCode = 1;
    return;
  }
  say("PASSED: the coding-agent login path stores a browser-approved key that works.");
}

await main();
