// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: routed.push, replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ projectId: "prj_1" }),
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

/** Whatever egma is standing in for, answered as the API would answer it. */
function apiAnswers(
  answers: Record<string, { status: number; body: unknown } | "never">,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = new URL(input, "http://egma.test").pathname;
      const answer = answers[path];
      if (answer === undefined) throw new Error(`nothing stubbed for ${path}`);
      if (answer === "never") return new Promise(() => undefined);
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  routed.push.mockReset();
  routed.pathname = "/projects/prj_1/agents";
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
  it("takes focus, and Escape gives it back without changing anything", () => {
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
