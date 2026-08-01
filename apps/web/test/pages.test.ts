import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROJECT_NAME as API_DEFAULT_PROJECT_NAME,
  organizationNameFromEmail as apiOrganizationNameFromEmail,
} from "../../api/src/auth/naming.ts";
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
});
