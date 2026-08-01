import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROJECT_NAME as API_DEFAULT_PROJECT_NAME,
  organizationNameFromEmail as apiOrganizationNameFromEmail,
} from "../../api/src/auth/naming.ts";
import { returnPathIn, safeReturnPath } from "../lib/return-to.ts";
import {
  DEFAULT_PROJECT_NAME,
  organizationNameFromEmail,
} from "../lib/signup-defaults.ts";
import { pickers } from "../lib/workspace.ts";

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

      // The one exception is the build-time default for where this process
      // proxies to, which is a loopback address on the operator's own machine.
      const offSite = absolute.filter(
        (url) => !url.startsWith("http://127.0.0.1:"),
      );
      expect(offSite, `${file} reaches ${offSite.join(", ")}`).toEqual([]);
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
   */
  it("refuses anywhere that is not this instance", () => {
    for (const elsewhere of [
      "https://elsewhere.example/steal",
      "//elsewhere.example/steal",
      "/\\elsewhere.example/steal",
      "javascript:alert(1)",
      "device/approve",
      "",
    ]) {
      expect(safeReturnPath(elsewhere), elsewhere).toBeNull();
    }
  });
});
