// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readFile } from "node:fs/promises";
import path from "node:path";

import AgentsLoading from "../app/projects/[projectId]/agents/loading.tsx";
import AgentsPage from "../app/projects/[projectId]/agents/page.tsx";
import TestLoading from "../app/projects/[projectId]/tests/[testId]/loading.tsx";
import type { Me } from "../lib/me.ts";
import { EVERY_NAVIGATION_ITEM } from "../lib/navigation.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Choice } from "../ui/choice.tsx";
import { Field } from "../ui/form.tsx";
import { DataTable, type Column } from "../ui/data-table.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Failure, Loading, NotFound } from "../ui/page-state.tsx";
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
import { observeRequest, type FetchInput } from "./platform-request.ts";

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
    /*
     * Which side sheet the agents screen has open is in the address and
     * nowhere else, so a page rendered here needs the query as well as the
     * path. Empty is the plain list with no panel over it.
     */
    search: "",
    projectId: "prj_1" as string | undefined,
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => routed.router,
  useSearchParams: () => new URLSearchParams(routed.search),
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
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const { path } = await observeRequest(input, init);
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

/**
 * Let the work a control deliberately defers actually happen.
 *
 * Radix's roving focus moves focus in a task after the key rather than during
 * it, so React has committed the new state before anything is focused. A test
 * that reads the DOM in the same tick is reading it before the control has
 * finished, which is a race rather than a failure.
 */
