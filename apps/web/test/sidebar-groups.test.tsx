// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Me } from "../lib/me.ts";
import { AppShell } from "../ui/shell.tsx";

/**
 * The grouped sidebar, drawn.
 *
 * The module test beside this one says what the three groups *are*. This says
 * what a person meets: three labelled groups in one navigation landmark, the
 * row they are on lit and saying so, the same six addresses the flat bar
 * offered, and the same three groups inside the mobile drawer rather than a
 * second, shorter list of where they may go.
 *
 * jsdom loads no stylesheet, so the Ember Wash and the Ember mark are asserted
 * as the mapping that produces them — the class that turns them on is bound to
 * the same `data-active` the row carries. The colours themselves were read back
 * in a real browser, in both themes, at both widths.
 */

const routed = vi.hoisted(() => ({ pathname: "/projects/prj_2/agents" }));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ projectId: "prj_2" }),
}));

const ADA: Me = {
  user: { id: "usr_1", email: "ada@acme.example" },
  organizations: [{ id: "org_1", name: "Acme", slug: "acme", role: "admin" }],
  projects: [
    { id: "prj_1", name: "Default", slug: "default" },
    { id: "prj_2", name: "Outbound", slug: "outbound" },
  ],
};

/**
 * The six addresses the bar offers, sorted.
 *
 * Five are the ones it offered before the groups existed. Graders is the one
 * that moved, and it moved for the same reason Monitoring's did: its section
 * holds two screens behind one strip, the strip now leads with Running, and a
 * first tab nobody lands on is not a first tab. `/projects/prj_2/graders` is
 * still the library and still opens it — this is where the *bar* points, not
 * which addresses exist.
 */
const EVERY_ADDRESS = [
  "/projects/prj_2/agents",
  "/projects/prj_2/graders/running",
  "/projects/prj_2/monitoring/transcripts",
  "/projects/prj_2/personas",
  "/projects/prj_2/runs",
  "/projects/prj_2/tests",
];

/**
 * The three clusters, top to bottom. The first has no label at all — the
 * developer dropped the word "Global" on first sight of the built bar, and
 * nothing replaced it: the two rows that stand above both jobs are the two rows
 * at the top, and their position already says so.
 */
const GROUPS: readonly {
  readonly label: string | null;
  readonly items: readonly string[];
}[] = [
  { label: null, items: ["Agents", "Graders"] },
  { label: "Simulations", items: ["Tests", "Personas", "Runs"] },
  { label: "Monitoring", items: ["Transcripts"] },
];

/** The clusters as drawn, labelled or not — a named region is only two of them. */
function clustersIn(navigation: HTMLElement): readonly HTMLElement[] {
  return [...navigation.querySelectorAll<HTMLElement>('[data-slot="sidebar-group"]')];
}

function drawShell(pathname = "/projects/prj_2/agents"): void {
  routed.pathname = pathname;
  render(
    <AppShell initialMe={ADA}>
      <p>page</p>
    </AppShell>,
  );
}

/** The docked bar's own navigation landmark, which is the first one drawn. */
function sidebarNavigation(): HTMLElement {
  return screen.getAllByRole("navigation", { name: "Product navigation" })[0]!;
}

function groupsIn(navigation: HTMLElement): readonly HTMLElement[] {
  return within(navigation).getAllByRole("group");
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  routed.pathname = "/projects/prj_2/agents";
});

