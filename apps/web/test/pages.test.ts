import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROJECT_NAME as API_DEFAULT_PROJECT_NAME,
  organizationNameFromEmail as apiOrganizationNameFromEmail,
} from "../../api/src/auth/naming.ts";
import { safeReturnPath as apiSafeReturnPath } from "../../api/src/auth/password-reset.ts";
import { CODES } from "../../api/src/http/refusals.ts";
import {
  NOTHING_TO_HEAR,
  offersNothing,
} from "../lib/recording-refusals.ts";
import { runProgress } from "../lib/run-progress.ts";
import {
  DEFAULT_SIGNED_IN_PATH,
  returnPathIn,
  safeReturnPath,
} from "../lib/return-to.ts";
import {
  DEFAULT_PROJECT_NAME,
  organizationNameFromEmail,
} from "../lib/signup-defaults.ts";
import { pickers } from "../lib/me.ts";

/**
 * The two things the pages decide for themselves, and one thing about where
 * they are served from.
 */

const WEB = path.join(import.meta.dirname, "..");

describe("the names the signup form offers", () => {
  const cases: readonly [string, string][] = [
    ["ada@acme.example", "Acme"],
    ["ada@ACME.example", "ACME"],
    ["ada.lovelace@acme-labs.co.uk", "Acme Labs"],
    ["ada@localhost", "Localhost"],
    ["ada@", "My organization"],
    ["not-an-email", "My organization"],
  ];

  it.each(cases)("takes the organization from the email domain: %s", (email, expected) => {
    expect(organizationNameFromEmail(email)).toBe(expected);
  });

  it("calls the first project Default", () => {
    expect(DEFAULT_PROJECT_NAME).toBe("Default");
  });

  /**
   * The page fills the fields in and the API fills them in for an identity that
   * never saw the page, so both know the rules. This is what stops the value
   * somebody reads in the field from differing from the value they get by
   * submitting it untouched.
   */
  it("agrees with what the API would have chosen, for every one of them", () => {
    for (const [email] of cases) {
      expect(organizationNameFromEmail(email)).toBe(
        apiOrganizationNameFromEmail(email),
      );
    }
    expect(DEFAULT_PROJECT_NAME).toBe(API_DEFAULT_PROJECT_NAME);
  });
});

describe("a level with one thing in it", () => {
  const one = {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [
      { id: "org_1", name: "Acme", slug: "acme", role: "admin" },
    ],
    projects: [{ id: "prj_1", name: "Default", slug: "default" }],
  };

  it("is not a choice, so neither picker is shown", () => {
    expect(pickers(one)).toEqual({ organization: false, project: false });
  });

  it("becomes a choice the moment there are two", () => {
    expect(
      pickers({
        ...one,
        projects: [...one.projects, { id: "prj_2", name: "Outbound", slug: "outbound" }],
      }),
    ).toEqual({ organization: false, project: true });

    expect(
      pickers({
        ...one,
        organizations: [
          ...one.organizations,
          { id: "org_2", name: "Globex", slug: "globex", role: "admin" },
        ],
      }),
    ).toEqual({ organization: true, project: false });
  });

  it("shows nothing at all when somebody has landed nowhere", () => {
    expect(pickers({ ...one, organizations: [], projects: [] })).toEqual({
      organization: false,
      project: false,
    });
  });
});

/** Every source file under the web application, excluding what it did not write. */
async function pageSources(): Promise<readonly [string, string][]> {
  const found: [string, string][] = [];

  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", ".next", "test"].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if ([".ts", ".tsx"].includes(path.extname(entry.name))) {
        found.push([path.relative(WEB, full), await readFile(full, "utf8")]);
      }
    }
  }

  await walk(WEB);
  return found;
}