const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0));
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
    expect(trigger.textContent).toContain("Project");
    expect(trigger.textContent).toContain("Default");

    fireEvent.click(trigger);
    expect(
      within(screen.getByRole("menu")).queryByText(/project in this organization/i),
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
      within(screen.getByRole("menu"))
        .getByRole("menuitem", { name: "New project" })
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
    const panel = within(screen.getByRole("menu"));
    expect(panel.getByText("Default")).toBeTruthy();
    expect(panel.getByText("Outbound")).toBeTruthy();
  });

  /**
   * `push` and never `replace`, which is what puts the project change in the
   * history somebody can walk back out of.
   */
  it("leaves the change in the history, so Back undoes it", () => {
    open();
    fireEvent.click(within(screen.getByRole("menu")).getByText("Outbound"));

    expect(routed.push).toHaveBeenCalledTimes(1);
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_2/agents");
  });

  it("goes nowhere when the project chosen is the one already open", () => {
    open();
    fireEvent.click(within(screen.getByRole("menu")).getByText("Default"));
    expect(routed.push).not.toHaveBeenCalled();
  });

  it("closes on Escape, with focus back on the control that opened it", () => {
    const trigger = open();
    const panel = screen.getByRole("menu");

    fireEvent.keyDown(panel, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  /**
   * The panel leaves under its own motion, and the theme is what times it.
   *
   * The exit is a CSS animation keyed on `data-state="closed"`, and the kit
   * removes the panel on `animationend` rather than on the press — so "an exit
   * runs to completion" is a property of the surface rather than a timer this
   * page keeps. What is read here is the state the animation is keyed on.
   */
  it("marks the panel closed and leaves on the animation, not on the press", () => {
    const trigger = open();
    const panel = screen.getByRole("menu");
    expect(panel.dataset.slot).toBe("popover-content");
    expect(panel.dataset.state).toBe("open");

    fireEvent.keyDown(panel, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("data-state")).toBe("closed");
  });

  it("closes when the pointer lands somewhere else on the page", async () => {
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
    expect(screen.getByRole("menu")).toBeDefined();

    // Two things about a press outside, and both are the panel's own rule.
    // It starts listening on the task after it opened, so the press that
    // opened it is not also the press that closes it. And it leaves on the
    // *finished* press rather than on the way down, so a selection that starts
    // in the panel and ends outside it does not close what it was reading.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("menu")).toBeDefined();
    fireEvent.click(document.body);

    expect(screen.queryByRole("menu")).toBeNull();
    // A press elsewhere is a way of leaving, so the keyboard is not dragged
    // back to the control somebody has just moved away from.
    expect(document.activeElement).not.toBe(trigger);
  });

  it("opens a direct project menu without search or orange trigger text", () => {
    const trigger = open();
    const panel = screen.getByRole("menu");

    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(within(panel).getByRole("menuitem", { name: /Default/u })).toBeTruthy();
    expect(within(panel).getByRole("menuitem", { name: "Outbound" })).toBeTruthy();
    const projectName = trigger.querySelector('[data-slot="project-name"]');
    expect(projectName?.classList.contains("text-foreground")).toBe(true);
    expect(projectName?.classList.contains("text-brand")).toBe(false);
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
    const current = within(navigation).getByRole("heading", {
      name: "Simulation 01",
    });

    expect(runs.getAttribute("href")).toBe("/projects/prj_1/runs");
    expect(run.getAttribute("href")).toBe("/projects/prj_1/runs/run_1");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.closest("a")).toBeNull();
    expect(current.classList.contains("text-sm")).toBe(true);
    expect(current.classList.contains("font-normal")).toBe(true);
    expect(runs.classList.contains("no-underline")).toBe(true);
    expect(runs.classList.contains("pointer-hover:underline")).toBe(true);
    expect(navigation.querySelector("ol")?.classList.contains("flex-wrap")).toBe(true);
    expect(current.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
    expect(runs.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
    expect(within(navigation).getAllByText("/")).toHaveLength(2);
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

    const navigation = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(screen.getAllByText("Runs")).toHaveLength(1);
    expect(
      within(navigation).getByRole("heading", { name: "Nightly smoke" }),
    ).toBeTruthy();
    expect(navigation.textContent).toBe("Runs/Nightly smoke");
  });

  /**
   * The trail and the page's name are one line, in one type.
   *
   * They used to be two things in one bar: a small underlined "Tests" beside a
   * larger "Livekit agent suite", with no separator between them. That is the
   * mismatch the developer read off production on 2026-08-26, and this is the
   * shape that answers it — one line, one type, the section linked and the
   * page the last step of its own trail.
   */
  it("draws the trail and the page as one line, ending in the page", () => {
    render(
      <PageHeader
        title="Livekit agent suite"
        breadcrumbs={[
          { label: "Tests", href: "/projects/prj_1/tests" },
          { label: "Livekit agent suite" },
        ]}
      />,
    );

    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    const tests = within(trail).getByRole("link", { name: "Tests" });
    const page = within(trail).getByRole("heading", {
      name: "Livekit agent suite",
    });

    expect(tests.getAttribute("href")).toBe("/projects/prj_1/tests");
    expect(trail.textContent).toBe("Tests/Livekit agent suite");
    /* The page's own name carries the trail's size, not a heading's. */
    expect(page.className).toContain("text-sm");
    expect(page.className).toContain("font-normal");
  });

  /**
   * One page, one name — the invariant the first cut of this line broke.
   *
   * A header that appended its title whenever the trail's last step said
   * something else drew two steps with no address, and this file draws every
   * addressless step as an `<h1 aria-current="page">`. Three real pages ended
   * up with two headings and two current steps, the settled simulation among
   * them. The trail's type now allows one current step, and this holds the
   * render to it: a deep trail, a short one, and a page with no trail at all.
   */
  it("names itself once, whatever shape of page it is", () => {
    /* `steps` is 1 for a page inside a trail and 0 for a page with none. */
    function namesItselfOnce(page: ReactElement, steps: 0 | 1): void {
      const { container, unmount } = render(page);
      expect(container.querySelectorAll("h1")).toHaveLength(1);
      expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(steps);
      unmount();
    }

    // The settled simulation: Runs, the run, then the test it executed.
    namesItselfOnce(
      <PageHeader
        eyebrow="Simulation runs"
        title="Reschedules a booked appointment"
        breadcrumbs={[
          { label: "Runs", href: "/projects/prj_1/runs" },
          { label: "Nightly smoke", href: "/projects/prj_1/runs/run_1" },
          { label: "Reschedules a booked appointment" },
        ]}
      />,
      1,
    );
    // A transcript state page, whose heading is the state it is in.
    namesItselfOnce(
      <PageHeader
        title="Open this from the list"
        breadcrumbs={[
          { label: "Traces", href: "/projects/prj_1/monitoring/transcripts" },
          { label: "Open this from the list" },
        ]}
      />,
      1,
    );
    // A list page: one name, and no trail for a current step to sit in.
    namesItselfOnce(<PageHeader title="Tests" />, 0);
  });

  /**
   * The other half of the rule above, and it needs its own case.
   *
   * A page with no trail still says which section it is in, and on one screen
   * that label is a *fact* rather than a repetition: the transcript page puts
   * the trace's source and environment in it — "production / default" — and
   * states it nowhere else. Sixty-four call sites pass this prop, so a version
   * of `PageHeader` that accepted it and quietly drew nothing would take a
   * line off every one of them and break no test at all. This is that test.
   *
   * It is not in the title bar. The bar holds the page title alone, which is
   * what `71V-0` draws; the label and the purpose statement are the quiet
   * block under it.
   */
  it("draws the eyebrow when a page offers no trail, outside the title bar", () => {
    render(
      <PageHeader
        eyebrow="production / default"
        title="Nightly smoke"
        lead="What this run was for."
      />,
    );

    const label = screen.getByText("production / default");
    expect(label).toBeTruthy();
    expect(label.closest('[data-slot="page-topbar"]')).toBeNull();
    expect(label.closest('[data-slot="page-toolbar"]')).not.toBeNull();

    const title = screen.getByRole("heading", { name: "Nightly smoke" });
    expect(title.closest('[data-slot="page-topbar"]')).not.toBeNull();
    /* One header holds both, which is how a page finds its own controls. */
    expect(title.closest("header")).toBe(label.closest("header"));
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

  /**
   * A 44px target around an 18px box.
   *
   * `DESIGN.md` asks for a 44px pointer target on a coarse pointer; it does not
   * ask for a 44px checkbox. The label is the target, because a label activates
   * the control it wraps, so it is what grows — and only on a coarse pointer,
   * so a mouse sees no change at all.
   *
   * A class assertion for the reason `design-system.test.tsx` writes down: jsdom
   * loads no stylesheet, so what is guarded is the mapping. `pointer-coarse` is
   * an egma variant, not a Tailwind one, and it is the whole of this fix — a
   * later tidy that drops it takes the target back to 18px and nothing else on
   * the page would look any different.
   */
  it("gives the checkbox a coarse-pointer target without growing its box", () => {
    render(<Checkbox id="weekly-summary" checked onChange={() => undefined} />);

    const box = screen.getByRole("checkbox");
    expect(box.className).toContain("size-[18px]");

    const target = box.parentElement;
    expect(target?.tagName).toBe("LABEL");
    expect(target?.className).toContain("size-[18px]");
    expect(target?.className).toContain("pointer-coarse:size-(--tap-target)");
  });

  it("connects the field hint to the native checkbox", () => {
    render(
      <Field
        label="Send weekly summary"
        htmlFor="weekly-summary"
        hint="Email the project summary every Monday."
      >
        <Checkbox
          id="weekly-summary"
          checked
          onChange={() => undefined}
        />
      </Field>,
    );

    const checkbox = screen.getByRole("checkbox", {
      name: "Send weekly summary",
    });
    const hint = screen.getByText("Email the project summary every Monday.");
    expect(checkbox.getAttribute("aria-describedby")).toBe(hint.id);
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The two-list choice, driven the way somebody without a pointer drives it.
 *
 * **This test moved here rather than being deleted, and where it came from is
 * the point.** It lived on the Personas list, because that page was one of the
 * two that drew this control — and the 2026-08-20 annotation batch took the
 * archive filter's control off both of them. A test that clicks a control the
 * page no longer draws is not a weakened test, it is a broken one, so it could
 * not stay there. `Choice` itself is untouched by that batch: it still does
 * every one of the things below, and after the removal there was no test in
 * this repository that asked it to.
 *
 * So it is proven where the behavior lives. That is the better home anyway —
 * `Choice` is a shared control, its keyboard contract belongs to it rather
 * than to whichever page happened to mount it, and the proof now survives the
 * next page that adopts or drops it.
 *
 * It is the kit's radio group now, which is Radix's, so the contract below is
 * no longer hand-written. It is still asked for here: what a person gets from
 * this control is the same list of promises whoever keeps them, and a later
 * change that swaps the primitive back out has to keep them too.
 */
describe("a choice between two lists", () => {
  const OPTIONS = [
    { value: "active", label: "Active" },
    { value: "archived", label: "Archived" },
  ] as const;

  type Shown = (typeof OPTIONS)[number]["value"];

  function Example({ onChange }: { readonly onChange?: (value: Shown) => void }) {
    const [shown, setShown] = useState<Shown>("active");
    return (
      <Choice<Shown>
        label="Which personas to show"
        value={shown}
        options={OPTIONS}
        onChange={(value) => {
          setShown(value);
          onChange?.(value);
        }}
      />
    );
  }

  it("is one radio group, named, with the chosen option announced", () => {
    render(<Example />);

    const group = screen.getByRole("radiogroup", {
      name: "Which personas to show",
    });
    expect(within(group).getAllByRole("radio").map((one) => one.textContent))
      .toEqual(["Active", "Archived"]);
    expect(screen.getByRole("radio", { name: "Active" }).getAttribute("aria-checked"))
      .toBe("true");
    expect(screen.getByRole("radio", { name: "Archived" }).getAttribute("aria-checked"))
      .toBe("false");
  });

  /**
   * **One Tab stop, an arrow key inside it, and selection following focus.**
   * Roving `tabindex` is what keeps a two-option filter from costing two Tab
   * presses on the way to the table — and a ten-option one from costing ten.
   * Selection following focus is what keeps the keyboard and the announcement
   * agreeing: a group that moved the highlight without moving focus would
   * leave a screen reader saying one thing and the next keypress landing on
   * another.
   *
   * Radix moves focus in a task after the key rather than during it, so React
   * has committed the new selection before anything is focused. That is why
   * each key here is followed by a flush: the order a caller sees is `onChange`
   * and then the focus move, and asking for both in the same tick would be
   * asking for an order this control does not promise.
   */
  it("chooses the other list from the keyboard, and says which is chosen", async () => {
    const chose = vi.fn();
    render(<Example onChange={chose} />);

    /*
     * The group is the Tab stop and the options are not, which is the same
     * promise the old hand-written `tabindex` made and a stricter way to keep
     * it: entering forwards focus to whichever option is chosen.
     */
    const group = screen.getByRole("radiogroup", {
      name: "Which personas to show",
    });
    expect(group.getAttribute("tabindex")).toBe("0");
    for (const option of within(group).getAllByRole("radio")) {
      expect(option.getAttribute("tabindex")).toBe("-1");
    }

    const active = screen.getByRole("radio", { name: "Active" });
    act(() => active.focus());
    expect(active.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("radio", { name: "Archived" }).getAttribute("tabindex"))
      .toBe("-1");

    fireEvent.keyDown(active, { key: "ArrowRight" });
    await settle();

    expect(chose).toHaveBeenCalledWith("archived");
    const now = screen.getByRole("radio", { name: "Archived" });
    expect(now.getAttribute("aria-checked")).toBe("true");
    expect(now.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("radio", { name: "Active" }).getAttribute("tabindex"))
      .toBe("-1");
    // Selection follows focus, so the keyboard and the announcement agree.
    expect(document.activeElement).toBe(now);

    // The same key again comes back round rather than stopping at the end: a
    // closed set of two has no far edge to be stuck against.
    fireEvent.keyDown(now, { key: "ArrowRight" });
    await settle();
    expect(chose).toHaveBeenLastCalledWith("active");
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Active" }),
    );
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

  it("draws one page at a time with previous and next controls", () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    render(
      <DataTable
        label="Agents"
        columns={COLUMNS}
        rows={ROWS}
        keyOf={(row) => row.id}
        pagination={{
          page: 2,
          canPrevious: true,
          canNext: false,
          loading: false,
          onPrevious,
          onNext,
          previousLabel: "Previous",
          pageLabel: (page) => `Page ${page}`,
          nextLabel: "Next",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Page 2")).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
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

/**
 * A closing animation, said out loud, because jsdom runs no stylesheet.
 *
 * The kit removes a dialog on `animationend`, and it decides whether there is
 * an animation to wait for by reading the computed style. jsdom loads no CSS,
 * so every surface there claims `animationName: ""` and leaves the instant it
 * is closed — which would make "an exit runs to completion" untestable in this
 * lane. This answers the way the real theme answers: the entrance while the
 * surface is open, the exit once it is closed. Nothing else is changed, so the
 * test still drives the kit's own presence machine rather than a stand-in.
 */
function finishExit(surface: HTMLElement, animationName: string): void {
  // jsdom has no `AnimationEvent`, so the one property the kit reads is put on
  // an ordinary event rather than left undefined by a constructor that ignores
  // it. The kit's own listener is on the element, so this reaches it.
  const ended = new Event("animationend", { bubbles: false });
  Object.defineProperty(ended, "animationName", { value: animationName });
  fireEvent(surface, ended);
}

function withClosingAnimation(): void {
  const real = window.getComputedStyle.bind(window);
  vi.stubGlobal(
    "getComputedStyle",
    (element: Element, pseudo?: string | null) => {
      const styles = real(element, pseudo);
      const slot =
        element instanceof HTMLElement ? (element.dataset.slot ?? "") : "";
      if (!slot.startsWith("dialog-")) return styles;
      return new Proxy(styles, {
        get(target, key, receiver) {
          if (key !== "animationName") return Reflect.get(target, key, receiver);
          return (element as HTMLElement).dataset.state === "closed"
            ? "egma-dialog-out"
            : "egma-dialog-in";
        },
      });
    },
  );
}

describe("a dialog", () => {
  it("puts the page behind it out of reach, and closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">Elsewhere</button>
        <Dialog title="Navigation" onClose={onClose}>
          <a href="/projects/prj_1/tests">Tests</a>
        </Dialog>
      </>,
    );

    const panel = screen.getByRole("dialog", { name: "Navigation" });
    expect(document.querySelector("[data-slot='dialog-overlay']")).toBeTruthy();

    // Inert is not a class on the page behind: the kit hides it from the
    // accessibility tree, so a control out there is no longer reachable at all.
    expect(screen.queryByRole("button", { name: "Elsewhere" })).toBeNull();

    // Focus is inside, so the keyboard is no longer driving the page beneath.
    expect(panel.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores the exact control that opened it", async () => {
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
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("uses a right-side sheet without drawing a scrim", () => {
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
    expect(document.querySelector("[data-slot='dialog-overlay']")).toBeNull();
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(within(sheet).getByRole("button", { name: "Close" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Transcript and audio" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  /**
   * The sheet is the one kind that does not take the screen, and this is the
   * whole reason it is allowed to be different: the simulation page opens one
   * by default and is built to be read with the transcript beside the grader
   * results. A sheet that hid the page or closed on a press into it would take
   * that page away.
   */
  it("leaves the page beside a sheet readable and usable", async () => {
    const pressed = vi.fn();
    render(
      <>
        <button type="button" onClick={pressed}>Grade again</button>
        <Dialog kind="sheet" title="Transcript and audio" onClose={vi.fn()}>
          <audio aria-label="Simulation recording" />
        </Dialog>
      </>,
    );

    const behind = screen.getByRole("button", { name: "Grade again" });
    expect(behind.closest("[aria-hidden='true']")).toBeNull();

    // The panel starts listening for a press outside on the task after it
    // opened, so the press that opened it is not the one that closes it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.pointerDown(behind);
    fireEvent.click(behind);

    expect(pressed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Transcript and audio" }))
      .toBeTruthy();
  });

  /**
   * "An exit runs to completion and is never cut off. A surface that is closed
   * finishes leaving before it is removed."
   *
   * So `onClose` — the owner's instruction to take the dialog away — is not the
   * press. It is the end of the closing animation, and the dialog is still on
   * screen for the whole of it.
   */
  it("keeps a dismissed dialog present until its exit has finished", () => {
    withClosingAnimation();
    const onClose = vi.fn();
    render(
      <Dialog title="Archive agent?" onClose={onClose}>
        <button type="button">Confirm archive</button>
      </Dialog>,
    );

    const panel = screen.getByRole("dialog", { name: "Archive agent?" });
    expect(panel.dataset.slot).toBe("dialog-content");
    expect(panel.dataset.state).toBe("open");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.getByRole("dialog", { name: "Archive agent?" })).toBe(panel);
    expect(panel.dataset.state).toBe("closed");
    expect(onClose).not.toHaveBeenCalled();

    finishExit(panel, "egma-dialog-out");

    expect(screen.queryByRole("dialog", { name: "Archive agent?" })).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * "No motion delays input. A control answers on press, not after an
   * animation."
   *
   * So this is about *when*, and the animation has to be real for the question
   * to exist: with no stylesheet the panel leaves in the same tick and every
   * naive assertion here passes without proving anything. With one in flight,
   * the panel is still on screen, `onClose` has not been called, and the
   * keyboard is nevertheless already back on the control that opened it.
   */
  it("hands the keyboard back on the press, not at the end of the exit", () => {
    withClosingAnimation();
    const onClose = vi.fn();
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Archive</button>
          {open ? (
            <Dialog title="Archive agent?" onClose={onClose}>
              {(dismiss) => (
                <Button type="button" variant="secondary" onClick={dismiss}>
                  Cancel
                </Button>
              )}
            </Dialog>
          ) : null}
        </>
      );
    }

    render(<Example />);
    const opener = screen.getByRole("button", { name: "Archive" });
    opener.focus();
    fireEvent.click(opener);
    const panel = screen.getByRole("dialog", { name: "Archive agent?" });
    expect(panel.contains(document.activeElement)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Still leaving: the panel is on screen and the owner has not been told.
    expect(panel.dataset.state).toBe("closed");
    expect(screen.getByRole("dialog", { name: "Archive agent?" })).toBe(panel);
    expect(onClose).not.toHaveBeenCalled();
    // And the keyboard is already back, mid-exit.
    expect(document.activeElement).toBe(opener);

    finishExit(panel, "egma-dialog-out");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it("gives a Cancel action written by the caller the same way out", () => {
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

    expect(screen.queryByRole("dialog", { name: "Archive agent?" })).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * A successful write may take the dialog away itself, and the owner has
   * already been told. Reporting the exit as a second close would ask the page
   * to answer twice for one action.
   */
  it("stays quiet when the owner removes the dialog itself", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <Dialog title="Archive agent?" onClose={onClose}>
          <button type="button">Confirm archive</button>
        </Dialog>
      </>,
    );
    expect(screen.getByRole("dialog", { name: "Archive agent?" })).toBeDefined();

    rerender(<></>);

    expect(screen.queryByRole("dialog", { name: "Archive agent?" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
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

/**
 * The loading state, which used to be a sentence and nothing else.
 *
 * `DESIGN.md` asks it for a "fast, quiet indicator", and none of what that
 * costs is written in these components: the wait before anything appears, the
 * breath in the bars, the phase between them and the reduced-motion form all
 * live in `tailwind-theme.css`, keyed on the slots the components publish.
 *
 * So the tests come in two halves. The first reads the DOM and proves the
 * components emit the hooks and say the true sentence. The second reads the
 * theme and proves the rules keyed on those hooks are made of egma's tokens.
 * Neither half watches anything move — jsdom computes no animation — and the
 * movement itself is proven in a browser.
 */
describe("the state a page shows while it is still waiting", () => {
  function loadingState(): HTMLElement {
    render(<Loading what="agents" />);
    return screen.getByRole("status");
  }

  function bars(inside: HTMLElement): readonly HTMLElement[] {
    return [...inside.querySelectorAll<HTMLElement>('[data-slot="skeleton"]')];
  }

  it("still says what it is waiting for, in the quiet tone it always had", () => {
    const said = loadingState();

    expect(said.dataset.tone).toBe("quiet");
    expect(screen.getByText("Loading agents…")).toBeTruthy();
  });

  it("shows the wait is alive without saying it twice to a screen reader", () => {
    const said = loadingState();
    const indicator = said.querySelector('[data-slot="loading-indicator"]');

    expect(indicator?.getAttribute("aria-hidden")).toBe("true");
    expect(bars(said)).toHaveLength(3);
    // The sentence is announced once, by the heading above the bars.
    expect(said.textContent).toBe("Loading agents…");
  });

  /**
   * The hooks are the contract between the two halves. A rename here is a rule
   * in the theme that silently stops matching anything, which is the one
   * failure this arrangement can have and the one nothing else would catch.
   */
  it("publishes the slots the theme's motion is keyed on", () => {
    const said = loadingState();

    expect(said.dataset.slot).toBe("page-state");
    expect(said.querySelector('[data-slot="loading-indicator"]')).toBeTruthy();
    expect(bars(said)).toHaveLength(3);
  });

  it("writes no motion of its own, in either file", async () => {
    const said = loadingState();
    for (const element of [said, ...bars(said)]) {
      expect(element.className).not.toContain("animate");
      expect(element.className).not.toContain("animation");
    }

    // `import.meta.dirname`, not a URL: this file runs under jsdom, where
    // `import.meta.url` is an http address rather than a path on disk.
    const here = import.meta.dirname;
    for (const file of ["../ui/page-state.tsx", "../components/ui/skeleton.tsx"]) {
      const source = await readFile(path.join(here, file), "utf8");
      expect(source, `${file} writes motion`).not.toContain("animation:");
      expect(source, `${file} writes motion`).not.toContain("animate-");
    }
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The other half: the rules those slots are keyed on.
 *
 * `DESIGN.md` puts loading motion in the theme beside the run state mark's
 * turn, so this reads the theme rather than a class list. What it checks is
 * not the exact declarations but the rules that would be broken silently — a
 * duration that stopped being a token, an entrance short enough to flash, a
 * reduced-motion form that went missing.
 */
describe("the motion the theme gives a state that is waiting", () => {
  async function theme(): Promise<string> {
    return readFile(
      path.join(import.meta.dirname, "../ui/tailwind-theme.css"),
      "utf8",
    );
  }

  function ruleFor(css: string, selector: string): string {
    const at = css.indexOf(selector);
    expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
    const opened = css.indexOf("{", at);
    return css.slice(opened, css.indexOf("}", opened));
  }

  it("breathes on a keyframe of its own rather than one Tailwind might drop", async () => {
    const css = await theme();

    // Tailwind's `pulse` is only emitted while some class list still says
    // `animate-pulse`. Reading it from a rule here would be a keyframe that
    // exists as a side effect of a utility nothing uses.
    expect(css).toContain("@keyframes egma-skeleton-pulse");
  });

  it("times the breath with tokens, never with the numbers shadcn shipped", async () => {
    const css = await theme();
    const rule = ruleFor(css, '[data-slot="skeleton"] {');

    expect(rule).toContain("var(--duration-drawer-in)");
    expect(rule).toContain("var(--ease-in-out)");
    expect(rule).not.toContain("cubic-bezier");
    expect(rule).not.toMatch(/\d+m?s/);
  });

  /**
   * The rule this proves is a number: a route that answers before the wait is
   * up is drawn without the indicator ever having been on screen. The token is
   * read out of the same file and checked against the threshold, rather than
   * the test agreeing with whatever the theme happens to say today.
   */
  it("waits longer than a fast answer takes, so nothing flashes", async () => {
    const css = await theme();
    const rule = ruleFor(css, '[data-slot="route-loading"],');

    expect(rule).toContain("egma-fade-in");
    expect(rule).toContain("var(--duration-popover-in)");
    // `both` is what holds it at nothing for the length of the wait.
    expect(rule).toContain("both");

    const waited = /--duration-popover-in:\s*(\d+)ms/.exec(css)?.[1];
    expect(Number(waited)).toBeGreaterThanOrEqual(150);
  });

  it("gives a route fallback one entrance rather than one for each layer", async () => {
    const css = await theme();
    const rule = ruleFor(
      css,
      '[data-slot="route-loading"]\n    [data-slot="page-state"]',
    );

    expect(rule).toContain("animation: none");
  });

  it("staggers the bars by a token, and by a negative one", async () => {
    const css = await theme();
    const second = ruleFor(css, ':nth-child(2) {');
    const third = ruleFor(css, ':nth-child(3) {');

    expect(second).toContain("calc(var(--duration-hover) * -1)");
    expect(third).toContain("calc(var(--duration-hover) * -2)");
  });

  /**
   * The breath stops and the bar stays. The entrance deliberately has no rule
   * of its own here: it is already opacity and nothing else, and `globals.css`
   * caps every animation at one frame under this query while leaving
   * `animation-delay` alone — so the wait survives and only the fade goes.
   */
  it("stops the breath under reduced motion and leaves the bar", async () => {
    const css = await theme();
    const from = css.indexOf('[data-slot="skeleton"] {');
    const reduced = css.slice(from, css.indexOf('[data-slot="popover-content"]', from));

    expect(reduced).toContain("@media (prefers-reduced-motion: reduce)");
    expect(reduced.slice(reduced.indexOf("prefers-reduced-motion"))).toContain(
      "animation: none",
    );
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The route boundary, which is the half of this a person actually meets.
 *
 * A press on a navigation item used to hold the previous page on screen with
 * nothing said until the next one was ready. The fallback answers the press
 * instead: the shell never moves, the destination is named in the page's own
 * words **and the page's own header shape**, and the whole composition arrives
 * as one thing.
 */
describe("what the router draws while a page is still coming", () => {
  it("keeps the frame, names where the press landed, and shows the one indicator", async () => {
    apiAnswers({ "/api/me": { status: 200, body: meWith("admin") } });
    render(
      <ProductShellBoundary>
        <AgentsLoading />
      </ProductShellBoundary>,
    );

    // The shell is the root layout's, so the fallback must not draw a second
    // one: one navigation, one account control, one session read.
    expect(await screen.findAllByText("ada@acme.example")).toHaveLength(1);
    expect(
      screen.getAllByRole("navigation", { name: "Product navigation" }),
    ).toHaveLength(1);

    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    const said = screen.getByRole("status");
    expect(said.textContent).toBe("Loading agents…");
    expect(said.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);
  });

  /**
   * One appearance, so there is one element for the theme to fade. Without it
   * the header would paint at once and the card 180ms later, which is a
   * sub-second navigation showing a title above a tall empty gap.
   */
  it("wraps the whole composition, header included, in one arrival", async () => {
    apiAnswers({ "/api/me": { status: 200, body: meWith("admin") } });
    const { container } = render(
      <ProductShellBoundary>
        <AgentsLoading />
      </ProductShellBoundary>,
    );
    await screen.findAllByText("ada@acme.example");

    const arrival = container.querySelector('[data-slot="route-loading"]');
    expect(arrival).toBeTruthy();
    expect(arrival?.querySelector("h1")?.textContent).toBe("Agents");
    expect(arrival?.querySelector('[data-slot="loading-indicator"]')).toBeTruthy();
  });

  /**
   * The header a fallback draws has to be the *shape* the page draws, not only
   * the same words. `shell.tsx` hides the eyebrow whenever breadcrumbs are
   * given, so a fallback with an eyebrow standing in for a page with crumbs
   * swaps one line for another of a different height on arrival.
   */
  it("draws the page's own breadcrumbs, into this project, rather than an eyebrow", async () => {
    apiAnswers({ "/api/me": { status: 200, body: meWith("admin") } });
    render(
      <ProductShellBoundary>
        <TestLoading />
      </ProductShellBoundary>,
    );
    await screen.findAllByText("ada@acme.example");

    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Tests" }).getAttribute("href")).toBe(
      "/projects/prj_1/tests",
    );
    /*
     * The current page is the last step of the trail, and that step is the
     * `<h1>`: one line, one type, one name. The fallback and the page it
     * stands in for draw the same line, which is the shape this case is about.
     */
    expect(within(crumbs).getByRole("heading", { name: "Test" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Loading this test…");
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

  it("keeps a draft on the page until the discard action is explicit", async () => {
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
      within(screen.getByRole("menu")).getByText("Outbound"),
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

  it("keeps organization and project as two clear sidebar controls", () => {
    render(
      <AppShell initialMe={meWith("admin")}>
        <p>page</p>
      </AppShell>,
    );

    const sidebar = screen.getByRole("complementary");
    const organization = within(sidebar).getByRole("button", {
      name: "Open organization menu for Acme",
    });
    const organizationBar = organization.closest('[data-slot="sidebar-brand"]');
    const mark = organizationBar?.querySelector("img");
    expect(mark?.getAttribute("src")).toBe(
      "/brand/egma-mark-light.svg",
    );
    expect(mark?.getAttribute("width")).toBe("32");
    expect(mark?.getAttribute("height")).toBe("32");
    expect(organization.querySelector("img")).toBeNull();
    expect(organization.textContent).toContain("Acme");
    /* The bar says the organization, and no plan chip beside it. */
    expect(organization.textContent).not.toContain("Free");
    expect(
      organization.querySelector('[data-slot="organization-name"]')?.className,
    ).toContain("text-sm");
    expect(organization.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );

    const project = within(sidebar).getByRole("button", {
      name: /^Organization Acme, project Default/u,
    });
    expect(project.textContent).toContain("Project");
    expect(project.textContent).toContain("Default");
    expect(project.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(organization);
    const summary = within(
      screen.getByRole("dialog", { name: "Open organization menu for Acme" }),
    );
    /*
     * The panel is the mark, the grey word `Organization` and the name that
     * word names. The plan was hard-written copy for a fact `/api/me` does not
     * carry, and the role is already said by the account control at the foot of
     * this same sidebar.
     */
    const eyebrow = summary.getByText("Organization");
    const organizationName = summary.getByText("Acme");
    /* Directly above the name, the way `Project` sits above the project's. */
    expect(eyebrow.nextElementSibling).toBe(organizationName);
    /* The `Project` label's own recipe: 12px, faint, and left in sentence case. */
    expect(eyebrow.className).toContain("text-2xs");
    expect(eyebrow.className).toContain("text-faint");
    expect(eyebrow.className).not.toContain("uppercase");
    expect(summary.queryByText("Free Plan")).toBeNull();
    expect(summary.queryByText("Admin")).toBeNull();
    expect(summary.queryByText("Organization settings")).toBeNull();
  });

  it.each(["admin", "member", "viewer"] as const)(
    "keeps the bottom account avatar square for a %s",
    (role) => {
      render(
        <AppShell initialMe={meWith(role)}>
          <p>page</p>
        </AppShell>,
      );

      const account = within(screen.getByRole("complementary")).getByRole(
        "button",
        { name: /^Account /u },
      );
      const avatar = account.querySelector('[data-slot="account-avatar"]');
      expect(avatar?.classList.contains("rounded-none")).toBe(true);
      expect(avatar?.classList.contains("rounded-full")).toBe(false);
    },
  );

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
    const settings = screen.getByRole("menuitem", { name: "Settings" });
    expect(settings.getAttribute("href")).toBe("/projects/prj_1/settings");
    fireEvent.click(settings);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("sends projectless Settings to People in the first available project", () => {
    routed.pathname = "/new-project";
    routed.projectId = undefined;
    render(
      <AppShell initialMe={meWith("admin")}>
        <p>page</p>
      </AppShell>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /^Account / })[0]!);
    expect(screen.getByRole("menuitem", { name: "Settings" }).getAttribute("href")).toBe(
      "/projects/prj_1/settings/people",
    );
  });

  it("sends projectless Settings to project creation when none exists", () => {
    routed.pathname = "/new-project";
    routed.projectId = undefined;
    render(
      <AppShell initialMe={{ ...meWith("admin"), projects: [] }}>
        <p>page</p>
      </AppShell>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /^Account / })[0]!);
    expect(screen.getByRole("menuitem", { name: "Settings" }).getAttribute("href")).toBe(
      "/new-project",
    );
  });

  /**
   * A cold load of a product address: a bookmark opened, or reload pressed.
   *
   * The frame mounts with nobody in it, and what used to stand in the two slots
   * that had no value yet was the sentence "Checking your session…" — the
   * application's own news, said twice, by two controls that cannot act on it.
   * The cover says it once now, and each slot draws the shape of the value it
   * is waiting for.
   */
  it("claims nothing at all while the session read is in flight", async () => {
    apiAnswers({ "/api/me": "never", "/v1/agents": "never" });
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    expect(await screen.findByText("page")).toBeDefined();
    expect(screen.queryByText(/view only/i)).toBeNull();
    expect(screen.queryAllByText(/Checking your session/)).toHaveLength(0);

    // One cover, and nothing behind it left in reach of a Tab step.
    const covering = screen.getByRole("status");
    expect(covering.dataset.slot).toBe("session-loading");
    expect(covering.getAttribute("aria-busy")).toBe("true");
    expect(
      [...document.body.children]
        .filter((one) => !one.contains(covering))
        .filter((one) => !one.hasAttribute("inert")),
    ).toEqual([]);

    fireEvent.click(screen.getAllByRole("button", { name: /^Account / })[0]!);
    const settings = screen.getByRole("menuitem", { name: "Settings" });
    expect(settings.tagName).toBe("BUTTON");
    expect(settings.hasAttribute("disabled")).toBe(true);
    expect(settings.getAttribute("href")).toBeNull();
  });

  it("never shows an admin a View only badge, before or after the answer", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/agents": "never",
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
      "/v1/agents": "never",
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
    // not Runs, not Traces, and no href under /projects at all.
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
      "/v1/agents": "never",
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
   * says `Traces`, and the Simulations group's says `Runs`. Both addresses
   * are the ones they always were.
   */
  it("puts Traces in the sidebar, opening this project's transcript list", async () => {
    routed.pathname = "/projects/prj_2/agents";
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/agents": "never",
    });
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    expect(await screen.findByText("page")).toBeDefined();

    const transcripts = screen.getAllByRole("link", { name: "Traces" })[0];
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
      "/v1/agents": "never",
    });
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    expect(await screen.findAllByText("Session unavailable")).not.toHaveLength(0);
    expect(screen.queryByText(/view only/i)).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: /^Account / })[0]!);
    const settings = screen.getByRole("menuitem", { name: "Settings" });
    expect(settings.tagName).toBe("BUTTON");
    expect(settings.hasAttribute("disabled")).toBe(true);
    expect(settings.getAttribute("href")).toBeNull();
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
    projectId: "prj_1",
    name: "Front desk",
    // Every field the contract makes required is here, `agentPlatform`
    // included: the row reads it to say which platform an agent is on, and a
    // fixture that left it out would be a shape the API cannot answer with.
    agentPlatform: "retell",
    // The list read carries every agent's connections, so a row in this
    // fixture carries the field. An agent with none is one of the states the
    // page draws, and it is drawn from an empty list rather than a missing one.
    connections: [],
    createdAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
  };

  it("names its project in the request, every time", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/agents": {
        status: 200,
        body: { agents: [AGENT], nextPageToken: null },
      },
    });
    render(<AgentsPage />);

    // Once, because the table changes layout without cloning the row.
    expect(await screen.findAllByText("Front desk")).toHaveLength(1);
    const asked = await Promise.all(
      vi.mocked(globalThis.fetch).mock.calls.map(([input, init]) =>
        observeRequest(input as FetchInput, init),
      ),
    );
    expect(asked.map(({ address }) => `${address.pathname}${address.search}`)).toContain(
      "/v1/agents?projectId=prj_1",
    );
  });

  it("shows an empty project as empty, not as a failure", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/agents": {
        status: 200,
        body: { agents: [], nextPageToken: null },
      },
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
      "/v1/agents": {
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
    for (const control of screen.getAllByRole("button", { name: "Connect an agent" })) {
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
      "/v1/agents": [
        {
          status: 200,
          body: { agents: [AGENT], nextPageToken: "agt_1" },
        },
        {
          status: 503,
          body: { error: "unavailable", message: "Egma could not reach the agents store." },
        },
        {
          status: 200,
          body: {
            agents: [{ ...AGENT, id: "agt_2", name: "Outbound reminders" }],
            nextPageToken: null,
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
        agents: [
          {
            ...AGENT,
            projectId: String(project),
            id: `agt_${String(project)}`,
            name: project === "prj_1" ? "Front desk" : "Night line",
          },
        ],
        nextPageToken: "agt_cursor",
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: RequestInit) => {
        const { address: at } = await observeRequest(input, init);
        if (at.pathname === "/api/me") return json(200, meWith("admin"));
        if (at.searchParams.has("pageToken")) return pending;
        return firstPageOf(at.searchParams.get("projectId"));
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
        agents: [{ ...AGENT, id: "agt_stale", name: "Somebody else's project" }],
        nextPageToken: null,
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
      "/v1/agents": {
        status: 200,
        body: { agents: [AGENT], nextPageToken: null },
      },
    });
    const { unmount } = render(<AgentsPage />);
    expect(await screen.findByRole("link", { name: "Connect an agent" })).toBeDefined();
    unmount();

    apiAnswers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/v1/agents": {
        status: 200,
        body: { agents: [AGENT], nextPageToken: null },
      },
    });
    render(<AgentsPage />);

    const refused = await screen.findByRole("button", { name: "Connect an agent" });
    expect((refused as HTMLButtonElement).disabled).toBe(true);
    expect(refused.getAttribute("title")).toContain("viewer role cannot");
    expect(screen.queryByRole("link", { name: "Connect an agent" })).toBeNull();
  });
});
