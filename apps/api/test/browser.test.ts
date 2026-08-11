import type { Browser, Page, Request } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openBrowser } from "./support/browser.ts";
import {
  capturedRequests,
  FIXTURE_PROVIDER_CALL_ID,
  FIXTURE_TRACE,
} from "./support/fixture.ts";
import { SETTLE, startInstance, type Instance } from "./support/instance.ts";

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

beforeAll(async () => {
  instance = await startInstance("browser", { traces: true });
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
      await page.goto(`${origin}/members`);
      expect(await page.getByText("Invite somebody").count()).toBe(0);
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
      await bob.waitForSelector("text=Join Acme on egma");
      await expect
        .poll(() => bob.inputValue("#email"))
        .toBe("bob@acme.example");
      expect(await bob.innerText("main")).toContain("viewer");

      await bob.fill("#password", "a-long-enough-password");
      await bob.getByRole("button", { name: "Join Acme" }).click();

      // And he is in Acme, at the role he was invited at, without ever having
      // been asked to name an organization.
      await bob.waitForURL(new RegExp(`^${origin}/traces$`));
      await expect.poll(() => bob.getByRole("heading", { name: "Transcripts" }).count()).toBe(1);

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
      const bob = page.locator("article", { hasText: "bob@acme.example" });
      await bob.waitFor();
      expect(
        await bob.locator("select, button").evaluateAll((controls) =>
          controls.map((control) => control.getBoundingClientRect().height),
        ),
      ).toEqual([44, 44, 44]);

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
        await expect.poll(() => bob.innerText()).toContain("deactivated");
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
  await theirs.waitForURL(new RegExp(`^${origin}/traces$`));
  return theirs;
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
 * the developer who owns it opens the dashboard and reads the exchange.
 *
 * This is the spec's own demo sentence executed rather than described — *run
 * compose, point an agent's export at egma, open the dashboard, read the
 * exchange with its timings*. The fourteen captured bodies are the ones an
 * exporter really sent, replayed byte for byte, and they arrive **through the
 * same origin the dashboard is served from**, which is the deployment a
 * self-hoster actually gets: one address, and the exporter aimed at it.
 *
 * Ada is the same Ada as above: already signed up, already signed in, already
 * holding an organization. Which is exactly the state somebody is in when they
 * first have telemetry to look at.
 */
describe("the list of what an organization recorded", () => {
  beforeAll(async () => {
    await page.clock.setFixedTime(AT);

    const hers = (await page.context().cookies(origin))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
    acmeKey = await keyForTheProject(hers, "Acme");

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
      await page.goto(`${origin}/traces`);

      const sidebar = page.locator("aside");
      const settings = sidebar.locator('summary[aria-label="Open settings menu"]');
      await settings.waitFor({ state: "visible" });
      expect(await sidebar.innerText()).not.toContain("ada@acme.example");
      expect(await sidebar.innerText()).not.toContain("Admin account");
      expect(await sidebar.innerText()).not.toContain("Acme");
      expect(await sidebar.innerText()).not.toContain("Voice Reliability project");
      expect(await sidebar.getByRole("link", { name: "Home" }).count()).toBe(0);
      expect(await sidebar.innerText()).toContain("Settings");
      expect(await sidebar.getByRole("link", { name: "Organization" }).count()).toBe(0);

      await settings.click();
      expect(
        await sidebar.getByRole("button", { name: "Sign out" }).count(),
      ).toBe(1);
      expect(
        await page.locator("main").getByRole("button", { name: "Sign out" }).count(),
      ).toBe(0);
      await sidebar.getByRole("link", { name: "Organization settings" }).click();
      await page.waitForURL(/\/members$/);
      await page.getByRole("tab", { name: "People" }).waitFor({ state: "visible" });
      expect(await page.getByRole("tab", { name: "People" }).count()).toBe(1);
      expect(await page.getByRole("tab", { name: "Invitations" }).count()).toBe(1);
      await page.evaluate(() => {
        Reflect.set(window, "__egma_same_document_navigation", true);
      });
      await page.getByRole("link", { name: "Transcripts", exact: true }).click();
      await page.waitForURL(/\/traces$/);

      expect(
        await page.evaluate(() =>
          Reflect.get(window, "__egma_same_document_navigation"),
        ),
      ).toBe(true);
      expect(
        await page.locator("#window").evaluate((element) =>
          getComputedStyle(element).appearance,
        ),
      ).toBe("base-select");
    },
    SETTLE,
  );

  it(
    "opens on the last day, and shows the exchange the agent just had",
    async () => {
      // The root address has no separate home page. It opens transcripts.
      await page.goto(`${origin}/`);
      await page.waitForURL(/\/traces$/);

      await page.waitForSelector("table");
      const shown = await page.innerText("main");

      // The window control is on the default nobody chose, and the capture is
      // inside it. Nothing was widened to find this row.
      expect(await page.inputValue("#window")).toBe("24h");

      // The facts the list endpoint returns, as columns.
      expect(shown).toContain("2026-08-02 18:04:40 UTC");
      expect(shown).toContain("1m 13s");
      expect(shown).toContain(
        `${FIXTURE_TRACE.humanTurns} human · ${FIXTURE_TRACE.agentTurns} agent`,
      );
      expect(shown).toContain(String(FIXTURE_TRACE.spans));
      expect(shown).toContain("livekit");
      expect(shown).toContain("production");

      // The first thing the *human* said, which is what somebody scanning a
      // list is looking for — not the greeting the agent opens every one with.
      expect(shown).toContain("Hi Kelly, my name is Sam.");
      expect(shown).not.toContain("Hello! How can I assist you today?");

      // And exactly one row: one exchange was recorded, and it is the last page.
      expect(shown).toContain("1 transcript");
      expect(await page.getByRole("button", { name: "Show more" }).count()).toBe(
        0,
      );
    },
    SETTLE,
  );

  it(
    "marks what failed without anybody having to open anything",
    async () => {
      await page.goto(`${origin}/traces`);
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

  it(
    "keeps the window somebody chose in the address, so a reload stays on it",
    async () => {
      await page.goto(`${origin}/traces`);
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
      expect(await page.innerText("main")).toContain("1 transcript");

      // A window nobody was offered is not one. Editing the address to a word
      // the store would refuse lands on the default instead of on an error.
      await page.goto(`${origin}/traces?window=all-of-it`);
      await page.waitForSelector("table");
      expect(await page.inputValue("#window")).toBe("24h");
    },
    SETTLE,
  );

  it("says nothing the glossary bans", async () => {
    await page.goto(`${origin}/traces`);
    await page.waitForSelector("table");
    saysNothingBanned(await page.innerText("main"));
  });
});

describe("one exchange, read as a transcript", () => {
  /** Following the link out of the list, which is how anybody arrives. */
  async function openIt(): Promise<void> {
    await page.goto(`${origin}/traces`);
    await page.waitForSelector("table");
    await page.locator("tbody tr td a").first().click();
    await page.waitForSelector("text=The exchange");
  }

  it(
    "is reached from the row, which carries when it happened",
    async () => {
      await openIt();

      // The window rode along in the address. That is the whole reason this
      // page can be a link somebody sends: the endpoint under it requires one,
      // and the row already knew the answer.
      const asked = new URL(page.url()).searchParams;
      expect(Date.parse(asked.get("from") ?? "")).toBeLessThan(
        Date.parse("2026-08-02T18:04:40.281989Z"),
      );
      expect(Date.parse(asked.get("to") ?? "")).toBeGreaterThan(
        Date.parse("2026-08-02T18:05:53.776865Z"),
      );

      // And it deep-links: the same address, opened cold, is the same page.
      const address = page.url();
      await page.goto(`${origin}/`);
      await page.goto(address);
      await page.waitForSelector("text=The exchange");
      expect(await page.innerText("main")).toContain(FIXTURE_PROVIDER_CALL_ID);
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
      const turns = page.locator("main > div > details");
      const weather = turns.nth(4);
      expect(await weather.innerText()).toContain("6 steps");

      await weather.locator("summary").first().click();
      const steps = weather.locator("> div > details");
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
      const around = page.locator("main > div > details").last();
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
      // must never see each other's anything.
      const them = await signedInBrowser("bare@sparse.example");

      await them.goto(`${origin}/traces`);
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
      await them.goto(`${origin}/traces`);
      await them.waitForSelector("table");

      // One page is fifty, which is the contract's default. There is more, and
      // the page says so rather than ending silently at the page boundary.
      const rows = them.locator("tbody tr");
      expect(await rows.count()).toBe(50);
      expect(await them.innerText("main")).toContain("50 transcripts");

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
      expect(shown).toContain("51 transcripts");
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
    "starts light, keeps both controls synchronized, and survives a reload",
    async () => {
      await page.goto(`${origin}/`);
      await page.evaluate(() => localStorage.removeItem("egma-theme"));
      await page.reload();

      expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
      const controls = page.locator('button[aria-label="Use dark theme"]');
      await expect.poll(() => controls.count()).toBe(2);
      await controls.first().click();

      expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
      expect(await page.evaluate(() => localStorage.getItem("egma-theme"))).toBe("dark");
      expect(await page.locator('button[aria-label="Use light theme"]').count()).toBe(2);

      await page.reload();
      expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
      await expect
        .poll(() => page.locator('button[aria-label="Use light theme"]').count())
        .toBe(2);
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
      await page.waitForSelector("text=Organization settings could not be loaded");
      await page.unroute("**/api/members");
      await page.getByRole("button", { name: "Try again" }).click();
      await page.waitForSelector("text=Everybody in your organization");

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