describe("the pages", () => {
  it("are served from the instance's own origin, and reach no other", async () => {
    const sources = await pageSources();
    expect(sources.length).toBeGreaterThan(3);

    for (const [file, source] of sources) {
      // Comments say plenty about acme.example and egma.example; what matters
      // is that no line of code fetches, links to or embeds a fixed host.
      const code = source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      const absolute = code.match(/https?:\/\/[^\s"'`)]+/g) ?? [];

      // Two exceptions, and neither is a host anything reaches. One is the
      // build-time default for where this process proxies to, a loopback
      // address on the operator's own machine. The other is the reserved name
      // the return-path rule anchors a URL parser to: RFC 2606 guarantees a
      // `.invalid` name resolves nowhere, and nothing here fetches it — it is
      // there to be compared against, so that a candidate which moves the
      // origin can be refused without listing the ways to move it.
      const offSite = absolute.filter(
        (url) =>
          !url.startsWith("http://127.0.0.1:") &&
          !/^https?:\/\/[^/]+\.invalid$/.test(url),
      );
      expect(offSite, `${file} reaches ${offSite.join(", ")}`).toEqual([]);
    }
  });

  /**
   * The tenancy the pages show has exactly two levels and they are called
   * `organization` and `project` — the same two words the API and the database
   * use for the same two things.
   *
   * A container word invented above them is how `project` comes to mean the
   * tenancy container in one place and something inside one in another, and a
   * word that means two things is a word nobody can read a permission with.
   * This costs nothing today and is written down now because the dashboard is
   * what would grow on top of it.
   */
  it("name the two levels of tenancy, and invent no word above them", async () => {
    for (const [file, source] of await pageSources()) {
      expect(source.toLowerCase(), `${file} names a level above organization`)
        .not.toContain("workspace");
    }
  });

  it("post at paths this instance serves, with no host in them", async () => {
    const signup = await readFile(
      path.join(WEB, "app/signup/page.tsx"),
      "utf8",
    );
    expect(signup).toContain('fetch("/api/signup"');
    expect(signup).toContain('fetch("/api/signup/availability")');
  });

  /**
   * The provider ships the five device-flow endpoints and no interface at all,
   * so without these `egma login` opens a browser on nothing. Each is a page a
   * person actually reaches, and each says a different thing — which is the
   * point of there being five rather than one with a status on it.
   */
  it("include the five the device flow needs, all of them on this instance", async () => {
    const files = (await pageSources()).map(([file]) => file);

    for (const page of [
      "app/device/page.tsx",
      "app/device/approve/page.tsx",
      "app/device/denied/page.tsx",
      "app/device/expired/page.tsx",
      "app/device/success/page.tsx",
    ]) {
      expect(files, page).toContain(page);
    }
  });

  /**
   * A denied code and an expired code are different things and reach different
   * pages, because "check what you typed" and "that timed out, nothing is
   * broken" are different instructions.
   */
  it("say which of the two happened, on the two pages that mean different things", async () => {
    const denied = await readFile(
      path.join(WEB, "app/device/denied/page.tsx"),
      "utf8",
    );
    const expired = await readFile(
      path.join(WEB, "app/device/expired/page.tsx"),
      "utf8",
    );

    expect(denied).toContain("not authorized");
    expect(denied).toContain("/device");
    expect(expired).toContain("expired");
    expect(expired).toMatch(/egma login/);
  });

  /**
   * The dashboard is deliberately not built, so this is the page that decides
   * whether adding a second person is something a person can do or something an
   * API can do. Without it, inviting a colleague would be a curl command.
   */
  it("include the two an invitation needs: somewhere to send one, and somewhere to land", async () => {
    const files = (await pageSources()).map(([file]) => file);
    expect(files).toContain("app/members/page.tsx");
    expect(files).toContain("app/invite/page.tsx");
  });

  /**
   * The link that comes back when nothing was emailed is the whole ticket. A
   * page that quietly dropped it would leave a self-hoster with an invitation
   * that exists and cannot be delivered, which is worse than a refusal.
   */
  it("hand the invitation link back when there was nowhere to post it", async () => {
    const members = await readFile(
      path.join(WEB, "app/members/page.tsx"),
      "utf8",
    );

    expect(members).toContain("accept_url");
    expect(members).toContain("delivered");
    expect(members).toMatch(/no mail transport is configured/i);
  });

  /**
   * Expired and already-accepted mean opposite things to whoever is holding the
   * link — ask for another, versus you are already in — so the page says which.
   */
  it("say which of the two a dead invitation is", async () => {
    const invite = await readFile(path.join(WEB, "app/invite/page.tsx"), "utf8");

    expect(invite).toContain("has expired");
    expect(invite).toContain("already been accepted");
  });

  /**
   * The way back in for somebody who cannot sign in to ask for one.
   *
   * Two pages, because there are two moments: naming the address, and choosing
   * the password behind the link. The first has to be reachable from the sign-in
   * page — a way back in nobody can find is not a way back in.
   */
  it("offer somewhere to ask for a reset, reachable from the sign-in page", async () => {
    const files = (await pageSources()).map(([file]) => file);
    expect(files).toContain("app/forgot-password/page.tsx");
    expect(files).toContain("app/reset-password/page.tsx");

    const signIn = await readFile(path.join(WEB, "app/sign-in/page.tsx"), "utf8");
    expect(signIn).toContain("/forgot-password");
  });

  /**
   * Spent, never-minted and too-old-to-tell are three different things and each
   * says so. A spent link means you already did this — sign in. One this egma
   * never minted means check what was copied. One past the hour means both are
   * still possible, and the page says so. Sharing a sentence would send half
   * the people holding one exactly the wrong way.
   */
  it("say which of the three a dead reset link is", async () => {
    const reset = await readFile(
      path.join(WEB, "app/reset-password/page.tsx"),
      "utf8",
    );

    expect(reset).toContain("reset_link_already_used");
    expect(reset).toContain("reset_link_no_longer_works");
    expect(reset).toContain("no_such_reset_link");
    expect(reset).toContain("has already been used");
    expect(reset).toContain("no longer works");
  });

  /**
   * **The page never says a thing the API did not check**, and past the hour
   * there is exactly one thing left to check: that the link is dead.
   *
   * "Your old password still works" is true of a link that ran out unused and
   * false of one somebody already reset with, and there is one deadline now —
   * the auth provider forgets the token at the moment egma stops honouring the
   * link, so nothing can tell those two apart afterwards. The reassurance is
   * therefore not on any refusal, anywhere on this page. It used to be, on the
   * refusal that was checked; that refusal no longer exists to hold it.
   */
  it("never promise the old password still works", async () => {
    const reset = await readFile(
      path.join(WEB, "app/reset-password/page.tsx"),
      "utf8",
    );

    expect(reset).not.toContain("old password still works");
    expect(reset).not.toContain("Nothing has changed");
    expect(reset).not.toContain("nothing has changed");

    const tooOld = reset.slice(reset.indexOf('"reset_link_no_longer_works"'));
    expect(tooOld).toMatch(/whether it was used/i);
  });

  /**
   * Where somebody was going survives a reset, all the way through the message.
   *
   * A developer approving a terminal's login who turns out to have forgotten
   * their password has to land back on the approval page. The sign-in page
   * carries the destination to the form, the form sends it to the API, the API
   * writes it into the link, and the page behind the link carries it on to
   * sign-in. Any one of those dropping it leaves a terminal waiting on a person
   * who is looking at the wrong page.
   */
  it("carry where somebody was going through a reset, and not only up to it", async () => {
    const signIn = await readFile(path.join(WEB, "app/sign-in/page.tsx"), "utf8");
    const forgot = await readFile(
      path.join(WEB, "app/forgot-password/page.tsx"),
      "utf8",
    );
    const reset = await readFile(
      path.join(WEB, "app/reset-password/page.tsx"),
      "utf8",
    );

    expect(signIn).toContain('withReturnTo("/forgot-password", returnTo)');
    // Sent to the API, which is the only thing that can write it into the link.
    expect(forgot).toContain("next: returnTo");
    // And read back off the link the message carried.
    expect(reset).toContain("returnPathIn(window.location.search)");
    expect(reset).toContain('withReturnTo("/sign-in", returnTo)');
  });

  /**
   * And the rule that keeps it from being a way off this instance is one rule,
   * written twice because the two halves cannot import each other: the API
   * refuses anything else before it writes a link, and the page refuses it
   * again before it follows one. Two copies of a security rule are worth having
   * only while something checks they still say the same thing.
   */
  it("agree with the API about what a return path may be", async () => {
    for (const raw of [
      "/device/approve?code=WDJB",
      "/traces",
      "https://elsewhere.example/x",
      "//elsewhere.example/x",
      "/\\elsewhere.example",
      "javascript:alert(1)",
      "  /device  ",
      "",
      // The shapes a list of shapes let through. A URL parser strips tab,
      // carriage return and newline before it parses, so each of these is read
      // as `//elsewhere.example` by the browser that would follow it — and the
      // last two also travelled to the auth provider as a header, where a line
      // ending turned a public request into a 500.
      "/\telsewhere.example",
      "/\t/elsewhere.example",
      "/\t\\elsewhere.example",
      "/\n/elsewhere.example",
      "/\r\n//elsewhere.example",
      "/foo\r\nx: y",
    ]) {
      expect(safeReturnPath(raw), raw).toBe(apiSafeReturnPath(raw));
    }
  });

  it("reach the API for a password reset at paths this instance rewrites", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    const forgot = await readFile(
      path.join(WEB, "app/forgot-password/page.tsx"),
      "utf8",
    );
    const reset = await readFile(
      path.join(WEB, "app/reset-password/page.tsx"),
      "utf8",
    );

    expect(rewrites).toContain("/api/password-reset/:path*");
    expect(forgot).toContain('fetch("/api/password-reset"');
    expect(reset).toContain('fetch("/api/password-reset/complete"');
  });

  it("reach the API for invitations at paths this instance rewrites", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    const invite = await readFile(path.join(WEB, "app/invite/page.tsx"), "utf8");
    const members = await readFile(
      path.join(WEB, "app/members/page.tsx"),
      "utf8",
    );

    // A path a page fetches and the config does not forward would be served by
    // this process, which has no such route, and the flow would 404.
    expect(rewrites).toContain("/api/invitations/:path*");
    expect(rewrites).toContain("/api/members/:path*");
    expect(invite).toContain("/api/invitations/lookup");
    expect(invite).toContain("/api/invitations/accept");
    expect(members).toContain('fetch("/api/members")');
  });

  /**
   * Somewhere to click, and a path that reaches the API rather than this
   * process. Without the rewrite the button would post at Next, which has no
   * such route, and signing out would 404 while looking like a product bug.
   */
  it("give a signed-in person somewhere to sign out, at a path this instance rewrites", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    const home = await readFile(path.join(WEB, "app/page.tsx"), "utf8");
    const shell = await readFile(path.join(WEB, "app/ui.tsx"), "utf8");

    expect(rewrites).toContain("/api/sign-out");
    expect(shell).toContain('fetch("/api/sign-out"');
    expect(shell).toContain("Sign out");
    expect(home).not.toContain('fetch("/api/sign-out"');
    expect(home).not.toContain("Sign out");
  });

  /**
   * Moving between signed-in pages must not briefly replace the application
   * with the access-page composition. The request can still be pending or can
   * fail, but the navigation and account controls remain stable until the API
   * has explicitly said that the session is gone.
   */
  it("keep the application shell while signed-in page data settles", async () => {
    const shell = await readFile(path.join(WEB, "app/ui.tsx"), "utf8");
    const members = await readFile(
      path.join(WEB, "app/members/page.tsx"),
      "utf8",
    );
    const transcript = await readFile(
      path.join(WEB, "app/traces/[traceId]/page.tsx"),
      "utf8",
    );
    const run = await readFile(
      path.join(WEB, "app/runs/[runId]/page.tsx"),
      "utf8",
    );
    const root = await readFile(path.join(WEB, "app/page.tsx"), "utf8");
    expect(shell).toContain("export function ProductStatePage");
    expect(members).toContain("<ProductStatePage");
    expect(transcript).toContain('<ProductStatePage active="transcripts"');
    expect(run).toContain('<ProductStatePage active="transcripts"');
    expect(root).toContain('<ProductStatePage');
    expect(root).not.toContain("<StatePage");
    expect(members).not.toContain(
      'return <StatePage title="Loading organization settings"',
    );
    expect(transcript).not.toMatch(
      /state\.status === "loading"[\s\S]*?return <StatePage/,
    );
    expect(run).not.toMatch(
      /state\.status === "loading"[\s\S]*?return <StatePage/,
    );
  });

  it("show real run verdicts without folding execution failures into grader failures", async () => {
    const run = await readFile(
      path.join(WEB, "app/runs/[runId]/page.tsx"),
      "utf8",
    );
    const judgment = await readFile(
      path.join(WEB, "app/judgment-card.tsx"),
      "utf8",
    );

    expect(run).toContain("/api/runs/");
    expect(run).toContain("runProgress(run)");
    expect(run).toContain("run.graded_count");
    expect(run).toContain("simulation.verdicts.map");
    expect(run).toContain("This is an execution problem, not a failed grader verdict.");
    expect(run).toContain("<JudgmentCard");
    expect(judgment).toContain("judgment.rationale");
    expect(judgment).toContain("judgment.cited_turns");
  });

  it("shows the aggregate trace outcome", async () => {
    const transcript = await readFile(
      path.join(WEB, "app/traces/[traceId]/page.tsx"),
      "utf8",
    );
    const contract = await readFile(
      path.join(WEB, "lib/transcripts.ts"),
      "utf8",
    );

    expect(contract).toContain("readonly outcome: Outcome | null");
    expect(transcript).toContain("<OutcomeSummary outcome={detail.outcome}");
    expect(transcript).toContain('aria-label="Grading outcome"');
  });

  it("reach the API for the device flow at paths this instance rewrites", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    const approve = await readFile(
      path.join(WEB, "app/device/approve/page.tsx"),
      "utf8",
    );

    // A path the page fetches and the config does not forward would be served
    // by this process, which has no such route, and the flow would 404.
    expect(rewrites).toContain("/api/device/:path*");
    expect(approve).toContain("/api/device/authorization");
    expect(approve).toContain("/api/device/approve");
    expect(approve).toContain("/api/device/deny");
  });
});

