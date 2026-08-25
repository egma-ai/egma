import {
  appendGrades,
  claimGradingJobs,
  finishGradingJob,
  getGradingJobForTrace,
} from "@egma/db";
import { newId } from "@egma/ids";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import type { Browser, Page, Request, Route } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asListInstant, asSecond } from "../../web/lib/instants.ts";
import { openBrowser } from "./support/browser.ts";
import {
  capturedRequests,
  FIXTURE_PROVIDER_CALL_ID,
  FIXTURE_TRACE,
} from "./support/fixture.ts";
import { SETTLE, startInstance, type Instance } from "./support/instance.ts";
import {
  aRecording,
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";
import {
  aConductedRun,
  fileTranscriptOf,
  landOneConversationOf,
  standingOf,
} from "./support/recordings.ts";

/**
 * Everything a person actually clicks through, once each, in a real browser:
 * logging in from a terminal, adding a colleague, and reading what an agent
 * did.
 *
 * **The happy path of each, and resist growing it further.** Every error branch
 * — a mistyped code, a stale one, a denial, a client polling too fast, an
 * expired invitation, a link for somebody else, a window a read endpoint
 * refuses — is proved in `device-flow.test.ts`, `invitations.test.ts` and
 * `trace-reads-contract.test.ts` beside this file, where each costs
 * milliseconds. What a browser proves and nothing else can is that the pages
 * exist, that they are served from this instance's own origin, that this
 * process forwards the API paths they use, and that clicking through them in
 * order gets somebody where they were going.
 *
 * Everything in here is real: a real Postgres, a real ClickHouse, the real API,
 * the real Next process with its real rewrites, and a real Chrome. A stub
 * anywhere in that list would remove the only reason this test exists.
 *
 * **All of it is one file on purpose.** Two development servers compiling into
 * one `apps/web/.next` each serve half of the other's build, so the browser
 * tests run one at a time — and Vitest runs the tests within a file in order,
 * which makes one file the whole of the arrangement. It is also the cheaper
 * one: three flows share a single instance rather than standing up three.
 * `support/instance.ts` records what the alternatives cost.
 *
 * It sits with the API's tests rather than with the web application's because
 * it builds the API in this process, and a test that spawned it instead would
 * depend on the workspace having been compiled first.
 *
 * The narrative is continuous and each part depends on the one above it. Ada
 * signs up on the way to authorizing a terminal; she is already signed in when
 * she adds a colleague; and she is still signed in when she points an agent at
 * egma and goes to read what it did. That is the order somebody meets the
 * product in.
 */

let instance: Instance;
let browser: Browser;
let page: Page;
let origin: string;

async function openPeopleSettings(which: Page): Promise<void> {
  await which.goto(`${origin}/`);
  await which.waitForURL(/\/projects\/prj_[^/]+\/agents$/);
  const projectId = /\/projects\/(prj_[^/]+)\//u.exec(which.url())?.[1];
  if (projectId === undefined) throw new Error("the signed-in landing page named no project");
  await which.goto(`${origin}/projects/${projectId}/settings/people`);
}

const BROWSER_RETELL_KEY = "retell-browser-fixture-key-WXYZ";
const BROWSER_RETELL_AGENT = "agent_in_retell_journey";
const BROWSER_RETELL_NUMBER = "+14155550100";
const BROWSER_PHONE_SETTINGS = {
  carrier_trunk_address: "browser-fixture.pstn.twilio.com",
  carrier_trunk_number: "+14155550101",
} as const;

/** Retell's read-only setup surface, with no network outside the test. */
const browserRetellFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const authorization = new Headers(init?.headers).get("authorization");
  if (authorization !== `Bearer ${BROWSER_RETELL_KEY}`) {
    return new Response(JSON.stringify({ error_message: "Invalid API key" }), {
      status: 401,
    });
  }
  if (url.pathname === "/v2/list-agents") {
    return new Response(
      JSON.stringify({
        items: [
          {
            agent_id: BROWSER_RETELL_AGENT,
            agent_name: "The Support line",
            channel: "voice",
          },
        ],
        has_more: false,
      }),
      { status: 200 },
    );
  }
  if (url.pathname === "/v2/list-phone-numbers") {
    return new Response(
      JSON.stringify({
        items: [
          {
            phone_number: BROWSER_RETELL_NUMBER,
            nickname: "Support",
            inbound_agents: [{ agent_id: BROWSER_RETELL_AGENT }],
          },
        ],
        has_more: false,
      }),
      { status: 200 },
    );
  }
  if (url.pathname.startsWith("/get-phone-number/")) {
    return new Response(
      JSON.stringify({
        phone_number: BROWSER_RETELL_NUMBER,
        nickname: "Support",
        inbound_agents: [{ agent_id: BROWSER_RETELL_AGENT }],
      }),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify({ error_message: "not found" }), {
    status: 404,
  });
};

/**
 * A real object store, for the one thing below that needs one.
 *
 * Started at collection rather than in `beforeAll`, because the flow that uses
 * it has to **skip visibly** where no container can be started and a `describe`
 * decides that before any hook runs. Everything else in this file is unaffected
 * either way: an instance with no store configured is exactly the egma every
 * other test here is about.
 */
const storage: ObjectStorage = await startObjectStorage("browser");
if (!storage.available) {
  process.stderr.write(
    `\nskipping the recording playback flow — ${storage.why}\n\n`,
  );
}

beforeAll(async () => {
  instance = await startInstance("browser", {
    traces: true,
    retellFetch: browserRetellFetch,
    platformSettings: BROWSER_PHONE_SETTINGS,
    ...(storage.available ? { blob: storage.store } : {}),
    ...(storage.available ? { ingestStore: storage.ingestStore } : {}),
  });
  origin = instance.origin;

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
  await instance?.close();
  if (storage.available) storage.stop();
});

describe("entering the app", () => {
  it(
    "sends a signed-out person from the root address to sign in",
    async () => {
      await page.goto(`${origin}/`);
      await page.waitForURL(`${origin}/sign-in`);
    },
    SETTLE,
  );
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
      const used = await fetch(`${origin}/v1/keys`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(used.status).toBe(200);
      const keys = (await used.json()) as {
        keys: { organization_id: string }[];
      };
      expect(keys.keys).toHaveLength(1);

      const { rows } = await instance.database.sql<{ name: string }>(
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
      await openPeopleSettings(page);
      expect(await page.getByText("Invite somebody").count()).toBe(0);
      // People and invitations are two views of this settings page. The tab
      // keeps that navigation clear without making either view look like a
      // form choice.
      await page.getByRole("tab", { name: "Invitations" }).click();
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
      await bob.waitForSelector("text=Join Acme on Egma");
      await expect
        .poll(() => bob.inputValue("#email"))
        .toBe("bob@acme.example");
      expect(await bob.innerText("main")).toContain("viewer");

      await bob.fill("#password", "a-long-enough-password");
      await bob.getByRole("button", { name: "Join Acme" }).click();

      // And he is in Acme, at the role he was invited at, without ever having
      // been asked to name an organization. He lands on Agents, in a project
      // named in the address he was sent to.
      await bob.waitForURL(new RegExp(`^${origin}/projects/prj_[^/]+/agents$`));
      await expect
        .poll(() => bob.getByRole("heading", { name: "Agents", exact: true }).count())
        .toBe(1);

      // He was invited as a viewer, so he is told so once, on the same page
      // everybody else sees, and the control that would change data is
      // disabled rather than removed.
      //
      // No waiting on anything else first. The shell claims no role until the
      // session read answers — `components.test.tsx` holds that promise — so
      // `View only` appearing here can only be Bob's actual role.
      await expect
        .poll(() => bob.locator("aside").innerText())
        .toMatch(/view only/i);

      // Disabled for real: not a link he can follow, not focusable, and a
      // forced click goes nowhere. A control that looked disabled and still
      // fired would promise a refusal it does not deliver — and the refusal
      // that does hold is the server's, proved in `agents.test.ts`.
      const connect = bob.getByRole("button", { name: "Connect an agent" });
      await connect.first().waitFor();
      expect(
        await connect.evaluateAll((controls) =>
          controls.map((control) => (control as { disabled?: boolean }).disabled),
        ),
      ).not.toContain(false);
      expect(
        await bob.getByRole("link", { name: "Connect an agent" }).count(),
      ).toBe(0);
      const before = bob.url();
      await connect.first().click({ force: true }).catch(() => undefined);
      await bob.waitForTimeout(300);
      expect(bob.url()).toBe(before);

      const { rows } = await instance.database.sql<{ email: string; role: string }>(
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

  it(
    "does nothing until an admin confirms a destructive member action",
    async () => {
      await openPeopleSettings(page);
      // The wide layout's row. The list beside it is the same three controls
      // over the same person, drawn for a narrow screen from one column
      // definition, so driving either would prove the same thing.
      const bob = page.locator("tr", { hasText: "bob@acme.example" });
      await bob.waitFor();
      const dismissDialogThroughOverlay = async () => {
        await page
          .locator('[data-slot="dialog-overlay"]')
          .click({ position: { x: 4, y: 4 } });
      };
      // Three controls, and all one height. The height itself is the shared
      // system's token rather than this page's own now that Settings is built
      // from the same controls as every other product page, so what is held
      // here is that they agree — the density itself is a token to tune.
      const heights = await bob
        .locator("select, button")
        .evaluateAll((controls) =>
          controls.map((control) => control.getBoundingClientRect().height),
        );
      expect(heights).toHaveLength(3);
      expect(new Set(heights).size).toBe(1);

      const memberActions: string[] = [];
      const recordMemberAction = (request: Request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() === "POST" && /\/v1\/members\/[^/]+\/(?:deactivate|remove)$/u.test(path)) {
          memberActions.push(path);
        }
      };
      page.on("request", recordMemberAction);

      try {
        // The dialog itself is not an action. Every ordinary way out is safe.
        await bob.getByRole("button", { name: "Deactivate" }).click();
        expect(memberActions).toEqual([]);
        await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

        await bob.getByRole("button", { name: "Deactivate" }).click();
        await page.keyboard.press("Escape");
        expect(memberActions).toEqual([]);

        await bob.getByRole("button", { name: "Deactivate" }).click();
        await dismissDialogThroughOverlay();
        await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
        expect(memberActions).toEqual([]);

        // Only the destructive button sends the request, and it sends the
        // endpoint named by the choice once.
        await bob.getByRole("button", { name: "Deactivate" }).click();
        const deactivated = page.waitForResponse((response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith("/deactivate"),
        );
        await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
        expect((await deactivated).status()).toBe(200);
        // Case-insensitive: the standing is a badge now, and the shared
        // system draws a badge in small capitals.
        await expect.poll(() => bob.innerText()).toMatch(/deactivated/i);
        expect(memberActions).toHaveLength(1);
        expect(memberActions[0]).toMatch(/\/deactivate$/u);

        // Removal has its own confirmation and endpoint. Closing it is safe;
        // confirming it removes the row and sends one more request.
        await bob.getByRole("button", { name: "Remove" }).click();
        expect(memberActions).toHaveLength(1);
        await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
        await expect.poll(() => page.getByRole("dialog").count()).toBe(0);

        await bob.getByRole("button", { name: "Remove" }).click();
        await page.keyboard.press("Escape");
        await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
        expect(memberActions).toHaveLength(1);

        await bob.getByRole("button", { name: "Remove" }).click();
        await dismissDialogThroughOverlay();
        await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
        expect(memberActions).toHaveLength(1);

        await bob.getByRole("button", { name: "Remove" }).click();
        const removed = page.waitForResponse((response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith("/remove"),
        );
        await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
        expect((await removed).status()).toBe(200);
        await expect.poll(() => bob.count()).toBe(0);
        expect(memberActions).toHaveLength(2);
        expect(memberActions[1]).toMatch(/\/remove$/u);
      } finally {
        page.off("request", recordMemberAction);
      }
    },
    SETTLE,
  );
});

/* ==================================================================== *
 * The dashboard: a real agent's telemetry, read as a transcript.
 * ==================================================================== */

/**
 * What the browser is told the time is, from here on.
 *
 * The capture happened at the instants it really happened at — `18:04:40Z` to
 * `18:05:53Z` on 2 August 2026 — and the bytes are evidence, so they are never
 * restamped. The list page asks about **the last twenty-four hours**, computed
 * from the browser's own clock, and a fixed capture necessarily ages out of any
 * window measured from now.
 *
 * So the clock is pinned instead. The page's default window is then exercised
 * exactly as it is written — no widening, no absolute window typed into a
 * control, no branch in the test — and the assertions below hold in a year as
 * firmly as they do today. Only the browser's clock moves; the API, the store
 * and every timestamp in them are the real ones.
 */
const AT = new Date("2026-08-02T20:00:00.000Z");

const PASSWORD = "a-long-enough-password";

let acmeKey: string;

/**
 * The project Ada's browser stands in, which is the one her production traffic
 * is read in. Filled in once the telemetry has somewhere to go, and read by
 * every flow below that opens Monitoring.
 */
let acme = "";

/** The cookie header a browser would send back, given what it was just set. */
function cookiesFrom(header: string | null): string {
  return (header ?? "")
    .split(/,(?=[^;]+?=)/u)
    .map((cookie) => cookie.split(";", 1)[0]?.trim() ?? "")
    .filter((cookie) => cookie !== "")
    .join("; ");
}

/**
 * A key for the project an organization already has, and the exporter pointed
 * at egma with it.
 *
 * **The key names a project, and that is load-bearing rather than
 * incidental.** Customer OTLP export rejects a key minted for the whole
 * organization, because no project would own its Monitoring evidence. The
 * exporter is configured with the project key the product requires.
 */
async function keyForTheProject(cookie: string, name: string): Promise<string> {
  const me = await fetch(`${origin}/api/me`, { headers: { cookie } });
  expect(me.status, await me.clone().text()).toBe(200);
  const projects = ((await me.json()) as { projects: { id: string }[] }).projects;

  const minted = await fetch(`${origin}/v1/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name, projectId: projects[0]?.id }),
  });
  expect(minted.status, await minted.clone().text()).toBe(201);
  return ((await minted.json()) as { secret: string }).secret;
}

/** Somebody else's organization entirely, with a key of its own. */
async function anotherCustomer(
  email: string,
  organizationName: string,
): Promise<string> {
  const signedUp = await fetch(`${origin}/api/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, organizationName }),
  });
  expect(signedUp.status, await signedUp.clone().text()).toBe(201);
  return keyForTheProject(
    cookiesFrom(signedUp.headers.get("set-cookie")),
    organizationName,
  );
}

/**
 * Wait until React has taken the page over, before clicking something only
 * React answers.
 *
 * The markup is served before the script that makes it work, and in between
 * every one of these pages is inert. A `<button type="button">` clicked in that
 * gap does nothing at all, and a form clicked in it does something worse: with
 * no `action` a browser submits it natively, as a GET to the page's own
 * address, which navigates away and puts the password in the URL bar. Both are
 * intermittent — the gap is milliseconds on a warm development server and
 * seconds on a cold one — and the second is what a ~6% failure rate here
 * turned out to be.
 *
 * Most clicks in this file need no gate because they already wait on something
 * only React could have put there: a prefilled field, a table drawn from a
 * fetch, a line of text that arrived with an answer. The two below wait on
 * markup that is in the server's own response, so they wait on this instead.
 *
 * The signal is React's own bookkeeping: hydration attaches the fiber for a DOM
 * node to the node, under a key nothing else writes. Checking for it says
 * exactly the thing worth knowing — this element's handlers are live — rather
 * than approximating it with a timeout.
 *
 * The condition is a string because it is evaluated in the browser and not in
 * this process: these tests are compiled without the DOM library, on purpose,
 * so that Node code cannot reach for `document` by accident.
 */
async function reactHasTakenOver(page: Page, selector: string): Promise<void> {
  await page.waitForSelector(selector);
  await page.waitForFunction(
    `Object.keys(document.querySelector(${JSON.stringify(selector)}) ?? {})` +
      `.some((key) => key.startsWith("__react"))`,
  );
}

/** A browser of their own, signed in, with the same pinned clock. */
async function signedInBrowser(email: string): Promise<Page> {
  const context = await browser.newContext();
  const theirs = await context.newPage();
  theirs.setDefaultTimeout(30_000);
  await theirs.clock.setFixedTime(AT);
  await theirs.goto(`${origin}/sign-in`);
  await reactHasTakenOver(theirs, "form");
  await theirs.fill("#email", email);
  await theirs.fill("#password", PASSWORD);
  await theirs.getByRole("button", { name: "Sign in" }).click();
  await theirs.waitForURL(new RegExp(`^${origin}/projects/prj_[^/]+/agents$`));
  return theirs;
}

/**
 * Where production traffic is read: **Monitoring**, inside a project.
 *
 * Written once here rather than at each `goto`, because the whole of this
 * effort is that these pages moved. The old top-level `/traces` addresses are
 * gone — not redirected — and a test that still knew how to spell one would go
 * on proving the page that no longer exists.
 */
function monitoringAt(projectId: string): string {
  return `${origin}/projects/${projectId}/monitoring/transcripts`;
}

/**
 * Which project a browser is standing in, read off the address it landed on.
 *
 * Asked of the page rather than of the API, because the address is what every
 * one of these pages reads the project out of — so this is the same answer the
 * page under test is working from, rather than a second opinion that could
 * agree with the wrong page.
 */
function projectIn(which: Page): string {
  const found = /\/projects\/(prj_[^/?#]+)/u.exec(which.url())?.[1];
  expect(found, `${which.url()} names a project`).toBeDefined();
  return found ?? "";
}

/** One short exchange as OTLP/JSON, at an instant of the test's choosing. */
function exchange(
  traceId: string,
  openedAt: Date,
  humanSaid: string,
  agentSaid: string,
) {
  const at = (offsetSeconds: number) =>
    String(BigInt(openedAt.getTime() + offsetSeconds * 1000) * 1_000_000n);
  const root = `${traceId.slice(0, 14)}01`;
  const span = (
    suffix: string,
    name: string,
    parent: string,
    from: number,
    to: number,
    attributes: { key: string; value: { stringValue: string } }[] = [],
  ) => ({
    traceId,
    spanId: `${traceId.slice(0, 14)}${suffix}`,
    parentSpanId: parent,
    name,
    startTimeUnixNano: at(from),
    endTimeUnixNano: at(to),
    attributes,
    status: { code: "STATUS_CODE_UNSET" },
  });

  return {
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: "a-sparse-agent" } },
      ],
    },
    scopeSpans: [
      {
        scope: { name: "livekit-agents", version: "1.6.7" },
        spans: [
          span("01", "agent_session", "", 0, 4, [
            { key: "session.id", value: { stringValue: `room-${traceId}` } },
          ]),
          span("02", "user_turn", root, 1, 2, [
            { key: "lk.user_transcript", value: { stringValue: humanSaid } },
          ]),
          span("03", "agent_turn", root, 2, 3, [
            { key: "lk.response.text", value: { stringValue: agentSaid } },
          ]),
        ],
      },
    ],
  };
}

