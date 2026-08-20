import { newId } from "@egma/ids";
import type { Browser, Page, Request, Route } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asSecond } from "../../web/lib/instants.ts";
import { PLATFORM_IDENTITY_PATH } from "../src/routes/platform.ts";
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

const BROWSER_RETELL_KEY = "retell-browser-fixture-key-WXYZ";
const BROWSER_RETELL_AGENT = "agent_in_retell_journey";
const BROWSER_RETELL_NUMBER = "+14155550100";
const BROWSER_PHONE_SETTINGS = {
  carrier_trunk_address: "browser-fixture.pstn.twilio.com",
  carrier_trunk_number: "+14155550101",
  text_to_speech_provider: "openai",
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
  if (url.pathname === "/list-phone-numbers") {
    return new Response(
      JSON.stringify([
        {
          phone_number: BROWSER_RETELL_NUMBER,
          nickname: "Support",
          inbound_agents: [{ agent_id: BROWSER_RETELL_AGENT }],
        },
      ]),
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

describe("what a self-hoster's origin answers before anybody logs in", () => {
  /**
   * The address a self-hoster is handed is this one — the pages — and it is the
   * address they paste into `npx egma --url`. The CLI reads the platform's
   * identity there before it sends a single repository identifier, so the read
   * has to survive the trip through this process. Proved here rather than
   * against the API's own port, because a rewrite that forgot this path would
   * pass every test that talks straight to the API and would still make a
   * running platform unusable from an agent repository.
   */
  it("serves the platform identity through the pages, at the origin the CLI is given", async () => {
    const read = await fetch(`${origin}${PLATFORM_IDENTITY_PATH}`, {
      headers: { accept: "application/json" },
    });
    expect(read.status).toBe(200);

    const identity = (await read.json()) as {
      instance_id: string;
      origin: string;
    };
    expect(identity.instance_id).toMatch(/^pf_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(identity.origin).toBe(origin);

    // The API's own port answers the same thing. One platform, one identity,
    // whichever door it is read through.
    const direct = await instance.api.inject({
      method: "GET",
      url: PLATFORM_IDENTITY_PATH,
    });
    expect(direct.json()).toEqual(identity);
  });
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
      // The address organization settings has always been at. Settings moved
      // into the product shell so the project selector stays on screen through
      // it, and this one resolves the project and goes there — which is the
      // half worth walking in a real browser, because a redirect that never
      // arrives looks exactly like a page that failed to load.
      await page.goto(`${origin}/members`);
      await page.waitForURL(/\/projects\/prj_[^/]+\/settings\/people$/);
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
      const connect = bob.getByRole("button", { name: "Connect agent" });
      await connect.first().waitFor();
      expect(
        await connect.evaluateAll((controls) =>
          controls.map((control) => (control as { disabled?: boolean }).disabled),
        ),
      ).not.toContain(false);
      expect(
        await bob.getByRole("link", { name: "Connect agent" }).count(),
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
      await page.goto(`${origin}/members`);
      await page.waitForURL(/\/settings\/people$/);
      // The wide layout's row. The list beside it is the same three controls
      // over the same person, drawn for a narrow screen from one column
      // definition, so driving either would prove the same thing.
      const bob = page.locator("tr", { hasText: "bob@acme.example" });
      await bob.waitFor();
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
        if (request.method() === "POST" && /\/api\/members\/[^/]+\/(?:deactivate|remove)$/u.test(path)) {
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
        await page.mouse.click(4, 4);
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

        await bob.getByRole("button", { name: "Remove" }).click();
        await page.keyboard.press("Escape");
        expect(memberActions).toHaveLength(1);

        await bob.getByRole("button", { name: "Remove" }).click();
        await page.mouse.click(4, 4);
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
 * incidental.** A key minted for a whole organization files its spans under no
 * project at all, while a browser session always acts inside one — so an
 * organization-wide key exports telemetry the dashboard cannot then find. That
 * asymmetry is the API's rather than these pages', and it is reported with the
 * ticket; what it means here is that the exporter is configured the way the
 * README says to configure it.
 */
async function keyForTheProject(cookie: string, name: string): Promise<string> {
  const me = await fetch(`${origin}/api/me`, { headers: { cookie } });
  expect(me.status, await me.clone().text()).toBe(200);
  const projects = ((await me.json()) as { projects: { id: string }[] }).projects;

  const minted = await fetch(`${origin}/api/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name, project_id: projects[0]?.id }),
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

      // Where you are, without having to open anything: the organization and
      // the project, on one compact control that is there with one project.
      const selector = sidebar.locator('button[aria-label^="Organization"]');
      await selector.waitFor({ state: "visible" });
      await expect.poll(() => selector.innerText()).toMatch(/acme/i);

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

      // The four product areas, and Personas and Graders beside them. Settings
      // is not one of them and neither is a simulation.
      for (const area of [
        "Agents",
        "Tests",
        "Simulation runs",
        "Monitoring",
        "Personas",
        "Graders",
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
       */
      expect(
        await sidebar
          .getByRole("link", { name: "Monitoring", exact: true })
          .getAttribute("href"),
      ).toBe(`/projects/${project ?? ""}/monitoring/transcripts`);

      // And the runs surface is reached by its new label. `Runs` on its own is
      // what it said before this effort separated the two kinds of traffic.
      expect(
        await sidebar.getByRole("link", { name: "Runs", exact: true }).count(),
      ).toBe(0);
      expect(await sidebar.getByRole("link", { name: "Home" }).count()).toBe(0);
      expect(
        await sidebar.getByRole("link", { name: "Simulations" }).count(),
      ).toBe(0);
      expect(await sidebar.innerText()).not.toContain("Settings");

      await account.click();
      expect(
        await sidebar.getByRole("menuitem", { name: "Sign out" }).count(),
      ).toBe(1);
      expect(
        await page.locator("main").getByRole("button", { name: "Sign out" }).count(),
      ).toBe(0);
      await sidebar.getByRole("menuitem", { name: "Settings" }).click();
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
        .getByRole("dialog")
        .getByText("New project", { exact: true })
        .click();
      await page.waitForURL(new RegExp(`/new-project$`));
      await selector.click();
      await page
        .getByRole("dialog")
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

      // The heading is the product's word for this area, and the page says what
      // it holds before a single row is read.
      expect(shown).toContain("Monitoring");
      expect(shown).toContain("What your agents did in production, newest first.");

      // The window control is on the default nobody chose, and the capture is
      // inside it — the browser's clock is pinned to the evening of the day the
      // capture was recorded. Nothing was widened to find this row.
      expect(await page.inputValue("#window")).toBe("24h");

      // The facts the list endpoint returns, as columns.
      const started = page.locator("tbody time").first();
      expect(await started.innerText()).toBe("2 hours ago");
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
      expect(shown).toContain("livekit");

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

      // And exactly one row: one exchange was recorded, and it is the last page.
      // `DataTable` no longer repeats a count beside a complete page, so the
      // rendered row and the absence of paging are the two facts to hold.
      expect(await page.locator("tbody tr").count()).toBe(1);
      expect(await page.getByRole("button", { name: "Show more" }).count()).toBe(
        0,
      );
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
        expect(one.searchParams.get("project_id"), one.href).toBe(acme);
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
    "carries on from where the last page stopped, skipping none and repeating none",
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
      // the paging control says so rather than ending silently at the page
      // boundary.
      const rows = them.locator("tbody tr");
      expect(await rows.count()).toBe(50);
      expect(await them.innerText("main")).toContain("50 transcripts");
      expect(
        await them.getByRole("button", { name: "Show more" }).count(),
      ).toBe(1);

      await reactHasTakenOver(them, "main button");
      await them.getByRole("button", { name: "Show more" }).click();
      await expect
        .poll(async () => rows.count(), { timeout: 30_000 })
        .toBe(HOW_MANY);

      // Every one of them, each exactly once, newest first.
      const shown = await them.innerText("main");
      const numbered = [
        ...shown.matchAll(/This is exchange number (\d+)\./gu),
      ].map((found) => Number(found[1]));
      expect(numbered).toEqual(
        Array.from({ length: HOW_MANY }, (_, index) => index),
      );

      // And nothing is left to ask for.
      expect(
        await them.getByRole("button", { name: "Show more" }).count(),
      ).toBe(0);

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
      await page.locator("aside").getByRole("switch", { name: "Dark theme" }).click();

      expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
      expect(await page.evaluate(() => localStorage.getItem("egma-theme"))).toBe("dark");
      expect(await controls.first().getAttribute("aria-checked")).toBe("true");

      await page.reload();
      expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
      await page.locator('aside button[aria-label^="Account"]').click();
      await expect
        .poll(() => page.locator("aside").getByRole("switch", { name: "Dark theme" }).getAttribute("aria-checked"))
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
        instance.api,
        run.heard,
        { human: "I need to move my cleaning.", agent: "Of course — when to?" },
        at,
      );
      const silent = await fileTranscriptOf(
        instance.api,
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
          answer.url().includes("/api/simulations/") &&
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

/**
 * The grader screens' addresses, which are inside a project.
 *
 * The library and the running copies moved under `/projects/:projectId` when
 * the product UI took over these screens: a running copy belongs to one
 * project, and an address that does not name one leaves the page to guess —
 * which it did, by drawing whichever project came first. So this asks the
 * platform which project this browser is standing in rather than assuming, and
 * both describes below go through it rather than each writing the address out.
 */
async function gradersUrl(step?: string): Promise<string> {
  const hers = (await page.context().cookies(origin))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  const who = await standingOf(instance.api, hers, "her graders");
  const at = `${origin}/projects/${who.auth.projectId ?? ""}/graders`;
  return step === undefined ? at : `${at}/${step}`;
}

/**
 * Switching the Use form from one grader to another, in a real browser.
 *
 * **The one thing about this screen a source scan cannot prove.** Every other
 * assertion about the Library screen is that it draws its controls from what the
 * entry declared and holds no list of its own, which reading the file settles.
 * What it cannot settle is what happens between two presses: a form is state,
 * and state that outlives the thing it was answering questions about is a bug
 * only a running page can show.
 *
 * The failure it is here to catch: the entry that asks for nothing was open,
 * somebody pressed Use on the entry that asks for a measure and a bound, and the
 * new entry's controls drew over the old entry's empty answers — a measure
 * dropdown with nothing chosen. Typing a bound and submitting then sends a bound
 * with no measure, and the write door refuses it naming a field the person can
 * see is filled in.
 */
describe("pressing Use on a second grader while the first one's form is open", () => {
  /** One library row's Use button, from the table rather than the mobile list. */
  function useOn(named: string) {
    return page
      .locator("table")
      .getByRole("row")
      .filter({ hasText: named })
      .getByRole("button", { name: "Use" });
  }

  it(
    "draws the second grader's form, with its own fields and nothing left over",
    async () => {
      await page.goto(await gradersUrl());
      // Both of egma's own graders, written onto the shelf at boot.
      await page.waitForSelector("text=Expected behaviors");
      await page.waitForSelector("text=Latency");

      // The entry whose assertions are each test's own sentences: it asks for
      // nothing, so its form has no fields at all.
      await useOn("Expected behaviors").click();
      await page.waitForSelector("text=Uses each test's expected behaviors");
      expect(await page.locator("form select").count()).toBe(0);

      // And now the other one, **without closing the first**.
      await useOn("Latency").click();

      // The heading followed, and the sentence belonging to the entry that asks
      // nothing is gone rather than sitting above fields that ask for two things.
      await page.waitForSelector("text=Use Latency");
      expect(
        await page.locator("text=Uses each test's expected behaviors").count(),
      ).toBe(0);

      // The measure dropdown is there, and so is the bound.
      const measure = page.locator("form select");
      await measure.waitFor();
      expect(await page.locator('form input[type="number"]').inputValue()).toBe(
        "",
      );

      /**
       * **Submitted, because the DOM cannot be asked this question.**
       *
       * A `<select>` whose React value is the empty string still *displays* its
       * first option and reports that option from `inputValue()` — so reading
       * the control back says "a measure is chosen" in exactly the case where
       * none is. The only witness that cannot be fooled is what the form
       * actually sends, and the write door is the thing that would refuse it:
       * "this grader needs metric".
       *
       * So this fills in the bound the way somebody would and presses the
       * button. A copy appearing is the proof that the measure travelled with
       * it.
       */
      await page.locator('form input[type="number"]').fill("2000");
      await page.getByRole("button", { name: "Start judging" }).click();

      await page.waitForSelector("text=is running on this project now");
      // And no refusal — a missing measure would have come back as one rather
      // than as a copy.
      expect(await page.locator("text=this grader needs").count()).toBe(0);
    },
    SETTLE,
  );

  it(
    "starts from the entry's own answers again when somebody switches back",
    async () => {
      // Type into the latency form, so there is something that could be left
      // behind, then go to the entry that asks nothing and come back.
      await useOn("Latency").click();
      await page.waitForSelector("text=Use Latency");
      await page.locator('form input[type="number"]').fill("1234");

      await useOn("Expected behaviors").click();
      await page.waitForSelector("text=Uses each test's expected behaviors");

      await useOn("Latency").click();
      await page.waitForSelector("text=Use Latency");

      // Nothing survived the round trip. This is the assertion the DOM *can*
      // answer honestly: an input holds the string it was given, so a bound
      // still reading 1234 is state that outlived the question it answered.
      expect(await page.locator('form input[type="number"]').inputValue()).toBe(
        "",
      );
    },
    SETTLE,
  );
});

/**
 * Changing a running copy and switching one off, in a real browser.
 *
 * **The one thing about this screen a source scan cannot prove**, and it is the
 * same shape as the Use form's above: the edit form is drawn from the library
 * entry and pre-filled from the copy, so what a person sees when they open it
 * is state assembled from two answers that arrived separately. A source scan
 * settles that the right components are wired together; only a running page
 * settles that the values come back.
 *
 * It is also the only place the **forwarding rule** for a copy's own address is
 * exercised. `/api/graders/:path*` is a rewrite this Next process resolves at
 * build time; without it the edit would post into this app's own file routing
 * and read Next's 404 page as though egma had refused it — and every other test
 * in the repository would still pass, because they all speak to the API
 * directly.
 *
 * It runs after the Use flow above and depends on it: that flow left a copy of
 * `latency` running on Ada's project, which is the row this one changes and
 * then switches off.
 */
describe("changing a running grader and switching it off", () => {
  /** One running copy's button, from the table rather than the mobile list. */
  function on(named: string, button: string) {
    return page
      .locator("table")
      .getByRole("row")
      .filter({ hasText: named })
      .getByRole("button", { name: button });
  }

  /** Every row of the table, the heading row included. */
  function rows() {
    return page.locator("table").getByRole("row");
  }

  /**
   * **Wait for the list to say it, never for the write to say it.**
   *
   * The screen shows what happened the moment the request comes back, and
   * *then* reads the list again — two commits, not one. So the sentence
   * confirming a write is not a signal that the table has caught up, and
   * counting rows straight after it is a race that widens under load until it
   * loses: this file counted three rows where two were expected the first time
   * the whole suite ran beside it.
   *
   * `expect.poll` is how the rest of this file waits on a list settling, and it
   * is the right shape here for the same reason — the assertion *is* the wait,
   * so there is no gap left between them for the screen to change in.
   */
  function settlesAt(howMany: number) {
    return expect.poll(() => rows().count(), { timeout: 30_000 }).toBe(howMany);
  }

  /**
   * The bound, which is the entry's own question — named by what it is not,
   * because what a grader asks for is the library entry's business and a test
   * spelling the parameter would be the copy of egma's catalog this screen
   * exists without.
   */
  const theEntrysNumber = 'form input[type="number"]:not(#edit-sample-rate)';

  it(
    "saves a new value and reads it back, and turns a blocker into a diagnostic",
    async () => {
      await page.goto(await gradersUrl("running"));
      // The table, settled: two graders on this project, and a heading row.
      await settlesAt(3);
      // Blocking, as anything switched on is unless somebody said otherwise.
      await page.waitForSelector("text=Blocks");

      await on("Latency", "Edit").click();
      await page.waitForSelector("text=Edit Latency");

      // Filled in from the copy, which is the half a source scan cannot see:
      // this is what was typed when Use was pressed, come back round.
      expect(await page.locator(theEntrysNumber).inputValue()).toBe("2000");

      await page.locator(theEntrysNumber).fill("1500");
      await page.locator("#edit-required").uncheck();
      await page.getByRole("button", { name: "Save" }).click();

      // What the write said, which is the sentence being asserted and **not**
      // the moment the table is fresh.
      await page.waitForSelector("text=is saved");
      // And what the *list* says, which is: the row's own cell, from the read
      // that happened after the write. This is the wait the next line depends
      // on — the form closes with the notice, so "Diagnostic" can only be
      // coming from the table by the time it matches.
      await page.waitForSelector("text=Diagnostic");

      // And opening it again shows the saved value rather than the old one —
      // which is the whole round trip: the browser wrote it, the API versioned
      // it, and the list handed it back.
      await on("Latency", "Edit").click();
      await page.waitForSelector("text=Edit Latency");
      expect(await page.locator(theEntrysNumber).inputValue()).toBe("1500");
    },
    SETTLE,
  );

  it(
    "says what a switched-off grader keeps before it switches one off",
    async () => {
      await page.goto(await gradersUrl("running"));
      await settlesAt(3);

      await on("Latency", "Switch off").click();

      // The sentence that makes the button pressable: what stops is obvious,
      // and what stays is the thing somebody is actually worried about.
      await page.waitForSelector("text=already judged keeps exactly what it said");

      await page.getByRole("button", { name: "Switch it off" }).click();
      // What the write said — the sentence, asserted for its own sake.
      await page.waitForSelector("text=is switched off");

      // And then what the list says, waited for rather than read straight off
      // the back of the sentence above: the row is gone, and the copy every
      // project is created with is still there — only the one that was named
      // stopped judging.
      await settlesAt(2);
      expect(await on("Latency", "Switch off").count()).toBe(0);
      await page.waitForSelector("text=Expected behaviors");
    },
    SETTLE,
  );
});

describe("recovering when a page cannot load", () => {
  it(
    "shows a retry for People and for an invitation lookup",
    async () => {
      await page.route("**/api/members", (route) => route.abort());
      await page.goto(`${origin}/members`);
      await page.waitForSelector("text=Egma could not be reached");
      await page.unroute("**/api/members");
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
  let testAddress = "";
  let runAddress = "";
  let conversation = "";

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
      await walk.fill("#project-search", "Supp");
      await walk.keyboard.press("Enter");

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

      await walk.getByRole("link", { name: "Connect agent" }).first().click();
      await walk.waitForURL(new RegExp(`/projects/${second}/agents/new$`));
      await reactHasTakenOver(walk, "form");

      await walk.fill("#agent-name", "The Support line");
      await walk.fill(
        "#agent-description",
        "The one that answers the phone at the front desk.",
      );
      await walk.getByRole("button", { name: "Register agent" }).click();

      await walk.waitForURL(/\/agents\/agt_[^/]+\/connections\/new\?onboarding=connection$/);
      agentAddress = walk
        .url()
        .replace(/\/connections\/new\?onboarding=connection$/u, "");
      // The form is drawn from the registry rather than from a list in the
      // browser, so waiting for the first field is waiting for that read.
      await walk.waitForSelector("#connection-type");

      await walk.fill("#connection-name", "Retell staging");
      await walk.fill("#retell-api-key", BROWSER_RETELL_KEY);
      await walk.getByRole("button", { name: "Load Retell agents" }).click();
      await walk.waitForSelector("#retell-agent");
      await expect.poll(() => walk.inputValue("#retell-agent")).toBe(
        BROWSER_RETELL_AGENT,
      );
      await expect.poll(() => walk.inputValue("#retell-number")).toBe(
        BROWSER_RETELL_NUMBER,
      );
      await walk.getByRole("button", { name: "Add connection" }).click();

      await walk.waitForURL(/\/agents\/agt_[^/]+\/onboarding$/);
      // Provider discovery rechecks the route immediately before the write.
      // The resulting connection is only the public phone destination; the
      // Retell key and agent id do not enter the stored connection.
      const stored = await instance.database.sql<{
        id: string;
        type: string;
        modality: string;
        config: Record<string, unknown>;
        credentials: string | null;
      }>(
        `select id, type, modality, config, credentials
           from connection where name = 'Retell staging'`,
      );
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]).toMatchObject({
        type: "phone",
        modality: "voice",
        config: { phoneNumber: BROWSER_RETELL_NUMBER },
        credentials: null,
      });
      connectionAddress = `${agentAddress}/connections/${stored.rows[0]?.id ?? ""}`;
      expect(JSON.stringify(stored.rows)).not.toContain(BROWSER_RETELL_KEY);
      expect(JSON.stringify(stored.rows)).not.toContain(BROWSER_RETELL_AGENT);
      await walk.getByRole("link", { name: "Finish setup" }).click();
      await walk.waitForURL(agentAddress);

      /*
       * The agent's page is its identity and its connections, and nothing else.
       *
       * The absences are asserted only after the connection's own name has
       * landed. A page still loading says none of these words either, so
       * checking them first would pass for the wrong reason — and go on
       * passing after the connections it is meant to guard stopped being drawn.
       */
      await saysWithin(walk, "Retell staging");
      const agentPage = await walk.innerText("main");
      expect(agentPage).toContain("Connections");
      expect(agentPage).not.toContain("Recent runs");
      expect(agentPage).not.toContain("Attached tests");

      /*
       * And the list says egma can reach it, without anybody opening it. This
       * is the whole point of the widened read: the row carries the platform in
       * the registry's own words, the channel, the environment label — written
       * out, because this connection has none — and whether the target has been
       * measured.
       */
      await walk.goto(at("agents"));
      await saysWithin(walk, "The Support line");
      const row = walk
        .locator('table[aria-label="Agents in this project"] tbody tr')
        .first();
      await expect
        .poll(() => row.innerText(), { timeout: 30_000 })
        .toContain("Phone number · Voice");
      const said = await row.innerText();
      expect(said).toContain("Unlabelled");
      // Read without regard to case: a chip is drawn in capitals, and the word
      // is the fact rather than the letterform it is set in.
      expect(said.toLowerCase()).toContain("not checked");
      expect(said.toLowerCase()).not.toContain("no connections");
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
      // Who they are, which is the whole of a persona — never what they want,
      // which is the test's. The voice is what the simulator brings them to
      // life with, and the form asks for both because egma refuses a caller
      // with no personality and no voice rather than inventing one.
      await walk.fill(
        "#persona-personality",
        "Speaks quickly, interrupts, and wants the answer before the greeting is over.",
      );
      await walk.fill("#persona-voice-id", "EXAVITQu4vr4xnSDxMaL");
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
    "switches a grader on, in this project and not in the first",
    async () => {
      await walk.goto(at("graders"));
      // Both of egma's own entries, written onto the shelf at boot.
      await walk.waitForSelector("text=Expected behaviors");
      await walk.waitForSelector("text=Latency");

      await walk
        .locator("table")
        .getByRole("row")
        .filter({ hasText: "Latency" })
        .getByRole("button", { name: "Use" })
        .click();
      await walk.waitForSelector("text=Use Latency");

      await walk.locator("form select").first().selectOption({ index: 1 });
      await walk.locator('form input[type="number"]').fill("2500");
      await walk.getByRole("button", { name: "Start judging" }).click();
      await walk.waitForSelector("text=is running on this project now");

      // On this project's own list, beside the copy every project is created
      // with — and the request that made it named this project in its body.
      await walk.goto(at("graders", "running"));
      await expect
        .poll(() => walk.locator("table").getByRole("row").count(), {
          timeout: 30_000,
        })
        .toBe(3);
      expect(await walk.innerText("main")).toContain("Latency");

      /*
       * **And not in the first**, which this case is named for and used never
       * to open.
       *
       * A copy is a project's own, so switching one on here must leave every
       * other project exactly as it was. The first project is the one that
       * would be moved by a write reading the session's acting project instead
       * of the address — the same fault five doors had — and it is also the one
       * project whose running list this file already knows the whole of:
       * `latency` was switched on there and then switched off again above, so
       * what is left is the copy every project is created with, and one heading
       * row.
       */
      await walk.goto(`${origin}/projects/${first}/graders/running`);
      await expect
        .poll(() => walk.locator("table").getByRole("row").count(), {
          timeout: 30_000,
        })
        .toBe(2);
      const inTheFirst = await walk.innerText("main");
      expect(inTheFirst).toContain("Expected behaviors");
      expect(inTheFirst).not.toContain("Latency");

      await walk.goto(at("graders", "running"));
      await saysWithin(walk, "Latency");
    },
    SETTLE,
  );

  it(
    "writes a test against that agent, with the persona who calls about it",
    async () => {
      await walk.goto(at("tests"));
      await walk.getByRole("link", { name: "Write a test" }).first().click();
      await walk.waitForURL(new RegExp(`/projects/${second}/tests/new$`));
      await saysWithin(walk, "What should happen");

      await walk.fill("#test-name", "Reschedules a booked appointment");
      await walk.fill(
        "#test-scenario",
        "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
      );
      await walk
        .getByRole("textbox", { name: "Expected behavior 1" })
        .fill("confirms the new time back before finishing");
      await walk.getByRole("button", { name: "Choose agents" }).click();
      await walk.getByRole("checkbox", { name: "The Support line" }).click();
      await walk.getByRole("button", { name: "Done" }).click();
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
      ).toBe("confirms the new time back before finishing");
    },
    SETTLE,
  );

  it(
    "creates a run over that connection and starts it",
    async () => {
      await walk.goto(at("runs"));
      await walk.getByRole("link", { name: "Create a run" }).first().click();
      await walk.waitForURL(new RegExp(`/projects/${second}/runs/new$`));

      await walk.waitForSelector("#run-agent");
      await walk.selectOption("#run-agent", { label: "The Support line" });
      await walk.waitForSelector("#run-connection");
      await walk.selectOption("#run-connection", { index: 1 });

      await walk
        .getByRole("checkbox", { name: "Include Reschedules a booked appointment" })
        .check();

      // The review is the same resolution the start performs, so waiting for it
      // is waiting for egma to have said what it would freeze.
      await walk.waitForSelector("#run-name");
      await walk.fill("#run-name", "The first run in Support");
      // Nothing here is a run that judges nothing: a grader was switched on two
      // steps ago and every project is created holding another.
      expect(
        await walk.locator("text=No grader is running in this project").count(),
      ).toBe(0);

      await walk.getByRole("button", { name: "Start run" }).click();
      const confirmation = walk.getByRole("dialog", { name: "Start this run?" });
      await confirmation
        .getByText("1 simulation will be conducted.")
        .waitFor();
      const startResponse = walk.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/runs",
      );
      await confirmation.getByRole("button", { name: "Start run" }).click();
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
      await saysWithin(walk, "Simulations");

      const shown = await walk.innerText("main");
      expect(shown).toContain("Reschedules a booked appointment");
      expect(shown).toContain("Impatient Rita");
      // What the run was against, as it now stands — the agent, and the
      // connection exactly as this run went over it.
      expect(shown).toContain("The Support line");
      expect(shown).toContain("Retell staging");

      const row = walk
        .getByRole("link", { name: "Reschedules a booked appointment" })
        .first();
      await row.waitFor();
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
      await fileTranscriptOf(
        instance.api,
        landed,
        {
          human: "I need to move my cleaning to next week.",
          agent: "Of course — which afternoon suits you?",
        },
        new Date(),
      );

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
        says: "Its name and description in Egma",
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
        says: "Reschedules a booked appointment",
      },
      {
        what: "Write a test",
        address: at("tests", "new"),
        says: "What should happen",
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
        says: "Who calls, and how they behave",
      },
      {
        what: "one persona",
        address: personaAddress,
        says: "Impatient Rita",
      },
      {
        what: "Graders",
        address: at("graders"),
        // Egma's own library entry, written onto the shelf at boot.
        says: "Expected behaviors",
      },
      {
        what: "the running graders",
        address: at("graders", "running"),
        // The copy every project is created with.
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
        says: "Choose one agent, one connection and the tests to run.",
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
        what: "Judge",
        address: at("settings", "judge"),
        says: "The model that decides an LLM judgment in this project",
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

    // A test suite is a saved selector over tests and this version has none.
    expect(shown, route.what).not.toMatch(/\bsuite/iu);
    // Archive is reversible. No page deletes evidence for good.
    expect(shown, route.what).not.toMatch(/purge|delete permanently/iu);

    /*
     * `tag` and `replay` are valid words in some copy, so this checks only
     * controls that would let somebody use those excluded features.
     */
    for (const absent of ["Tags", "Add tag", "New tag", "Replay"]) {
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
     * real layout proof without loading all 22 pages two more times.
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
              const navigation = await sidebar.innerText();
              // Monitoring used to be banned here and is deliberately not:
              // production traffic is a navigation item now — it is what the
              // monitoring-surface effort added. What stays excluded is a
              // Simulations area: a simulation is evidence, reached from the
              // run that produced it. "Simulation runs" is that run surface's
              // label and carries no "simulations" to trip the ban.
              expect(navigation).not.toMatch(/simulations/iu);
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
        // **Simulation runs** by its label, `/runs` by its address. The rename
        // was a label and only a label — the addresses did not move — and this
        // line is where the two have to be spelled differently on purpose.
        await walk
          .getByRole("link", { name: "Simulation runs", exact: true })
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
        await walk.fill("#project-search", "Default");
        await walk.keyboard.press("Enter");
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
   * A rule in a stylesheet is not a measurement — a browser decides whether it
   * applied, which is the whole reason these two live here rather than in a
   * regex over `system.module.css`.
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
          at("graders", "running"),
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

        for (const address of lists) {
          await walk.goto(address);
          await walk.locator("table tbody tr").first().waitFor({ timeout: 30_000 });
          sidebars.push(Math.round(await widthOf(walk, "aside")));
          headings.push(Math.round(await heightOf(walk, "table thead tr")));
          cells.push(await cellStyle());
          rows.push(Math.round(await heightOf(walk, "table tbody tr")));
        }

        expect(new Set(sidebars).size, sidebars.join(", ")).toBe(1);
        expect(new Set(headings).size, headings.join(", ")).toBe(1);
        expect(new Set(cells).size, cells.join(" | ")).toBe(1);

        /*
         * **A row is measured as a floor rather than as an equality**, and the
         * distinction is the honest one.
         *
         * `--row-height` is a `height` on a table cell, which a browser treats
         * as a minimum: a row carrying controls can be taller than a row
         * carrying a sentence, on the same table, from the same definition. A
         * test demanding one number would be a test demanding that no list ever
         * hold a button.
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
            row: Number.parseInt(read.getPropertyValue("--row-height"), 10),
            control: Number.parseInt(read.getPropertyValue("--control-lg"), 10),
          };
        });

        // The shell's width is the token's own, rather than five pages
        // happening to agree on a hand-typed number.
        expect(sidebars[0]).toBe(tokens.sidebar);
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
        const theRunsStatus = 'main span[title^="The machinery finished"]';
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
     * The developer's hands-on pass is an edit to `tokens.css` and nothing
     * else, and that promise is only worth making if a token really does reach
     * every page. So one is moved here, at runtime, and two pages that share
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
            rowToken: await pixelToken(walk, "--row-height"),
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
            "--row-height",
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
     * The direction is written down in `tokens.css` — a sidebar narrow enough
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
          row: await pixelToken(walk, "--row-height"),
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

        await walk.goto(at("tests", "new"));
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
            asked.pathname === "/api/agents";
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
        await walk.keyboard.press("Tab");
        expect(await focused()).toMatch(/^Organization/u);
        await walk.keyboard.press("Tab");
        expect(await focused()).toBe("Agents");
        await walk.keyboard.press("Tab");
        expect(await focused()).toBe("Tests");
      },
      SETTLE,
    );

    /**
     * **A table's rows, reached and followed without a pointer.**
     *
     * The case above stops at the sidebar, and stopping there is what left the
     * word *tables* in this criterion covered by nothing: a list whose rows
     * could not be reached by Tab would have passed every keyboard case in this
     * file. A row's name is a link, so the promise is the ordinary one — Tab
     * gets there, Enter follows it — and it has to hold past the page's own
     * controls, one of which is a radio group whose whole design is that it
     * costs a single Tab stop rather than one per option.
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
        for (let press = 0; press < 20 && !reached; press += 1) {
          await walk.keyboard.press("Tab");
          const name = await focused();
          trail.push(name === "" ? "(nothing)" : name);
          reached = name === "The Support line";
        }
        expect(reached, `the focus went ${trail.join(" → ")}`).toBe(true);

        // It is the row's own link in the table, rather than a heading or a
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
        await walk.locator("#persona-voice-id").focus();
        await walk.keyboard.type("EXAVITQu4vr4xnSDxMaL");
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
});