describe("coming back after signing in", () => {
  it("opens the transcript list by default", async () => {
    const signIn = await readFile(path.join(WEB, "app/sign-in/page.tsx"), "utf8");
    const signup = await readFile(path.join(WEB, "app/signup/page.tsx"), "utf8");
    const invite = await readFile(path.join(WEB, "app/invite/page.tsx"), "utf8");

    expect(DEFAULT_SIGNED_IN_PATH).toBe("/traces");
    for (const page of [signIn, signup, invite]) {
      expect(page).toContain("DEFAULT_SIGNED_IN_PATH");
      expect(page).not.toContain('window.location.assign("/")');
    }
  });

  it("goes where the page was asked to go", () => {
    expect(returnPathIn("?next=%2Fdevice%2Fapprove%3Fuser_code%3DABCD1234")).toBe(
      "/device/approve?user_code=ABCD1234",
    );
    expect(returnPathIn("")).toBeNull();
  });

  /**
   * A redirect decided by a query parameter is the shape of every open-redirect
   * bug there has ever been, and this one is handed to somebody in the middle
   * of authorizing a terminal — which is exactly when a page that looks like
   * egma but is not would be worth the most to somebody.
   *
   * The rule used to be a list of the shapes that leave, and a list is a thing
   * somebody finds the next entry in: the tab was the entry. It is resolution
   * now — the candidate is parsed against this origin and has to land back on
   * it — so the entries below are examples of a rule rather than the rule.
   */
  it("refuses anywhere that is not this instance", () => {
    for (const elsewhere of [
      "https://elsewhere.example/steal",
      "//elsewhere.example/steal",
      "/\\elsewhere.example/steal",
      "javascript:alert(1)",
      "device/approve",
      "",
      "/\t/elsewhere.example",
      "/\t\\elsewhere.example",
      "/\n/elsewhere.example",
      "/\r\n//elsewhere.example",
    ]) {
      expect(safeReturnPath(elsewhere), elsewhere).toBeNull();
    }
  });

  /**
   * And what survives is the parser's own path — the same string the browser
   * would have made of it — so a return path can never carry a control
   * character on into a header, and never means one thing here and another
   * where it is followed.
   */
  it("hands back the path a browser would have read, and nothing else", () => {
    expect(safeReturnPath("/device/approve?code=WDJB")).toBe(
      "/device/approve?code=WDJB",
    );
    // Still on this instance once the tab is gone, so it is kept — as the one
    // path it can mean, rather than as the two it looked like.
    expect(safeReturnPath("/\telsewhere.example")).toBe("/elsewhere.example");
    expect(safeReturnPath("/foo\r\nx: y")).not.toMatch(/[\t\r\n]/);
  });
});

