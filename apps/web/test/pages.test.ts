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
import {
  DEFAULT_SIGNED_IN_PATH,
  returnPathIn,
  safeReturnPath,
} from "../lib/return-to.ts";
import {
  citedTurnPositions,
  priorGrades,
  withoutCurrentGrade,
  type EvidenceGrade,
  type EvidenceStep,
} from "../lib/simulations.ts";
import {
  DEFAULT_PROJECT_NAME,
  organizationNameFromEmail,
} from "../lib/signup-defaults.ts";

/**
 * The two things the pages decide for themselves, and one thing about where
 * they are served from.
 */

const WEB = path.join(import.meta.dirname, "..");

/** One conversation, inside the project's monitoring section. */
const TRANSCRIPT_PAGE =
  "app/projects/[projectId]/monitoring/transcripts/[transcriptId]/page.tsx";

describe("the names the signup form offers", () => {
  const cases: readonly [string, string][] = [
    ["ada@acme.example", "Acme"],
    ["ada@ACME.example", "ACME"],
    ["ada.lovelace@acme-labs.co.uk", "Acme Labs"],
    ["ada@localhost", "Localhost"],
    ["ada@", "My organization"],
    ["not-an-email", "My organization"],
    /*
     * A personal address names no company, so what is offered is the person
     * rather than their mail provider. An organization called `Gmail` is what
     * the fastest path through this form used to produce, and what somebody
     * then lived with.
     */
    ["ada@gmail.com", "Ada's organization"],
    ["ada.lovelace@GMAIL.com", "Ada's organization"],
    ["ada+egma@hotmail.co.uk", "Ada's organization"],
    ["-@icloud.com", "My organization"],
  ];

  it.each(cases)("takes the organization from the email: %s", (email, expected) => {
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
  it("include the two an invitation needs: project Settings to send one, and somewhere to land", async () => {
    const files = (await pageSources()).map(([file]) => file);
    expect(files).toContain("app/projects/[projectId]/settings/people/page.tsx");
    expect(files).toContain("app/invite/page.tsx");
  });

  it("does not keep projectless compatibility pages", async () => {
    const files = (await pageSources()).map(([file]) => file);
    expect(files).not.toContain("app/members/page.tsx");
    expect(files).not.toContain("app/runs/[runId]/page.tsx");
  });

  /**
   * The link that comes back when nothing was emailed is the whole ticket. A
   * page that quietly dropped it would leave a self-hoster with an invitation
   * that exists and cannot be delivered, which is worse than a refusal.
   *
   * Organization settings moved into the product shell, so this reads the page
   * that now holds it. `settings.test.tsx` drives the behaviour; this only
   * holds the file to carrying the branch at all.
   */
  it("hand the invitation link back when there was nowhere to post it", async () => {
    const people = await readFile(
      path.join(WEB, "app/projects/[projectId]/settings/people/page.tsx"),
      "utf8",
    );

    expect(people).toContain("acceptUrl");
    expect(people).toContain("delivered");
    expect(people).toMatch(/no mail transport is configured/i);
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
    const people = await readFile(
      path.join(WEB, "app/projects/[projectId]/settings/people/page.tsx"),
      "utf8",
    );

    // A path a page fetches and the config does not forward would be served by
    // this process, which has no such route, and the flow would 404.
    expect(rewrites).toContain("/api/invitations/:path*");
    expect(rewrites).not.toContain('source: "/api/invitations",');
    expect(rewrites).toContain("/v1/:path*");
    expect(invite).toContain("/api/invitations/lookup");
    expect(invite).toContain("/api/invitations/accept");
    expect(people).toContain("listMembers(");
    expect(people).toContain("listInvitations(");
  });

  /**
   * The Settings pages reach the API paths below, and none is
   * served by this process. Without the rules the pages would post at Next and
   * read its 404 page as egma's refusal.
   */
  it("reach the API for settings at paths this instance rewrites", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");

    expect(rewrites).toContain("/v1/:path*");
  });

  it("reaches persona form metadata through the versioned platform rewrite", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");

    expect(rewrites).toContain(
      '{ source: "/v1/:path*", destination: `${api}/v1/:path*` }',
    );
  });

  /**
   * The generated client owns the concrete routes. This one scoped rewrite
   * keeps every current and future versioned operation on the page's origin.
   */
  it("rewrites every API path the browser client names", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");

    // The generated client owns every concrete platform path. One scoped
    // version rewrite covers both present and future named operations.
    expect(rewrites).toContain(
      '{ source: "/v1/:path*", destination: `${api}/v1/:path*` }',
    );
    expect(rewrites).not.toContain(
      '{ source: "/health", destination: `${api}/health` }',
    );
    expect(rewrites).toContain(
      '{ source: "/openapi.json", destination: `${api}/openapi.json` }',
    );
    expect(rewrites).not.toContain('source: "/api/:path*"');
  });

  /** Deep resource routes are covered by the same scoped version rewrite. */
  it("rewrites every path the browser client builds beneath a collection", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");

    expect(rewrites).toContain(
      '{ source: "/v1/:path*", destination: `${api}/v1/:path*` }',
    );
  });

  /**
   * Somewhere to click, and a path that reaches the API rather than this
   * process. Without the rewrite the button would post at Next, which has no
   * such route, and signing out would 404 while looking like a product bug.
   */
  it("give a signed-in person somewhere to sign out, at a path this instance rewrites", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    const home = await readFile(path.join(WEB, "app/page.tsx"), "utf8");
    const shell = await readFile(path.join(WEB, "ui/shell.tsx"), "utf8");

    expect(rewrites).toContain("/api/sign-out");
    expect(shell).toContain('fetch("/api/sign-out"');
    expect(shell).toContain("Sign out");
    expect(home).not.toContain('fetch("/api/sign-out"');
    expect(home).not.toContain("Sign out");
  });

  /**
   * **Simulation runs is a label, and only a label.**
   *
   * Monitoring gave production traffic a surface of its own, so the surface
   * beside it has to say which traffic *it* holds. What changed is the words on
   * four pages and one navigation item. What did not change is anything a
   * machine reads: the addresses stay at `/projects/{projectId}/runs`, and the
   * stored word stays `run` — which is why this reads the page headings rather
   * than sweeping the sources for the word.
   */
  it("labels every runs surface Simulation runs, without moving one address", async () => {
    for (const page of [
      "app/projects/[projectId]/runs/page.tsx",
      "app/projects/[projectId]/runs/new/page.tsx",
      "app/projects/[projectId]/runs/[runId]/page.tsx",
      "app/projects/[projectId]/runs/[runId]/simulations/[simulationId]/page.tsx",
    ]) {
      const source = await readFile(path.join(WEB, page), "utf8");
      expect(source, page).toContain('"Simulation runs"');
      expect(source, page).not.toContain('eyebrow="Runs"');
      expect(source, page).not.toContain('title="Runs"');
      // And the addresses are where they were: every link is still built from
      // the `runs` section, which is the stored word and stays one.
      expect(source, page).not.toContain("simulation-runs");
    }
  });

  it("keeps simulation execution and grading progress separate", async () => {
    const run = await readFile(
      path.join(WEB, "app/projects/[projectId]/runs/[runId]/page.tsx"),
      "utf8",
    );
    const simulation = await readFile(
      path.join(
        WEB,
        "app/projects/[projectId]/runs/[runId]/simulations/[simulationId]/page.tsx",
      ),
      "utf8",
    );
    const grades = await readFile(
      path.join(WEB, "ui/simulation-evidence.tsx"),
      "utf8",
    );
    // A simulation Egma could not conduct is an execution failure. It does not
    // become a zero score or an errored grader.
    for (const page of [run, simulation]) {
      expect(page).toContain("Egma could not conduct this simulation.");
    }
    // The run reports grading progress, while the simulation reads its own
    // trace-level grading state and grade results.
    expect(run).toContain("read.gradedCount");
    expect(simulation).toContain('evidence.gradingState === "pending"');
    expect(grades).toContain("evidence.grades");
    expect(grades).toContain("evidence.gradeHistory");
  });

  it("shows trace grading without inventing a pass or fail result", async () => {
    const transcript = await readFile(
      path.join(WEB, TRANSCRIPT_PAGE),
      "utf8",
    );
    const contract = await readFile(
      path.join(WEB, "lib/transcripts.ts"),
      "utf8",
    );

    expect(contract).toContain("export type Detail = GetTraceResponse");
    expect(transcript).toContain("<GradeSummary");
    expect(transcript).toContain("combinedScore={detail.combinedScore}");
    expect(transcript).toContain("grades={detail.grades}");
    expect(transcript).toContain("history={detail.gradeHistory}");
    expect(transcript).toContain("It is not a pass or fail result.");
    expect(transcript).toContain("shownScore(combinedScore)");
    expect(transcript).toMatch(
      /import \{ shownScore \} from "[^"]*ui\/run-status\.tsx"/u,
    );
    expect(transcript).not.toMatch(/function shownScore\(/u);
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
  it("goes to the entrance, which opens Agents under the first project", async () => {
    const signIn = await readFile(path.join(WEB, "app/sign-in/page.tsx"), "utf8");
    const signup = await readFile(path.join(WEB, "app/signup/page.tsx"), "utf8");
    const invite = await readFile(path.join(WEB, "app/invite/page.tsx"), "utf8");

    // The root, because none of these three pages can know which project
    // somebody is in — an invitation link and a fresh sign-in both arrive with
    // nothing. The entrance chooses it once and puts it in the address.
    expect(DEFAULT_SIGNED_IN_PATH).toBe("/");
    for (const page of [signIn, signup, invite]) {
      expect(page).toContain("DEFAULT_SIGNED_IN_PATH");
      // Through the constant, never by typing the address. The entrance is
      // going to stop being the root the day somebody gives it a better one.
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

/** The transcript turns cited by one grade's assertion details. */
describe("the turns a grade cites", () => {
  function step(id: string, children: EvidenceStep[] = []): EvidenceStep {
    return {
      spanId: id,
      parentSpanId: "",
      name: id,
      kind: "turn:agent",
      status: "ok",
      startedAt: "2026-08-15T10:00:00.000000Z",
      durationNs: "1000",
      text: "",
      audioUrl: "",
      toolName: "",
      toolArguments: "",
      toolResult: "",
      spans: children,
    };
  }

  const turns = [step("one"), step("two", [step("tool-inside-two")]), step("three")];

  it("names them by their position in the transcript", () => {
    expect(citedTurnPositions(["three", "one"], turns)).toEqual([1, 3]);
  });

  it("sends a cited step to the turn it happened inside", () => {
    expect(citedTurnPositions(["tool-inside-two"], turns)).toEqual([2]);
  });

  it("drops an id that is nowhere in the transcript rather than inventing a turn", () => {
    expect(citedTurnPositions(["nothing-here"], turns)).toEqual([]);
  });
});

describe("equal-time grade history", () => {
  const current: EvidenceGrade = {
    projectGraderId: "grd_current",
    graderDefinitionId: "grl_expected",
    graderDefinitionVersion: 1,
    graderName: "expected_behaviors",
    score: 1,
    details: { rationale: "the reclaimed worker scored it" },
    passThreshold: 0.5,
    result: "passed",
    gradedAt: "2026-08-21T08:01:00.000000Z",
  };
  const stale: EvidenceGrade = {
    ...current,
    score: 0,
    details: { rationale: "the stale worker scored it" },
    result: "failed",
  };

  it("removes only the current public row", () => {
    expect(withoutCurrentGrade(current, [stale, current])).toEqual([stale]);
  });

  it("keeps the equal-time stale row in simulation history", () => {
    expect(priorGrades(current, [stale, current])).toEqual([stale]);
  });
});
