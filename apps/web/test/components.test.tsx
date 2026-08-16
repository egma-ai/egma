// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AgentsPage from "../app/projects/[projectId]/agents/page.tsx";
import type { Me } from "../lib/me.ts";
import { ButtonLink } from "../ui/controls.tsx";
import { DataTable, type Column } from "../ui/data-table.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Failure, NotFound } from "../ui/page-state.tsx";
import { ProjectSelector } from "../ui/project-selector.tsx";
import { AppShell } from "../ui/shell.tsx";

/**
 * The shared components, rendered.
 *
 * **This is the fast lane's half of the visual system, and it exists so that
 * the browser journey does not have to grow.** Ten tickets follow this one into
 * this shell; if the only way to prove a menu closes on Escape is to start
 * Postgres, ClickHouse, the API, Next and a real Chrome, then every one of them
 * will add to that file and the narrow ordered journey the spec asks for will
 * not survive. What genuinely needs a browser — two independent tabs on two
 * projects — stays there. Everything a component decides for itself is here.
 *
 * Nothing in this file asserts that a component exists or that a source file
 * contains a string. Every test drives a rendered component the way somebody
 * with a keyboard would, and reads what the DOM then says.
 */

const routed = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/projects/prj_1/agents",
  projectId: "prj_1",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: routed.push, replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ projectId: routed.projectId }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: unknown;
  }) => <a href={href} {...rest}>{children as never}</a>,
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const PROJECTS = [
  { id: "prj_1", name: "Default", slug: "default" },
  { id: "prj_2", name: "Outbound", slug: "outbound" },
];

const ACME = { id: "org_1", name: "Acme", slug: "acme", role: "admin" };

function meWith(role: string): Me {
  return {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [{ ...ACME, role }],
    projects: PROJECTS,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Stubbed = { status: number; body: unknown } | "never";

/**
 * Whatever egma is standing in for, answered as the API would answer it.
 *
 * A path may be given a list, which is answered in order and then repeats its
 * last entry — that is how a read that fails and then succeeds is written.
 */
function apiAnswers(answers: Record<string, Stubbed | readonly Stubbed[]>): void {
  const asked: Record<string, number> = {};

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = new URL(input, "http://egma.test").pathname;
      const held = answers[path];
      if (held === undefined) throw new Error(`nothing stubbed for ${path}`);

      const turn = asked[path] ?? 0;
      asked[path] = turn + 1;
      const answer = Array.isArray(held)
        ? ((held[Math.min(turn, held.length - 1)] ?? "never") as Stubbed)
        : (held as Stubbed);

      if (answer === "never") return new Promise<Response>(() => undefined);
      return json(answer.status, answer.body);
    }),
  );
}

