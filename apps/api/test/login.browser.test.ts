import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

import { connect, disconnect } from "@egma/db";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";
import { buildApi } from "../src/server.ts";
import {
  createMigratedDatabase,
  type MigratedDatabase,
} from "../../../packages/db/test/support/database.ts";

/**
 * The two paths a person actually clicks through, once each, in a real browser:
 * logging in from a terminal, and adding a colleague.
 *
 * **The happy path of each, and resist growing it further.** Every error branch
 * — a mistyped code, a stale one, a denial, a client polling too fast, an
 * expired invitation, a link for somebody else — is proved in
 * `device-flow.test.ts` and `invitations.test.ts` beside this file, where each
 * costs milliseconds. What a browser proves and nothing else can is that the
 * pages exist, that they are served from this instance's own origin, that this
 * process forwards the API paths they use, that the code arrives already in the
 * field, and that clicking through them in order ends with a terminal holding a
 * key that works and a second person inside the organization.
 *
 * Everything in here is real: a real Postgres, the real API, the real Next
 * process with its real rewrites, and a real Chrome. A stub anywhere in that
 * list would remove the only reason this test exists.
 *
 * It sits with the API's tests rather than with the web application's because
 * it builds the API in this process, and a test that spawned it instead would
 * depend on the workspace having been compiled first.
 */

const WEB = path.join(import.meta.dirname, "../../web");

/** Long, because a development server compiles each page the first time. */
const SETTLE = 120_000;

let database: MigratedDatabase;
let api: Awaited<ReturnType<typeof startApi>>;
let web: ChildProcess;
let browser: Browser;
let page: Page;
let origin: string;

/** A port nothing is listening on, so two test files never collide. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not find a free port"));
        return;
      }
      probe.close(() => {
        resolve(address.port);
      });
    });
  });
}

async function startApi(databaseUrl: string, apiPort: number, baseUrl: string) {
  const { app } = buildApi({
    config: loadConfig({
      DATABASE_URL: databaseUrl,
      EGMA_AUTH_SECRET: "a-secret-only-this-test-uses",
      EGMA_ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
      EGMA_BASE_URL: baseUrl,
      EGMA_SINGLE_ORGANIZATION: "false",
    }),
  });
  await app.listen({ host: "127.0.0.1", port: apiPort });
  return app;
}

/** Wait until something answers, or give up loudly rather than hang forever. */
async function answers(
  url: string,
  within: number,
  gaveUp: () => Error | undefined,
): Promise<void> {
  const until = Date.now() + within;
  for (;;) {
    const failed = gaveUp();
    if (failed !== undefined) throw failed;

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > until) throw new Error(`nothing answered at ${url}`);
    await new Promise((resume) => setTimeout(resume, 250));
  }
}

/**
 * Chrome. The one already on the machine by preference, so that running the
 * suite does not mean downloading a browser first.
 */
async function openBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return chromium.launch({ headless: true });
  }
}

beforeAll(async () => {
  database = await createMigratedDatabase("login_browser");
  connect({ databaseUrl: database.url, maxConnections: 4 });

  // Both ports up front: the API has to be told the origin a browser reaches
  // egma on, and the web process has to be told where to forward the API's
  // paths. One origin in every deployment, and both halves know it.
  const apiPort = await freePort();
  const webPort = await freePort();
  origin = `http://127.0.0.1:${webPort}`;

  api = await startApi(database.url, apiPort, origin);

  web = spawn(
    path.join(WEB, "node_modules/.bin/next"),
    ["dev", "--port", String(webPort), "--hostname", "127.0.0.1"],
    {
      cwd: WEB,
      env: {
        ...process.env,
        EGMA_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
        NODE_ENV: "development",
      },
      stdio: "ignore",
    },
  );

  // Loudly and at once, rather than after two minutes of nothing answering.
  let failedToStart: Error | undefined;
  web.on("error", (cause) => {
    failedToStart = cause;
  });
  web.on("exit", (code) => {
    failedToStart ??= new Error(`the web application exited with ${code}`);
  });

  await answers(`${origin}/api/health`, SETTLE, () => failedToStart);

  browser = await openBrowser();
  page = await browser.newPage();
  page.setDefaultTimeout(30_000);

  // A page that fails silently is the worst thing to debug in a browser test,
  // so anything the page complains about comes out with the failure.
  page.on("pageerror", (cause) => {
    process.stderr.write(`the page threw: ${cause.message}\n`);
  });
  // A 401 is part of the path — it is how the approval page discovers that
  // nobody is signed in yet — so only a fault is worth saying out loud.
  page.on("response", (response) => {
    if (response.status() >= 500) {
      process.stderr.write(
        `the page got ${response.status()} from ${response.url()}\n`,
      );
    }
  });
}, SETTLE * 2);

afterAll(async () => {
  await browser?.close();
  web?.kill("SIGTERM");
  await api?.close();
  await disconnect();
  await database?.drop();
});

