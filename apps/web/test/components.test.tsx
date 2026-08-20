// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { Suspense, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RunResultsAddress from "../app/runs/[runId]/page.tsx";
import AgentsPage from "../app/projects/[projectId]/agents/page.tsx";
import type { Me } from "../lib/me.ts";
import { EVERY_NAVIGATION_ITEM } from "../lib/navigation.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "../ui/form.tsx";
import { DataTable, type Column } from "../ui/data-table.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Failure, NotFound } from "../ui/page-state.tsx";
import { PageNavigation } from "../ui/page-navigation.tsx";
import { ProjectSelector } from "../ui/project-selector.tsx";
import { RunProgress } from "../ui/run-status.tsx";
import { useUnsavedChanges } from "../ui/settings-read.ts";
import {
  AppShell,
  PageHeader,
  ProductShellBoundary,
  useShellSession,
} from "../ui/shell.tsx";

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

/**
 * The router, and **one** of it.
 *
 * `useRouter` is stable in Next: a component may depend on it in an effect and
 * the effect runs once. Answering with a fresh object per call makes that
 * effect run on every render, and a page whose effect sets state then reads,
 * renders, reads again, for ever — a hang that says nothing about the page.
 * So the object is made once here, the way the real one is.
 */
const routed = vi.hoisted(() => {
  const push = vi.fn();
  const replace = vi.fn();
  const back = vi.fn();
  return {
    push,
    replace,
    back,
    router: { push, replace, back },
    pathname: "/projects/prj_1/agents",
    projectId: "prj_1" as string | undefined,
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => routed.router,
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

/**
 * Every word the sidebar puts on a link, read from the navigation module rather
 * than typed here.
 *
 * A list typed into this file goes stale the day an item is added or renamed,
 * and the test keeps passing while saying nothing about the item nobody
 * remembered — which is exactly what a navigation test is for.
 */
const NAVIGATION_ITEMS = EVERY_NAVIGATION_ITEM.map((item) => item.label);

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
  routed.replace.mockReset();
  routed.back.mockReset();
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

    fireEvent.click(trigger);
    expect(
      within(screen.getByRole("dialog")).queryByText(/project in this organization/i),
    ).toBeNull();
  });

  it("puts project creation with project selection for an admin", () => {
    render(
      <ProjectSelector
        organization={ACME}
        projects={PROJECTS}
        projectId="prj_1"
        mayCreateProject
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Organization Acme/ }));
    expect(
      within(screen.getByRole("dialog"))
        .getByRole("link", { name: "New project" })
        .getAttribute("href"),
    ).toBe("/new-project");
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

  it("keeps a pointer-dismissed panel present through its short exit", () => {
    render(
      <ProjectSelector
        organization={ACME}
        projects={PROJECTS}
        projectId="prj_1"
      />,
    );
    const trigger = screen.getByRole("button", { name: /^Organization Acme/ });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    const panel = screen.getByRole("dialog");

    fireEvent.pointerDown(document.body);

    expect(screen.getByRole("dialog")).toBe(panel);
    expect(trigger.parentElement?.getAttribute("data-closing")).toBe("true");
    fireEvent.transitionEnd(panel, { propertyName: "opacity" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("uses the pointer exit when a keyboard-opened panel is clicked away", () => {
    const trigger = open();
    const panel = screen.getByRole("dialog");

    fireEvent.pointerDown(document.body);

    expect(trigger.parentElement?.getAttribute("data-input")).toBe("pointer");
    expect(trigger.parentElement?.getAttribute("data-closing")).toBe("true");
    fireEvent.transitionEnd(panel, { propertyName: "opacity" });
    expect(screen.queryByRole("dialog")).toBeNull();
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

describe("nested page navigation", () => {
  it("links every parent and names the current page without making it a link", () => {
    render(
      <PageNavigation
        items={[
          { label: "Runs", href: "/projects/prj_1/runs" },
          { label: "Nightly smoke", href: "/projects/prj_1/runs/run_1" },
          { label: "Simulation 01" },
        ]}
      />,
    );

    const navigation = screen.getByRole("navigation", { name: "Breadcrumb" });
    const runs = within(navigation).getByRole("link", { name: "Runs" });
    const run = within(navigation).getByRole("link", { name: "Nightly smoke" });
    const current = within(navigation).getByText("Simulation 01");

    expect(runs.getAttribute("href")).toBe("/projects/prj_1/runs");
    expect(run.getAttribute("href")).toBe("/projects/prj_1/runs/run_1");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.closest("a")).toBeNull();
  });

  it("lets the breadcrumb own section context instead of repeating the eyebrow", () => {
    render(
      <PageHeader
        eyebrow="Runs"
        title="Nightly smoke"
        breadcrumbs={[
          { label: "Runs", href: "/projects/prj_1/runs" },
          { label: "Nightly smoke" },
        ]}
      />,
    );

    expect(screen.getAllByText("Runs")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Nightly smoke" })).toBeTruthy();
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The two halves of "somewhere to go, dressed as a control".
 *
 * The old control set had a `ButtonLink` that decided this for itself. There
 * is no such component on the shadcn base — a page writes the fork out — so
 * what has to be guarded is that both halves still do what the decision said,
 * because the decision now lives in every page rather than in one file.
 */
describe("a control somebody may not use", () => {
  it("is a real link when it is available", () => {
    render(
      <Button asChild variant="secondary">
        <a href="/projects/prj_1/agents/new">Register agent</a>
      </Button>,
    );

    const link = screen.getByRole("link", { name: "Register agent" });
    expect(link.getAttribute("href")).toBe("/projects/prj_1/agents/new");
  });

  /**
   * A link cannot be disabled: an anchor carrying `aria-disabled` still follows
   * on click and still takes the keyboard. So the unavailable form is not a
   * link at all — it is a button that is disabled for real, and it says why
   * somewhere a keyboard can reach, because a disabled control cannot be
   * focused and a `title` alone is a reason only a pointer gets.
   */
  it("is a button that is disabled for real, and says why", () => {
    render(
      <Button type="button" disabled why="Your viewer role cannot.">
        Register agent
      </Button>,
    );

    expect(screen.queryByRole("link", { name: "Register agent" })).toBeNull();
    const control = screen.getByRole("button", { name: "Register agent" });
    expect((control as HTMLButtonElement).disabled).toBe(true);
    expect(control.getAttribute("href")).toBeNull();
    expect(control.getAttribute("title")).toBe("Your viewer role cannot.");

    const said = control.getAttribute("aria-describedby");
    expect(said).not.toBeNull();
    expect(document.getElementById(said ?? "")?.textContent).toBe(
      "Your viewer role cannot.",
    );
  });
});

describe("a binary choice", () => {
  it("keeps native checkbox behavior and an accessible name", () => {
    function Example() {
      const [checked, setChecked] = useState(false);
      return (
        <Checkbox
          id="include-archived"
          checked={checked}
          aria-label="Include archived agents"
          onChange={(event) => setChecked(event.target.checked)}
        />
      );
    }

    render(<Example />);
    const checkbox = screen.getByRole("checkbox", { name: "Include archived agents" });
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });

  it("connects the field hint to the native checkbox", () => {
    render(
      <Field
        label="Required"
        htmlFor="required-grader"
        hint="A required grader can stop the test from passing."
      >
        <Checkbox
          id="required-grader"
          checked
          onChange={() => undefined}
        />
      </Field>,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Required" });
    const hint = screen.getByText(
      "A required grader can stop the test from passing.",
    );
    expect(checkbox.getAttribute("aria-describedby")).toBe(hint.id);
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

  /** One table changes layout without putting a hidden copy of every control in the DOM. */
  it("draws each row once and carries its small-screen labels on the same cells", () => {
    render(
      <DataTable label="Agents" columns={COLUMNS} rows={ROWS} keyOf={(row) => row.id} />,
    );

    const table = screen.getByRole("table", { name: "Agents" });
    expect(within(table).getAllByRole("row")).toHaveLength(ROWS.length + 1);
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent))
      .toEqual(["Agent", "Registered"]);
    expect(screen.queryByRole("list", { name: "Agents" })).toBeNull();
    expect(screen.getAllByText("Front desk")).toHaveLength(1);

    const firstRow = within(table).getAllByRole("row")[1];
    const cells = within(firstRow as HTMLElement).getAllByRole("cell");
    expect(cells.map((cell) => cell.getAttribute("data-label"))).toEqual([
      "Agent",
      "Registered",
    ]);
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

  it("mounts an interactive cell once, with one id and one focus target", () => {
    const roleCell = vi.fn((row: Row) => (
      <select id={`role-${row.id}`} aria-label={`Role for ${row.name}`}>
        <option>Admin</option>
      </select>
    ));
    const columns: readonly Column<Row>[] = [
      COLUMNS[0]!,
      { key: "role", header: "Role", cell: roleCell },
    ];

    render(
      <DataTable label="Agents" columns={columns} rows={[ROWS[0]!]} keyOf={(row) => row.id} />,
    );

    expect(roleCell).toHaveBeenCalledTimes(1);
    expect(screen.getAllByLabelText("Role for Front desk")).toHaveLength(1);
    expect(document.querySelectorAll("#role-agt_1")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------ */

describe("a dialog", () => {
  it("uses the browser's modal lifecycle and turns Escape into a cancel request", () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Navigation" onClose={onClose}>
        <a href="/projects/prj_1/tests">Tests</a>
      </Dialog>,
    );

    const panel = screen.getByRole("dialog", { name: "Navigation" });
    expect(panel.tagName).toBe("DIALOG");
    expect(panel.getAttribute("aria-modal")).toBe("true");

    // Focus is inside, so the keyboard is no longer driving the page beneath.
    expect(panel.contains(document.activeElement)).toBe(true);

    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(panel, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores the exact control that opened it", () => {
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open navigation</button>
          {open ? (
            <Dialog title="Navigation" onClose={() => setOpen(false)}>
              <a href="/projects/prj_1/tests">Tests</a>
            </Dialog>
          ) : null}
        </>
      );
    }

    render(<Example />);
    const opener = screen.getByRole("button", { name: "Open navigation" });
    const matches = vi.spyOn(opener, "matches").mockImplementation(
      (selector) => selector === ":focus-visible",
    );
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    expect(dialog.getAttribute("data-input")).toBe("keyboard");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(document.activeElement).toBe(opener);
    matches.mockRestore();
  });

  it("uses the same modal lifecycle for a right-side sheet", () => {
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open evidence
          </button>
          {open ? (
            <Dialog
              kind="sheet"
              title="Transcript and audio"
              onClose={() => setOpen(false)}
            >
              <audio aria-label="Simulation recording" />
            </Dialog>
          ) : null}
        </>
      );
    }

    render(<Example />);
    const opener = screen.getByRole("button", { name: "Open evidence" });
    opener.focus();
    fireEvent.click(opener);

    const sheet = screen.getByRole("dialog", {
      name: "Transcript and audio",
    });
    expect(sheet.getAttribute("data-kind")).toBe("sheet");
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(within(sheet).getByRole("button", { name: "Close" })).toBeTruthy();

    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(sheet, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Transcript and audio" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps a pointer-dismissed dialog present through its short exit", () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Archive agent?" onClose={onClose}>
        <button type="button">Confirm archive</button>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "Archive agent?" });
    fireEvent.pointerDown(dialog);

    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.getAttribute("data-closing")).toBe("true");
    fireEvent.transitionEnd(dialog.firstElementChild as HTMLElement, {
      propertyName: "opacity",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses the pointer exit after a dialog was opened with the keyboard", () => {
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open archive</button>
          {open ? (
            <Dialog title="Archive agent?" onClose={() => setOpen(false)}>
              <p>Archive it.</p>
            </Dialog>
          ) : null}
        </>
      );
    }

    render(<Example />);
    const opener = screen.getByRole("button", { name: "Open archive" });
    const matches = vi.spyOn(opener, "matches").mockImplementation(
      (selector) => selector === ":focus-visible",
    );
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Archive agent?" });
    expect(dialog.getAttribute("data-input")).toBe("keyboard");
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.pointerDown(close);
    fireEvent.click(close, { detail: 1 });

    expect(dialog.getAttribute("data-input")).toBe("pointer");
    expect(dialog.getAttribute("data-closing")).toBe("true");
    fireEvent.transitionEnd(dialog.firstElementChild as HTMLElement, {
      propertyName: "opacity",
    });
    expect(screen.queryByRole("dialog", { name: "Archive agent?" })).toBeNull();
    matches.mockRestore();
  });

  it("gives pointer Cancel actions the same short exit as the close button", () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Archive agent?" onClose={onClose}>
        {(dismiss) => (
          <Button type="button" variant="secondary" onClick={dismiss}>
            Cancel
          </Button>
        )}
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "Archive agent?" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    fireEvent.pointerDown(cancel);
    fireEvent.click(cancel, { detail: 1 });

    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.getAttribute("data-input")).toBe("pointer");
    expect(dialog.getAttribute("data-closing")).toBe("true");
    fireEvent.transitionEnd(dialog.firstElementChild as HTMLElement, {
      propertyName: "opacity",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps keyboard Cancel actions immediate", () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Archive agent?" onClose={onClose}>
        {(dismiss) => (
          <Button type="button" variant="secondary" onClick={dismiss}>
            Cancel
          </Button>
        )}
      </Dialog>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not restore focus to an opener removed while the dialog closes", () => {
    function Removing() {
      const [open, setOpen] = useState(false);
      const [gone, setGone] = useState(false);
      const remove = () => {
        setGone(true);
        setOpen(false);
      };

      return (
        <>
          <button type="button">Elsewhere</button>
          {gone ? null : (
            <button type="button" onClick={() => setOpen(true)}>
              Remove
            </button>
          )}
          {open ? (
            <Dialog title="Remove this member?" onClose={remove}>
              <button type="button" onClick={remove}>Remove this member</button>
            </Dialog>
          ) : null}
        </>
      );
    }

    render(<Removing />);
    const opener = screen.getByRole("button", { name: "Remove" });
    opener.focus();
    fireEvent.click(opener);

    const panel = screen.getByRole("dialog", { name: "Remove this member?" });
    expect(panel.contains(document.activeElement)).toBe(true);
    fireEvent.click(within(panel).getByRole("button", { name: "Remove this member" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(opener);
    expect(document.contains(document.activeElement)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */

describe("run progress", () => {
  it("moves one full-width layer with a transform instead of changing layout width", () => {
    render(<RunProgress finished={3} expected={4} />);

    const progress = screen.getByRole("progressbar", { name: "Simulations finished" });
    const fill = progress.firstElementChild as HTMLElement;
    expect(fill.style.transform).toBe("scaleX(0.75)");
    expect(fill.style.width).toBe("");
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

describe("the shared draft navigation guard", () => {
  function DraftPage({ busy = false }: { readonly busy?: boolean }) {
    const [changed, setChanged] = useState(false);
    const state = useUnsavedChanges(changed && !busy, busy);

    return (
      <AppShell initialMe={meWith("admin")}>
        <button type="button" onClick={() => setChanged(true)}>Change name</button>
        <span aria-label="Draft state">{state}</span>
        <a href="/projects/prj_1/tests">Leave page</a>
      </AppShell>
    );
  }

  it("keeps a draft on the page until the discard action is explicit", () => {
    render(<DraftPage />);
    fireEvent.click(screen.getByRole("button", { name: "Change name" }));
    expect(screen.getByLabelText("Draft state").textContent).toBe("unsaved");

    const destination = screen.getByRole("link", { name: "Leave page" });
    destination.focus();
    fireEvent.click(destination);

    expect(routed.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Leave without saving?" }))
      .toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("dialog", { name: "Leave without saving?" }))
      .toBeNull();
    expect(document.activeElement).toBe(destination);

    const [projectSelector] = screen.getAllByRole("button", {
      name: /^Organization Acme/u,
    });
    expect(projectSelector).toBeDefined();
    if (projectSelector === undefined) throw new Error("project selector missing");
    fireEvent.click(projectSelector);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByText("Outbound"),
    );
    expect(routed.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Leave without saving?" }))
      .toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(routed.push).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(projectSelector);

    fireEvent.click(destination);
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/tests");
  });

  it("blocks in-product navigation and browser unload while a write is in flight", () => {
    render(<DraftPage busy />);
    expect(screen.getByLabelText("Draft state").textContent).toBe("saving");

    const destination = screen.getByRole("link", { name: "Leave page" });
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    destination.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(routed.push).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Leave without saving?" }))
      .toBeNull();

    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
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
  it("keeps resolved project context while the page changes", async () => {
    apiAnswers({
      "/api/me": [
        { status: 200, body: meWith("admin") },
        "never",
      ],
    });

    const { rerender } = render(
      <ProductShellBoundary>
        <AppShell key="agents">
          <p>Agents page</p>
        </AppShell>
      </ProductShellBoundary>,
    );
    expect(await screen.findAllByText("ada@acme.example")).not.toHaveLength(0);

    routed.pathname = "/projects/prj_1/tests";
    rerender(
      <ProductShellBoundary>
        <AppShell key="tests">
          <p>Tests page</p>
        </AppShell>
      </ProductShellBoundary>,
    );

    expect(screen.getByText("Tests page")).toBeDefined();
    expect(screen.queryAllByText("Checking your session…")).toHaveLength(0);
    expect(screen.queryAllByText("No organization")).toHaveLength(0);
    expect(screen.queryAllByText("Unknown project")).toHaveLength(0);
    expect(screen.getAllByText("ada@acme.example")).not.toHaveLength(0);

    routed.pathname = "/new-project";
    rerender(
      <ProductShellBoundary>
        <AppShell key="new-project">
          <p>New project page</p>
        </AppShell>
      </ProductShellBoundary>,
    );

    expect(screen.getByText("New project page")).toBeDefined();
    expect(screen.queryAllByText("Checking your session…")).toHaveLength(0);
    expect(screen.queryAllByText("No organization")).toHaveLength(0);
    expect(screen.getAllByText("ada@acme.example")).not.toHaveLength(0);

    const sessionReads = vi.mocked(fetch).mock.calls.filter(([input]) =>
      new URL(String(input), "http://egma.test").pathname === "/api/me"
    );
    expect(sessionReads).toHaveLength(1);
  });

  it("refreshes changed shell context without first clearing the old answer", async () => {
    const renamed: Me = {
      ...meWith("admin"),
      organizations: [{ ...ACME, name: "Analytical Engines" }],
    };
    apiAnswers({
      "/api/me": [
        { status: 200, body: meWith("admin") },
        { status: 200, body: renamed },
      ],
    });

    function RefreshProbe() {
      const { me, refresh } = useShellSession();
      return (
        <button type="button" onClick={() => void refresh()}>
          Refresh {me?.organizations[0]?.name ?? "unknown"}
        </button>
      );
    }

    render(
      <ProductShellBoundary>
        <RefreshProbe />
      </ProductShellBoundary>,
    );

    const refresh = await screen.findByRole("button", { name: "Refresh Acme" });
    fireEvent.click(refresh);

    expect(screen.queryAllByText("Checking your session…")).toHaveLength(0);
    expect(screen.queryAllByText("No organization")).toHaveLength(0);
    expect(
      await screen.findByRole("button", {
        name: "Refresh Analytical Engines",
      }),
    ).toBeDefined();

    const sessionReads = vi.mocked(fetch).mock.calls.filter(([input]) =>
      new URL(String(input), "http://egma.test").pathname === "/api/me"
    );
    expect(sessionReads).toHaveLength(2);
  });

  it("starts the signed-in sidebar with project context, not a repeated logo", () => {
    render(
      <AppShell initialMe={meWith("admin")}>
        <p>page</p>
      </AppShell>,
    );

    const sidebar = screen.getByRole("complementary");
    const firstControl = sidebar.querySelector("button");
    expect(firstControl?.getAttribute("aria-label")).toMatch(/^Organization Acme/);
    expect(within(sidebar).queryByRole("img", { name: /egma/i })).toBeNull();
  });

  it("keeps navigation icons decorative and every label visible", () => {
    render(
      <AppShell initialMe={meWith("admin")}>
        <p>page</p>
      </AppShell>,
    );

    const agents = screen.getAllByRole("link", { name: "Agents" })[0];
    expect(agents?.textContent).toContain("Agents");
    expect(agents?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps Settings in the account menu and out of product navigation", () => {
    render(
      <AppShell initialMe={meWith("admin")}>
        <p>page</p>
      </AppShell>,
    );

    const product = screen.getByRole("navigation", { name: "Product navigation" });
    expect(within(product).queryByRole("link", { name: "Settings" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: /^Account / })[0]!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

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
    // not Runs, not Transcripts, and no href under /projects at all.
    for (const item of NAVIGATION_ITEMS) {
      expect(screen.queryByRole("link", { name: item })).toBeNull();
    }
    expect(
      screen.queryByRole("button", { name: "Open product navigation" }),
    ).toBeNull();
    const hrefs = screen
      .queryAllByRole("link")
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
    for (const item of NAVIGATION_ITEMS) {
      const link = screen.getAllByRole("link", { name: item })[0];
      expect(link?.getAttribute("href")).toContain("/projects/prj_2/");
    }
  });

  /**
   * **Monitoring, drawn rather than declared.** The list above is read from the
   * navigation module, so it cannot catch an item that exists in the module and
   * never reaches the sidebar — a missing icon path would do exactly that. This
   * asks the rendered shell for the item by the words on it, and follows where
   * it goes.
   *
   * The words are the ones the groups left behind: the Monitoring group's item
   * says `Transcripts`, and the Simulations group's says `Runs`. Both addresses
   * are the ones they always were.
   */
  it("puts Transcripts in the sidebar, opening this project's transcript list", async () => {
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

    const transcripts = screen.getAllByRole("link", { name: "Transcripts" })[0];
    expect(transcripts?.getAttribute("href")).toBe(
      "/projects/prj_2/monitoring/transcripts",
    );

    const runs = screen.getAllByRole("link", { name: "Runs" })[0];
    expect(runs?.getAttribute("href")).toBe("/projects/prj_2/runs");
    expect(screen.queryByRole("link", { name: "Simulation runs" })).toBeNull();
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
 * **The address a terminal prints, when it does not forward.**
 *
 * `inProject` once said in a comment that `/runs/{runId}` and `/members` "never
 * arrive here, because they forward before a selector is ever drawn". Both draw
 * `ProductStatePage`, which is this same shell around a page, and `AppShell`
 * draws the selector unconditionally — so the selector is on screen for as long
 * as the read takes, and indefinitely when the read does not end in a forward.
 *
 * This is that case: a `results_url` for a run the session cannot reach settles
 * into `missing` and stays there. It is not an exotic state — it is what a
 * copied `results_url` for a run in another project does today — and one click
 * on the selector goes straight into `inProject` from an address carrying no
 * project. So of the five addresses that reach that function, these two are the
 * likeliest, not the impossible ones.
 */
describe("the run address a terminal prints, stuck", () => {
  it("still draws the selector, and one click on it reaches inProject", async () => {
    routed.pathname = "/runs/run_9";
    routed.projectId = undefined;
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/runs/run_9": {
        status: 404,
        body: {
          error: "not_found",
          message: "no run of yours has that id.",
        },
      },
    });

    // `act` around the render because this page reads its own route parameters
    // through React's `use`, so its first paint is a suspension rather than a
    // page. Nothing else in this file needs it; nothing else in this file
    // suspends.
    // Rendered inside an awaited `act`, because this page reads its own route
    // parameters through React's `use`: its first paint is a suspension rather
    // than a page, and `render`'s own synchronous act cannot wait for one.
    // Nothing else in this file suspends, so nothing else needs it.
    await act(async () => {
      render(
        <Suspense fallback={<p>waiting</p>}>
          <RunResultsAddress params={Promise.resolve({ runId: "run_9" })} />
        </Suspense>,
      );
    });

    // The page has given up forwarding and is showing egma's absence.
    expect(await screen.findByText(/no run of yours has that id/)).toBeDefined();

    // And the shell around it is a whole shell: the selector, saying honestly
    // that this address is inside no project.
    // The shell draws the selector twice — the sidebar's and the narrow
    // screen's — so both are read, and either one is a way in.
    const triggers = screen.getAllByRole("button", {
      name: /^Organization Acme/,
    });
    expect(triggers).not.toHaveLength(0);
    for (const one of triggers) expect(one.textContent).toContain("No project");

    fireEvent.click(triggers[0] as HTMLElement);
    const panel = within(screen.getByRole("dialog"));
    fireEvent.click(panel.getByText("Outbound"));

    // `inProject`, reached from an address with no project in it: there is no
    // area to carry across, so the answer is the picked project's landing page.
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_2/agents");
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
    // The list read carries every agent's connections, so a row in this
    // fixture carries the field. An agent with none is one of the states the
    // page draws, and it is drawn from an empty list rather than a missing one.
    connections: [],
    created_at: "2026-08-15T10:00:00.000Z",
    updated_at: "2026-08-15T10:00:00.000Z",
  };

  it("names its project in the request, every time", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/agents": { status: 200, body: { items: [AGENT], next_cursor: null } },
    });
    render(<AgentsPage />);

    // Once, because the table changes layout without cloning the row.
    expect(await screen.findAllByText("Front desk")).toHaveLength(1);
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

    // No project here to connect an agent to, so nothing offers to.
    for (const control of screen.getAllByRole("button", { name: "Connect agent" })) {
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

  it("offers a member the way to connect an agent, and a viewer the same control disabled", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/agents": { status: 200, body: { items: [AGENT], next_cursor: null } },
    });
    const { unmount } = render(<AgentsPage />);
    expect(await screen.findByRole("link", { name: "Connect agent" })).toBeDefined();
    unmount();

    apiAnswers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/api/agents": { status: 200, body: { items: [AGENT], next_cursor: null } },
    });
    render(<AgentsPage />);

    const refused = await screen.findByRole("button", { name: "Connect agent" });
    expect((refused as HTMLButtonElement).disabled).toBe(true);
    expect(refused.getAttribute("title")).toContain("viewer role cannot");
    expect(screen.queryByRole("link", { name: "Connect agent" })).toBeNull();
  });
});