/**
 * When a page that was offered a recording shows nothing at all, and when it
 * speaks.
 *
 * It is the whole substance of the player's honesty rule, and it has been got
 * wrong twice — once by hiding a failure that arrived after a player was
 * already on screen, once by hiding every fault egma could have. Both times it
 * was carried entirely by a render branch, which nothing could reach. It is a
 * function now, and this is where it is held.
 */
describe("a refusal of a recording", () => {
  const A_TRANSCRIPT = { knownToExist: false, afterOneWorked: false };
  const A_RUNS_RESULTS = { knownToExist: true, afterOneWorked: false };

  /**
   * The one case silence is bought for: a surface that was asking whether
   * there is anything here at all, being told there is not. A chat can never
   * have audio and a call that never connected wrote none — and a disabled
   * control, or a sentence beside every one of them, reads as a broken feature
   * rather than as an honest absence.
   */
  it("is answered with nothing where the surface was only asking", () => {
    expect(offersNothing({ code: "not_found" }, A_TRANSCRIPT)).toBe(true);
    expect(offersNothing({ code: "unprocessable" }, A_TRANSCRIPT)).toBe(true);
  });

  /**
   * A run's results were told there is a recording before this component was
   * mounted at all, so any refusal contradicts what the same page just said.
   */
  it("is always said where the page had already been told there is one", () => {
    expect(offersNothing({ code: "not_found" }, A_RUNS_RESULTS)).toBe(false);
    expect(offersNothing({ code: "unprocessable" }, A_RUNS_RESULTS)).toBe(false);
  });

  /**
   * Everything about **egma** rather than about the conversation. A store
   * nobody configured, a fault, an egma that answered nothing at all, and a row
   * carrying a reference no simulator could have written — the last of which
   * has a code of its own precisely so it is not mistaken for an absence.
   *
   * A deployment that is broken must never look like a product working
   * correctly. That is the failure the recordings effort exists to end, and the
   * surface that asks about every conversation somebody opens is where it would
   * spread furthest.
   */
  it("is said out loud when it is about egma rather than about the conversation", () => {
    for (const code of [
      "no_object_store",
      "unsignable_reference",
      "not_permitted",
      "too_many_requests",
      "internal_error",
    ]) {
      expect(offersNothing({ code }, A_TRANSCRIPT), code).toBe(false);
    }
  });

  /**
   * And an answer that was not egma's at all.
   *
   * Fastify's own not-found reply is `{"statusCode":404,"error":"Not
   * Found","message":"Route GET:… not found"}` — a 404 carrying a message, from
   * a route that is not mounted, a container running a different version, or a
   * proxy that has stopped forwarding this path. Reading the presence of a
   * message would have gone quiet on every one of those. A code is the API's
   * own promise and nobody else's, so a code is what is read; `Not Found` with
   * a capital and a space is not one of them.
   */
  it("is said out loud when the answer did not come from egma", () => {
    expect(offersNothing({ code: undefined }, A_TRANSCRIPT)).toBe(false);
    expect(offersNothing({ code: "Not Found" }, A_TRANSCRIPT)).toBe(false);
  });

  /**
   * A refusal arriving after a link had already worked is never quiet. By then
   * somebody has a player on screen and may be part-way through listening, and
   * a control that vanishes without a word is worse than the error it hides.
   */
  it("is said out loud once a player has already been on screen", () => {
    for (const code of ["not_found", "unprocessable"]) {
      expect(
        offersNothing({ code }, { knownToExist: false, afterOneWorked: true }),
        code,
      ).toBe(false);
    }
  });

  /**
   * The codes are the API's, so they are read from the API's own vocabulary
   * rather than typed twice. A code renamed on one side and not the other would
   * make a transcript start speaking about every chat, or stop speaking about a
   * fault — and neither would fail anything else.
   */
  it("names codes this API actually answers with", () => {
    for (const code of NOTHING_TO_HEAR) {
      expect(Object.keys(CODES), code).toContain(code);
    }
    expect(Object.keys(CODES)).toContain("unsignable_reference");
  });
});

describe("run progress", () => {
  it("uses the simulation rows while aggregate counters are still empty", () => {
    expect(runProgress({
      expected_simulation_count: 3,
      graded_count: 1,
      simulations: [
        { status: "completed" },
        { status: "failed" },
        { status: "running" },
      ],
    })).toEqual({ finished: 2, gradable: 2, failed: 1, moving: true });
  });

  it("does not wait for a canceled simulation to be graded", () => {
    expect(runProgress({
      expected_simulation_count: 2,
      graded_count: 1,
      simulations: [{ status: "completed" }, { status: "canceled" }],
    })).toEqual({ finished: 2, gradable: 1, failed: 0, moving: false });
  });
});