describe("logging in from a terminal", () => {
  it(
    "opens a browser on a prefilled code, signs up, approves, and leaves a working key behind",
    async () => {
      // The terminal asks to be let in. It shows the person the short code and
      // opens their browser on the address it was handed — this instance's own,
      // never a domain egma runs.
      const started = await fetch(`${origin}/api/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: "egma-cli" }),
      });
      expect(started.status).toBe(200);
      const grant = (await started.json()) as {
        device_code: string;
        user_code: string;
        verification_uri_complete: string;
      };
      expect(grant.verification_uri_complete.startsWith(origin)).toBe(true);

      // The browser opens. The code is already in the field, so nobody retypes
      // eight characters between two windows.
      await page.goto(grant.verification_uri_complete);
      await expect
        .poll(() => page.inputValue("#user_code"))
        .toBe(grant.user_code);

      await page.click('button[type="submit"]');

      // No account yet, so the approval page sends them to sign up — and brings
      // them back to the same code afterwards rather than to the front door.
      await page.waitForURL(/\/signup\?next=/);

      await page.fill("#email", "ada@acme.example");
      await page.fill("#password", "a-long-enough-password");
      await expect.poll(() => page.inputValue("#organizationName")).toBe("Acme");
      await page.fill("#organizationName", "Acme");
      await page.fill("#projectName", "Default");
      await page.click('button[type="submit"]');

      // Back on the approval page, which says plainly what the terminal is
      // being let into.
      await page.waitForURL(/\/device\/approve\?user_code=/);
      await page.waitForSelector("text=Authorize this terminal?");
      const shown = await page.innerText("main");
      expect(shown).toContain(grant.user_code);
      expect(shown).toContain("Acme");
      expect(shown).toContain("Default");

      await page.getByRole("button", { name: "Approve" }).click();

      // The browser is finished and says so.
      await page.waitForURL(/\/device\/success/);
      await expect
        .poll(() => page.innerText("main"))
        .toContain("back to your terminal");

      // And the terminal, still polling, collects a key.
      const collected = await fetch(`${origin}/api/device/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: grant.device_code,
          client_id: "egma-cli",
        }).toString(),
      });
      expect(collected.status).toBe(200);

      const secret = ((await collected.json()) as { access_token: string })
        .access_token;
      expect(secret).toMatch(/^egma_sk_/);

      // Which works on a real request, in Acme's account, resolved from the key
      // row and from nothing the terminal said.
      const used = await fetch(`${origin}/api/keys`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(used.status).toBe(200);
      const keys = (await used.json()) as {
        keys: { organization_id: string }[];
      };
      expect(keys.keys).toHaveLength(1);

      const { rows } = await database.sql<{ name: string }>(
        "select o.name from organization o join api_key k on k.organization_id = o.id",
      );
      expect(rows).toEqual([{ name: "Acme" }]);
    },
    SETTLE,
  );
});

/**
 * The second person, on an instance where nobody configured email.
 *
 * This runs after the one above and on purpose: Ada is already signed up and
 * already signed in, which is exactly the state somebody is in when they think
 * to add a colleague. Nothing here is stubbed, and the transport is the one a
 * bare `docker compose up` runs — it delivers nothing.
 */
describe("adding a colleague, with no mail configured", () => {
  it(
    "hands the link to the inviter, and following it lands the colleague inside",
    async () => {
      await page.goto(`${origin}/members`);
      await page.waitForSelector("text=Invite somebody");

      await page.fill("#invite-email", "bob@acme.example");
      await page.selectOption("#invite-role", "viewer");
      await page.getByRole("button", { name: "Send invitation" }).click();

      // Nothing was emailed, and the flow completed anyway. The link is on the
      // page, which is the whole promise: a self-hoster is never stopped here.
      await page.waitForSelector("text=Here is the link");
      const shown = await page.innerText("main");
      const link = /http:\/\/[^\s]*\/invite\?token=[^\s]+/.exec(shown)?.[0];
      expect(link, shown).toBeDefined();

      // Bob opens it in his own browser, knowing nothing but the URL.
      const his = await browser.newContext();
      const bob = await his.newPage();
      bob.setDefaultTimeout(30_000);
      await bob.goto(link ?? "");

      // It says what he is joining and at what, and asks for the one thing it
      // needs. The address is the invitation's, so there is nothing to mistype.
      await bob.waitForSelector("text=Join Acme on egma");
      await expect
        .poll(() => bob.inputValue("#email"))
        .toBe("bob@acme.example");
      expect(await bob.innerText("main")).toContain("viewer");

      await bob.fill("#password", "a-long-enough-password");
      await bob.getByRole("button", { name: "Join Acme" }).click();

      // And he is in Acme, at the role he was invited at, without ever having
      // been asked to name an organization.
      await bob.waitForURL(new RegExp(`^${origin}/$`));
      await expect.poll(() => bob.innerText("main")).toContain("viewer");
      expect(await bob.innerText("main")).toContain("Acme");

      const { rows } = await database.sql<{ email: string; role: string }>(
        `select u.email, m.role from membership m
           join "user" u on u.id = m.user_id
          order by u.email`,
      );
      expect(rows).toEqual([
        { email: "ada@acme.example", role: "admin" },
        { email: "bob@acme.example", role: "viewer" },
      ]);

      await his.close();
    },
    SETTLE,
  );
});