async function send(secret: string, resourceSpans: unknown[]): Promise<void> {
  const sent = await fetch(`${origin}/v1/traces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ resourceSpans }),
  });
  expect(sent.status, await sent.clone().text()).toBe(200);
}

/**
 * The banned list, as a person reading the screen would meet it.
 *
 * Held against **what is actually legible** — the rendered text of the page,
 * with nothing expanded — rather than against the markup. Two words behave
 * differently and it is worth saying which: `trace` and `span` are storage
 * words and must never appear at all, and `session` is the one carve-out,
 * correct for a signed-in browser session and wrong for an exchange, which
 * these pages have no reason to mention either way.
 *
 * The pages' own copy is held against the same list from the other side, in
 * `apps/web/test/transcripts.test.ts`, where every string they can render lives
 * in one file. Both are worth having: that one catches a word before it can
 * reach a screen, and this one catches a word that reached one anyway.
 */
const NEVER_SHOWN = [
  "trace",
  "span",
  "session",
  "conversation",
  "caller",
  "persona",
  "eval",
  "scenario",
  "experiment",
];

function saysNothingBanned(shown: string): void {
  for (const banned of NEVER_SHOWN) {
    expect(
      new RegExp(`\\b${banned}`, "iu").test(shown),
      `the page says "${banned}"`,
    ).toBe(false);
  }
}

/**
 * The whole slice: a real LiveKit agent's telemetry goes in at the door, and
 * the developer who owns it clicks **Monitoring** and reads the exchange.
 *
 * This is the spec's own demo sentence executed rather than described — *run
 * compose, point an agent's export at egma, open Monitoring, read the exchange
 * with its timings*. The fourteen captured bodies are the ones an exporter
 * really sent, replayed byte for byte, and they arrive **through the same
 * origin the pages are served from**, which is the deployment a self-hoster
 * actually gets: one address, and the exporter aimed at it.
 *
 * **The addresses are inside a project now**, which is the change this effort
 * made and the reason every `goto` below goes through `monitoringAt`. The old
 * top-level pages were reachable from nowhere in the product; production
 * traffic is a navigation item, and its list is a project's own.
 *
 * Ada is the same Ada as above: already signed up, already signed in, already
 * holding an organization. Which is exactly the state somebody is in when they
 * first have telemetry to look at.
 */
describe("what a project recorded in production", () => {
  beforeAll(async () => {
    await page.clock.setFixedTime(AT);

    const hers = (await page.context().cookies(origin))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
    acmeKey = await keyForTheProject(hers, "Acme");

    await page.goto(`${origin}/`);
    await page.waitForURL(/\/projects\/prj_[^/]+\/agents$/);
    acme = projectIn(page);

    for (const captured of await capturedRequests()) {
      const sent = await fetch(`${origin}/v1/traces`, {
        method: "POST",
        headers: {
          "content-type": captured.contentType,
          authorization: `Bearer ${acmeKey}`,
        },
        body: captured.body,
      });
      expect(sent.status, captured.file).toBe(200);
    }
  }, SETTLE);

  it(
    "moves between product pages without reloading the shell",
    async () => {
      await page.goto(`${origin}/`);
      await page.waitForURL(/\/projects\/prj_[^/]+\/agents$/);
      const project = /\/projects\/(prj_[^/]+)\//.exec(page.url())?.[1];
      expect(project).toBeDefined();

      const sidebar = page.locator("aside");
      const account = sidebar.locator('button[aria-label^="Account"]');
      await account.waitFor({ state: "visible" });

      // Where you are, without having to open anything: organization and
      // project are two clear controls, both present with one project.
      const organization = sidebar.locator(
        'button[aria-label^="Open organization menu for"]',
      );
      await organization.waitFor({ state: "visible" });
      await expect.poll(() => organization.innerText()).toMatch(/acme/i);
      const selector = sidebar.locator('button[aria-label^="Organization"]');
      await selector.waitFor({ state: "visible" });
      await expect.poll(() => selector.innerText()).toMatch(/project/i);

      // From here on, changing the page must not replace or empty the shell.
      // The old page-owned shell stayed in one document but still remounted,
      // fetched `/api/me` again, and briefly drew three false placeholders.
      const sessionReads: string[] = [];
      const countSessionRead = (request: Request) => {
        if (new URL(request.url()).pathname === "/api/me") {
          sessionReads.push(request.url());
        }
      };
      page.on("request", countSessionRead);
      await page.evaluate(() => {
        const pageDocument = Reflect.get(globalThis, "document") as {
          readonly body: unknown;
          querySelector(selector: string): {
            readonly textContent: string | null;
          } | null;
        };
        const Observer = Reflect.get(globalThis, "MutationObserver") as new (
          callback: () => void,
        ) => {
          observe(
            target: unknown,
            options: {
              readonly childList: boolean;
              readonly characterData: boolean;
              readonly subtree: boolean;
            },
          ): void;
          disconnect(): void;
        };
        const shell = pageDocument.querySelector("aside");
        const flickers: string[] = [];
        const sample = () => {
          const text = pageDocument.querySelector("aside")?.textContent ?? "";
          if (/No organization|Unknown project|Checking your session/.test(text)) {
            flickers.push(text);
          }
        };
        const observer = new Observer(sample);
        observer.observe(pageDocument.body, {
          childList: true,
          characterData: true,
          subtree: true,
        });
        Reflect.set(globalThis, "__egma_shell_navigation_watch", {
          shell,
          flickers,
          observer,
        });
      });

      // The six rows the three clusters hold — the unlabelled standing pair at
      // the top, the three Simulations rows, and Monitoring's one. Settings is
      // not one of them and neither is a simulation.
      for (const area of [
        "Agents",
        "Graders",
        "Tests",
        "Personas",
        "Runs",
        "Transcripts",
      ]) {
        expect(
          await sidebar.getByRole("link", { name: area, exact: true }).count(),
          area,
        ).toBe(1);
      }

      /*
       * Monitoring is one click, and the click lands on the transcripts.
       *
       * This is the whole of what the effort promised a person: production
       * traffic used to be reachable at no address the product linked to at
       * all. So the item is asserted by the address it carries rather than by
       * its presence — an item pointing at the area's own address would cost a
       * redirect on every visit, and a reserved neighbour under the same area
       * could become the landing by accident.
       *
       * The word `Monitoring` is the group's now, so the item says what its
       * page is. The address it carries did not move with the word.
       */
      expect(
        await sidebar
          .getByRole("link", { name: "Transcripts", exact: true })
          .getAttribute("href"),
      ).toBe(`/projects/${project ?? ""}/monitoring/transcripts`);

      // And the runs surface is reached by the word its group left it: the
      // pairing a person reads is Simulations → Runs, so the two-word label
      // that stood in for the group before the groups existed is gone.
      expect(
        await sidebar
          .getByRole("link", { name: "Simulation runs", exact: true })
          .count(),
      ).toBe(0);
      expect(
        await sidebar.getByRole("link", { name: "Home", exact: true }).count(),
      ).toBe(0);
      expect(
        await sidebar.getByRole("link", { name: "Simulations" }).count(),
      ).toBe(0);
      expect(await sidebar.innerText()).not.toContain("Settings");

      await account.click();
      // The account menu's panel portals to `body` since the kit overlays,
      // so its items are found on the page, not inside the sidebar tree.
      expect(
        await page.getByRole("menuitem", { name: "Sign out" }).count(),
      ).toBe(1);
      expect(
        await page.locator("main").getByRole("button", { name: "Sign out" }).count(),
      ).toBe(0);
      await page.getByRole("menuitem", { name: "Settings" }).click();
      // Settings is inside the product shell now, so its address names the
      // project like every other product page and the selector stays on screen
      // throughout it. Its own navigation is what separates the settings that
      // belong to this project from the ones that belong to the organization.
      await page.waitForURL(new RegExp(`/projects/${project}/settings$`));
      await page
        .getByRole("navigation", { name: "Settings" })
        .getByRole("link", { name: "People" })
        .waitFor({ state: "visible" });
      await expect.poll(() => page.getByRole("menu").count()).toBe(0);

      await page.evaluate(() => {
        Reflect.set(globalThis, "__egma_same_document_navigation", true);
      });
      // Clicked until the address answers. The shell has just re-rendered
      // around the Settings page, and a click can land on a link node the
      // re-render is replacing — dispatched at something already detached,
      // handled by nobody, navigating nowhere; that is how this step once
      // timed out with the click reported delivered. Each poll turn clicks
      // again unless the address already moved, so the settled node gets
      // the next attempt. The marker above still proves what this test
      // exists to prove: retried clicks never reload the document, and a
      // product that did reload would wipe the marker and fail below
      // exactly as before.
      const atTests = new RegExp(`/projects/${project}/tests$`);
      await expect
        .poll(
          async () => {
            if (!atTests.test(page.url())) {
              await page
                .getByRole("link", { name: "Tests", exact: true })
                .first()
                .click({ timeout: 2_000 })
                .catch(() => undefined);
              await page
                .waitForURL(atTests, { timeout: 2_000 })
                .catch(() => undefined);
            }
            return page.url();
          },
          { timeout: 30_000 },
        )
        .toMatch(atTests);

      // The shell also spans the projectless creation page. Choosing it and
      // returning to the current project must keep the same settled context.
      await selector.click();
      await page
        .getByRole("menu")
        .getByText("New project", { exact: true })
        .click();
      await page.waitForURL(new RegExp(`/new-project$`));
      await selector.click();
      await page
        .getByRole("menu")
        .locator("button[data-menu-item]")
        .first()
        .click();
      await page.waitForURL(new RegExp(`/projects/${project}/agents$`));

      expect(
        await page.evaluate(() =>
          Reflect.get(globalThis, "__egma_same_document_navigation"),
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() => {
          const pageDocument = Reflect.get(globalThis, "document") as {
            querySelector(selector: string): unknown;
          };
          const watch = Reflect.get(
            globalThis,
            "__egma_shell_navigation_watch",
          ) as { readonly shell: unknown; readonly flickers: readonly string[] };
          return {
            sameShell: watch.shell === pageDocument.querySelector("aside"),
            flickers: watch.flickers,
          };
        }),
      ).toEqual({ sameShell: true, flickers: [] });
      expect(sessionReads).toEqual([]);

      page.off("request", countSessionRead);
      await page.evaluate(() => {
        const watch = Reflect.get(
          globalThis,
          "__egma_shell_navigation_watch",
        ) as { readonly observer: { disconnect(): void } };
        watch.observer.disconnect();
        Reflect.deleteProperty(globalThis, "__egma_shell_navigation_watch");
      });
    },
    SETTLE,
  );

  /**
   * Two tabs, two projects, and this is the only part of the project-context
   * change that genuinely needs a browser.
   *
   * **Everything else about the selector moved out.** Typing to filter, Enter
   * to choose, Escape returning focus, `push` rather than `replace` so that
   * Back means something, and the absence page a foreign project answers with
   * are all in `apps/web/test/components.test.tsx`, where each costs
   * milliseconds and none of them needs a database. What no fast test can
   * reach is two *independent browser contexts*, each holding the same session
   * and each looking at a different project — because one tab would pass while
   * a browser-wide choice quietly decided for both.
   */
  it(
    "keeps two tabs on two projects, each reading its own",
    async () => {
      // A second project for Acme, so that there is something to differ about.
      const outbound = newId("prj");
      await instance.database.sql(
        `insert into project (id, organization_id, name, slug, revision)
           select $1, id, 'Outbound', 'outbound', $2 from organization
            where slug = 'acme'`,
        [outbound, newId("rev")],
      );

      await page.goto(`${origin}/`);
      await page.waitForURL(/\/projects\/prj_[^/]+\/agents$/);
      const first = /\/projects\/(prj_[^/]+)\//.exec(page.url())?.[1];
      expect(first).toBeDefined();
      expect(first).not.toBe(outbound);

      // A second tab, opened on the other project by its address alone, with
      // this person's own session.
      const second = await browser.newContext();
      await second.addCookies(await page.context().cookies());
      const other = await second.newPage();
      other.setDefaultTimeout(30_000);
      await other.goto(`${origin}/projects/${outbound}/agents`);
      const otherSelector = other.locator(
        'aside button[aria-label^="Organization"]',
      );
      await otherSelector.waitFor({ state: "visible" });
      await expect.poll(() => otherSelector.innerText()).toContain("Outbound");

      // And the first tab did not move. Nothing about opening the second one
      // changed which project the first one is in, and its own read is still
      // its own project's.
      expect(page.url()).toContain(`/projects/${first}/agents`);
      await expect
        .poll(() =>
          page.locator('aside button[aria-label^="Organization"]').innerText(),
        )
        .toContain("Default");

      await second.close();
    },
    SETTLE,
  );

  /**
   * The window control is dressed as this product's own rather than as
   * whatever the browser ships.
   *
   * Asserted through `getComputedStyle` in a real Chrome, because that is the
   * only thing that can say whether the rule applied. A regex over
   * `globals.css` proves a line was typed, not that a browser honoured it —
   * and `appearance: base-select` is exactly the kind of rule a browser can
   * decline.
   */
  it(
    "dresses the window control as this product's own",
    async () => {
      await page.goto(monitoringAt(acme));
      await page.waitForSelector("#window");

      expect(
        await page.locator("#window").evaluate((element) => {
          const styleOf = Reflect.get(globalThis, "getComputedStyle") as
            (target: unknown) => { readonly appearance: string };
          return styleOf(element).appearance;
        }),
      ).toBe("base-select");
      expect(
        await page.locator("#window").evaluate((element) => {
          const styleOf = Reflect.get(globalThis, "getComputedStyle") as
            (target: unknown) => { readonly alignItems: string };
          return styleOf(element).alignItems;
        }),
      ).toBe("center");
    },
    SETTLE,
  );

  it(
    "opens on the last day, and shows the exchange the agent just had",
    async () => {
      await page.goto(monitoringAt(acme));

      await page.waitForSelector("table");
      const shown = await page.innerText("main");

      // The heading is the product's word for this area.
      //
      // **And it is the whole of what stands above the list now.** The boards
      // draw a list screen as a title bar, one strip of controls and the table
      // (`71V-0`, `71N-0`) — no label over the title and no purpose sentence
      // under it. The sidebar already says which section this is and which
      // project it belongs to, and the table says what it holds; the sentence
      // that used to sit here is kept for the screens that ask somebody to
      // fill something in. Updated with the ui-refresh restyle of this screen.
      expect(shown).toContain("Monitoring");
      expect(shown).not.toContain(
        "What your agents did in production, newest first.",
      );

      // The window control is on the default nobody chose, and the capture is
      // inside it — the browser's clock is pinned to the evening of the day the
      // capture was recorded. Nothing was widened to find this row.
      expect(await page.inputValue("#window")).toBe("24h");

      // The facts the list endpoint returns, as columns.
      const started = page.locator("tbody time").first();
      /*
       * **A list's date column is an absolute short date, never a changing
       * age.** The boards print `Aug 16, 2026` in every list column that holds
       * a time, and a column of ages cannot be scanned — two exchanges a
       * minute apart read the same for the whole of the first hour. This
       * column names the exchange itself, so it keeps the precision it has
       * always had and takes that shape (ui-refresh ticket 09, item a).
       */
      expect(await started.innerText()).toBe(
        asListInstant(FIXTURE_TRACE.started_at, "second"),
      );
      expect(await started.getAttribute("title")).toBe(
        asSecond(FIXTURE_TRACE.started_at),
      );
      expect(await started.getAttribute("datetime")).toBe(
        FIXTURE_TRACE.started_at,
      );
      expect(shown).toContain("1m 13s");
      expect(shown).toContain(
        `${FIXTURE_TRACE.humanTurns} human · ${FIXTURE_TRACE.agentTurns} agent`,
      );
      expect(shown).toContain(String(FIXTURE_TRACE.spans));
      expect(shown).toContain("LiveKit");

      /*
       * **And no column saying `production`.** Every row on this surface is
       * production by definition — the request narrows to it at the server and
       * a simulation is read under the run that produced it — so a column
       * repeating a constant on every line would be furniture. The word is
       * still a fact about one exchange, and it is asserted where it is shown:
       * on the transcript, under *Where this came from*.
       *
       * Asked of the table rather than of `main`, because the page's own lead
       * says the word in a sentence and would answer this question wrongly.
       */
      expect(await page.locator("thead th").allInnerTexts()).not.toContain(
        "Source",
      );
      expect(await page.innerText("table")).not.toContain("production");

      // The first thing the *human* said, which is what somebody scanning a
      // list is looking for — not the greeting the agent opens every one with.
      expect(shown).toContain("Hi Kelly, my name is Sam.");
      expect(shown).not.toContain("Hello! How can I assist you today?");

      // And exactly one row: one exchange was recorded, on page one, with no
      // next page to visit.
      expect(await page.locator("tbody tr").count()).toBe(1);
      expect(await page.getByText("Page 1", { exact: true }).count()).toBe(1);
      expect(
        await page
          .getByRole("button", { name: "Next", exact: true })
          .isDisabled(),
      ).toBe(true);
    },
    SETTLE,
  );

  it(
    "marks what failed without anybody having to open anything",
    async () => {
      await page.goto(monitoringAt(acme));
      await page.waitForSelector("table");

      // Three spans of this capture carry an error status — a model timing out,
      // the fallback giving up, and then a successful retry. The count is on the
      // row, so a list of a hundred exchanges says which one to open.
      const headings = await page.locator("thead th").allInnerTexts();
      const errors = headings.indexOf("Errors");
      expect(errors, headings.join(", ")).toBeGreaterThan(-1);

      expect(await page.locator("tbody tr td").nth(errors).innerText()).toBe(
        String(FIXTURE_TRACE.erroredSpans),
      );
    },
    SETTLE,
  );

  /**
   * The one thing that keeps the two kinds of traffic apart, asked on the wire.
   *
   * **Monitoring is production and nothing else.** A simulation is read under
   * the run that produced it — beside the frozen test, the persona, the graders
   * and the mock-tools record — so drawing it a second time and poorer here
   * would be a wrong door.
   *
   * Asked of the *request* rather than of the rows, and that division is
   * deliberate. Whether the server honours `source` is the contract's own claim
   * and is proved exhaustively at the seam in `trace-reads-contract.test.ts`,
   * including that paging never crosses into a simulation. What no seam test can
   * reach is whether **this page asks** — a page that narrowed what came back
   * instead would answer differently depending on what had already been
   * fetched, and would quietly break paging, while every row on screen still
   * looked right.
   *
   * The project rides along for the same reason: a request that named no
   * project would let the server pick one, which looks correct in the only
   * project a new customer has.
   */
  it(
    "asks the store for production only, and for this project",
    async () => {
      const asked: URL[] = [];
      const listen = (request: Request) => {
        const address = new URL(request.url());
        if (address.pathname === "/v1/traces") asked.push(address);
      };

      page.on("request", listen);
      try {
        await page.goto(monitoringAt(acme));
        await page.waitForSelector("table");
      } finally {
        page.off("request", listen);
      }

      expect(asked.length, "the list read the store").toBeGreaterThan(0);
      for (const one of asked) {
        expect(one.searchParams.get("source"), one.href).toBe("production");
        expect(one.searchParams.get("projectId"), one.href).toBe(acme);
        // And a window on every one of them, because the store is filed by time
        // and refuses a read that bounded nothing.
        expect(one.searchParams.get("from"), one.href).not.toBeNull();
        expect(one.searchParams.get("to"), one.href).not.toBeNull();
      }
    },
    SETTLE,
  );

  /**
   * The addresses these pages used to have, which are gone rather than moved.
   *
   * They were never linked from the product — a saved `/traces` is a hand-typed
   * one — so nothing redirects, and what somebody who kept one meets is the
   * application's own not-found rather than a page that half works.
   */
  it(
    "no longer answers where the old top-level pages were",
    async () => {
      for (const gone of [
        `${origin}/traces`,
        `${origin}/traces/4d1c0b9a8e7f6a5b4c3d2e1f00998877`,
      ]) {
        const answer = await page.goto(gone);
        expect(answer?.status(), gone).toBe(404);
        // And not the transcript wearing a 404: neither the list nor the
        // exchange drew anything here.
        const shown = await page.innerText("body");
        expect(shown, gone).not.toContain("The exchange");
        expect(shown, gone).not.toContain("Hi Kelly, my name is Sam.");
      }
    },
    SETTLE,
  );

  it(
    "keeps the window somebody chose in the address, so a reload stays on it",
    async () => {
      await page.goto(monitoringAt(acme));
      await page.waitForSelector("table");
      expect(await page.inputValue("#window")).toBe("24h");

      await page.selectOption("#window", "7d");
      await expect
        .poll(() => new URL(page.url()).searchParams.get("window"))
        .toBe("7d");

      // Which is the whole point of putting it there: opened again, cold, the
      // page is on the window it was left on rather than back on the default.
      await page.reload();
      await page.waitForSelector("table");
      expect(await page.inputValue("#window")).toBe("7d");
      expect(await page.locator("tbody tr").count()).toBe(1);

      // A window nobody was offered is not one. Editing the address to a word
      // the store would refuse lands on the default instead of on an error.
      await page.goto(`${monitoringAt(acme)}?window=all-of-it`);
      await page.waitForSelector("table");
      expect(await page.inputValue("#window")).toBe("24h");
    },
    SETTLE,
  );

  it("says nothing the glossary bans", async () => {
    await page.goto(monitoringAt(acme));
    await page.waitForSelector("table");
    saysNothingBanned(await page.innerText("main"));
  });
});

describe("one exchange, read as a transcript", () => {
  /** Following the link out of the list, which is how anybody arrives. */
  async function openIt(): Promise<void> {
    await page.goto(monitoringAt(acme));
    await page.waitForSelector("table");
    await page.evaluate(() => {
      const pageDocument = Reflect.get(globalThis, "document") as {
        readonly body: { readonly scrollHeight: number };
      };
      const scrollTo = Reflect.get(globalThis, "scrollTo") as
        (x: number, y: number) => void;
      Reflect.apply(scrollTo, globalThis, [0, pageDocument.body.scrollHeight]);
    });
    await page.locator("tbody tr td a").first().click();
    await page.waitForSelector("text=The exchange");
    await expect.poll(() => page.evaluate(() => Number(Reflect.get(globalThis, "scrollY")))).toBe(0);
  }

  it(
    "is reached from the row, which carries when it happened",
    async () => {
      await openIt();

      // Inside the project and inside its monitoring section, which is what a
      // row leads to now. The old address was outside every project, so a link
      // somebody sent opened whichever project the reader was resolved into.
      const landed = new URL(page.url());
      expect(landed.pathname).toMatch(
        new RegExp(`^/projects/${acme}/monitoring/transcripts/[0-9a-f]+$`, "u"),
      );

      // The window rode along in the address. That is the whole reason this
      // page can be a link somebody sends: the endpoint under it requires one,
      // and the row already knew the answer.
      const asked = landed.searchParams;
      expect(Date.parse(asked.get("from") ?? "")).toBeLessThan(
        Date.parse("2026-08-02T18:04:40.281989Z"),
      );
      expect(Date.parse(asked.get("to") ?? "")).toBeGreaterThan(
        Date.parse("2026-08-02T18:05:53.776865Z"),
      );

      // And it deep-links: the same address, opened cold, is the same page.
      const address = page.url();
      await page.goto(`${origin}/sign-in`);
      await page.goto(address);
      await page.waitForSelector("text=The exchange");
      await page.getByText("Where this came from", { exact: true }).click();
      const recorded = await page.innerText("main");
      expect(recorded).toContain(FIXTURE_PROVIDER_CALL_ID);

      /*
       * **`production`, as a fact about this one exchange.**
       *
       * It used to be a column on the list, which is where this assertion was.
       * The list no longer carries one — every row there is production by
       * definition — so the word moved here rather than being dropped: this is
       * a *fact* about a conversation, and a reader correlating it with a
       * simulation's own page needs to be able to tell which they are reading.
       */
      expect(recorded).toContain("Source");
      expect(recorded).toContain("production");

      /*
       * Expected behaviors grades simulations only. This production trace
       * reached an explicit supported-platform end, so its empty frozen
       * selection is a durable decision: no grader was requested. It is not a
       * pending grade, and the page does not invent one to fill the surface.
       */
      const grades = page.getByRole("region", { name: "Grades" });
      expect(await grades.innerText()).toContain("Not requested");
      expect(await grades.innerText()).toContain(
        "No grader was selected for this transcript.",
      );
      expect(await grades.innerText()).toMatch(/Current grades\s+0/iu);
    },
    SETTLE,
  );

  it(
    "is the exchange that was actually had, in the order it was had",
    async () => {
      await openIt();
      const shown = await page.innerText("main");

      // Thirteen turns, alternating, labelled the way a transcript labels them.
      expect((shown.match(/^human:/gmu) ?? []).length).toBe(
        FIXTURE_TRACE.humanTurns,
      );
      expect((shown.match(/^agent:/gmu) ?? []).length).toBe(
        FIXTURE_TRACE.agentTurns,
      );

      const said = [
        "Hello! How can I assist you today?",
        "Hi Kelly, my name is Sam.",
        "Can you tell me what the weather is like in Lisbon today?",
        "The weather in Lisbon today is sunny with a temperature of 70 degrees.",
        "Thanks, and how about Oslo? Is it colder there right now?",
        "Oslo is also sunny, but it has the same temperature of 70 degrees.",
        "Great, that is all I needed.",
        "Have a good day, and goodbye.",
        "Thank you, Sam! Have a great day, and goodbye!",
      ];
      let reached = -1;
      for (const line of said) {
        const at = shown.indexOf(line);
        expect(at, `"${line}" is on the page`).toBeGreaterThan(-1);
        expect(at, `"${line}" is in order`).toBeGreaterThan(reached);
        reached = at;
      }

      // The four agent turns where nothing was said are turns, not gaps: two of
      // them are where the agent only reached for the weather.
      expect((shown.match(/\(no speech in this turn\)/gu) ?? []).length).toBe(4);
    },
    SETTLE,
  );

  it(
    "opens a turn onto the timed steps inside it",
    async () => {
      await openIt();

      // The fifth turn is the agent's answer to the Lisbon question: it says
      // nothing out loud, because all it did was reach for the weather. Six
      // timed things happened inside it — the tool, and a model request that
      // nests four adapters deep — and the count says so before it is opened.
      const turns = page.locator('[data-turn="true"]');
      const weather = turns.nth(4);
      expect(await weather.innerText()).toContain("6 steps");

      await weather.locator("summary").first().click();
      const steps = weather.locator(":scope > div > div > details");
      expect(await steps.count()).toBe(2);
      expect(await steps.nth(0).innerText()).toContain("Model");
      expect(await steps.nth(1).innerText()).toContain("Tool");
      expect(await weather.innerText()).toMatch(/\d+(\.\d+)? (ms|s)/u);

      // And a step opens again onto exactly what was recorded — which is where
      // the raw facts live, and deliberately not the default view.
      const tool = steps.nth(1);
      expect(await tool.innerText()).not.toContain("lookup_weather");
      await tool.locator("summary").first().click();
      const recorded = await tool.innerText();
      expect(recorded).toContain("lookup_weather");
      expect(recorded).toContain('{"location": "Lisbon"}');
      expect(recorded).toContain("sunny with a temperature of 70 degrees.");
    },
    SETTLE,
  );

  it(
    "reaches what the framework did around the exchange, without it being the page",
    async () => {
      await openIt();

      // Not every recorded step happened inside a turn. The one everything else
      // happened inside is the clearest of them, and it is deliberately not part
      // of the exchange — a transcript that opened with a row for the whole
      // recording would be a table pretending to be a transcript.
      const shown = await page.innerText("main");
      expect(shown).toContain("Everything else recorded");
      expect(shown).not.toContain("Overview");

      // One click in, it is there, under egma's word for it rather than the
      // provider's. `agent_session` is the name LiveKit gave it and it is shown
      // beside — the two carry different information.
      const around = page.locator("details", { hasText: "Everything else recorded" }).last();
      await around.locator("summary").first().click();
      const reached = await around.innerText();
      expect(reached).toContain("Overview");
      expect(reached).toContain("agent_session");
    },
    SETTLE,
  );

  it(
    "marks the turn something failed inside, before it is opened",
    async () => {
      await openIt();
      const shown = await page.innerText("main");

      // A failure four adapters down is still this turn's failure, and finding
      // it must not mean opening all thirteen.
      expect(shown).toContain("something failed inside");
      expect(
        await page
          .locator("summary", { hasText: "something failed inside" })
          .count(),
      ).toBeGreaterThan(0);
    },
    SETTLE,
  );

  it("says nothing the glossary bans", async () => {
    await openIt();
    saysNothingBanned(await page.innerText("main"));
  });
});

/**
 * The transcript of an exchange nobody reported steps for.
 *
 * Span coverage is not uniform across providers — some emit rich native spans,
 * some emit a turn and nothing else — and a page that rendered only the rich
 * case would be a page that works for LiveKit. This one arrives at the same
 * door as the capture, carrying two turns and no children at all.
 */
describe("an exchange with nothing timed inside its turns", () => {
  it(
    "still renders as a transcript, and says what is missing rather than hiding it",
    async () => {
      const theirs = await anotherCustomer("bare@sparse.example", "Sparse");
      await send(theirs, [
        exchange(
          "4d1c0b9a8e7f6a5b4c3d2e1f00998877",
          new Date(AT.getTime() - 60 * 60 * 1000),
          "Is anybody there?",
          "I am here.",
        ),
      ]);

      // Their own browser, because this is a different organization and the two
      // must never see each other's anything — and their own project, read off
      // the address their session landed on rather than borrowed from Ada's.
      const them = await signedInBrowser("bare@sparse.example");

      await them.goto(monitoringAt(projectIn(them)));
      await them.waitForSelector("table");

      const listed = await them.innerText("main");
      expect(listed).toContain("Is anybody there?");
      expect(listed).not.toContain("Hi Kelly, my name is Sam.");

      await them.locator("tbody tr td a").first().click();
      await them.waitForSelector("text=The exchange");

      const shown = await them.innerText("main");
      expect(shown).toContain("human:");
      expect(shown).toContain("Is anybody there?");
      expect(shown).toContain("agent:");
      expect(shown).toContain("I am here.");
      // Nothing was reported inside either turn, and the page says exactly that
      // rather than leaving a space that could mean anything.
      expect((shown.match(/0 steps/gu) ?? []).length).toBe(2);

      await them.locator("summary", { hasText: "Is anybody there?" }).click();
      expect(await them.innerText("main")).toContain(
        "Nothing timed was recorded inside this turn.",
      );

      saysNothingBanned(shown);
      await them.context().close();
    },
    SETTLE,
  );
});

/**
 * More than one page of them.
 *
 * Paging is by **token**, not by offset: the answer carries where it stopped
 * and asking for more hands that back. An offset would re-sort and re-read the
 * rows already shown, and would skip or repeat one the moment something arrived
 * mid-page — which, on a store being written into by a live agent, is every
 * page. So the assertion that matters is not that a second page exists: it is
 * that the two pages together are every exchange, each exactly once.
 */
describe("more exchanges than one page holds", () => {
  const HOW_MANY = 51;

  it(
    "moves between cursor pages, skipping none and repeating none",
    async () => {
      const theirs = await anotherCustomer("many@globex.example", "Globex");

      // A minute apart, so newest-first is unambiguous, and inside the day the
      // page asks about.
      await send(
        theirs,
        Array.from({ length: HOW_MANY }, (_, index) =>
          exchange(
            `9a0b0c0d0e0f${String(index).padStart(20, "0")}`,
            new Date(AT.getTime() - (index + 1) * 60 * 1000),
            `This is exchange number ${index}.`,
            "Understood.",
          ),
        ),
      );

      const them = await signedInBrowser("many@globex.example");
      await them.goto(monitoringAt(projectIn(them)));
      await them.waitForSelector("table");

      // One page is fifty, which is the contract's default. There is more, and
      // the paging control says so rather than ending silently at the boundary.
      const rows = them.locator("tbody tr");
      expect(await rows.count()).toBe(50);
      expect(await them.innerText("main")).toContain("50 transcripts");
      expect(await them.getByText("Page 1", { exact: true }).count()).toBe(1);

      await reactHasTakenOver(them, "main button");
      await them.getByRole("button", { name: "Next", exact: true }).click();
      await expect
        .poll(async () => rows.count(), { timeout: 30_000 })
        .toBe(1);

      // Page two contains only the one older exchange. Page one is cached and
      // returns without mixing both pages into one table.
      expect(await them.innerText("main")).toContain("This is exchange number 50.");
      expect(await them.getByText("Page 2", { exact: true }).count()).toBe(1);
      expect(
        await them
          .getByRole("button", { name: "Next", exact: true })
          .isDisabled(),
      ).toBe(true);

      await them.getByRole("button", { name: "Previous" }).click();
      await expect.poll(async () => rows.count()).toBe(50);
      const shown = await them.innerText("main");
      const numbered = [...shown.matchAll(/This is exchange number (\d+)\./gu)].map(
        (found) => Number(found[1]),
      );
      expect(numbered).toEqual(Array.from({ length: 50 }, (_, index) => index));
      expect(await them.getByText("Page 1", { exact: true }).count()).toBe(1);

      await them.context().close();
    },
    SETTLE,
  );
});

describe("the saved theme", () => {
  it(
    "starts light, toggles from settings, and survives a reload",
    async () => {
      await page.goto(monitoringAt(acme));
      await page.evaluate(() => localStorage.removeItem("egma-theme"));
      await page.reload();

      expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
      const account = page.locator('aside button[aria-label^="Account"]');
      await account.click();
      const controls = page.getByRole("switch", { name: "Dark theme" });
      await expect.poll(() => controls.count()).toBe(1);
      await controls.first().click();

      expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
      expect(await page.evaluate(() => localStorage.getItem("egma-theme"))).toBe("dark");
      expect(await controls.first().getAttribute("aria-checked")).toBe("true");

      await page.reload();
      expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
      await page.locator('aside button[aria-label^="Account"]').click();
      await expect
        .poll(() => page.getByRole("switch", { name: "Dark theme" }).first().getAttribute("aria-checked"))
        .toBe("true");
    },
    SETTLE,
  );
});

/**
 * Hearing a recording from a run's results.
 *
 * **This file resists growing, and this is what had to grow it.** Every refusal,
 * every sentence and the shape of the link are proved at the route seam beside
 * it, where each costs milliseconds. What no route test can reach is whether a
 * *browser* can do anything with what the API mints: whether a real Chrome
 * fetches the signed link, decodes what comes back, seeks inside it, and
 * recovers when a link stops working. Those are the browser's own behaviours and
 * this is the only place they happen.
 *
 * **What this does not prove, said plainly, because a comment that overstates
 * its own proof is how a guarantee rots.** It does *not* prove the address
 * binding on its own. The store here answers on the same address this process
 * would use, so signed host and fetched host are equal by construction and would
 * stay equal if the API started signing for its own endpoint. What proves that
 * is two other things: `recordings-routes.test.ts` asserts the minted host is
 * the configured browser one and carries no internal name, `recording-store.test.ts`
 * makes a real MinIO refuse a link signed for a different host, and — the guard
 * that catches the mistake somebody would actually make — the compose check in
 * `deployment.test.ts` fails if `EGMA_BLOB_PUBLIC_URL` is ever defaulted to
 * `minio:9000`. This file is the other half of that: proof that the whole chain
 * ends in audio a person can hear.
 *
 * Two tests. The first is the story — a player where there is audio, seeking,
 * recovery, and nothing at all where there is no recording. The second is the
 * other way to have nothing to play, which is a modality that can never have any.
 */
describe.skipIf(!storage.available)("hearing a recording from a run", () => {
  it(
    "plays the audio from the store's own address, and offers nothing where there is none",
    async () => {
      const running = storage as Extract<ObjectStorage, { available: true }>;
      const reference = "sim_01JQ0A2B3C4D5E6F7G8H9J0K/dual-channel.wav";
      await running.put(reference, aRecording());

      // Ada's own run — the same Ada who has been signed in since the top of
      // this file, because a run somebody else owns is a run this browser
      // cannot open, which is a different test and it lives at the route seam.
      const hers = (await page.context().cookies(origin))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
      const who = await standingOf(instance.api, hers, "her recordings");
      const run = await aConductedRun(instance.api, who, { reference });

      const inProject = `${origin}/projects/${who.auth.projectId ?? ""}/runs/${run.runId}`;

      /*
       * The run first, and it mints nothing.
       *
       * **Opening one conversation is what asks for a link**, and that is now a
       * property of where the player lives rather than of a disclosure being
       * closed: the run lists its conversations and the evidence page is one
       * conversation. A run of two hundred must never mint two hundred links to
       * serve the one somebody wanted.
       */
      await page.goto(inProject);
      await page.getByRole("link", { name: /Reschedules/u }).first().waitFor({
        timeout: 30_000,
      });
      expect(await page.locator("audio").count()).toBe(0);

      await page.goto(`${inProject}/simulations/${run.heard}`);

      const player = page.getByLabel("Simulation recording");
      await player.waitFor({ timeout: 30_000 });

      // The link points at the **store**, and never at egma. The bytes do not
      // pass through the control plane; only the decision did.
      const source = await player.getAttribute("src");
      expect(new URL(source ?? "").origin).toBe(running.store.publicUrl);
      expect(new URL(source ?? "").origin).not.toBe(origin);
      expect(source).toContain("X-Amz-Signature=");

      // And it really loaded. This assertion is the whole reason a browser is
      // here: a link signed for the wrong host comes back 403 from a real
      // Chrome, `duration` stays `NaN`, and nothing else in the suite notices.
      await expect
        .poll(
          () =>
            player.evaluate((element) => {
              const audio = element as unknown as {
                readyState: number;
                duration: number;
              };
              return audio.readyState >= 1 && audio.duration > 0.5;
            }),
          { timeout: 30_000 },
        )
        .toBe(true);

      // Seeking, which is a byte range served by the store — the one thing that
      // would quietly not work if the audio were proxied or the link were bound
      // to a whole-object fetch.
      await player.evaluate((element) => {
        (element as unknown as { currentTime: number }).currentTime = 0.5;
      });
      await expect
        .poll(() =>
          player.evaluate((element) =>
            Math.round(
              (element as unknown as { currentTime: number }).currentTime * 10,
            ),
          ),
        )
        .toBe(5);

      /*
       * A link that has stopped working is asked for again, and the listener is
       * put back where they were.
       *
       * A results page open for an afternoon outlives the fifteen minutes a
       * link lives, and what a person then meets is a scrubber that stopped for
       * no stated reason. Waiting out a real expiry is not a test anybody can
       * run, so the store is made to refuse **once** — which is byte for byte
       * what an expired link looks like to this element — and what is asserted
       * is that the page recovers on its own, rather than that it noticed a
       * clock. The recovery deliberately does not consult one: a browser a few
       * minutes slow would decide a dead link was still good and never ask.
       */
      let refusals = 0;
      await page.route(`${running.store.publicUrl}/**`, async (route) => {
        refusals += 1;
        if (refusals > 1) return route.continue();
        return route.fulfill({
          status: 403,
          contentType: "application/xml",
          body: "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>",
        });
      });
      try {
        await player.evaluate((element) => {
          const audio = element as unknown as {
            currentTime: number;
            load(): void;
            dispatchEvent(event: unknown): void;
          };
          audio.currentTime = 0.75;
          const Event = Reflect.get(globalThis, "Event") as new (
            name: string,
          ) => unknown;
          audio.dispatchEvent(new Event("error"));
        });

        // A second link was asked for, off the same page, with no reload.
        await expect
          .poll(() => refusals, { timeout: 30_000 })
          .toBeGreaterThan(1);

        // And it plays, from where the listener had got to rather than from the
        // beginning — being thrown back to the start of a recording you were
        // part-way into is its own small betrayal.
        await expect
          .poll(
            () =>
              player.evaluate((element) => {
                const audio = element as unknown as {
                  readyState: number;
                  currentTime: number;
                };
                return audio.readyState >= 1
                  ? Math.round(audio.currentTime * 100)
                  : -1;
              }),
            { timeout: 30_000 },
          )
          .toBe(75);
      } finally {
        // Removed with `behavior: "wait"`, not the default: the player keeps
        // fetching the store while it plays, so a handler can be mid-continue
        // at exactly this moment, and a default removal races it over one
        // request. This is the page's only route here, so removing all of
        // them is the same removal with the safe semantics.
        await page.unrouteAll({ behavior: "wait" });
      }

      // The other conversation of the same run never connected, so it wrote no
      // recording — and its own page offers no control at all. A disabled
      // player there would read as a broken feature rather than an honest
      // absence.
      await page.goto(`${inProject}/simulations/${run.silent}`);
      // **Waited for the read that would have supplied a player**: the
      // default-open evidence sheet is drawn from the same answer, so by here
      // the page has been told everything it knows and is offering nothing.
      const silentEvidence = page.getByRole("dialog", {
        name: "Transcript and audio",
      });
      await silentEvidence.waitFor({ timeout: 30_000 });
      await silentEvidence
        .getByRole("heading", { name: "Transcript", exact: true })
        .waitFor();
      expect(await page.locator("audio").count()).toBe(0);
    },
    SETTLE,
  );

  it(
    "offers a chat nothing at all, because a chat has no audio and never will",
    async () => {
      // The other half of "only where there is something to play", and the half
      // the run above cannot reach: that one turns on whether a recording was
      // *written*, and this one on whether audio could exist at all. The page
      // asks both questions and only one of them was being answered here.
      //
      // Refusing a chat is proved at the route seam. What is proved here is the
      // page's own promise: no player, no placeholder, no disabled control —
      // nothing, so the product never implies audio that cannot exist.
      const hers = (await page.context().cookies(origin))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
      const who = await standingOf(instance.api, hers, "her chats");
      const run = await aConductedRun(instance.api, who, {
        reference: "unused-by-a-chat",
        modality: "chat",
        label: "a folder of chats",
      });

      await page.goto(
        `${origin}/projects/${who.auth.projectId ?? ""}/runs/${run.runId}/simulations/${run.heard}`,
      );
      // The default-open sheet comes off the same answer a player would have,
      // so waiting for it is waiting for the read that could contradict the
      // absence below.
      const evidence = page.getByRole("dialog", {
        name: "Transcript and audio",
      });
      await evidence.waitFor({ timeout: 30_000 });
      await evidence
        .getByRole("heading", { name: "Transcript", exact: true })
        .waitFor();

      expect(await page.locator("audio").count()).toBe(0);
      // Not even the line that says a recording is being looked for, which is
      // the one thing on this path that could momentarily imply there is one.
      expect(await page.locator("body").innerText()).not.toContain(
        "Finding the recording",
      );
    },
    SETTLE,
  );
});

/**
 * Hearing the same recording from the transcript, which is where the doubt is.
 *
 * **The minimum this file can grow by, and it does have to grow.** A transcript
 * resolves its recording from the trace identifier it already holds — the two
 * are the same number in two forms — and every part of that is proved at the
 * route seam beside it, in milliseconds: that the read names the simulation,
 * that the recording route then answers, and that a conversation which recorded
 * nothing is refused. What no route test reaches is whether a *browser* on this
 * page ends up with audio a person can hear, and whether the page that asks
 * about every exchange stays quiet on the ones that have none.
 *
 * One test, two transcripts of one run: the conversation that recorded, and the
 * one whose call never connected.
 */
describe.skipIf(!storage.available)("hearing a recording from a transcript", () => {
  it(
    "plays it beside the turns, and offers nothing where there is none",
    async () => {
      const running = storage as Extract<ObjectStorage, { available: true }>;
      const reference = "sim_01JQ0A2B3C4D5E6F7G8H9J0M/dual-channel.wav";
      await running.put(reference, aRecording());

      const hers = (await page.context().cookies(origin))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
      const who = await standingOf(instance.api, hers, "her transcripts");
      const run = await aConductedRun(instance.api, who, { reference });

      // The telemetry a simulator files for each of them, under the trace the
      // contract derives from the simulation id. Nothing here chooses an
      // address: that derivation is what makes a transcript and a run's results
      // two views of one conversation.
      const at = new Date(AT.getTime() - 5 * 60 * 1000);
      const heard = await fileTranscriptOf(
        instance,
        run.heard,
        { human: "I need to move my cleaning.", agent: "Of course — when to?" },
        at,
      );
      const silent = await fileTranscriptOf(
        instance,
        run.silent,
        { human: "Hello? Is anybody there?", agent: "" },
        at,
      );

      /*
       * Opened at the transcript's own address inside this project.
       *
       * **A simulation opens here, and that is on purpose.** Monitoring's
       * *list* is production only; one transcript is not filtered, because the
       * name already picks out a single row and a filter on a lookup could only
       * ever turn a transcript somebody was sent into a page saying it is not
       * there. A run's results link one of its conversations to exactly this
       * page.
       */
      const openTranscript = async (filed: typeof heard): Promise<void> => {
        const asked = new URLSearchParams({ from: filed.from, to: filed.to });
        await page.goto(
          `${monitoringAt(who.auth.projectId ?? "")}/${filed.traceId}?${asked.toString()}`,
        );
        await page.waitForSelector("text=The exchange");
      };

      await openTranscript(heard);

      // The turns are here, which is the whole reason somebody is on this page
      // rather than on the run's results.
      const shown = await page.innerText("main");
      expect(shown).toContain("I need to move my cleaning.");

      const player = page.locator("audio[data-recording]");
      await player.waitFor({ timeout: 30_000 });

      // The bytes come from the store and never through egma, exactly as they
      // do on the other surface — one route served both.
      const source = await player.getAttribute("src");
      expect(new URL(source ?? "").origin).toBe(running.store.publicUrl);
      expect(source).toContain("X-Amz-Signature=");

      // And a real Chrome made audio of it.
      await expect
        .poll(
          () =>
            player.evaluate((element) => {
              const audio = element as unknown as {
                readyState: number;
                duration: number;
              };
              return audio.readyState >= 1 && audio.duration > 0.5;
            }),
          { timeout: 30_000 },
        )
        .toBe(true);

      // Seeking, so the one turn somebody doubts can be reached without
      // listening from the start.
      await player.evaluate((element) => {
        (element as unknown as { currentTime: number }).currentTime = 0.5;
      });
      await expect
        .poll(() =>
          player.evaluate((element) =>
            Math.round(
              (element as unknown as { currentTime: number }).currentTime * 10,
            ),
          ),
        )
        .toBe(5);

      // Said beside it, so nobody mistakes egma's own audio for the audio a
      // framework's telemetry attached to a step of this same exchange.
      expect(await page.innerText("main")).toContain("Egma's own audio");
      saysNothingBanned(await page.innerText("main"));

      /*
       * The other conversation of the same run recorded nothing, and its
       * transcript offers no control at all — not a disabled one, which reads
       * as a broken feature rather than as an honest absence.
       *
       * **Waited for rather than looked at.** A player only appears once the
       * ask has been answered, so counting the elements the moment the turns
       * arrive would pass whether or not this page had learned to behave: the
       * request has barely left. So the refusal itself is what is waited on,
       * and only then is the page held to showing nothing.
       */
      const refused = page.waitForResponse(
        (answer) =>
          answer.url().includes("/v1/simulations/") &&
          answer.url().endsWith("/recording"),
      );
      await openTranscript(silent);
      expect((await refused).status()).toBe(404);

      expect(await page.innerText("main")).toContain("Is anybody there?");
      expect(await page.locator("audio").count()).toBe(0);
      // And the refusal's own sentence — written for whoever is reading a log
      // or a terminal — never reaches the page either. A transcript that
      // printed "this conversation has no recording" beside every chat and
      // every call that never connected would be the disabled control again,
      // wearing a sentence.
      expect(await page.innerText("main")).not.toContain("has no recording");
    },
    SETTLE,
  );
});

const BROWSER_CUSTOM_GRADER = "Polite resolution";

/**
 * The Graders surface, through the same browser, API, and stores a customer
 * uses. A definition on the library shelf is not active until this project
 * chooses it; customer authoring creates an organization definition and its
 * first project policy together.
 */
describe("the project grader library", () => {
  it(
    "uses Response latency and creates one custom LLM grader",
    async () => {
      await page.goto(`${origin}/projects/${acme}/graders`);
      await page.getByText("Expected behaviors", { exact: true }).waitFor();
      expect(await page.getByRole("tab", { name: "Active graders" }).count())
        .toBe(1);
      expect(await page.getByRole("tab", { name: "Grader library" }).count())
        .toBe(1);
      expect(await page.innerText("main")).toContain(
        "All simulations · Production off",
      );

      await page.getByRole("tab", { name: "Grader library" }).click();
      const latency = page
        .locator("table")
        .getByRole("row")
        .filter({ hasText: "Response latency" });
      await latency.waitFor();
      expect(await latency.innerText()).toContain("Available");
      await latency
        .getByRole("button", { name: "Open the menu for Response latency" })
        .click();
      await page.getByRole("menuitem", { name: "View details" }).click();

      const details = page.getByRole("dialog", { name: "Response latency" });
      await details.waitFor();
      await expect
        .poll(() => details.innerText(), { timeout: 30_000 })
        .toContain("turn response latency");
      expect(await details.innerText()).toContain(
        "Maximum average response time: 3 seconds by default",
      );
      await details.getByRole("button", { name: "Use in project" }).click();
      await details.getByLabel("Grades simulations").click();
      await details.getByLabel("All simulations").click();
      await details.getByLabel("Maximum average response time").fill("2.5");
      await details.getByRole("button", { name: "Use in project" }).click();

      await page.getByText("Grader added to Active graders.").waitFor();
      const activeLatency = page
        .locator("table")
        .getByRole("row")
        .filter({ hasText: "Response latency" });
      await activeLatency.waitFor();
      expect(await activeLatency.innerText()).toContain("All simulations");
      await activeLatency
        .getByRole("button", { name: "Open the menu for Response latency" })
        .click();
      await page.getByRole("menuitem", { name: "View and edit" }).click();
      const activeLatencyDetails = page.getByRole("dialog", {
        name: "Response latency",
      });
      expect(
        await activeLatencyDetails
          .getByLabel("Maximum average response time")
          .inputValue(),
      ).toBe("2.5");
      await activeLatencyDetails.getByRole("button", { name: "Cancel" }).click();

      await page.getByRole("button", { name: "Create custom grader" }).click();
      const custom = page.getByRole("dialog", { name: "Create custom grader" });
      await custom.waitFor();
      await custom.getByLabel("Name").fill(BROWSER_CUSTOM_GRADER);
      await custom
        .getByLabel("Grading instructions")
        .fill("The agent stays polite and resolves the request.");
      await custom.getByRole("button", { name: "Create grader" }).click();

      await page.getByText("Custom grader created and added to Active graders.")
        .waitFor();
      const activeCustom = page
        .locator("table")
        .getByRole("row")
        .filter({ hasText: BROWSER_CUSTOM_GRADER });
      await activeCustom.waitFor();
      expect(await activeCustom.innerText()).toContain("Organization");
      expect(await activeCustom.innerText()).toContain("LLM judge");
    },
    SETTLE,
  );
});

describe("recovering when a page cannot load", () => {
  it(
    "shows a retry for People and for an invitation lookup",
    async () => {
      await page.route("**/v1/members", (route) => route.abort());
      await openPeopleSettings(page);
      await page.waitForSelector("text=Egma could not be reached");
      await page.unroute("**/v1/members");
      await page.getByRole("button", { name: "Try again" }).click();
      await page.waitForSelector("text=Everybody in this organization");

      await page.route("**/api/invitations/lookup", (route) =>
        route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"unavailable"}' }),
      );
      await page.goto(`${origin}/invite?token=unreachable`);
      await page.waitForSelector("text=The invitation could not be checked");
      await page.unroute("**/api/invitations/lookup");
      await page.getByRole("button", { name: "Try again" }).click();
      await page.waitForSelector("text=That invitation does not name anything");
    },
    SETTLE,
  );
});

/* ==================================================================== *
 * The complete product, walked once, in order, in a second project.
 * ==================================================================== */

/**
 * One journey rather than a collection of pages.
 *
 * **This is the thing the product UI effort is finally judged by**, and it is
 * ordered on purpose: a person meets egma by making somewhere to work, putting
 * the agent they want to test into it, telling egma how to reach that agent,
 * describing who calls, switching judging on, writing what should happen,
 * running it, and reading what came back. Every step below is the previous
 * step's output, so a break anywhere in the chain shows up as the step that
 * could not start rather than as a page that rendered oddly.
 *
 * **It is in a project that is not the first one, throughout.** The first
 * project is where a fallback would hide: a page that reached for `projects[0]`
 * some other way, or a request that named no project and let the server pick,
 * looks perfectly correct in the default project and wrong nowhere else. So the
 * journey makes a second project through the product's own page, switches into
 * it with the control a person uses, and never leaves it.
 *
 * **Everything under it is real.** The real Next process with its real
 * rewrites, the real API, a real Postgres, a real ClickHouse, a real Chrome —
 * `support/instance.ts` stands all of it up and this file has one instance. The
 * only thing standing in for something is the simulator, which does not exist
 * in this lane: the run is planned and started through the screens, and its
 * conversation is then moved by the same data-access calls a simulator makes.
 * A fake feed would have proved that a page can render invented rows.
 *
 * **And it resists growing, the way the flows above it do.** Permissions,
 * archive matrices, refusals, revisions, Retry, idempotency, migration and
 * repository synchronization are all proved in the fast lane, where each costs
 * milliseconds. If a case here starts being about one of those, it belongs
 * there instead.
 */
describe("the complete product, walked in order in a second project", () => {
  /**
   * Ada's own browser for the walk, and a second page rather than the one
   * above.
   *
   * The page above has a clock pinned to the day the captured telemetry was
   * recorded, because the transcript list asks about the last twenty-four
   * hours. Nothing in this journey reads a fixed capture, and a run started
   * today under a clock set to a fortnight ago would be a run whose own page
   * says it started in the future. So this walk keeps the real clock and takes
   * Ada's session across as cookies.
   */
  let walk: Page;

  /** The first project, which this journey deliberately does not work in. */
  let first = "";
  /** The project it makes and then stays in. */
  let second = "";

  /** What each step leaves for the next one. */
  let agentAddress = "";
  let connectionAddress = "";
  let personaAddress = "";
  let suiteAddress = "";
  let testAddress = "";
  let runAddress = "";
  let conversation = "";

  /** The seven statements one Expected behaviors grade reads in this walk. */
  const expectedBehaviors = [
    "confirms the new time back before finishing",
    "checks that an afternoon next week is acceptable",
    "keeps the existing booking until the new time is confirmed",
    "states the day of the rescheduled cleaning",
    "states the time of the rescheduled cleaning",
    "does not create a second booking",
    "explains what happens to the Thursday booking",
  ] as const;

  /** Where the walk stands, for the one thing no browser can do. */
  let auth: {
    readonly userId: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly role: "admin";
    readonly via: "session";
  };

  /** One address inside the project this journey is in. */
  function at(...rest: readonly string[]): string {
    return [`${origin}/projects/${second}`, ...rest].join("/");
  }

  /** The run an address names, read off the address rather than remembered. */
  function runIdOf(address: string): string {
    const found = /\/runs\/(run_[0-9A-HJKMNP-TV-Z]{26})/u.exec(address)?.[1];
    expect(found, `${address} names a run`).toBeDefined();
    return found ?? "";
  }

  /** The conversation an address names, the same way. */
  function simulationIdOf(address: string): string {
    const found = /\/simulations\/(sim_[0-9A-HJKMNP-TV-Z]{26})/u.exec(
      address,
    )?.[1];
    expect(found, `${address} names a conversation`).toBeDefined();
    return found ?? "";
  }

  /** The test suite an address names, read off the address rather than copied. */
  function suiteIdOf(address: string): string {
    const found = /\/suites\/(ste_[0-9A-HJKMNP-TV-Z]{26})/u.exec(address)?.[1];
    expect(found, `${address} names a test suite`).toBeDefined();
    return found ?? "";
  }

  /** The only place a new test can be written: inside its permanent suite. */
  function testWriterAddress(): string {
    return `${at("tests", "new")}?suite=${suiteIdOf(suiteAddress)}`;
  }

  /** The project this control says the browser is standing in. */
  function selectorOf(which: Page) {
    return which.locator('aside button[aria-label^="Organization"]');
  }

  /**
   * What the page says, waited for.
   *
   * `waitForSelector` on a text engine is the shorter spelling and it is the
   * wrong one here: when a step of this journey goes wrong the page usually
   * says exactly why — a refusal, an absence, a project that is not this one —
   * and a timeout naming the string that never appeared throws that sentence
   * away. Polling the page's own text keeps it, and prints it with the failure.
   */
  async function saysWithin(which: Page, said: string): Promise<void> {
    await expect
      .poll(() => which.innerText("main").catch(() => ""), { timeout: 30_000 })
      .toContain(said);
  }

  /**
   * Finish the one browser journey's real queue row with one grade.
   *
   * No grader worker runs in this browser lane. The queue, frozen definition,
   * project threshold, ClickHouse grade row, and successful job deletion are
   * still the production doors; only the model call is replaced with the
   * deterministic answer this proof needs to read in Chrome.
   */
  async function finishExpectedBehaviorsGrade(traceId: string): Promise<void> {
    await expect
      .poll(
        async () =>
          (await getGradingJobForTrace(auth, traceId))?.status ?? "missing",
        { timeout: 30_000 },
      )
      .toBe("pending");

    const claimant = "browser-grader-proof";
    const claims = await claimGradingJobs({ claimant, capacity: 50 });
    const claim = claims.find((candidate) => candidate.traceId === traceId);
    expect(claim, `grading work exists for ${traceId}`).toBeDefined();
    if (claim === undefined) return;
    expect(claim.entries).toHaveLength(1);
    const entry = claim.entries[0];
    expect(entry, "Expected behaviors is in the frozen plan").toBeDefined();
    if (entry === undefined || claim.runId === null) return;

    const score = 6 / 7;
    const citedAgentTurn = `${traceId.slice(0, 14)}03`;
    await appendGrades(claim.auth, [
      {
        source: "simulation",
        traceId,
        traceStartedAtMicroseconds:
          BigInt(claim.traceStartedAt.getTime()) * 1_000n,
        runId: claim.runId,
        projectGraderId: entry.projectGraderId,
        graderDefinitionId: entry.graderDefinitionId,
        graderDefinitionVersion: entry.graderDefinitionVersion,
        score,
        details: {
          rationale: "Six of seven expected behaviors were present.",
          assertions: expectedBehaviors.map((behavior, at) => ({
            key: `behavior_${String(at + 1)}`,
            score: at === expectedBehaviors.length - 1 ? 0 : 1,
            rationale:
              at === expectedBehaviors.length - 1
                ? "The transcript did not explain what happened to the Thursday booking."
                : `The transcript supports: ${behavior}`,
            ...(at === expectedBehaviors.length - 1
              ? {}
              : { citedSpanIds: [citedAgentTurn] }),
          })),
        },
        graderPassThreshold: entry.graderPassThreshold,
        gradingSequence: claim.sequenceBase + claim.attempts,
        gradedAtMicroseconds: BigInt(Date.now()) * 1_000n,
      },
    ]);
    expect(
      await finishGradingJob(claim.auth, claim.id, claimant),
    ).toEqual({ id: claim.id });
  }

  /**
   * **The run's own machinery word**, as against any conversation's.
   *
   * A run's page holds four facts that must never be folded into one another,
   * and two of them spell their words the same way: the run is `completed` and
   * so is each conversation that finished. The one this reads is the fact
   * labelled `Run`, taken by its label rather than by a class a build hashes or
   * by a sentence somebody may reword.
   */
  async function machineryOfTheRun(which: Page): Promise<string> {
    return which.evaluate(() => {
      // The DOM library is deliberately not compiled into these tests, so the
      // shape this needs is named here rather than imported.
      const document = Reflect.get(globalThis, "document") as {
        querySelectorAll(selector: string): Iterable<{
          readonly textContent: string | null;
          readonly nextElementSibling: {
            readonly textContent: string | null;
          } | null;
        }>;
      };
      for (const label of document.querySelectorAll("main dt")) {
        if ((label.textContent ?? "").trim() !== "Status") continue;
        return (label.nextElementSibling?.textContent ?? "").trim();
      }
      return "";
    });
  }

  beforeAll(async () => {
    const context = await browser.newContext();
    await context.addCookies(await page.context().cookies());
    walk = await context.newPage();
    walk.setDefaultTimeout(30_000);
    walk.on("pageerror", (cause) => {
      process.stderr.write(`the page threw: ${cause.message}\n`);
    });
    walk.on("response", (response) => {
      if (response.status() >= 500) {
        process.stderr.write(
          `the page got ${response.status()} from ${response.url()}\n`,
        );
      }
    });
  }, SETTLE);

  afterAll(async () => {
    await walk.context().close();
  });

  it(
    "makes a second project, and switches into it with the control a person uses",
    async () => {
      // The entrance picks a door, once, in the open — and the address it lands
      // on names the project it picked.
      await walk.goto(`${origin}/`);
      await walk.waitForURL(/\/projects\/prj_[^/]+\/agents$/);
      first = /\/projects\/(prj_[^/]+)\//.exec(walk.url())?.[1] ?? "";
      expect(first).not.toBe("");

      // The one page deliberately outside every project. It draws no product
      // navigation and it says so rather than naming the first project.
      await walk.goto(`${origin}/new-project`);
      await reactHasTakenOver(walk, "form");
      await expect.poll(() => selectorOf(walk).innerText()).toContain("No project");
      expect(await walk.locator("aside nav").count()).toBe(0);

      await walk.fill("#new-project-name", "Support");
      await walk.fill(
        "#new-project-description",
        "The inbound queue, which is not where anybody's first project is.",
      );
      await walk.getByRole("button", { name: "Create project" }).click();

      await walk.waitForURL(/\/projects\/prj_[^/]+\/agents$/);
      second = /\/projects\/(prj_[^/]+)\//.exec(walk.url())?.[1] ?? "";
      expect(second).not.toBe("");
      expect(second, "the new project is not the first one").not.toBe(first);

      // Back to the first project, and then across with the selector rather
      // than by typing an address — which is the move this whole change was
      // about, and the only one that can silently decide for somebody.
      await walk.goto(`${origin}/projects/${first}/agents`);
      await expect.poll(() => selectorOf(walk).innerText()).toContain("Default");

      await selectorOf(walk).click();
      await walk
        .getByRole("menuitem", { name: "Support", exact: true })
        .click();

      await walk.waitForURL(`${origin}/projects/${second}/agents`);
      await expect.poll(() => selectorOf(walk).innerText()).toContain("Support");

      // Where the walk stands, for the one step below no browser can perform.
      const me = await instance.api.inject({
        method: "GET",
        url: "/api/me",
        headers: {
          cookie: (await walk.context().cookies(origin))
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; "),
        },
      });
      expect(me.statusCode, me.body).toBe(200);
      const who = me.json() as {
        user: { id: string };
        organizations: { id: string }[];
        projects: { id: string }[];
      };
      expect(
        who.projects.map((one) => one.id),
        "the new project is on this session's own list",
      ).toContain(second);
      auth = {
        userId: who.user.id,
        organizationId: who.organizations[0]?.id ?? "",
        projectId: second,
        role: "admin",
        via: "session",
      };
    },
    SETTLE,
  );

  it(
    "registers an agent, and gives egma a way to reach it",
    async () => {
      // A project nobody has put anything in says it is empty, which is a
      // different sentence from a page that failed to load.
      await walk.goto(at("agents"));
      await saysWithin(walk, "No agents in this project yet");

      /*
       * **One panel does both halves.** The agent and its first way in used to
       * be two pages with a forward between them, and an agent that never
       * reached the second one sat in the list unreachable. `/agents/new` is
       * still the address — the CLI and the documentation print it — and what
       * it opens is the side sheet over this list.
       */
      await walk.getByRole("link", { name: "Connect an agent" }).first().click();
      await walk.waitForURL(new RegExp(`/projects/${second}/agents/new$`));
      await reactHasTakenOver(walk, "form");

      // One field for the agent, and the shortness is the product's decision:
      // an agent's prompt, model and tools live where the customer configures
      // them, and the description column went with them (ADR-0015).
      await walk.fill("#agent-name", "The Support line");

      // The panel is drawn from the registry rather than from a list in the
      // browser, so waiting for the platform field is waiting for that read.
      await walk.waitForSelector("#agent-platform");
      await walk.getByLabel("Platform").selectOption("retell");
      /*
       * **Modality is the access choice on Retell.** Retell offers a chat
       * connection and a voice one and nothing else, so the board's segmented
       * control chooses between them and there is no Access select beside it.
       */
      await walk.getByRole("radio", { name: "Voice" }).click();
      await walk.fill("#connection-name", "Retell staging");
      await walk.fill("#retell-api-key", BROWSER_RETELL_KEY);
      const discoveryResponse = walk.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/v1/agents:discover",
      );
      await walk.getByRole("button", { name: "Load Retell agents" }).click();
      const discovered = await discoveryResponse;
      expect(discovered.status(), await discovered.text()).toBe(200);
      await walk.waitForSelector("#retell-agent");
      await expect.poll(() => walk.inputValue("#retell-agent")).toBe(
        BROWSER_RETELL_AGENT,
      );
      await expect.poll(() =>
        walk
          .locator("#discovered-connection option:checked")
          .textContent(),
      ).toContain(BROWSER_RETELL_NUMBER);
      /*
       * **One write, both halves.** `registerAgent` carries the connection, so
       * there is no window in which the agent exists and nothing can reach it.
       */
      const connectionResponse = walk.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/v1/agents",
      );
      await walk.getByRole("button", { name: "Connect agent" }).click();
      const connected = await connectionResponse;
      expect(connected.status(), await connected.text()).toBe(201);

      /*
       * **The panel closes onto the agent it just made**, which is the record
       * the person created rather than the list of everything that holds it.
       * The address is read from the product — the browser is standing on it —
       * rather than reconstructed from a database id.
       */
      await walk.waitForURL(
        new RegExp(`/projects/${second}/agents/agt_[^/?#]+$`),
      );
      agentAddress = walk.url();
      await saysWithin(walk, "The Support line");
      await saysWithin(walk, "Retell staging");

      // The selected discovery candidate goes through the generic connection
      // write. The stored connection is only the public phone destination; the
      // Retell key and agent id do not enter it.
      const stored = await instance.database.sql<{
        id: string;
        connection_type: string;
        access_variant: string;
        modality: string;
        config: Record<string, unknown>;
        credentials: string | null;
      }>(
        // No `agent_platform` column: which platform a connection reaches is
        // answered by its type where the type pins one, and by the agent
        // otherwise. `phone_number` spans platforms and pins nothing.
        `select id, connection_type, access_variant, modality, config, credentials
           from connection where name = 'Retell staging'`,
      );
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]).toMatchObject({
        connection_type: "phone_number",
        access_variant: "phone_number.public_e164",
        modality: "voice",
        config: { phoneNumber: BROWSER_RETELL_NUMBER },
        credentials: null,
      });
      // The connection's own address still exists and still opens the same
      // panel; the row's link, read off the list below, is the query form of it.
      const storedConnectionId = stored.rows[0]?.id ?? "";
      connectionAddress = `${agentAddress}/connections/${storedConnectionId}`;
      expect(JSON.stringify(stored.rows)).not.toContain(BROWSER_RETELL_KEY);
      expect(JSON.stringify(stored.rows)).not.toContain(BROWSER_RETELL_AGENT);

      /*
       * The agent's page is its identity, whether Egma pulls its production
       * calls, and its connections. Nothing else.
       *
       * The absences are asserted only after the connection's own name has
       * landed. A page still loading says none of these words either, so
       * checking them first would pass for the wrong reason — and go on
       * passing after the connections it is meant to guard stopped being drawn.
       */
      const agentPage = await walk.innerText("main");
      expect(agentPage).toContain("Connections");
      // The pull switch, which is the only stored monitoring choice in the
      // product and lives on the agent that owns it (ADR-0015). Nothing binds
      // this agent to a platform yet, so it reads off and says so.
      expect(agentPage).toContain("Production calls");
      expect(agentPage).toContain("Not bound");
      expect(agentPage).not.toContain("Recent runs");
      expect(agentPage).not.toContain("Attached tests");

      /*
       * And the list says egma can reach it, without anybody opening it. This
       * is the whole point of the widened read: the row carries the connection
       * in the registry's own words, the channel, and the environment label —
       * written out, because this connection has none.
       */
      await walk.goto(at("agents"));
      await saysWithin(walk, "The Support line");
      /*
       * **The row names the agent as plain text, and its ⋮ is the way in.**
       * This list is the one agent screen (`6ZJ-0`), so the name is a name
       * rather than a link, and the underline on this row belongs to the
       * connections alone. Open agent still carries the address the panel
       * landed on.
       */
      const named = walk
        .locator('table[aria-label="Agents in this project"] tbody tr')
        .filter({ hasText: "The Support line" })
        .first();
      await named.waitFor();
      expect(
        await named
          .getByRole("link", { name: "The Support line", exact: true })
          .count(),
        "the agent's name is not a link",
      ).toBe(0);
      await named
        .getByRole("button", { name: "Actions for The Support line" })
        .click();
      const openAgent = walk.getByRole("menuitem", {
        name: "Open agent",
        exact: true,
      });
      await openAgent.waitFor();
      expect(
        new URL((await openAgent.getAttribute("href")) ?? "/", origin).toString(),
        "the registered agent has a row whose menu opens it",
      ).toBe(agentAddress);
      await walk.keyboard.press("Escape");
      // And the way in is named on the row, as a link that opens it over the
      // list rather than as four facts nobody can press.
      const connection = walk
        .getByRole("link", { name: "Retell staging", exact: true })
        .first();
      await connection.waitFor();
      const connectionHref = await connection.getAttribute("href");
      expect(
        connectionHref,
        "the created connection opens from the row it is on",
      ).toContain("sheet=connection");
      expect(connectionHref).toContain(storedConnectionId);
      const row = walk
        .locator('table[aria-label="Agents in this project"] tbody tr')
        .first();
      // The way in, by the name somebody gave it.
      await expect
        .poll(() => row.innerText(), { timeout: 30_000 })
        .toContain("Retell staging");
      const said = await row.innerText();
      /*
       * **Retell under Platform, and that is a fact rather than a gap.**
       * A `phone_number` connection spans platforms, so it answers the platform
       * question through its agent. Register agent now records that required
       * platform declaration separately from Start monitoring's credentials.
       */
      expect(said).toContain("Retell");
      expect(said.toLowerCase()).not.toContain("not checked");
      expect(said.toLowerCase()).not.toContain("no connections yet");
    },
    SETTLE,
  );

  it(
    "authors a persona for this project",
    async () => {
      await walk.goto(at("agents"));
      await walk.getByRole("link", { name: "Personas", exact: true }).first().click();
      await walk.waitForURL(new RegExp(`/projects/${second}/personas$`));

      await walk.getByRole("link", { name: "New persona" }).first().click();
      await walk.waitForURL(new RegExp(`/projects/${second}/personas/new$`));
      await reactHasTakenOver(walk, "form");

      await walk.fill("#persona-name", "Impatient Rita");
      await walk.fill(
        "#persona-description",
        "Somebody in a hurry, calling from a busy place.",
      );
      // Who they are, never what they want, which belongs to the test. Human
      // traits and the separate Models section are saved together in the same
      // immutable persona version.
      await walk.fill(
        "#persona-personality",
        "Speaks quickly, interrupts, and wants the answer before the greeting is over.",
      );
      await walk.getByRole("button", { name: "Create persona" }).click();

      await walk.waitForURL(
        new RegExp(`/projects/${second}/personas/prs_[^/]+$`),
      );
      personaAddress = walk.url();
      await saysWithin(walk, "Impatient Rita");
    },
    SETTLE,
  );

  it(
    "sees the organization's custom grader inactive and edits only this project's Expected behaviors threshold",
    async () => {
      await walk.goto(at("graders"));
      await walk.waitForSelector("text=Expected behaviors");
      await saysWithin(walk, "All simulations · Production off");

      expect(
        await walk
          .locator("table")
          .getByRole("row")
          .filter({ hasText: BROWSER_CUSTOM_GRADER })
          .count(),
      ).toBe(0);
      await walk.getByRole("tab", { name: "Grader library" }).click();
      const customDefinition = walk
        .locator("table")
        .getByRole("row")
        .filter({ hasText: BROWSER_CUSTOM_GRADER });
      await customDefinition.waitFor();
      expect(await customDefinition.innerText()).toContain("Available");

      await walk.getByRole("tab", { name: "Active graders" }).click();

      const secondProjectGrader = walk
        .locator("table")
        .getByRole("row")
        .filter({ hasText: "Expected behaviors" });
      await secondProjectGrader
        .getByRole("button", { name: "Open the menu for Expected behaviors" })
        .click();
      await walk.getByRole("menuitem", { name: "View and edit" }).click();
      const thresholdEditor = walk.getByRole("dialog", {
        name: "Expected behaviors",
      });
      await thresholdEditor.getByLabel("Pass threshold").fill("0.62");
      await thresholdEditor.getByRole("button", { name: "Save changes" }).click();
      await walk.waitForSelector("text=Grader changes saved.");
      await expect
        .poll(() => secondProjectGrader.innerText(), { timeout: 30_000 })
        .toContain("0.62");

      // Project grader policy belongs to the project named by the address. A
      // write in the second project must not change the first project's row.
      await walk.goto(`${origin}/projects/${first}/graders`);
      const firstProjectGrader = walk
        .locator("table")
        .getByRole("row")
        .filter({ hasText: "Expected behaviors" });
      await firstProjectGrader.waitFor();
      expect(await firstProjectGrader.innerText()).not.toContain("0.62");

      await walk.goto(at("graders"));
      await expect
        .poll(
          () =>
            walk
              .locator("table")
              .getByRole("row")
              .filter({ hasText: "Expected behaviors" })
              .innerText(),
          { timeout: 30_000 },
        )
        .toContain("0.62");
    },
    SETTLE,
  );

  it(
    "creates the test suite before writing its first test",
    async () => {
      await walk.goto(at("tests"));
      await saysWithin(walk, "No test suites yet");

      await walk.getByRole("button", { name: "Create suite" }).click();
      const dialog = walk.getByRole("dialog", {
        name: "Create a suite",
      });
      await dialog.waitFor();
      await dialog.getByLabel("Suite name").fill("Support reception");

      const createResponse = walk.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/v1/test-suites",
      );
      await dialog.getByRole("button", { name: "Create suite" }).click();
      const created = await createResponse;
      expect(created.status(), await created.text()).toBe(201);

      await walk.waitForURL(
        new RegExp(
          `/projects/${second}/tests/suites/ste_[0-9A-HJKMNP-TV-Z]{26}$`,
        ),
      );
      suiteAddress = walk.url();
      await saysWithin(walk, "No tests in this suite");
      expect(await walk.innerText("main")).toContain("Support reception");
    },
    SETTLE,
  );

  it(
    "writes a test inside that suite, with the persona who calls about it",
    async () => {
      await walk.goto(suiteAddress);
      await walk.getByRole("link", { name: "Write a test" }).first().click();
      await walk.waitForURL(testWriterAddress());
      // The writer is the side sheet the boards draw, over the suite it writes
      // into: the block label is what the page says, and the panel's own
      // sub-line is which suite this test will belong to.
      await saysWithin(walk, "EXPECTED BEHAVIORS");
      expect(await walk.innerText("main")).toContain("In suite Support reception");

      await walk.fill("#test-name", "Reschedules a booked appointment");
      await walk.fill(
        "#test-scenario",
        "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
      );
      for (let at = 1; at < expectedBehaviors.length; at += 1) {
        await walk
          .getByRole("button", { name: "Add a behavior" })
          .click();
      }
      for (const [at, behavior] of expectedBehaviors.entries()) {
        await walk
          .getByRole("textbox", {
            name: `Expected behavior ${String(at + 1)}`,
          })
          .fill(behavior);
      }
      expect(
        await walk.getByRole("button", { name: "Choose agents" }).count(),
        "a test has no agent assignment",
      ).toBe(0);
      await walk.getByRole("button", { name: "Choose personas" }).click();
      await walk.getByRole("checkbox", { name: "Impatient Rita" }).click();
      await walk.getByRole("button", { name: "Done" }).click();
      await walk.getByRole("button", { name: "Write the test" }).click();

      await walk.waitForURL(new RegExp(`/projects/${second}/tests/tst_[^/]+$`));
      testAddress = walk.url();
      await saysWithin(walk, "Reschedules a booked appointment");
      // Read off the control rather than the page's text: the behavior is in a
      // box somebody can edit, and a textarea's value is not part of what a
      // page says.
      expect(
        await walk
          .getByRole("textbox", { name: "Expected behavior 1" })
          .inputValue(),
      ).toBe(expectedBehaviors[0]);
      expect(
        await walk
          .getByRole("textbox", { name: "Expected behavior 7" })
          .inputValue(),
      ).toBe(expectedBehaviors[6]);
    },
    SETTLE,
  );

  it(
    "starts one complete-suite run over that connection",
    async () => {
      await walk.goto(at("runs"));
      await walk.getByRole("link", { name: "Create a run" }).first().click();
      await walk.waitForURL(new RegExp(`/projects/${second}/runs/new$`));

      await walk.waitForSelector("#run-suite");
      await walk.selectOption("#run-suite", { label: "Support reception" });
      await walk.waitForSelector("#run-agent");
      await walk.selectOption("#run-agent", { label: "The Support line" });
      await walk.waitForSelector("#run-connection");
      await walk.selectOption("#run-connection", { index: 1 });

      const runBuilder = await walk.innerText("main");
      expect(runBuilder).toContain(
        "Egma runs the full suite. Individual tests cannot be picked here.",
      );
      expect(
        await walk
          .getByRole("checkbox", {
            name: "Include Reschedules a booked appointment",
          })
          .count(),
        "a run cannot select part of a suite",
      ).toBe(0);

      await walk.waitForSelector("#run-name");
      await walk.fill("#run-name", "The first run in Support");
      // Nothing here is a run with no grading plan: every project receives the
      // Expected behaviors project grader when the project is created.
      expect(
        await walk.locator("text=No grader is running in this project").count(),
      ).toBe(0);

      const start = walk.getByRole("button", { name: "Start run" });
      await expect.poll(() => start.isEnabled()).toBe(true);
      const startResponse = walk.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/v1/runs",
      );
      await start.click();
      const started = await startResponse;
      expect(started.status(), await started.text()).toBe(201);
      await walk.waitForURL(
        new RegExp(`/projects/${second}/runs/run_[^/]+$`),
      );
      runAddress = walk.url();
    },
    SETTLE,
  );

  it(
    "opens the run, which lists the simulation it wrote",
    async () => {
      await walk.goto(runAddress);
      // The section heading is present before its request finishes. Wait for
      // the row that proves the simulations response has landed, so every
      // assertion below reads the settled page rather than its loading shell.
      const row = walk
        .getByRole("link", { name: "Reschedules a booked appointment" })
        .first();
      await row.waitFor();

      const shown = await walk.innerText("main");
      expect(shown).toContain("Reschedules a booked appointment");
      expect(shown).toContain("Impatient Rita");
      expect(shown).toContain("Support reception");
      // What the run was against, as it now stands — the agent, and the
      // connection exactly as this run went over it.
      expect(shown).toContain("The Support line");
      expect(shown).toContain("Retell staging");

      conversation = (await row.getAttribute("href")) ?? "";
      expect(conversation).toMatch(/\/simulations\/sim_[0-9A-HJKMNP-TV-Z]{26}$/u);
    },
    SETTLE,
  );

  it(
    "opens that conversation's own evidence, before anything has conducted it",
    async () => {
      await walk.goto(`${origin}${conversation}`);
      const evidence = walk.getByRole("dialog", {
        name: "Transcript and audio",
      });
      await evidence.waitFor({ timeout: 30_000 });
      await evidence
        .getByRole("heading", { name: "Transcript", exact: true })
        .waitFor();

      const shown = await walk.innerText("main");
      // It is the conversation it says it is: the test it will execute, and
      // who will call about it.
      expect(shown).toContain("Reschedules a booked appointment");
      expect(shown).toContain("Impatient Rita");
      // And nothing has happened yet, said as an absence rather than as a
      // failure or as an empty space that could mean either.
      expect(await evidence.innerText()).toContain("No transcript was filed");
      expect(await walk.locator("audio").count()).toBe(0);
    },
    SETTLE,
  );

  it(
    "shows what the conversation left behind, once it has been conducted",
    async () => {
      // The one step in this journey no browser can take. A simulator would
      // claim it, hold the conversation and report; none runs in this lane, so
      // the same data-access calls a simulator makes are made here and the
      // telemetry goes in at the door a simulator's exporter posts to.
      const landed = await landOneConversationOf(auth, runIdOf(runAddress), {
        ...(storage.available
          ? { reference: `${simulationIdOf(conversation)}/dual-channel.wav` }
          : {}),
      });
      expect(landed).toBe(simulationIdOf(conversation));
      if (storage.available) {
        await (storage as Extract<ObjectStorage, { available: true }>).put(
          `${landed}/dual-channel.wav`,
          aRecording(),
        );
      }
      const filed = await fileTranscriptOf(
        instance,
        landed,
        {
          human: "I need to move my cleaning to next week.",
          agent: "Of course — which afternoon suits you?",
        },
        new Date(),
      );
      expect(filed.traceId).toBe(traceIdOfSimulation(landed));
      await finishExpectedBehaviorsGrade(filed.traceId);

      await walk.goto(`${origin}${conversation}`);
      const evidence = walk.getByRole("dialog", {
        name: "Transcript and audio",
      });
      await evidence.waitFor({ timeout: 30_000 });
      await evidence
        .getByRole("heading", { name: "Transcript", exact: true })
        .waitFor();

      await expect
        .poll(() => evidence.innerText(), { timeout: 30_000 })
        .toContain("I need to move my cleaning to next week.");
      const shown = await evidence.innerText();
      expect(shown).toContain("Of course — which afternoon suits you?");
      expect(shown).not.toContain("No transcript was filed");

      // One trace, one current grade, seven nested assertions, and one mean.
      // With one selected grader the display-only mean is that grader's score.
      const summary = walk.getByRole("region", { name: "Simulation summary" });
      expect(await summary.innerText()).toMatch(/Combined score\s+0\.86/u);

      const grades = walk.getByRole("region", { name: "Grades" });
      const expected = grades.getByRole("region", {
        name: "Expected behaviors",
      });
      expect(await expected.innerText()).toContain(
        "Score 0.86 · pass threshold 0.62",
      );
      expect(await expected.innerText()).toContain(
        "Six of seven expected behaviors were present.",
      );
      const assertionDetails = expected
        .getByText("Assertion details")
        .locator("..");
      expect(await assertionDetails.getByRole("listitem").count()).toBe(7);
      expect(await expected.innerText()).toContain(expectedBehaviors[0]);
      expect(await expected.innerText()).toContain(expectedBehaviors[6]);
      expect(await expected.innerText()).toContain(
        "The transcript did not explain what happened to the Thursday booking.",
      );
      for (const retired of [
        "overall verdict",
        "required grader",
        "gate",
        "Latency",
      ]) {
        expect((await grades.innerText()).toLowerCase()).not.toContain(
          retired.toLowerCase(),
        );
      }

      /*
       * And the run it belongs to has caught up with it, on the page somebody
       * would go back to.
       *
       * **The run's own word, read off the fact that names it.** A page-wide
       * search for `/completed/iu` was the first attempt and it proves nothing
       * here: the simulations table prints each simulation's own machinery
       * word, and the conversation above was completed a moment ago — so the
       * word is on this page whatever the *run* holds. A regression that left a
       * run `running` after its last conversation landed would have kept that
       * green, and telling a run's machinery apart from a conversation's is
       * exactly what this area exists to do.
       */
      await walk.goto(runAddress);
      await expect
        .poll(() => machineryOfTheRun(walk), { timeout: 30_000 })
        .toBe("completed");
    },
    SETTLE,
  );

  /* ------------------------------------------------------------------ *
   * The same project, revisited: the address is the whole of the state.
   * ------------------------------------------------------------------ */

  type ProductRoute = {
    readonly what: string;
    readonly address: string;
    /**
     * Something `main` says **only once this page has settled**, so that
     * arriving is proved rather than assumed.
     */
    readonly says: string;
  };

  /**
   * Every product route this project now has something on, named once.
   *
   * Written out rather than derived, because a list a test computes from the
   * application's own routing would go green about whatever that routing
   * happens to say — including about a route that stopped existing. Each entry
   * is a page a person can be sent a link to.
   *
   * **Each carries a phrase, and choosing it is the whole value of the list.**
   * The walks below used to wait for the shell — the organization control in
   * the sidebar — and then assert the address, a measurement, or the *absence*
   * of some word. Every one of those is satisfied by a page that is still
   * loading, and by a page drawing a refusal: the shell stays around a refusal
   * on purpose, which the absence case in this same file proves. So five
   * Settings routes could have stopped rendering entirely and all three walks
   * would have stayed green.
   *
   * A phrase is therefore taken from what the settled page says and from
   * nothing a loading or refused one does. Where a page draws the same header
   * in every state, the phrase is data that had to be read — this journey's own
   * agent, connection, persona, test or run — and where a page has one shape,
   * it is the sentence that shape carries.
   */
  function everyProductRoute(): readonly ProductRoute[] {
    return [
      { what: "Agents", address: at("agents"), says: "The Support line" },
      {
        what: "Register an agent",
        address: at("agents", "new"),
        // The refused shape of this page carries the other lead, so this
        // sentence is the form itself rather than the address of it.
        says: "Its name in Egma",
      },
      { what: "one agent", address: agentAddress, says: "The Support line" },
      {
        what: "Add a connection",
        address: `${agentAddress}/connections/new`,
        // The form is drawn from the registry, so this field exists only once
        // that read has landed.
        says: "Platform",
      },
      {
        what: "one connection",
        address: connectionAddress,
        says: "Retell staging",
      },
      {
        what: "Tests",
        address: at("tests"),
        says: "Support reception",
      },
      {
        what: "one test suite",
        address: suiteAddress,
        says: "Reschedules a booked appointment",
      },
      {
        what: "Write a test",
        address: testWriterAddress(),
        says: "In suite Support reception",
      },
      {
        what: "one test",
        address: testAddress,
        says: "Reschedules a booked appointment",
      },
      { what: "Personas", address: at("personas"), says: "Impatient Rita" },
      {
        what: "New persona",
        address: at("personas", "new"),
        /*
         * The New sheet's own sub-line, which the settled panel draws over the
         * list. The page's purpose statement moved there with the form when
         * the record moved into a side sheet, so this is the sentence the
         * shape now carries.
         */
        says: "Starts at v1 and is nobody's default",
      },
      {
        what: "one persona",
        address: personaAddress,
        says: "Impatient Rita",
      },
      {
        what: "Graders",
        address: at("graders"),
        // The protected project grader every project is created with.
        says: "Expected behaviors",
      },
      {
        what: "Runs",
        address: at("runs"),
        says: "The first run in Support",
      },
      {
        what: "Create a run",
        address: at("runs", "new"),
        // The whole page waits on the agents read, so its own sentence is
        // drawn only after that read answers.
        says: "Run every current test in one suite against one agent and one connection.",
      },
      {
        what: "one run",
        address: runAddress,
        says: "The first run in Support",
      },
      {
        what: "one conversation",
        address: `${origin}${conversation}`,
        says: "Reschedules a booked appointment",
      },
      {
        what: "Start monitoring",
        address: at("monitoring", "start"),
        /*
         * The start-monitoring flow, which replaced the monitoring-setup page
         * when the setup object was dropped (ADR-0015). The header's lead is
         * drawn while the roster read is still in flight, so the phrase is the
         * picker's own section heading, which only the settled page draws.
         *
         * The Monitoring list itself is not here: this walk opens it many
         * times already, under `monitoringAt`, and against its own states.
         */
        says: "What Egma should watch",
      },
      {
        what: "Settings",
        address: at("settings"),
        says: "What this product area is called",
      },
      {
        what: "People",
        address: at("settings", "people"),
        says: "Everybody in this organization",
      },
      {
        what: "Keys",
        address: at("settings", "keys"),
        says: "What a terminal or a script authenticates to Egma with",
      },
      {
        what: "Organization",
        address: at("settings", "organization"),
        says: "The customer every project below belongs to",
      },
    ];
  }

  /**
   * Arriving, proved by what the page says rather than by what the shell says.
   *
   * The shell is read too, because "in *this* project" is half the claim and
   * the project's name is only in the selector. But a page that is still
   * loading, or that drew a refusal inside a perfectly good shell, fails here.
   */
  async function landedOn(which: Page, route: ProductRoute): Promise<void> {
    await expect
      .poll(() => selectorOf(which).innerText().catch(() => ""), {
        timeout: 30_000,
      })
      .toContain("Support");
    await expect
      .poll(() => which.innerText("main").catch(() => ""), { timeout: 30_000 })
      .toContain(route.says);
  }

  /**
   * The route one address is, so a case that walks a handful of addresses can
   * wait for a settled page without keeping its own copy of what each one says.
   *
   * **An address with no entry throws rather than skipping the wait**, which is
   * the whole point of routing through the one list: a case that quietly
   * stopped waiting would go on asserting absences against a blank page, and a
   * blank page satisfies every absence there is.
   */
  function routeAt(address: string): ProductRoute {
    const found = everyProductRoute().find((one) => one.address === address);
    if (found === undefined) {
      throw new Error(
        `no product route is listed at ${address}, so nothing here knows what ` +
          `its settled page says. Add it to everyProductRoute().`,
      );
    }
    return found;
  }

  /**
   * Product controls that this version deliberately does not offer.
   *
   * These checks run while the direct-route walk already has the settled page
   * open. The shell has its own one-time check in that walk; these are the
   * controls and words that can differ from one page to another.
   */
  async function hasNoExcludedPageControls(
    which: Page,
    route: ProductRoute,
  ): Promise<void> {
    const shown = await which.innerText("main");

    // Historical run evidence cannot be removed from a product page.
    expect(shown, route.what).not.toMatch(/purge|delete permanently/iu);

    /*
     * `tag` and `replay` are valid words in some copy, so this checks only
     * controls that would let somebody use those excluded features.
     */
    for (const absent of [
      "Tags",
      "Add tag",
      "New tag",
      "Replay",
      "Retry",
      "Retry run",
      "Rerun",
      "Rerun simulation",
    ]) {
      expect(
        await which.getByRole("button", { name: absent }).count(),
        `${route.what} offers ${absent}`,
      ).toBe(0);
      expect(
        await which.getByRole("link", { name: absent }).count(),
        `${route.what} links ${absent}`,
      ).toBe(0);
      expect(
        await which.getByLabel(absent, { exact: true }).count(),
        `${route.what} asks for ${absent}`,
      ).toBe(0);
    }
  }

  /** Nothing in this settled page extends past a phone's right edge. */
  async function fitsPhoneWidth(which: Page, route: ProductRoute): Promise<void> {
    const tooWide = await which.evaluate(() => {
      const document = Reflect.get(globalThis, "document") as {
        readonly documentElement: {
          readonly scrollWidth: number;
          readonly clientWidth: number;
        };
        querySelectorAll(selector: string): Iterable<{
          readonly tagName: string;
          readonly className: unknown;
          readonly textContent: string | null;
          getBoundingClientRect(): {
            readonly right: number;
            readonly width: number;
          };
        }>;
      };
      const root = document.documentElement;
      const over = root.scrollWidth - root.clientWidth;
      if (over <= 1) return { over, worst: [] as string[] };

      const found: { how: number; what: string }[] = [];
      for (const element of document.querySelectorAll("main *")) {
        const box = element.getBoundingClientRect();
        const past = Math.round(box.right - root.clientWidth);
        if (past <= 1) continue;
        const named =
          typeof element.className === "string" && element.className !== ""
            ? `.${element.className.split(/\s+/u).join(".")}`
            : "";
        found.push({
          how: past,
          what:
            `${element.tagName.toLowerCase()}${named} ` +
            `${Math.round(box.width)}px wide, ${past}px past the edge: ` +
            `“${(element.textContent ?? "").trim().slice(0, 40)}”`,
        });
      }
      found.sort((one, two) => two.how - one.how);
      return { over, worst: found.slice(0, 3).map((one) => one.what) };
    });
    expect(
      tooWide.over,
      `${route.what} is wider than the screen — ${tooWide.worst.join(" | ")}`,
    ).toBeLessThanOrEqual(1);
  }

  describe("a copied link, reload, Back and Forward", () => {
    /**
     * Every product route, opened directly once.
     *
     * A direct open is what a copied link does. Each address is entered without
     * following an application link, and the settled page must belong to the
     * Support project. While that page is open, the same case checks its
     * page-specific exclusions and resizes it to a phone width. That keeps the
     * real layout proof without loading all 23 pages two more times.
     *
     * The shell is shared, so it is checked once. One stateful detail page is
     * reloaded as the representative proof that the address keeps its state;
     * focused reload cases elsewhere still prove their own window and theme
     * state.
     */
    it(
      "opens and checks every product route once, and reloads one",
      async () => {
        const sent = await browser.newContext({
          viewport: { width: 1280, height: 900 },
        });
        await sent.addCookies(await walk.context().cookies());
        const opened = await sent.newPage();
        opened.setDefaultTimeout(30_000);
        const reloadRoute = routeAt(`${origin}${conversation}`);

        try {
          for (const [index, route] of everyProductRoute().entries()) {
            await opened.setViewportSize({ width: 1280, height: 900 });
            await opened.goto(route.address);
            await landedOn(opened, route);
            expect(opened.url(), route.what).toBe(route.address);

            if (index === 0) {
              const sidebar = opened.locator("aside");
              /*
               * Monitoring used to be banned here and is deliberately not:
               * production traffic is a navigation item now. What stays
               * excluded is a Simulations *destination* — a simulation is
               * evidence, reached from the run that produced it, and no row in
               * this bar may open a list of every one.
               *
               * **The word is no longer the test, and it cannot be.**
               * `Simulations` is a group label now: it names the half of the
               * product that proves trust before release. A sweep of the bar's
               * text would fail on that label while the thing it guards is
               * still absent. A destination is an address, so the addresses are
               * what is read.
               */
              const addresses = await sidebar
                .getByRole("link")
                .evaluateAll((links) =>
                  links.map((link) => link.getAttribute("href") ?? ""),
                );
              /*
               * **The count, and not merely "some".** `toBeGreaterThan(0)` let
               * this sweep pass on a bar that had lost five of its six rows:
               * the loop below only ever says that what *is* here is allowed,
               * so an empty-ish bar satisfies every line of it. Six is the
               * whole of `NAVIGATION_GROUPS` — Agents, Graders, Tests,
               * Personas, Runs, Transcripts — and a row added or dropped
               * should be a decision somebody takes here on purpose.
               */
              expect(addresses, addresses.join(", ")).toHaveLength(6);
              expect(addresses, addresses.join(", ")).not.toContain("/");
              for (const address of addresses) {
                expect(address, address).not.toContain("simulations");
              }
              expect(
                await sidebar
                  .getByRole("link", { name: "Simulations" })
                  .count(),
              ).toBe(0);
            }

            await hasNoExcludedPageControls(opened, route);

            if (route.address === reloadRoute.address) {
              await opened.reload();
              await landedOn(opened, route);
              expect(opened.url(), `${route.what}, reloaded`).toBe(route.address);
            }

            // Resize the page that is already open. Do not visit it again.
            await opened.setViewportSize({ width: 390, height: 844 });
            if (index === 0) {
              expect(await opened.locator("aside").isVisible()).toBe(false);
              expect(
                await opened
                  .getByRole("button", { name: "Open product navigation" })
                  .isVisible(),
              ).toBe(true);
            }
            await fitsPhoneWidth(opened, route);
          }
        } finally {
          await sent.close();
        }
      },
      SETTLE,
    );

    it(
      "undoes a move between areas, and a change of project, with Back",
      async () => {
        await walk.goto(at("agents"));
        await expect
          .poll(() => selectorOf(walk).innerText(), { timeout: 30_000 })
          .toContain("Support");

        await walk.getByRole("link", { name: "Tests", exact: true }).first().click();
        await walk.waitForURL(at("tests"));
        // **Runs** by its label, `/runs` by its address. Both relabelings were
        // labels and only labels — the addresses never moved — and this line is
        // where the word and the address have to be spelled apart on purpose.
        await walk
          .getByRole("link", { name: "Runs", exact: true })
          .first()
          .click();
        await walk.waitForURL(at("runs"));

        await walk.goBack();
        await walk.waitForURL(at("tests"));
        await walk.goBack();
        await walk.waitForURL(at("agents"));
        await walk.goForward();
        await walk.waitForURL(at("tests"));

        /*
         * And the change of project itself, which is the one that has to be a
         * push rather than a replace. Choosing a project is a move somebody can
         * be wrong about — it is one click and it changes every list on the
         * screen — so Back has to undo it.
         */
        await selectorOf(walk).click();
        await walk
          .getByRole("menuitem", { name: "Default", exact: true })
          .click();
        await walk.waitForURL(`${origin}/projects/${first}/tests`);

        await walk.goBack();
        await walk.waitForURL(at("tests"));
        await expect
          .poll(() => selectorOf(walk).innerText(), { timeout: 30_000 })
          .toContain("Support");
      },
      SETTLE,
    );

    /**
     * Two tabs, two projects, every area — and this is the half of the
     * project-context change that genuinely cannot be proved anywhere else.
     *
     * There is a smaller version of this above, on the shell alone. What it
     * cannot say is whether the *pages* keep their tabs apart: the shell reads
     * the project out of the address, and a page that read it from anywhere
     * else — a module-level variable, a store, the session's own default —
     * would pass that test and fail this one. So both tabs walk the same five
     * areas, and each is held to reading its own project's data, with the reads
     * interleaved so that one tab's request cannot be what settles the other's.
     */
    it(
      "keeps two tabs on two projects across every area, each reading its own",
      async () => {
        const theirs = await browser.newContext();
        await theirs.addCookies(await walk.context().cookies());
        const other = await theirs.newPage();
        other.setDefaultTimeout(30_000);

        try {
          for (const area of ["agents", "tests", "personas", "graders", "runs"]) {
            // The second tab first, so that if a page did keep one chosen
            // project anywhere, the first tab is the one that would have been
            // moved by it.
            await other.goto(`${origin}/projects/${first}/${area}`);
            await expect
              .poll(() => selectorOf(other).innerText(), { timeout: 30_000 })
              .toContain("Default");

            await walk.goto(at(area));
            await expect
              .poll(() => selectorOf(walk).innerText(), { timeout: 30_000 })
              .toContain("Support");

            // Interleaved: the second tab is read again, after the first has
            // asked its own questions.
            expect(other.url(), area).toBe(`${origin}/projects/${first}/${area}`);
            await expect
              .poll(() => selectorOf(other).innerText(), { timeout: 30_000 })
              .toContain("Default");
          }

          // And the data, not only the shell's label. What this journey made is
          // in Support and in no other project, and the other tab says so by
          // not having it.
          await walk.goto(at("agents"));
          await saysWithin(walk, "The Support line");
          await other.goto(`${origin}/projects/${first}/agents`);
          /*
           * **The settled page first, and then the absence.** A negated poll
           * resolves on its first tick, and the first tick of a list is
           * "Loading…" — which does not contain this agent's name and never
           * would, whatever the page went on to show. So the other tab is held
           * to the agent the *first* project really has, registered at the top
           * of this file, and the absence is read off a list that has arrived.
           */
          await saysWithin(other, "Front desk");
          expect(await other.innerText("main")).not.toContain(
            "The Support line",
          );
          expect(await walk.innerText("main")).toContain("The Support line");
        } finally {
          await theirs.close();
        }
      },
      SETTLE,
    );
  });

  /* ------------------------------------------------------------------ *
   * One visual system: shared components, and tokens that reach them.
   * ------------------------------------------------------------------ */

  /**
   * What a measurement is, read from a real browser.
   *
   * A rule is not a measurement — a browser decides whether it applied, which
   * is the whole reason these two live here rather than in a regex over the
   * source. That was already true when the rules sat in one stylesheet, and it
   * is more true now that the classes live beside their components: a utility
   * in a class list says even less about what was drawn than a rule did.
   */
  async function heightOf(which: Page, selector: string): Promise<number> {
    return which
      .locator(selector)
      .first()
      .evaluate((element) => element.getBoundingClientRect().height);
  }

  async function widthOf(which: Page, selector: string): Promise<number> {
    return which
      .locator(selector)
      .first()
      .evaluate((element) => element.getBoundingClientRect().width);
  }

  /** One concrete pixel token, read from the document that uses it. */
  async function pixelToken(which: Page, token: string): Promise<number> {
    return which.evaluate((name) => {
      const styleOf = Reflect.get(globalThis, "getComputedStyle") as (
        target: unknown,
      ) => { getPropertyValue(key: string): string };
      const root = (
        Reflect.get(globalThis, "document") as {
          readonly documentElement: unknown;
        }
      ).documentElement;
      return Number.parseFloat(styleOf(root).getPropertyValue(name));
    }, token);
  }

  /**
   * One token's value, set on the document — and a way to take it back.
   *
   * The taking back is returned rather than left to the next `goto`. A comment
   * here claimed it happened and nothing did it: the value survived until the
   * next navigation, which was true of every caller by luck rather than by
   * design, and the next case written above one of them would have measured a
   * page somebody else had retuned.
   */
  async function retuned(
    which: Page,
    token: string,
    value: string,
  ): Promise<() => Promise<void>> {
    await which.evaluate(
      ([name, next]) => {
        const root = (
          Reflect.get(globalThis, "document") as {
            readonly documentElement: {
              readonly style: { setProperty(key: string, val: string): void };
            };
          }
        ).documentElement;
        root.style.setProperty(String(name), String(next));
      },
      [token, value],
    );

    return async () => {
      await which.evaluate((name) => {
        const root = (
          Reflect.get(globalThis, "document") as {
            readonly documentElement: {
              readonly style: { removeProperty(key: string): void };
            };
          }
        ).documentElement;
        root.style.removeProperty(String(name));
      }, token);
    };
  }

  describe("one visual system rather than a page's own", () => {
    /**
     * The same measurement on pages that were written at different times.
     *
     * **This is the readable form of "equivalent pages do not carry copied
     * visual implementations."** A page that had its own table, its own row
     * padding or its own sidebar would measure differently, and no amount of
     * looking at imports would say whether the difference is real — only a
     * browser can, because only a browser resolves the cascade.
     */
    it(
      "measures the same shell and the same cell on every list in the product",
      async () => {
        const lists = [
          at("agents"),
          at("tests"),
          at("personas"),
          at("graders"),
          at("runs"),
        ];

        /** One cell's own measurements, which content cannot move. */
        const cellStyle = () =>
          walk
            .locator("table tbody td")
            .first()
            .evaluate((element) => {
              const styleOf = Reflect.get(globalThis, "getComputedStyle") as (
                target: unknown,
              ) => {
                readonly paddingTop: string;
                readonly paddingRight: string;
                readonly paddingBottom: string;
                readonly paddingLeft: string;
                readonly fontSize: string;
              };
              const read = styleOf(element);
              // All four sides, not two. The vertical pair is what decides how
              // tall a row carrying a control comes out, so leaving it
              // unmeasured left the one dimension a page could differ in.
              return [
                read.paddingTop,
                read.paddingRight,
                read.paddingBottom,
                read.paddingLeft,
                read.fontSize,
              ].join("/");
            });

        const sidebars: number[] = [];
        const headings: number[] = [];
        const cells: string[] = [];
        const rows: number[] = [];
        const lanes: number[] = [];
        /** Where the toolbar strip ends and the panel under it begins. */
        let strip = { ends: 0, panelBegins: 0 };

        for (const address of lists) {
          await walk.goto(address);
          await walk.locator("table tbody tr").first().waitFor({ timeout: 30_000 });
          sidebars.push(Math.round(await widthOf(walk, "aside")));
          headings.push(Math.round(await heightOf(walk, "table thead tr")));
          cells.push(await cellStyle());
          rows.push(Math.round(await heightOf(walk, "table tbody tr")));
          if (address === lists[0]) {
            /*
             * **The toolbar row carries the gap, and the panel starts on the
             * pixel it ends on.** `71N-0` is a 52px strip — a 36px control with
             * 16px under it — and `6ZM-0` begins at 132 from the top of the
             * page, which is the title bar, the page gutter and that strip and
             * nothing more. Read as a relationship rather than as 132, because
             * 132 is three other numbers added up and this is the one of them
             * that was wrong: the body was adding a second gutter under the
             * strip and putting the panel at 156.
             */
            strip = await walk.evaluate(() => {
              const find = (selector: string) =>
                (
                  Reflect.get(globalThis, "document") as {
                    querySelector(one: string): {
                      getBoundingClientRect(): {
                        readonly top: number;
                        readonly bottom: number;
                      };
                    } | null;
                  }
                ).querySelector(selector);
              const toolbar = find('[data-slot="toolbar"]');
              const panel = find('[data-slot="table-panel"]');
              return {
                ends: Math.round(toolbar?.getBoundingClientRect().bottom ?? -1),
                panelBegins: Math.round(
                  panel?.getBoundingClientRect().top ?? -2,
                ),
              };
            });
          }
          /*
           * Only the lists that declare a trailing lane have one to measure.
           * All five do now — the last two grew a row ⋮ in ui-refresh 10 — and
           * this still measures whichever are there rather than demanding a
           * lane of a list that has no row control to put in one.
           */
          const lane = walk.locator('table tbody td[data-action="true"]');
          if ((await lane.count()) > 0) {
            lanes.push(
              Math.round(
                await widthOf(walk, 'table tbody td[data-action="true"]'),
              ),
            );
          }
        }

        expect(
          strip.panelBegins,
          `the toolbar strip ends at ${String(strip.ends)}`,
        ).toBe(strip.ends);
        expect(new Set(sidebars).size, sidebars.join(", ")).toBe(1);
        expect(new Set(headings).size, headings.join(", ")).toBe(1);
        expect(new Set(cells).size, cells.join(" | ")).toBe(1);

        /*
         * **A row is measured as a floor rather than as an equality**, and the
         * distinction is the honest one.
         *
         * `--row-min-height` is a `height` on a table cell, which a browser
         * treats as a minimum: a row carrying controls can be taller than a row
         * carrying a sentence, on the same table, from the same definition. A
         * test demanding one number would be a test demanding that no list ever
         * hold a button.
         *
         * It is the *body* row's token. `--row-height` is the header's, and
         * the header is held to an equality above because it holds no
         * controls. The two parted company on 2026-08-23, when the boards gave
         * a 40px header row and a 52px body row.
         *
         * What a copied implementation would break is the three above — the
         * shell, the heading row that holds no controls, and the cell's own
         * padding and type — and the floor here, which no page may sink below.
         */
        const tokens = await walk.evaluate(() => {
          const styleOf = Reflect.get(globalThis, "getComputedStyle") as (
            target: unknown,
          ) => { getPropertyValue(name: string): string };
          const root = (
            Reflect.get(globalThis, "document") as {
              readonly documentElement: unknown;
            }
          ).documentElement;
          const read = styleOf(root);
          return {
            sidebar: Number.parseInt(
              read.getPropertyValue("--sidebar-width"),
              10,
            ),
            row: Number.parseInt(
              read.getPropertyValue("--row-min-height"),
              10,
            ),
            header: Number.parseInt(read.getPropertyValue("--row-height"), 10),
            lane: Number.parseInt(
              read.getPropertyValue("--table-action-width"),
              10,
            ),
            control: Number.parseInt(read.getPropertyValue("--control-lg"), 10),
          };
        });

        // The shell's width is the token's own, rather than five pages
        // happening to agree on a hand-typed number.
        expect(sidebars[0]).toBe(tokens.sidebar);
        // The header row holds no controls, so it is an equality rather than a
        // floor — and it is the token's own number, not five pages agreeing.
        expect(headings[0], headings.join(", ")).toBe(tokens.header);
        // The trailing lane a row control stands in, on every list that has
        // one. A page that drew its own action column would put its control
        // somewhere else down the table.
        expect(lanes.length, "no list offered a row control").toBeGreaterThan(0);
        expect(new Set(lanes).size, lanes.join(", ")).toBe(1);
        expect(lanes[0], lanes.join(", ")).toBe(tokens.lane);
        // No list sinks below the row token, and none rises above it by more
        // than one control — which is the whole of what a row may hold.
        expect(Math.min(...rows), rows.join(", ")).toBeGreaterThanOrEqual(
          tokens.row,
        );
        expect(Math.max(...rows), rows.join(", ")).toBeLessThanOrEqual(
          tokens.row + tokens.control,
        );
      },
      SETTLE,
    );

    /** The same shared status meaning appears in list and compact detail forms. */
    it(
      "keeps one status meaning on a list and on the page it links to",
      async () => {
        const theRunsStatus = 'main span[title^="The run finished"]';
        const stateOf = async (): Promise<string> =>
          walk
            .locator(theRunsStatus)
            .first()
            .evaluate((element) => {
              if (element.getBoundingClientRect().height === 0) return "";
              return JSON.stringify({
                meaning: element.getAttribute("title"),
                text: element.textContent?.trim(),
                moving:
                  element.querySelector('[data-motion="active"]') !== null,
              });
            })
            .catch(() => "");

        const settledState = async (): Promise<string> => {
          let state = "";
          await expect
            .poll(
              async () => {
                state = await stateOf();
                return state;
              },
              { timeout: 30_000 },
            )
            .not.toBe("");
          return state;
        };

        await walk.goto(at("runs"));
        const onTheList = await settledState();

        await walk.goto(runAddress);
        const onThePage = await settledState();

        expect(onThePage, `${onTheList} on the list`).toBe(onTheList);
      },
      SETTLE,
    );

    /**
     * A change of visual direction, applied without touching a page.
     *
     * The developer's hands-on pass is an edit to
     * `apps/web/ui/tailwind-theme.css` and nothing else, and that promise is
     * only worth making if a value really does reach every page. So one is moved here, at runtime, and two pages that share
     * nothing but the components are held to following it — which they cannot
     * do if either of them drew its own.
     */
    it(
      "carries a retuned token into pages that share only their components",
      async () => {
        for (const address of [at("agents"), at("runs")]) {
          await walk.goto(address);
          await walk.locator("table tbody tr").first().waitFor({ timeout: 30_000 });

          const before = {
            sidebar: Math.round(await widthOf(walk, "aside")),
            row: Math.round(await heightOf(walk, "table tbody tr")),
            sidebarToken: await pixelToken(walk, "--sidebar-width"),
            rowToken: await pixelToken(walk, "--row-min-height"),
          };
          const nextSidebar = before.sidebarToken + 36;
          // A table row may already sit above its token because a control plus
          // cell padding sets a larger content floor. Move the token above the
          // measured row so the browser must show the full retune.
          const nextRow = before.row + 16;

          const putBackWidth = await retuned(
            walk,
            "--sidebar-width",
            `${nextSidebar}px`,
          );
          const putBackRow = await retuned(
            walk,
            "--row-min-height",
            `${nextRow}px`,
          );

          await expect
            .poll(async () => Math.round(await widthOf(walk, "aside")))
            .toBe(nextSidebar);
          let retunedRow = 0;
          await expect
            .poll(async () => {
              retunedRow = Math.round(
                await heightOf(walk, "table tbody tr"),
              );
              return retunedRow;
            })
            .toBeGreaterThanOrEqual(nextRow);

          expect(before.sidebar, address).toBe(before.sidebarToken);
          expect(before.row, address).toBeGreaterThanOrEqual(before.rowToken);
          expect(retunedRow, address).toBeGreaterThan(before.row);

          // **And it goes back**, which is what makes the two measurements
          // above a consequence of the token rather than of anything else that
          // happened on the way. It also leaves the page as it was found, so
          // nothing below this case is measuring somebody else's tuning.
          await putBackWidth();
          await putBackRow();
          await expect
            .poll(async () => Math.round(await widthOf(walk, "aside")))
            .toBe(before.sidebar);
          await expect
            .poll(async () => Math.round(await heightOf(walk, "table tbody tr")))
            .toBe(before.row);
        }
      },
      SETTLE,
    );

    /**
     * Compact, and measurably so.
     *
     * The direction is written down in `apps/web/ui/tailwind-theme.css` — a
     * sidebar narrow enough
     * to leave the screen to the data, a row that is one line of reading, a
     * control that sits in a toolbar rather than becoming it. What is held here
     * is the direction and not the numbers: the final art direction and the
     * tuning of every one of these is the developer's own pass, and a test that
     * pinned one old pixel value would have to be edited by that pass rather
     * than survive it.
     */
    it(
      "uses the settled compact tokens on the shell, a list and a form",
      async () => {
        await walk.goto(at("agents"));
        await walk.locator("table tbody tr").first().waitFor({ timeout: 30_000 });

        const tokens = {
          sidebar: await pixelToken(walk, "--sidebar-width"),
          row: await pixelToken(walk, "--row-min-height"),
          control: await pixelToken(walk, "--control-lg"),
        };

        // A sidebar is navigation, not a column of the product.
        expect(Math.round(await widthOf(walk, "aside"))).toBe(tokens.sidebar);
        // A row is a line of reading rather than a card.
        const row = Math.round(await heightOf(walk, "table tbody tr"));
        expect(row).toBeGreaterThanOrEqual(tokens.row);
        expect(row).toBeLessThanOrEqual(tokens.row + tokens.control);

        // A form's controls are the same height as the ones in a toolbar, which
        // is what stops an editor from becoming a different product.
        await walk.goto(at("agents", "new"));
        await reactHasTakenOver(walk, "form");
        const field = Math.round(await heightOf(walk, "#agent-name"));
        expect(field).toBe(tokens.control);

        await walk.goto(testWriterAddress());
        await reactHasTakenOver(walk, "form");
        expect(Math.round(await heightOf(walk, "#test-name"))).toBe(field);

        // And a transcript is dense: its turns are lines rather than cards.
        await walk.goto(`${origin}${conversation}`);
        const evidence = walk.getByRole("dialog", {
          name: "Transcript and audio",
        });
        await evidence.waitFor({ timeout: 30_000 });
        await evidence
          .getByRole("heading", { name: "Transcript", exact: true })
          .waitFor();
        await expect
          .poll(() => evidence.innerText(), { timeout: 30_000 })
          .toContain("I need to move my cleaning to next week.");
      },
      SETTLE,
    );
  });

  /* ------------------------------------------------------------------ *
   * A narrow screen, and no pointer at all.
   * ------------------------------------------------------------------ */

  describe("a narrow screen", () => {
    afterAll(async () => {
      await walk.setViewportSize({ width: 1280, height: 900 });
    });

    it(
      "restyles one semantic table for a narrow screen",
      async () => {
        await walk.setViewportSize({ width: 390, height: 844 });
        await walk.goto(at("agents"));
        await saysWithin(walk, "The Support line");

        // The DOM keeps one table. CSS turns its rows into the narrow stacked
        // shape, instead of rendering a second list with duplicate controls.
        const table = walk.locator('table[aria-label="Agents in this project"]');
        expect(await table.count()).toBe(1);
        expect(await table.isVisible()).toBe(true);
        expect(
          await table
            .locator("tbody tr")
            .first()
            .evaluate((row) => {
              const styleOf = Reflect.get(globalThis, "getComputedStyle") as (
                target: unknown,
              ) => { readonly display: string; readonly flexDirection: string };
              const style = styleOf(row);
              return `${style.display}/${style.flexDirection}`;
            }),
        ).toBe("flex/column");
        expect(
          await walk.locator('ul[aria-label="Agents in this project"]').count(),
        ).toBe(0);

        await walk.setViewportSize({ width: 1280, height: 900 });
        await expect.poll(() => table.isVisible()).toBe(true);
      },
      SETTLE,
    );

    it(
      "opens and closes the navigation drawer from the keyboard alone",
      async () => {
        await walk.setViewportSize({ width: 390, height: 844 });
        await walk.goto(at("agents"));
        await saysWithin(walk, "The Support line");

        const opener = walk.getByRole("button", {
          name: "Open product navigation",
        });
        await opener.focus();
        await walk.keyboard.press("Enter");

        const drawer = walk.getByRole("dialog");
        await drawer.waitFor();
        expect(await drawer.getByRole("link", { name: "Tests", exact: true }).count()).toBe(1);

        await walk.keyboard.press("Escape");
        await expect.poll(() => walk.getByRole("dialog").count()).toBe(0);
        // And the control that opened it has the focus back, so the next key
        // press goes somewhere a person expects.
        expect(
          await walk.evaluate(() => {
            const active = (
              Reflect.get(globalThis, "document") as {
                readonly activeElement: { getAttribute(name: string): string | null } | null;
              }
            ).activeElement;
            return active?.getAttribute("aria-label") ?? "";
          }),
        ).toBe("Open product navigation");
      },
      SETTLE,
    );
  });

  /**
   * The states a working product does not show you.
   *
   * Empty, error and viewer are all met elsewhere in this file — an empty
   * project at the top of this journey, a refused read and its retry in
   * "recovering when a page cannot load", and Bob's view-only shell where a
   * colleague is added. These three are the rest of the list, and each of them
   * is a state somebody meets on a bad day, so each is made to happen rather
   * than assumed. Its own section rather than the narrow screen's, because two
   * of the three are checked at both widths.
   */
  describe("loading and an absence", () => {
    it(
      "shows loading and an absence on a phone and on a desktop",
      async () => {
        for (const width of [390, 1280]) {
          await walk.setViewportSize({ width, height: 900 });

          // **Loading**, made to last by holding the read open. The page says
          // what it is waiting for rather than showing an empty frame that
          // could equally mean an empty project.
          let release = (): void => undefined;
          const held = new Promise<void>((resume) => {
            release = () => resume();
          });
          // Matched by predicate rather than by glob: the address carries a
          // query, and which characters a glob treats as special is the
          // library's business rather than something this test should depend
          // on.
          const theAgentsRead = (asked: URL) =>
            asked.pathname === "/v1/agents";
          const holdTheAgentsRead = async (route: Route) => {
            // The real answer is fetched at once; only its delivery is held.
            // The shorter spelling — await the gate, then `route.continue()`
            // — parks the request itself across the release below, and a
            // continue that loses the race kills the fetch. A
            // killed fetch carries no error for the page to react to, so it
            // renders as "Loading agents…" until the poll gives up — which
            // is exactly how this step once failed on a tree that passed
            // this same suite twice. Fetch-then-fulfil parks nothing: one
            // pending request until `release()`, then one delivery.
            const answer = await route.fetch();
            await held;
            return route.fulfill({ response: answer });
          };
          await walk.route(theAgentsRead, holdTheAgentsRead);
          try {
            await walk.goto(at("agents"));
            await expect
              .poll(() => walk.innerText("main"), { timeout: 30_000 })
              .toContain("Loading");
            release();
            // Keep the handler installed until the page has consumed the
            // released response. A finished route handler is not proof that
            // the browser's fetch promise and React state update have run.
            await saysWithin(walk, "The Support line");
          } finally {
            release();
            // Remove only this test's handler. Other routes on this page do
            // not belong to this loading-state proof.
            await walk.unroute(theAgentsRead, holdTheAgentsRead);
          }

          // **An absence**, in egma's own words rather than in a page's
          // paraphrase of them — a project this organization has not got is
          // the same answer as a project that never existed, on purpose.
          await walk.goto(`${origin}/projects/${newId("prj")}/agents`);
          await saysWithin(walk, "Not available here");
          expect(await walk.innerText("main")).toContain(
            "Choose a project from the selector",
          );
          // The shell is still around it: a refusal is a page, not a dead end.
          await expect
            .poll(() => selectorOf(walk).count(), { timeout: 30_000 })
            .toBeGreaterThan(0);
        }

      },
      SETTLE,
    );
  });

  describe("no pointer at all", () => {
    /** What has the focus, said the way a person would name it. */
    const focused = () =>
      walk.evaluate(() => {
        const active = (
          Reflect.get(globalThis, "document") as {
            readonly activeElement:
              | {
                  getAttribute(name: string): string | null;
                  readonly textContent: string | null;
                }
              | null;
          }
        ).activeElement;
        if (active === null) return "";
        // The name a control carries for a reader who cannot see it, and
        // its own words where it carries none — which is how the
        // navigation links name themselves.
        return (
          active.getAttribute("aria-label") ?? (active.textContent ?? "").trim()
        );
      });

    it(
      "reaches the shell's controls in the order they are drawn in",
      async () => {
        await walk.setViewportSize({ width: 1280, height: 900 });
        await walk.goto(at("agents"));
        await saysWithin(walk, "The Support line");

        // No click first: a fresh document starts with the focus on nothing, so
        // the first Tab is the first focusable thing on the page. Clicking a
        // corner would make the answer depend on what is drawn there.
        //
        // Organization is the first control and Project is the second.
        await walk.keyboard.press("Tab");
        expect(await focused()).toMatch(/^Open organization menu for/u);
        await walk.keyboard.press("Tab");
        expect(await focused()).toMatch(/^Organization/u);
        await walk.keyboard.press("Tab");
        expect(await focused()).toBe("Agents");
        // Graders, not Tests: the second row of the bar is the other half of
        // the standing pair at the top, and Tests begins the group below it.
        // That pair sits under no heading now — the developer dropped the word
        // "Global" rather than replace it — which changes nothing here, since a
        // heading was never a Tab stop.
        await walk.keyboard.press("Tab");
        expect(await focused()).toBe("Graders");
      },
      SETTLE,
    );

    /**
     * **A table's rows, reached and followed without a pointer.**
     *
     * The case above stops at the sidebar, and stopping there is what left the
     * word *tables* in this criterion covered by nothing: a list whose rows
     * could not be reached by Tab would have passed every keyboard case in this
     * file. A row's name is plain text now — the agents list is the one agent
     * screen — so the row's own control is its ⋮, and the promise is the
     * ordinary one: Tab gets to it, Enter opens it, Enter follows the way in
     * it offers. It has to hold past the page's own controls, one of which is
     * a radio group whose whole design is that it costs a single Tab stop
     * rather than one per option.
     *
     * The presses are bounded and the trail is reported. "Press Tab until
     * something happens" with no bound is a test that hangs where it should
     * fail, and the trail is what turns a failure into a sentence somebody can
     * read: it names every control the focus visited on the way.
     */
    it(
      "reaches a list's rows by Tab, and follows one with Enter",
      async () => {
        await walk.setViewportSize({ width: 1280, height: 900 });
        await walk.goto(at("agents"));
        await saysWithin(walk, "The Support line");

        const trail: string[] = [];
        let reached = false;
        // The row's ⋮ sits after the connection links in the same row, so the
        // bound allows for those stops as well as the page's own controls.
        for (let press = 0; press < 30 && !reached; press += 1) {
          await walk.keyboard.press("Tab");
          const name = await focused();
          trail.push(name === "" ? "(nothing)" : name);
          reached = name === "Actions for The Support line";
        }
        expect(reached, `the focus went ${trail.join(" → ")}`).toBe(true);

        // It is the row's own control in the table, rather than a heading or a
        // control that happens to carry the same words.
        expect(
          await walk.evaluate(() => {
            const active = (
              Reflect.get(globalThis, "document") as {
                readonly activeElement: {
                  closest(selector: string): unknown;
                } | null;
              }
            ).activeElement;
            return active === null ? "" : active.closest("table tbody") === null
              ? "outside the table"
              : "in the table";
          }),
        ).toBe("in the table");

        // Lifecycle filters are not part of this UI. They must not add hidden
        // keyboard stops before the rows either.
        expect(trail.filter((name) => name === "Active")).toEqual([]);
        expect(trail.filter((name) => name === "Archived")).toEqual([]);

        // Enter opens the row's menu on its first item, and Enter again
        // follows it to the agent this row is a row for.
        await walk.keyboard.press("Enter");
        await walk
          .getByRole("menuitem", { name: "Open agent", exact: true })
          .waitFor();
        expect(await focused()).toBe("Open agent");
        await walk.keyboard.press("Enter");
        await walk.waitForURL(agentAddress);
        await saysWithin(walk, "The Support line");
      },
      SETTLE,
    );

    it(
      "opens the account menu, chooses in it, and gives the focus back on Escape",
      async () => {
        await walk.goto(at("agents"));
        await saysWithin(walk, "The Support line");

        const account = walk.locator('aside button[aria-label^="Account"]');
        await account.focus();
        await walk.keyboard.press("Enter");
        await walk.getByRole("menuitem", { name: "Settings" }).first().waitFor();

        await walk.keyboard.press("Escape");
        await expect
          .poll(() => walk.getByRole("menuitem", { name: "Settings" }).count())
          .toBe(0);
        expect(
          await walk.evaluate(() => {
            const active = (
              Reflect.get(globalThis, "document") as {
                readonly activeElement: { getAttribute(name: string): string | null } | null;
              }
            ).activeElement;
            return (active?.getAttribute("aria-label") ?? "").slice(0, 7);
          }),
        ).toBe("Account");
      },
      SETTLE,
    );

    it(
      "fills in and submits a form without a pointer, and labels every field it asks for",
      async () => {
        await walk.goto(at("personas", "new"));
        await reactHasTakenOver(walk, "form");

        // Every control this form asks for has a name a screen reader can say.
        const unnamed = await walk
          .locator("main input, main textarea, main select")
          .evaluateAll((controls) =>
            controls
              .filter((control) => {
                const named =
                  control.getAttribute("aria-label") ??
                  control.getAttribute("aria-labelledby");
                if (named !== null && named !== "") return false;
                const id = control.getAttribute("id") ?? "";
                if (id === "") return true;
                const root = control.ownerDocument;
                return root.querySelector(`label[for="${id}"]`) === null;
              })
              .map((control) => control.getAttribute("id") ?? control.tagName),
          );
        expect(unnamed).toEqual([]);

        // And it is usable with the keyboard alone: reach the name, type, and
        // press Enter, which submits rather than doing nothing.
        await walk.locator("#persona-name").focus();
        await walk.keyboard.type("Deliberate Sam");
        await walk.locator("#persona-personality").focus();
        await walk.keyboard.type("Takes their time and repeats things back.");
        await walk.locator("#persona-name").focus();
        await walk.keyboard.press("Enter");

        await walk.waitForURL(
          new RegExp(`/projects/${second}/personas/prs_[^/]+$`),
        );
        await saysWithin(walk, "Deliberate Sam");
      },
      SETTLE,
    );

    /**
     * The recording controls, which are the browser's own.
     *
     * Egma does not draw a scrubber; it renders `<audio controls>` and Chrome
     * draws one that is already keyboard-operable. What egma can get wrong is
     * putting it somewhere the keyboard cannot reach, so what is asserted is
     * that it is in the tab order and takes the focus.
     */
    it.skipIf(!storage.available)(
      "reaches the recording controls with the keyboard",
      async () => {
        await walk.goto(`${origin}${conversation}`);
        const player = walk.getByLabel("Simulation recording");
        await player.waitFor({ timeout: 30_000 });

        expect(await player.getAttribute("controls")).not.toBeNull();
        await player.focus();
        expect(
          await walk.evaluate(() => {
            const root = Reflect.get(globalThis, "document") as {
              readonly activeElement: { readonly tagName: string } | null;
            };
            return root.activeElement?.tagName ?? "";
          }),
        ).toBe("AUDIO");
      },
      SETTLE,
    );
  });

  /* ------------------------------------------------------------------ *
   * What the product deliberately has not got.
   * ------------------------------------------------------------------ */

  /**
   * Page-specific exclusions. The exclusions shared by all product pages are
   * checked during the direct-route walk, while each settled page is open.
   */
  describe("what this version deliberately does not have", () => {
    it(
      "keeps an agent's prompt, model and tools where the customer configures them",
      async () => {
        for (const address of [agentAddress, at("agents", "new")]) {
          await walk.goto(address);
          // The settled page, not the shell: every assertion below is an
          // absence, and a page that never rendered asks for no Prompt, no
          // Model and no Tools either.
          await landedOn(walk, routeAt(address));

          for (const provider of ["Prompt", "Model", "Tools"]) {
            expect(
              await walk.getByLabel(provider, { exact: true }).count(),
              `${address} asks for a ${provider}`,
            ).toBe(0);
          }
        }
      },
      SETTLE,
    );

    it(
      "offers no way to author a mock tool, and no repository sync to press",
      async () => {
        // Mock tools are read on the evidence of a conversation — what was
        // covered and what was not — and are authored in the repository folder
        // rather than here.
        for (const address of [
          `${origin}${conversation}`,
          runAddress,
          at("tests"),
          at("settings"),
        ]) {
          await walk.goto(address);
          // The settled page, for the reason the case above gives: nothing
          // offers to author a mock tool on a page that has not drawn.
          await landedOn(walk, routeAt(address));

          for (const control of [
            "New mock tool",
            "Add mock tool",
            "Sync",
            "Sync now",
            "Pull",
            "Push",
          ]) {
            expect(
              await walk.getByRole("button", { name: control }).count(),
              `${address} offers ${control}`,
            ).toBe(0);
            expect(
              await walk.getByRole("link", { name: control }).count(),
              `${address} links ${control}`,
            ).toBe(0);
          }
        }
      },
      SETTLE,
    );
  });

  it(
    "keeps the run after its suite is renamed and then permanently deleted",
    async () => {
      await walk.goto(suiteAddress);
      await saysWithin(walk, "Reschedules a booked appointment");

      // Renaming and deleting a suite live in the suite's own ⋮ menu now, and
      // the rename surface is a side sheet named by the suite it is about.
      await walk.getByRole("button", { name: "Open the suite menu" }).click();
      await walk.getByRole("menuitem", { name: "Rename suite" }).click();
      const rename = walk.getByRole("dialog", {
        name: "Support reception",
      });
      await rename.waitFor();
      await rename.getByLabel("Suite name").fill("Northside Ford");
      const renameResponse = walk.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          new URL(response.url()).pathname ===
            `/v1/test-suites/${suiteIdOf(suiteAddress)}`,
      );
      await rename.getByRole("button", { name: "Save name" }).click();
      const renamed = await renameResponse;
      expect(renamed.status(), await renamed.text()).toBe(200);
      await saysWithin(walk, "Northside Ford");

      // A run reads the suite's current name. Renaming does not create a suite
      // version or change the suite identity recorded on the run.
      await walk.goto(runAddress);
      const summary = walk.getByRole("group", { name: "Run summary" });
      await expect.poll(() => summary.innerText()).toContain("Northside Ford");
      expect(await summary.innerText()).not.toContain("Support reception");
      expect(await summary.innerText()).not.toContain("(deleted)");

      await walk.goto(suiteAddress);
      await saysWithin(walk, "Northside Ford");
      await walk.getByRole("button", { name: "Open the suite menu" }).click();
      await walk.getByRole("menuitem", { name: "Delete suite" }).click();
      const deletion = walk.getByRole("dialog", {
        name: "Delete Northside Ford?",
      });
      await deletion.waitFor();
      expect(await deletion.innerText()).toContain(
        "This deletes the suite and its tests. Nobody can author or run them after this.",
      );
      expect(await deletion.innerText()).toContain(
        "Runs that already happened keep their results and transcripts.",
      );

      const deleteResponse = walk.waitForResponse(
        (response) =>
          response.request().method() === "DELETE" &&
          new URL(response.url()).pathname ===
            `/v1/test-suites/${suiteIdOf(suiteAddress)}`,
      );
      await deletion.getByRole("button", { name: "Delete suite" }).click();
      const deleted = await deleteResponse;
      expect(deleted.status()).toBe(204);
      await walk.waitForURL(at("tests"));
      await saysWithin(walk, "No test suites yet");
      expect(await walk.innerText("main")).not.toContain(
        "Reschedules a booked appointment",
      );

      // Deleting authoring data does not delete execution evidence. The same
      // run and simulation remain, and the last suite name is marked clearly.
      await walk.goto(runAddress);
      await expect.poll(() => summary.innerText()).toContain(
        "Northside Ford (deleted)",
      );
      await walk
        .getByRole("link", { name: "Reschedules a booked appointment" })
        .first()
        .waitFor();
    },
    SETTLE,
  );
});