beforeEach(() => {
  routed.push.mockReset();
  routed.pathname = "/projects/prj_1/agents";
  routed.projectId = "prj_1";
  // The shell returns to the top on every navigation; jsdom has no scrolling.
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------------ */

describe("the organization and project selector", () => {
  function open() {
    render(
      <ProjectSelector
        organization={ACME}
        projects={PROJECTS}
        projectId="prj_1"
      />,
    );
    const trigger = screen.getByRole("button", { name: /^Organization Acme/ });
    fireEvent.click(trigger);
    return trigger;
  }

  it("shows where you are with one project as readily as with several", () => {
    render(
      <ProjectSelector
        organization={ACME}
        projects={PROJECTS.slice(0, 1)}
        projectId="prj_1"
      />,
    );

    const trigger = screen.getByRole("button", { name: /^Organization Acme/ });
    expect(trigger.textContent).toContain("Acme");
    expect(trigger.textContent).toContain("Default");
  });

  it("says so plainly when the address names a project this membership has not got", () => {
    render(
      <ProjectSelector
        organization={ACME}
        projects={PROJECTS}
        projectId="prj_gone"
      />,
    );

    const trigger = screen.getByRole("button", { name: /^Organization Acme/ });
    expect(trigger.textContent).toContain("Unknown project");
    expect(trigger.textContent).not.toContain("Default");
  });

  /**
   * The other half of the same rule, and the one the expand-contract change was
   * finished by removing. An address inside no project used to make this
   * control announce the *first* project in the list — on `/new-project`, the
   * one page deliberately outside every project, a person was told they were in
   * Default while they were in nothing.
   */
  it("names no project on an address that names none, rather than the first", () => {
    render(
      <ProjectSelector
        organization={ACME}
        projects={PROJECTS}
        projectId={null}
      />,
    );

    const trigger = screen.getByRole("button", { name: /^Organization Acme/ });
    expect(trigger.textContent).toContain("No project");
    expect(trigger.textContent).not.toContain("Default");
    // And the way into one is never lost: every project is still offered.
    fireEvent.click(trigger);
    const panel = within(screen.getByRole("dialog"));
    expect(panel.getByText("Default")).toBeTruthy();
    expect(panel.getByText("Outbound")).toBeTruthy();
  });

  /**
   * Typing filters, and Enter takes what is left. This is the whole of the
   * keyboard path a person uses to change project, and it never touches a
   * pointer.
   */
  it("is driven from the keyboard: open, type, Enter", () => {
    open();

    const search = screen.getByRole("textbox", { name: "Search projects" });
    expect(document.activeElement).toBe(search);

    // Scoped to the panel: the trigger still says which project is open, and
    // filtering is about the list of ones you could move to.
    const panel = within(screen.getByRole("dialog"));
    fireEvent.change(search, { target: { value: "outb" } });
    expect(panel.queryByText("Default")).toBeNull();
    expect(panel.getByText("Outbound")).toBeDefined();

    fireEvent.keyDown(search, { key: "Enter" });
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_2/agents");
  });

  /**
   * `push` and never `replace`, which is what puts the project change in the
   * history somebody can walk back out of.
   */
  it("leaves the change in the history, so Back undoes it", () => {
    open();
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Outbound"));

    expect(routed.push).toHaveBeenCalledTimes(1);
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_2/agents");
  });

  it("goes nowhere when the project chosen is the one already open", () => {
    open();
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Default"));
    expect(routed.push).not.toHaveBeenCalled();
  });

  it("closes on Escape, with focus back on the control that opened it", () => {
    const trigger = open();
    expect(screen.getByRole("dialog")).toBeDefined();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search projects" }), {
      key: "Escape",
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  /**
   * Home and End belong to the caret while somebody is typing in the search
   * field. Stealing them for the list means the ends of the text cannot be
   * reached, which is a worse trade than the one it buys.
   */
  it("leaves Home and End to the caret while the search field has focus", () => {
    open();

    const search = screen.getByRole("textbox", { name: "Search projects" });
    fireEvent.change(search, { target: { value: "outbound" } });
    const field = search as HTMLInputElement;
    field.setSelectionRange(8, 8);

    const home = fireEvent.keyDown(search, { key: "Home" });

    // Not prevented, so the browser still moves the caret.
    expect(home).toBe(true);
    expect(document.activeElement).toBe(search);
  });

  /**
   * A panel holding a text field is a dialog, not a menu: `role="menu"`
   * promises a list of commands and no screen reader's menu mode expects a
   * textbox inside one.
   */
  it("is a dialog rather than a menu, because it has something to type in", () => {
    open();

    const panel = screen.getByRole("dialog");
    expect(within(panel).getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */

describe("a control somebody may not use", () => {
  it("is a link when it is available", () => {
    render(<ButtonLink href="/projects/prj_1/agents/new">Register agent</ButtonLink>);

    const link = screen.getByRole("link", { name: "Register agent" });
    expect(link.getAttribute("href")).toBe("/projects/prj_1/agents/new");
  });

  /**
   * A link cannot be disabled: an anchor carrying `aria-disabled` still follows
   * on click and still takes the keyboard. So it stops being a link.
   */
  it("stops being a link, and becomes a button that is disabled for real", () => {
    render(
      <ButtonLink href="/projects/prj_1/agents/new" disabled why="Your viewer role cannot.">
        Register agent
      </ButtonLink>,
    );

    expect(screen.queryByRole("link", { name: "Register agent" })).toBeNull();
    const control = screen.getByRole("button", { name: "Register agent" });
    expect((control as HTMLButtonElement).disabled).toBe(true);
    expect(control.getAttribute("href")).toBeNull();
    expect(control.getAttribute("title")).toBe("Your viewer role cannot.");
  });
});

/* ------------------------------------------------------------------------ */

describe("a page of rows", () => {
  type Row = { readonly id: string; readonly name: string; readonly when: string };

  const COLUMNS: readonly Column<Row>[] = [
    { key: "name", header: "Agent", primary: true, cell: (row) => row.name },
    { key: "when", header: "Registered", cell: (row) => row.when },
  ];

  const ROWS: readonly Row[] = [
    { id: "agt_1", name: "Front desk", when: "2026-08-15" },
    { id: "agt_2", name: "Outbound reminders", when: "2026-08-14" },
  ];

  /**
   * One column definition, both layouts. A hand-written small-screen list
   * beside a table is two things to keep in step, and the small one is always
   * the half that falls behind.
   */
  it("draws the same rows as a table and as a list, from one definition", () => {
    render(
      <DataTable label="Agents" columns={COLUMNS} rows={ROWS} keyOf={(row) => row.id} />,
    );

    const table = screen.getByRole("table", { name: "Agents" });
    expect(within(table).getAllByRole("row")).toHaveLength(ROWS.length + 1);
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent))
      .toEqual(["Agent", "Registered"]);

    const list = screen.getByRole("list", { name: "Agents" });
    const entries = within(list).getAllByRole("listitem");
    expect(entries).toHaveLength(ROWS.length);

    // The primary column names the row, and every other column becomes a fact
    // under it rather than being dropped.
    expect(entries[0]?.textContent).toContain("Front desk");
    expect(entries[0]?.textContent).toContain("Registered");
    expect(entries[0]?.textContent).toContain("2026-08-15");
  });

  it("offers the next page only where the list said there is one", () => {
    const { rerender } = render(
      <DataTable label="Agents" columns={COLUMNS} rows={ROWS} keyOf={(row) => row.id} />,
    );
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();

    const onMore = vi.fn();
    rerender(
      <DataTable
        label="Agents"
        columns={COLUMNS}
        rows={ROWS}
        keyOf={(row) => row.id}
        more={{ onMore, loading: false, note: "2 agents so far" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(onMore).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------ */

describe("a dialog", () => {
  it("takes focus, and Escape asks to close without changing anything", () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Navigation" onClose={onClose}>
        <a href="/projects/prj_1/tests">Tests</a>
      </Dialog>,
    );

    const panel = screen.getByRole("dialog", { name: "Navigation" });
    expect(panel.getAttribute("aria-modal")).toBe("true");

    // Focus is inside, so the keyboard is no longer driving the page beneath.
    expect(panel.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * **Where the keyboard is put back**, which this file used to claim in a test
   * name and never assert.
   *
   * Closing a dialog and leaving the focus on nothing sends the next Tab back
   * to the top of the document, several presses from the control somebody was
   * just on. A pointer never meets it, so it only shows up to a person driving
   * the product with a keyboard — and it went unnoticed behind a case called
   * *Escape gives it back* that asserted only that the close handler ran.
   */
  it("puts the focus back on whatever opened it", () => {
    function Opening() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Archive
          </button>
          {open ? (
            <Dialog title="Archive this agent?" onClose={() => setOpen(false)}>
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </Dialog>
          ) : null}
        </>
      );
    }

    render(<Opening />);
    const opener = screen.getByRole("button", { name: "Archive" });
    opener.focus();
    fireEvent.click(opener);

    const panel = screen.getByRole("dialog", { name: "Archive this agent?" });
    expect(panel.contains(document.activeElement)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  /**
   * And a dialog closed by an act that removed the control which opened it
   * leaves the focus alone rather than reaching for a detached element.
   *
   * **The premise has to be made, not assumed.** An earlier version of this
   * case rendered the dialog already open, so the element the Dialog captured
   * was `document.body` — still attached, still focusable — and the
   * `isConnected` branch the case exists to walk was never reached. It was the
   * same shape of empty case as the *Escape gives it back* one this file set
   * out to fix. So the control is focused and pressed here, which is what makes
   * it the captured opener, and the act inside the dialog is what removes it.
   *
   * **What this can and cannot distinguish.** Focusing a detached element is a
   * no-op in jsdom and in Chrome alike, so dropping the `isConnected` guard
   * would not change where the focus ends up — the guard is a statement of
   * intent rather than a behaviour with two outcomes. What the assertions below
   * do hold is that the cleanup runs without throwing over a removed control,
   * and that the focus is left on something still in the document rather than
   * on a node nobody can see.
   */
  it("leaves the focus where it is when what opened it has gone", () => {
    function Removing() {
      const [open, setOpen] = useState(false);
      const [gone, setGone] = useState(false);
      return (
        <>
          <button type="button">Elsewhere</button>
          {gone ? null : (
            <button type="button" onClick={() => setOpen(true)}>
              Remove
            </button>
          )}
          {open ? (
            <Dialog
              title="Remove this member?"
              onClose={() => {
                setGone(true);
                setOpen(false);
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setGone(true);
                  setOpen(false);
                }}
              >
                Remove this member
              </button>
            </Dialog>
          ) : null}
        </>
      );
    }

    render(<Removing />);
    const opener = screen.getByRole("button", { name: "Remove" });
    opener.focus();
    fireEvent.click(opener);

    // The premise, asserted rather than hoped for: this dialog was opened from
    // that control, so that control is what its cleanup would reach for.
    const panel = screen.getByRole("dialog", { name: "Remove this member?" });
    expect(panel.contains(document.activeElement)).toBe(true);

    fireEvent.click(
      within(panel).getByRole("button", { name: "Remove this member" }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(opener.isConnected).toBe(false);
    // Nothing threw, and the focus is on something a person can still reach
    // rather than on a node that has left the page.
    expect(document.activeElement).not.toBe(opener);
    expect(document.contains(document.activeElement)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */

describe("a page that is not showing its data", () => {
  it("says egma refused in egma's own words, and offers a way to ask again", () => {
    const onRetry = vi.fn();
    render(<Failure message="Egma could not be reached." onRetry={onRetry} />);

    const said = screen.getByRole("alert");
    expect(said.textContent).toContain("Egma could not be reached.");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows an absence as an absence, never as a failure", () => {
    render(<NotFound message="There is no project prj_9 available to this organization." />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Not available here");
  });
});

/* ------------------------------------------------------------------------ */

/**
 * What the shell claims about somebody, and when.
 *
 * **An unanswered session is not a viewer.** Guessing the least role while
 * `/api/me` is in flight puts a `View only` badge in front of every admin on
 * every page load, and disables their controls with a sentence about a role
 * they do not hold. Not knowing is its own answer.
 */
describe("the role the shell shows", () => {
  it("claims nothing at all while the session read is in flight", async () => {
    apiAnswers({ "/api/me": "never", "/api/agents": "never" });
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    expect(await screen.findByText("page")).toBeDefined();
    expect(screen.queryByText(/view only/i)).toBeNull();
    expect(screen.getAllByText(/Checking your session/).length).toBeGreaterThan(0);
  });

  it("never shows an admin a View only badge, before or after the answer", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/agents": "never",
    });
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    expect(await screen.findAllByText("ada@acme.example")).not.toHaveLength(0);
    expect(screen.queryByText(/view only/i)).toBeNull();
    expect(screen.getAllByText("admin").length).toBeGreaterThan(0);
  });

  it("shows a viewer that they are one, once it knows", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/api/agents": "never",
    });
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    expect(await screen.findAllByText("ada@acme.example")).not.toHaveLength(0);
    expect(screen.getAllByText(/view only/i).length).toBeGreaterThan(0);
  });

  /**
   * **The last of the first-project fallback, and the reason ticket 12 could
   * not tick its first two criteria until now.**
   *
   * The shell reads the project out of the address. Where the address named
   * none it used to fall back to `projects[0]`, which drew a project's whole
   * navigation on a page that is not in that project — so every link in the
   * sidebar went somewhere the person was not, and the one page that names no
   * project on purpose was the page it happened on. Every product area is under
   * `/projects/:projectId/…` now, the graders screens last, so the fallback has
   * nothing left to stand in for.
   */
  it("draws no product navigation on an address inside no project", async () => {
    routed.pathname = "/new-project";
    apiAnswers({ "/api/me": { status: 200, body: meWith("admin") } });
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    expect(await screen.findByText("page")).toBeDefined();
    // No link into a project the address never named — not Agents, not Tests,
    // not Runs, and no href under /projects at all.
    for (const item of ["Agents", "Tests", "Runs", "Personas", "Graders"]) {
      expect(screen.queryByRole("link", { name: item })).toBeNull();
    }
    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href") ?? "");
    expect(hrefs.filter((href) => href.startsWith("/projects"))).toEqual([]);
  });

  it("keeps every navigation item on an address that does name one", async () => {
    routed.pathname = "/projects/prj_2/agents";
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/agents": "never",
    });
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    expect(await screen.findByText("page")).toBeDefined();
    // And every one of them under the project in the address, never the first
    // in the list.
    for (const item of ["Agents", "Tests", "Runs", "Personas", "Graders"]) {
      const link = screen.getAllByRole("link", { name: item })[0];
      expect(link?.getAttribute("href")).toContain("/projects/prj_2/");
    }
  });

  it("says the session is unavailable rather than that somebody is signed in", async () => {
    apiAnswers({
      "/api/me": { status: 503, body: { error: "x", message: "y" } },
      "/api/agents": "never",
    });
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    expect(await screen.findAllByText("Session unavailable")).not.toHaveLength(0);
    expect(screen.queryByText(/view only/i)).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The Agents landing page, driven through its own states with the API standing
 * in. Each of these is a page somebody actually meets, and each says a
 * different thing.
 */
describe("the Agents page", () => {
  const AGENT = {
    id: "agt_1",
    project_id: "prj_1",
    name: "Front desk",
    description: "Answers the main line.",
    created_at: "2026-08-15T10:00:00.000Z",
    updated_at: "2026-08-15T10:00:00.000Z",
  };

  it("names its project in the request, every time", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/agents": { status: 200, body: { items: [AGENT], next_cursor: null } },
    });
    render(<AgentsPage />);

    // Twice, because one column definition draws the table and the list both.
    expect(await screen.findAllByText("Front desk")).toHaveLength(2);
    const asked = vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url));
    expect(asked).toContain("/api/agents?project=prj_1");
  });

  it("shows an empty project as empty, not as a failure", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/agents": { status: 200, body: { items: [], next_cursor: null } },
    });
    render(<AgentsPage />);

    expect(await screen.findByText("No agents in this project yet")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /**
   * A project of somebody else's and one that never existed are one answer, so
   * following a stranger's link never says which. The API's own sentence is
   * shown unchanged — it names the way out — and there is a way back to a
   * project this membership does hold.
   */
  it("shows a project this organization has not got as an absence, in egma's words", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/agents": {
        status: 404,
        body: {
          error: "project_outside_organization",
          message:
            "There is no project prj_1 available to this organization. Choose a project from the selector and try again.",
        },
      },
    });
    render(<AgentsPage />);

    expect(await screen.findByText("Not available here")).toBeDefined();
    expect(screen.getByText(/available to this organization/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Open Default" })).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();

    // Nothing to register an agent in, so nothing offers to.
    for (const control of screen.getAllByRole("button", { name: "Register agent" })) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
    }
  });

  /**
   * A next page that does not arrive is still something that happened.
   *
   * Swallowing the refusal leaves somebody pressing a control that re-enables
   * itself, says nothing, and never works — which is worse than the failure it
   * hides, because there is nothing to act on.
   */
  it("says so when the next page fails, and lets somebody ask again on purpose", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/agents": [
        { status: 200, body: { items: [AGENT], next_cursor: "agt_1" } },
        {
          status: 503,
          body: { error: "unavailable", message: "Egma could not reach the agents store." },
        },
        {
          status: 200,
          body: {
            items: [{ ...AGENT, id: "agt_2", name: "Outbound reminders" }],
            next_cursor: null,
          },
        },
      ],
    });
    render(<AgentsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));

    const said = await screen.findByRole("alert");
    expect(said.textContent).toContain("Egma could not reach the agents store.");

    // And asking again is a deliberate act with a control of its own, not a
    // guess that pressing the same thing might work this time.
    fireEvent.click(within(said).getByRole("button", { name: "Try again" }));

    expect(await screen.findAllByText("Outbound reminders")).not.toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /**
   * The one thing this whole ticket exists to prevent, in the page it ships.
   *
   * Press `Show more` in one project, change project before the answer comes
   * back, and the rows that arrive belong to the project nobody is looking at
   * any more. They were correctly scoped when they were sent — the server was
   * never wrong — and showing them under another project's name would still
   * make somebody distrust everything else on the screen.
   */
  it("drops a next page that arrives after the project changed", async () => {
    let release: (answer: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });

    const firstPageOf = (project: string | null) =>
      json(200, {
        items: [
          {
            ...AGENT,
            project_id: String(project),
            id: `agt_${String(project)}`,
            name: project === "prj_1" ? "Front desk" : "Night line",
          },
        ],
        next_cursor: "agt_cursor",
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const at = new URL(String(input), "http://egma.test");
        if (at.pathname === "/api/me") return json(200, meWith("admin"));
        if (at.searchParams.has("cursor")) return pending;
        return firstPageOf(at.searchParams.get("project"));
      }),
    );

    const { rerender } = render(<AgentsPage />);
    expect(await screen.findAllByText("Front desk")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    // Somebody chooses another project while that read is still in flight.
    // The page is not remounted — it is the same route with another project in
    // it, which is exactly why its own state can outlive the change.
    routed.projectId = "prj_2";
    routed.pathname = "/projects/prj_2/agents";
    rerender(<AgentsPage />);
    expect(await screen.findAllByText("Night line")).not.toHaveLength(0);

    // The first project's next page finally arrives.
    release(
      json(200, {
        items: [{ ...AGENT, id: "agt_stale", name: "Somebody else's project" }],
        next_cursor: null,
      }),
    );
    await new Promise((settle) => setTimeout(settle, 0));

    expect(screen.queryByText("Somebody else's project")).toBeNull();
    expect(screen.queryAllByText("Front desk")).toHaveLength(0);
    expect(screen.getAllByText("Night line").length).toBeGreaterThan(0);
  });

  it("offers a member the way to register, and a viewer the same control disabled", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/agents": { status: 200, body: { items: [AGENT], next_cursor: null } },
    });
    const { unmount } = render(<AgentsPage />);
    expect(await screen.findByRole("link", { name: "Register agent" })).toBeDefined();
    unmount();

    apiAnswers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/api/agents": { status: 200, body: { items: [AGENT], next_cursor: null } },
    });
    render(<AgentsPage />);

    const refused = await screen.findByRole("button", { name: "Register agent" });
    expect((refused as HTMLButtonElement).disabled).toBe(true);
    expect(refused.getAttribute("title")).toContain("viewer role cannot");
    expect(screen.queryByRole("link", { name: "Register agent" })).toBeNull();
  });
});