describe("the grouped sidebar", () => {
  it("draws three clusters in the order the bar reads, the first unlabelled", () => {
    drawShell();

    const navigation = sidebarNavigation();
    const clusters = clustersIn(navigation);
    expect(clusters).toHaveLength(3);

    for (const [index, expected] of GROUPS.entries()) {
      const cluster = clusters[index]!;
      if (expected.label === null) {
        expect(within(cluster).queryByRole("heading")).toBeNull();
      } else {
        expect(within(cluster).getByText(expected.label)).toBeTruthy();
      }
      expect(
        within(cluster)
          .getAllByRole("link")
          .map((link) => link.textContent?.trim()),
      ).toEqual(expected.items);
    }
  });

  /**
   * **The word "Global" is gone, and it is gone from the accessible tree too.**
   * A heading removed while `aria-labelledby` still pointed at it would leave
   * the region named and the name unreadable, which is worse than the word was.
   */
  it("says Global nowhere, and leaves the top cluster unnamed rather than named badly", () => {
    drawShell();

    const navigation = sidebarNavigation();
    expect(navigation.textContent).not.toContain("Global");

    const top = clustersIn(navigation)[0]!;
    expect(top.getAttribute("role")).toBeNull();
    expect(top.getAttribute("aria-labelledby")).toBeNull();
    expect(top.getAttribute("aria-label")).toBeNull();

    // A named region is now only the two groups that kept a word.
    expect(groupsIn(navigation)).toHaveLength(2);
  });

  /**
   * The label belongs to the group rather than floating over it, so a screen
   * reader says which group it has entered instead of reading six links with
   * nothing between them.
   */
  it("gives each labelled group its label as its accessible name", () => {
    drawShell();

    const navigation = sidebarNavigation();
    for (const { label } of GROUPS) {
      if (label === null) continue;
      expect(within(navigation).getByRole("group", { name: label })).toBeTruthy();
    }
  });

  /**
   * **A sectioned navigation is walked by heading.**
   *
   * The accessible name above says which group somebody is *in*. This is how
   * they get to one at all: the heading list is Simulations and Monitoring, and
   * moving between them is one keystroke rather than six arrow presses. The two
   * mechanisms are wired to the same element on purpose — one word, said twice,
   * that cannot come apart. The top cluster is in neither list, because it is
   * drawn with no word at all: it is where a person already is.
   */
  it("offers every labelled group as a heading, in the order the bar reads", () => {
    drawShell();

    const navigation = sidebarNavigation();
    const headings = within(navigation).getAllByRole("heading");

    expect(headings.map((heading) => heading.textContent?.trim())).toEqual(
      GROUPS.map((group) => group.label).filter((label) => label !== null),
    );
    for (const heading of headings) {
      expect(heading.tagName).toBe("H2");
      const named = within(navigation).getByRole("group", {
        name: heading.textContent?.trim() ?? "",
      });
      expect(named.getAttribute("aria-labelledby")).toBe(
        heading.getAttribute("id"),
      );
    }
  });

  /**
   * **The assertion the regroup rests on.** Six links before, the same six
   * addresses after, whatever group each is drawn under now — so a copied URL
   * keeps meaning what it meant.
   */
  it("offers six addresses, one of them a step deeper than the flat bar\u2019s", () => {
    drawShell();

    const hrefs = within(sidebarNavigation())
      .getAllByRole("link")
      .map((link) => link.getAttribute("href") ?? "");
    expect([...hrefs].sort()).toEqual(EVERY_ADDRESS);
  });

  it("says Runs and Transcripts, and no longer says Simulation runs", () => {
    drawShell();

    const navigation = sidebarNavigation();
    expect(
      within(navigation).getByRole("link", { name: "Runs" }).getAttribute("href"),
    ).toBe("/projects/prj_2/runs");
    expect(
      within(navigation)
        .getByRole("link", { name: "Transcripts" })
        .getAttribute("href"),
    ).toBe("/projects/prj_2/monitoring/transcripts");
    expect(
      within(navigation).queryByRole("link", { name: "Simulation runs" }),
    ).toBeNull();
    expect(within(navigation).queryByRole("link", { name: "Monitoring" })).toBeNull();
  });

  /**
   * One row lit per group, from the address and nothing else. Each of the three
   * is checked, because a group that could never light one would be a group
   * nobody could tell they were in.
   */
  it.each([
    ["/projects/prj_2/agents", "Agents"],
    ["/projects/prj_2/graders/running", "Graders"],
    ["/projects/prj_2/personas/prs_3", "Personas"],
    ["/projects/prj_2/runs/run_9", "Runs"],
    ["/projects/prj_2/monitoring/transcripts/5c1e4b0f", "Transcripts"],
  ])("lights one row on %s, and says which", (pathname, lit) => {
    drawShell(pathname);

    const navigation = sidebarNavigation();
    const links = within(navigation).getAllByRole("link");
    const active = links.filter(
      (link) => link.getAttribute("data-active") === "true",
    );

    expect(active).toHaveLength(1);
    expect(active[0]?.textContent?.trim()).toBe(lit);
    // Never colour alone.
    expect(active[0]?.getAttribute("aria-current")).toBe("page");
    for (const quiet of links.filter((link) => link !== active[0])) {
      expect(quiet.getAttribute("aria-current")).toBeNull();
    }
  });

  /**
   * **The Ember Wash and the small Ember mark, as the mapping that draws them.**
   *
   * jsdom loads no stylesheet, so what is guarded here is that the wash and the
   * mark are bound to the same `data-active` the row above proved it carries —
   * `bg-selected` is Ember Wash and `bg-brand` is Ember, both by way of
   * `tailwind-theme.css`. Renaming either one would take the active state's
   * whole appearance with it and nothing else in the suite would say so.
   */
  it("binds Ember Wash and the Ember mark to the row that is lit", () => {
    drawShell();

    const agents = within(sidebarNavigation()).getByRole("link", {
      name: "Agents",
    });
    expect(agents.className).toContain("data-[active=true]:bg-selected");
    expect(agents.className).toContain("data-[active=true]:before:bg-brand");
    expect(agents.className).toContain("before:content-['']");
  });

  /**
   * **The row moves two properties, and `outline-color` is deliberately not one
   * of them.**
   *
   * `transition-colors` looks like the right class and is not: Tailwind's
   * colour group sweeps in `outline-color`, this product's focus indicator is
   * an outline, and the result was a focus ring that faded up from the row's
   * text colour over 140ms on every Tab step. `DESIGN.md` names keyboard
   * navigation first among the things not to animate, so the two properties
   * hover actually changes are named instead. A keyboard pass found this; only
   * this assertion can keep it found.
   */
  it("moves the hover colours without dragging the focus ring with them", () => {
    drawShell();

    const agents = within(sidebarNavigation()).getByRole("link", {
      name: "Agents",
    });
    expect(agents.className).toContain("transition-[color,background-color]");
    expect(agents.className).not.toContain("transition-colors");
    expect(agents.className).not.toContain("transition-all");
    // The colour fade IS the reduced-motion form — DESIGN.md asks every
    // movement for useful colour feedback, and a colour fade moves nothing —
    // so no rule turns the transition off. And hovering must not erase the
    // current row's Ember Wash: the hover colours are scoped off the active
    // row rather than fighting it on specificity.
    expect(agents.className).not.toContain("motion-reduce:transition-none");
    expect(agents.className).toContain(
      "pointer-hover:data-[active=false]:bg-surface-soft",
    );
  });

  /**
   * **One navigation model.** The drawer draws the same component, so it cannot
   * drift into a shorter list — and it closes behind the choice it was opened
   * to make.
   */
  it("shows the same three clusters in the mobile drawer, and closes behind a choice", () => {
    drawShell();

    fireEvent.click(
      screen.getByRole("button", { name: "Open product navigation" }),
    );

    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    const inDrawer = within(drawer).getByRole("navigation", {
      name: "Product navigation",
    });

    const clusters = clustersIn(inDrawer);
    expect(clusters).toHaveLength(3);
    expect(inDrawer.textContent).not.toContain("Global");
    for (const [index, expected] of GROUPS.entries()) {
      expect(
        within(clusters[index]!)
          .getAllByRole("link")
          .map((link) => link.textContent?.trim()),
      ).toEqual(expected.items);
    }
    expect(
      within(inDrawer)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href") ?? "")
        .sort(),
    ).toEqual(EVERY_ADDRESS);

    fireEvent.click(within(inDrawer).getByRole("link", { name: "Tests" }));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  });

  /**
   * The wordmark leads the bar, the switcher follows it, and the account
   * control stays at the bottom. What this asserts is that the groups landed
   * *between* them rather than around them — which is also the order a
   * keyboard walks the bar in.
   *
   * **The wordmark is first, and that is the 2026-08-23 ruling.** The
   * developer put the Egma logo back at the top of the signed-in sidebar
   * — "our logo, not the organization's" — so the first thing a keyboard
   * reaches in the bar is a link home, and the organization moved into the
   * eyebrow above the project name where the switcher now stands.
   */
  it("leads with the wordmark, then the switcher, and ends with the account", () => {
    drawShell();

    const bar = sidebarNavigation().closest("aside");
    expect(bar).not.toBeNull();

    const order = Array.from(
      bar!.querySelectorAll<HTMLElement>("a[href], button"),
    );
    const at = (node: HTMLElement | null) =>
      node === null ? -1 : order.indexOf(node);

    const wordmark = within(bar!).getByRole("link", { name: "Egma home" });
    const switcher = within(bar!).getByRole("button", { name: /^Organization Acme/ });
    const account = within(bar!).getByRole("button", { name: /account menu$/ });
    const agents = within(bar!).getByRole("link", { name: "Agents" });
    const transcripts = within(bar!).getByRole("link", { name: "Transcripts" });

    expect(at(wordmark)).toBe(0);
    expect(wordmark.getAttribute("href")).toBe("/");
    expect(at(switcher)).toBe(1);
    expect(at(switcher)).toBeLessThan(at(agents));
    expect(at(agents)).toBeLessThan(at(transcripts));
    expect(at(transcripts)).toBeLessThan(at(account));
    expect(at(account)).toBe(order.length - 1);
  });
});
