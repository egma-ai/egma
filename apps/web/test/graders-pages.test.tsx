// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GraderLibraryPage from "../app/projects/[projectId]/graders/page.tsx";
import RunningGradersPage from "../app/projects/[projectId]/graders/running/page.tsx";
import * as libraryCopy from "../lib/grader-library-copy.ts";
import * as runningCopy from "../lib/grader-running-copy.ts";
import type { LibraryEntry, RunningGrader } from "../lib/graders.ts";
import type { Me } from "../lib/me.ts";
import { graderTabsFor } from "../lib/presentation.ts";

/**
 * The two grader screens of one project, rendered and driven the way somebody
 * with a keyboard drives them.
 *
 * They replace two source-reading tests that held `main`'s organization-wide
 * pages to rendering their copy file. Those pages are gone, and so is that kind
 * of proof: nothing here asserts that a component exists or that a source file
 * contains a string. Every test puts the API's real answers in front of a real
 * component and reads what the DOM then says.
 *
 * **The claim these files exist to defend is the one the old pair could not
 * make: the project in the address is the project acted on.** The pages that
 * came in from `main` carried no project at all — they read the shelf without
 * one and posted Use without one — so on this shell the API resolved a project
 * for itself and a person with three projects switched a grader on in whichever
 * came first, with nothing on screen saying so. So the first thing asked of
 * every read and every write here is which project it named.
 *
 * The vocabulary check the deleted pair carried survives, at the bottom, over
 * the copy modules both screens render from. It is the one assertion worth
 * keeping about a source file: a word that should never be typed fails the
 * build rather than shipping in a heading.
 */

const routed = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/projects/prj_1/graders",
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

function meWith(role: string): Me {
  return {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [{ id: "org_1", name: "Acme", slug: "acme", role }],
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

/** Whatever egma is standing in for, keyed by method and path. */
function apiAnswers(answers: Record<string, Stubbed | readonly Stubbed[]>): {
  readonly asked: { method: string; path: string; body: unknown }[];
} {
  const seen: Record<string, number> = {};
  const asked: { method: string; path: string; body: unknown }[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const at = new URL(String(input), "http://egma.test");
      const method = init?.method ?? "GET";
      const key = `${method} ${at.pathname}`;
      asked.push({
        method,
        path: `${at.pathname}${at.search}`,
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as unknown)
            : undefined,
      });

      const held = answers[key];
      if (held === undefined) throw new Error(`nothing stubbed for ${key}`);

      const turn = seen[key] ?? 0;
      seen[key] = turn + 1;
      const answer = Array.isArray(held)
        ? ((held[Math.min(turn, held.length - 1)] ?? "never") as Stubbed)
        : (held as Stubbed);

      if (answer === "never") return new Promise<Response>(() => undefined);
      return json(answer.status, answer.body);
    }),
  );

  return { asked };
}

/** egma's own expected-behaviors entry: its Use form asks for nothing at all. */
const BEHAVIORS: LibraryEntry = {
  id: "grl_behaviors",
  name: "expected_behaviors",
  description: "Judges a simulation against its test's expected behaviors.",
  type: "llm_as_judge",
  owner: "egma",
  params: [],
};

/** egma's latency entry: a measure from the catalog, and a bound. */
const LATENCY: LibraryEntry = {
  id: "grl_latency",
  name: "latency",
  description: "Fails when a measured latency is over the bound.",
  type: "code",
  owner: "egma",
  params: [
    {
      name: "metric",
      label: "Measure",
      kind: "choice",
      means: "Which measure to hold to a bound.",
      options: [
        {
          value: "turn_response_latency",
          label: "Response latency",
          means: "How long the agent took to answer.",
          unit: "ms",
        },
        {
          value: "turn_count",
          label: "Turns",
          means: "How many turns it took.",
          unit: "turns",
        },
      ],
    },
    {
      name: "bound",
      label: "Bound",
      kind: "number",
      means: "The most this measure may be.",
    },
  ],
};

const SEEDED: RunningGrader = {
  id: "grd_1",
  library_id: "grl_behaviors",
  name: "expected_behaviors",
  description: null,
  type: "llm_as_judge",
  required: true,
  scope: "simulations",
  production_sample_rate: 0,
  config: { assertions: [] },
  // On the compatibility path, which is what every copy authored before the
  // model catalog existed reads as — a state rather than a fault.
  model: null,
  created_at: "2026-08-15T10:00:00.000Z",
  updated_at: "2026-08-15T10:00:00.000Z",
};

const DIAGNOSTIC: RunningGrader = {
  ...SEEDED,
  id: "grd_2",
  library_id: "grl_latency",
  name: "latency",
  type: "code",
  required: false,
  scope: "both",
  production_sample_rate: 10,
  config: { assertions: [{ metric: "turn_response_latency", bound: 2000 }] },
};

beforeEach(() => {
  routed.push.mockReset();
  routed.pathname = "/projects/prj_1/graders";
  routed.projectId = "prj_1";
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------------ */

describe("the grader library, in one project", () => {
  it("names its project in the read, and says what each entry is and whose", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/grader-library": {
        status: 200,
        body: { items: [BEHAVIORS, LATENCY], next_cursor: null },
      },
    });
    render(<GraderLibraryPage />);

    // Once, because the table changes layout without cloning the row.
    expect(await screen.findAllByText("Expected behaviors")).toHaveLength(1);
    expect(asked.map((one) => one.path)).toContain(
      "/api/grader-library?project=prj_1",
    );

    // The stored words turned into the ones a person reads, and never shown raw.
    expect(screen.getAllByText("Model judged")).not.toHaveLength(0);
    expect(screen.getAllByText("Computed")).not.toHaveLength(0);
    expect(screen.queryByText("llm_as_judge")).toBeNull();
    expect(screen.queryByText("expected_behaviors")).toBeNull();

    // The owner word is the approved identity, and the stored key is never what
    // a person is shown. `grader-library.test.ts` held this against the copy
    // module and was deleted with the organization-wide pages it read; the
    // claim is stronger here, because a rendering is what a person meets.
    expect(screen.getAllByText("Egma")).not.toHaveLength(0);
    expect(screen.queryByText("egma")).toBeNull();
  });

  /**
   * The whole reason these screens moved under the project. Pressing Use on a
   * page with no project in its address posted a body with no project in it,
   * and the copy landed wherever the API resolved — which for a person with
   * three projects is whichever came first in their list.
   */
  it("puts the running copy on the project in the address", async () => {
    routed.projectId = "prj_2";
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/grader-library": {
        status: 200,
        body: { items: [BEHAVIORS], next_cursor: null },
      },
      "POST /api/graders": { status: 201, body: SEEDED },
    });
    render(<GraderLibraryPage />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Use" }))[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Start judging" }));

    expect(
      (await screen.findByRole("status")).textContent,
    ).toContain("Expected behaviors is running on this project now");
    // **In the address, which is what this case is named for.** It used to
    // assert the project in the *body* under exactly this name — the page said
    // one thing and its test agreed with the other, which is how a spelling
    // nobody meant survives a review.
    const written = asked.find((one) => one.method === "POST");
    expect(written?.path).toBe("/api/graders?project=prj_2");
    expect(written?.body).toEqual({
      library_id: "grl_behaviors",
      required: true,
    });
  });

  /**
   * The form is the entry's own declaration rendered, so an entry that asks
   * nothing draws no controls and an entry that asks for a measure draws the
   * measures egma actually computes — never a list typed into this page.
   */
  it("draws the form from the entry, and sends a number as a number", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "GET /api/grader-library": {
        status: 200,
        body: { items: [BEHAVIORS, LATENCY], next_cursor: null },
      },
      "POST /api/graders": { status: 201, body: DIAGNOSTIC },
    });
    render(<GraderLibraryPage />);

    const pressed = await screen.findAllByRole("button", { name: "Use" });
    // The table's row for Latency is the second of the two entries.
    fireEvent.click(pressed[1]!);

    fireEvent.change(screen.getByLabelText("Bound"), {
      target: { value: "2000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start judging" }));

    await screen.findByRole("status");
    expect(asked.find((one) => one.method === "POST")?.path).toBe(
      "/api/graders?project=prj_1",
    );
    expect(asked.find((one) => one.method === "POST")?.body).toEqual({
      library_id: "grl_latency",
      required: true,
      params: { metric: "turn_response_latency", bound: 2000 },
    });
  });

  it("asks nothing for an entry that declares no parameters", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "GET /api/grader-library": {
        status: 200,
        body: { items: [BEHAVIORS], next_cursor: null },
      },
    });
    render(<GraderLibraryPage />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Use" }))[0]!);
    expect(screen.getByText(libraryCopy.USE.asksNothing)).toBeTruthy();
    expect(screen.queryByLabelText("Bound")).toBeNull();
  });

  /**
   * The refusal's own sentence, kept and never paraphrased — and the form still
   * holding what was typed into it, so a second attempt is one keystroke rather
   * than an afternoon.
   */
  it("shows a refused Use without clearing the form", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "GET /api/grader-library": {
        status: 200,
        body: { items: [LATENCY], next_cursor: null },
      },
      "POST /api/graders": {
        status: 422,
        body: {
          error: "unprocessable",
          message: "Egma does not compute a measure called that.",
        },
      },
    });
    render(<GraderLibraryPage />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Use" }))[0]!);
    fireEvent.change(screen.getByLabelText("Bound"), {
      target: { value: "2000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start judging" }));

    expect(
      await screen.findByText("Egma does not compute a measure called that."),
    ).toBeTruthy();
    expect((screen.getByLabelText("Bound") as HTMLInputElement).value).toBe(
      "2000",
    );
  });

  /**
   * A viewer sees the act and is told plainly that it is not theirs. The server
   * refuses their write either way, which is where the boundary actually is;
   * this is the courtesy, and it is never the lock.
   */
  it("leaves Use inert for a viewer, with the reason beside it", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("viewer") },
      "GET /api/grader-library": {
        status: 200,
        body: { items: [BEHAVIORS], next_cursor: null },
      },
    });
    render(<GraderLibraryPage />);

    const used = (await screen.findAllByRole("button", { name: "Use" }))[0]!;
    expect((used as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(libraryCopy.USE.notYours("viewer"))).not.toHaveLength(
      0,
    );
  });

  it("says a project that is not available here is not available", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/grader-library": {
        status: 404,
        body: {
          error: "not_found",
          message: "There is no project prj_1 available.",
        },
      },
    });
    render(<GraderLibraryPage />);

    expect(await screen.findByText("Not available here")).toBeTruthy();
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The shelf, as the running screen reads it: what each copy's entry asks for.
 *
 * Every case on that screen stubs it, because the page holds the copies and
 * their entries as one state — a page with the copies and not yet the shelf
 * would draw an edit form with no controls in it, which reads as a grader that
 * asks nothing rather than as a page still loading.
 */
const SHELF = {
  status: 200,
  body: { items: [BEHAVIORS, LATENCY], next_cursor: null },
} as const;

describe("the running graders of one project", () => {
  it("names its project in both reads, and says where each copy applies and whether it blocks", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED, DIAGNOSTIC], next_cursor: null },
      },
      "GET /api/grader-library": SHELF,
    });
    render(<RunningGradersPage />);

    expect(await screen.findAllByText("Expected behaviors")).toHaveLength(1);
    expect(asked.map((one) => one.path)).toContain("/api/graders?project=prj_1");
    // The shelf beside the copies, and in the same project: a copy's form is
    // its entry's declaration rendered, and this page cannot draw one without
    // having read the entry.
    expect(asked.map((one) => one.path)).toContain(
      "/api/grader-library?project=prj_1",
    );

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(
      within(breadcrumb)
        .getByRole("link", { name: "Graders" })
        .getAttribute("href"),
    ).toBe("/projects/prj_1/graders");
    expect(within(breadcrumb).getByText("Running").getAttribute("aria-current"))
      .toBe("page");

    // What `required` decides, rather than the flag's own value.
    expect(screen.getAllByText("Blocks")).not.toHaveLength(0);
    expect(screen.getAllByText("Diagnostic")).not.toHaveLength(0);
    // A copy with nothing to fill in is complete, and says what it judges.
    expect(screen.getAllByText(runningCopy.CONFIG.fromTheTest)).not.toHaveLength(
      0,
    );
    // Live traffic is sampled, and the share is the number that decides the bill.
    expect(screen.getAllByText(/10%/)).not.toHaveLength(0);
  });

  /**
   * Switching a copy off is deleting the row that was judging, because there is
   * no enable flag and no scope meaning nowhere — so it is one of the two acts
   * on this screen, and it names the project it is taken in.
   */
  it("switches a copy off, in the project in the address, and reads the list again", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": [
        { status: 200, body: { items: [SEEDED, DIAGNOSTIC], next_cursor: null } },
        { status: 200, body: { items: [SEEDED], next_cursor: null } },
      ],
      "GET /api/grader-library": SHELF,
      "DELETE /api/graders/grd_2": {
        status: 200,
        body: {
          id: "grd_2",
          name: "latency",
          deleted_at: "2026-08-15T12:00:00.000Z",
        },
      },
    });
    render(<RunningGradersPage />);

    const off = await screen.findAllByRole("button", { name: "Switch off" });
    // The table's rows are in answer order, so Latency's is the second.
    fireEvent.click(off[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Switch it off" }));

    expect((await screen.findByRole("status")).textContent).toContain(
      "Latency is switched off",
    );
    expect(asked.map((one) => one.path)).toContain(
      "/api/graders/grd_2?project=prj_1",
    );
    // Read again rather than edited here: what judges this project is the
    // server's answer, and there are two reads of the list for one switch-off.
    expect(
      asked.filter((one) => one.path === "/api/graders?project=prj_1"),
    ).toHaveLength(2);
  });

  /**
   * **What stays is the sentence that makes the button pressable**, and it is
   * shown before the act rather than after it. A team whose grader is failing
   * every run must not be asked to trade away the runs they have already read
   * in order to stop it.
   */
  it("says what stops and, in its own sentence, what stays", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED, DIAGNOSTIC], next_cursor: null },
      },
      "GET /api/grader-library": SHELF,
    });
    render(<RunningGradersPage />);

    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Switch off" }))[0]!,
    );

    expect(screen.getByText(runningCopy.SWITCH_OFF.stops)).toBeTruthy();
    expect(screen.getByText(runningCopy.SWITCH_OFF.keeps)).toBeTruthy();
    expect(screen.getByText(runningCopy.SWITCH_OFF.again)).toBeTruthy();
    // Not the last one, so the sentence about a project judged by nothing is
    // not said — it is a warning about what this press would do, not a fact
    // about switching graders off in general.
    expect(screen.queryByText(runningCopy.SWITCH_OFF.theLastOne)).toBeNull();
  });

  /**
   * A project may end up judged by nothing — the run door allows it — so
   * switching the last copy off is warned about and never refused.
   */
  it("warns before the last copy goes, and does not refuse it", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": [
        { status: 200, body: { items: [SEEDED], next_cursor: null } },
        { status: 200, body: { items: [], next_cursor: null } },
      ],
      "GET /api/grader-library": SHELF,
      "DELETE /api/graders/grd_1": {
        status: 200,
        body: {
          id: "grd_1",
          name: "Expected behaviors",
          deleted_at: "2026-08-15T12:00:00.000Z",
        },
      },
    });
    render(<RunningGradersPage />);

    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Switch off" }))[0]!,
    );
    expect(screen.getByText(runningCopy.SWITCH_OFF.theLastOne)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Switch it off" }));

    // Gone, and the page says what that means rather than pretending a project
    // with no graders is a project that has not finished setting up.
    expect(
      await screen.findByText("Nothing is judging this project"),
    ).toBeTruthy();
    expect(screen.getByText(runningCopy.RUNNING.empty)).toBeTruthy();
  });

  it("keeps the confirmation open and shows a refused switch-off", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED], next_cursor: null },
      },
      "GET /api/grader-library": SHELF,
      "DELETE /api/graders/grd_1": {
        status: 403,
        body: {
          error: "not_permitted",
          message: "Your viewer role cannot author definitions.",
        },
      },
    });
    render(<RunningGradersPage />);

    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Switch off" }))[0]!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch it off" }));

    expect(
      await screen.findByText("Your viewer role cannot author definitions."),
    ).toBeTruthy();
    // Still there to try again, and the row is still in the list.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getAllByText("Expected behaviors")).not.toHaveLength(0);
  });

  it("leaves both acts inert for a viewer, with the reason beside them", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("viewer") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED], next_cursor: null },
      },
      "GET /api/grader-library": SHELF,
    });
    render(<RunningGradersPage />);

    const off = (await screen.findAllByRole("button", {
      name: "Switch off",
    }))[0]!;
    const edit = screen.getAllByRole("button", { name: "Edit" })[0]!;

    expect((off as HTMLButtonElement).disabled).toBe(true);
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getAllByText(runningCopy.SWITCH_OFF.notYours("viewer")),
    ).not.toHaveLength(0);
    expect(
      screen.getAllByText(runningCopy.EDIT.notYours("viewer")),
    ).not.toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */

/**
 * Editing a running copy: the act that stops pressing **Use** being a one-way
 * door.
 *
 * A developer who pressed Use on latency and typed a bound too tight used to
 * live with it — every run red for ever, and the only way out a hand-written
 * update against Postgres.
 */
describe("changing a running copy", () => {
  it("connects each Edit button to the editor and moves focus to its heading", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED, DIAGNOSTIC], next_cursor: null },
      },
      "GET /api/grader-library": SHELF,
    });
    render(<RunningGradersPage />);

    const edits = await screen.findAllByRole("button", { name: "Edit" });
    expect(edits[1]!.getAttribute("aria-expanded")).toBe("false");
    expect(edits[1]!.getAttribute("aria-controls")).toBe(
      "grader-editor-grd_2",
    );

    fireEvent.click(edits[1]!);

    const editor = screen.getByRole("region", { name: "Edit Latency" });
    const heading = within(editor).getByRole("heading", {
      name: "Edit Latency",
    });
    expect(editor.id).toBe("grader-editor-grd_2");
    expect(edits[1]!.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(heading);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(edits[1]);
    expect(edits[1]!.getAttribute("aria-expanded")).toBe("false");
  });

  /**
   * **The edit form is the Use form's controls, filled in with what this copy
   * holds.** What a grader asks for is the library entry's own declaration, and
   * both forms render that one list through one component — so a bound opens
   * showing the bound this copy judges by, and a measure opens on the measure
   * it chose, rather than on the first option of a fresh form.
   */
  it("opens on what this copy holds, from its entry's own declaration", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED, DIAGNOSTIC], next_cursor: null },
      },
      "GET /api/grader-library": SHELF,
    });
    render(<RunningGradersPage />);

    // Latency's row is the second, and it is the one with values to fill in.
    fireEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[1]!);

    expect((screen.getByLabelText("Bound") as HTMLInputElement).value).toBe(
      "2000",
    );
    expect((screen.getByLabelText("Measure") as HTMLSelectElement).value).toBe(
      "turn_response_latency",
    );
    // The live settings, which only a copy that already exists can have.
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Latency",
    );
    expect(
      (screen.getByLabelText("Can fail a run") as HTMLInputElement).checked,
    ).toBe(false);
  });

  /**
   * **Opening a second copy's form over the first draws the second copy**, and
   * the key is what makes that true.
   *
   * React keeps a component's state across a re-render when only its props
   * change, so a form opened on one grader and then pointed at another would
   * hold the first grader's answers under the second grader's controls. It is
   * the failure the Use form has a real-browser walk for, one screen along —
   * and here it is worse, because these forms open already filled in: the
   * second copy's bound would read as the first copy's, and saving would write
   * a number nobody typed.
   */
  it("draws the second copy's own values when a form is opened over another", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED, DIAGNOSTIC], next_cursor: null },
      },
      "GET /api/grader-library": SHELF,
    });
    render(<RunningGradersPage />);

    // The copy whose assertions are each test's own sentences: it asks nothing.
    fireEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[0]!);
    expect(screen.getByText(runningCopy.EDIT.asksNothing)).toBeTruthy();

    // And now the other one, without closing the first.
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]!);

    expect(screen.getByText(runningCopy.EDIT.title("Latency"))).toBeTruthy();
    expect(screen.queryByText(runningCopy.EDIT.asksNothing)).toBeNull();
    // Its own filled-in values, not an empty form and not the first copy's.
    expect((screen.getByLabelText("Bound") as HTMLInputElement).value).toBe(
      "2000",
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Latency",
    );
  });

  it("keeps a changed copy when another Edit or Cancel is declined", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED, DIAGNOSTIC], next_cursor: null },
      },
      "GET /api/grader-library": SHELF,
    });
    render(<RunningGradersPage />);

    const edits = await screen.findAllByRole("button", { name: "Edit" });
    fireEvent.click(edits[0]!);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Draft behavior grader" },
    });

    fireEvent.click(edits[1]!);
    expect(screen.getByRole("dialog").textContent).toContain(
      "Leave without saving?",
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("region", {
      name: "Edit Expected behaviors",
    })).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Draft behavior grader",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Draft behavior grader",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("region", {
      name: "Edit Expected behaviors",
    })).toBeNull();
  });

  it("protects a changed copy from grader links, product links, project changes, and unload", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED, DIAGNOSTIC], next_cursor: null },
      },
      "GET /api/grader-library": SHELF,
    });
    render(<RunningGradersPage />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[0]!);
    fireEvent.change(screen.getByLabelText(runningCopy.EDIT.description), {
      target: { value: "Keep this draft" },
    });

    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);

    const graderViews = screen.getByRole("navigation", {
      name: "Grader views",
    });
    const library = within(graderViews).getByRole("link", { name: "Library" });
    const tabClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    fireEvent(library, tabClick);
    expect(tabClick.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    const product = screen.getByRole("navigation", {
      name: "Product navigation",
    });
    const agents = within(product).getByRole("link", { name: "Agents" });
    const productClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    fireEvent(agents, productClick);
    expect(productClick.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    const selectors = await screen.findAllByRole("button", {
      name: /^Organization Acme, project Default\./,
    });
    fireEvent.click(selectors[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Outbound" }));
    expect(routed.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").textContent).toContain(
      "Leave without saving?",
    );
    expect(
      (screen.getByLabelText(
        runningCopy.EDIT.description,
      ) as HTMLInputElement).value,
    ).toBe("Keep this draft");
  });

  it("keeps the editor and its navigation guard in place while Save is in flight", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED, DIAGNOSTIC], next_cursor: null },
      },
      "GET /api/grader-library": SHELF,
      "PATCH /api/graders/grd_1": "never",
    });
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    render(<RunningGradersPage />);

    const edits = await screen.findAllByRole("button", { name: "Edit" });
    fireEvent.click(edits[0]!);
    fireEvent.change(screen.getByLabelText(runningCopy.EDIT.description), {
      target: { value: "Saving this note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByRole("button", { name: runningCopy.EDIT.submitting }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Name").matches(":disabled")).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(edits.every((edit) => (edit as HTMLButtonElement).disabled)).toBe(
      true,
    );

    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);

    const graderViews = screen.getByRole("navigation", {
      name: "Grader views",
    });
    const library = within(graderViews).getByRole("link", { name: "Library" });
    const linkClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    library.dispatchEvent(linkClick);
    expect(linkClick.defaultPrevented).toBe(true);

    const selectors = await screen.findAllByRole("button", {
      name: /^Organization Acme, project Default\./,
    });
    fireEvent.click(selectors[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Outbound" }));
    expect(routed.push).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("region", {
      name: "Edit Expected behaviors",
    })).toBeTruthy();
  });

  /**
   * **A number is sent as a number**, at the edge that knows the control was
   * numeric — and the project rides in the body, because an edit lands on
   * exactly one project and never on whichever the credential happens to act in.
   */
  it("sends one body carrying both kinds of change, in the project in the address", async () => {
    routed.projectId = "prj_2";
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": [
        { status: 200, body: { items: [DIAGNOSTIC], next_cursor: null } },
        { status: 200, body: { items: [DIAGNOSTIC], next_cursor: null } },
      ],
      "GET /api/grader-library": SHELF,
      "PATCH /api/graders/grd_2": {
        status: 200,
        body: { ...DIAGNOSTIC, config: { assertions: [{ bound: 1200 }] } },
      },
    });
    render(<RunningGradersPage />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[0]!);
    fireEvent.change(screen.getByLabelText("Bound"), {
      target: { value: "1200" },
    });
    fireEvent.click(screen.getByLabelText("Can fail a run"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("status");
    const written = asked.find((one) => one.method === "PATCH");
    expect(written?.path).toBe("/api/graders/grd_2?project=prj_2");
    expect(written?.body).toEqual({
      name: "latency",
      // Null rather than the empty string: emptying a note is a real intent and
      // the platform reads null as exactly that.
      description: null,
      scope: "both",
      required: true,
      production_sample_rate: 10,
      params: { metric: "turn_response_latency", bound: 1200 },
    });
  });

  /**
   * **The claim after a save is the narrow one.** "What has already been judged
   * is unchanged" is true of the verdict rows and false of the runs they add up
   * to — and it would be shown at the exact moment somebody had turned
   * `required` off, which is when it is most wrong.
   */
  it("claims only that no verdict was rewritten, and reads the list again", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": [
        { status: 200, body: { items: [SEEDED], next_cursor: null } },
        { status: 200, body: { items: [SEEDED], next_cursor: null } },
      ],
      "GET /api/grader-library": SHELF,
      "PATCH /api/graders/grd_1": { status: 200, body: SEEDED },
    });
    render(<RunningGradersPage />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[0]!);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Expected behaviors",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const said = (await screen.findByRole("status")).textContent ?? "";
    expect(said).toContain("no verdict it has already written was rewritten");
    expect(said.toLowerCase()).not.toContain("nothing already judged");
    expect(
      asked.filter((one) => one.path === "/api/graders?project=prj_1"),
    ).toHaveLength(2);
    expect(asked.find((one) => one.method === "PATCH")?.body).toMatchObject({
      name: "expected_behaviors",
    });
  });

  /**
   * An entry that asks nothing draws no controls, and says so rather than
   * showing an empty form somebody would read as a page that failed to load.
   */
  it("asks nothing of a copy whose assertions are the test's own sentences", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED], next_cursor: null },
      },
      "GET /api/grader-library": SHELF,
    });
    render(<RunningGradersPage />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[0]!);

    expect(screen.getByText(runningCopy.EDIT.asksNothing)).toBeTruthy();
    expect(screen.queryByLabelText("Bound")).toBeNull();
    // And the live settings are still there, because they belong to the copy
    // rather than to what it asks for.
    expect(screen.getByLabelText("Applies to")).toBeTruthy();
  });

  it("keeps the running list beside a grouped editor and shows sampling only for live traffic", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED], next_cursor: null },
      },
      "GET /api/grader-library": SHELF,
    });
    render(<RunningGradersPage />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[0]!);

    const editor = screen.getByRole("region", {
      name: "Edit Expected behaviors",
    });
    expect(
      screen.getByRole("table", {
        name: "The graders running in this project",
      }),
    ).toBeTruthy();
    for (const group of [
      runningCopy.EDIT.groups.general,
      runningCopy.EDIT.groups.logic,
      runningCopy.EDIT.groups.applicability,
      runningCopy.EDIT.groups.impact,
    ]) {
      expect(within(editor).getByRole("group", { name: group })).toBeTruthy();
    }

    expect(within(editor).queryByLabelText(runningCopy.EDIT.sampleRate)).toBeNull();
    fireEvent.change(within(editor).getByLabelText(runningCopy.EDIT.scope), {
      target: { value: "production" },
    });
    expect(within(editor).getByLabelText(runningCopy.EDIT.sampleRate)).toBeTruthy();
  });

  /**
   * **The controls the real-browser walk drives, by the handles it drives them
   * by.**
   *
   * That walk is the only proof that an edit survives the round trip, and it
   * reaches these controls by their identifiers and their types rather than by
   * their labels — `#edit-required`, `#edit-sample-rate`, and "the number field
   * that is not the sample rate", which is how it names the entry's own bound
   * without naming a measure. Those handles are a contract between two files
   * and nothing else holds them, so a rename here would show up as a browser
   * case timing out ten minutes into a lane rather than as a failure naming
   * what moved.
   *
   * The types are the other half, and the reason this reads them rather than
   * trusting the prop: a numeric parameter has to wear a numeric control, or a
   * bound is typed on a phone keyboard with no digits on it.
   */
  it("gives the edit controls the handles the browser walk reaches them by", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [DIAGNOSTIC], next_cursor: null },
      },
      "GET /api/grader-library": SHELF,
    });
    render(<RunningGradersPage />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[0]!);

    // The panel names the copy, which is what the walk waits on before it
    // touches anything.
    expect(screen.getByText(runningCopy.EDIT.title("Latency"))).toBeTruthy();

    const required = document.querySelector("#edit-required");
    const rate = document.querySelector("#edit-sample-rate");
    expect((required as HTMLInputElement | null)?.type).toBe("checkbox");
    expect((rate as HTMLInputElement | null)?.type).toBe("number");

    // Exactly one other number field, and it is the entry's own — a bound is a
    // number because the catalog says the parameter is one.
    const numbers = [
      ...document.querySelectorAll('form input[type="number"]'),
    ].filter((one) => one.id !== "edit-sample-rate");
    expect(numbers).toHaveLength(1);
    expect((numbers[0] as HTMLInputElement).value).toBe("2000");
  });

  /**
   * **An emptied sample-rate box is not a rate of nought.**
   *
   * `Number("")` is `0`, and `0` is a perfectly good share of live traffic — so
   * a cleared box sent as a number would be written as *stop judging live
   * traffic*, accepted by the door, and reported back as saved. Nothing on the
   * far side can catch it: the value is in range and the request is well
   * formed. Leaving the key out is what the door reads as "keep what is there",
   * and it is the same rule the entry's own values already follow.
   */
  it("leaves the sample rate out when the box says nothing, rather than sending nought", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": [
        { status: 200, body: { items: [DIAGNOSTIC], next_cursor: null } },
        { status: 200, body: { items: [DIAGNOSTIC], next_cursor: null } },
      ],
      "GET /api/grader-library": SHELF,
      "PATCH /api/graders/grd_2": { status: 200, body: DIAGNOSTIC },
    });
    render(<RunningGradersPage />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[0]!);
    fireEvent.change(screen.getByLabelText(runningCopy.EDIT.sampleRate), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("status");
    const written = asked.find((one) => one.method === "PATCH");
    expect(written?.body).not.toHaveProperty("production_sample_rate");
  });

  /** The refusal's own sentence, kept, with the typing still on screen. */
  it("shows a refused edit without clearing the form", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [DIAGNOSTIC], next_cursor: null },
      },
      "GET /api/grader-library": SHELF,
      "PATCH /api/graders/grd_2": {
        status: 422,
        body: {
          error: "unprocessable",
          message: "Egma does not compute a measure called that.",
        },
      },
    });
    render(<RunningGradersPage />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[0]!);
    fireEvent.change(screen.getByLabelText("Bound"), {
      target: { value: "1200" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Egma does not compute a measure called that."),
    ).toBeTruthy();
    expect((screen.getByLabelText("Bound") as HTMLInputElement).value).toBe(
      "1200",
    );
  });
});

/* ------------------------------------------------------------------------ */

describe("the strip between the two screens", () => {
  it("carries the project in both addresses", () => {
    expect(graderTabsFor("prj_7")).toEqual([
      { id: "library", label: "Library", href: "/projects/prj_7/graders" },
      {
        id: "running",
        label: "Running",
        href: "/projects/prj_7/graders/running",
      },
    ]);
  });

  it("is a compact route navigation with the current view named", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/grader-library": {
        status: 200,
        body: { items: [BEHAVIORS], next_cursor: null },
      },
    });
    render(<GraderLibraryPage />);

    const views = await screen.findByRole("navigation", {
      name: "Grader views",
    });
    const library = within(views).getByRole("link", { name: "Library" });
    const running = within(views).getByRole("link", { name: "Running" });
    expect(library.getAttribute("aria-current")).toBe("page");
    expect(running.getAttribute("aria-current")).toBeNull();
    expect(library.getAttribute("href")).toBe("/projects/prj_1/graders");
    expect(running.getAttribute("href")).toBe(
      "/projects/prj_1/graders/running",
    );
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The banned list, as the domain model writes it, for these two screens.
 *
 * `evaluator`, `scorer` and `eval` are the words somebody arriving from another
 * product would type here first, which is exactly why these are the screens
 * that check for them. `dimension` and `gate` are the redesign's own
 * retirements — the verdict store's old column name, and the word considered
 * for the must-pass flag and not chosen. `built-in` is the old name for what is
 * now a predefined grader.
 *
 * `assertion` is deliberately **not** here. It was un-banned by the same
 * redesign that built these screens and is now the canonical word for one
 * 0-or-1 decision inside a grader — the ban that stands is narrower: an
 * assertion is never a grader.
 */
const NEVER_SAID = [
  "eval",
  "evaluation",
  "evaluator",
  "scorer",
  "dimension",
  "gate",
  "built-in",
  "digital human",
  "trace",
  "span",
  "conversation",
  "caller",
  "experiment",
  "batch",
];

/** Every string a copy module can put in front of somebody. */
function everySentence(said: unknown): string[] {
  if (typeof said === "string") return [said];
  if (typeof said === "function") {
    // The ones that take something, asked at both the singular and the plural.
    const asked = said as (one: never) => unknown;
    return [1, 2]
      .flatMap((count) => {
        try {
          return [asked(count as never), asked(String(count) as never)];
        } catch {
          return [];
        }
      })
      .filter((one): one is string => typeof one === "string");
  }
  if (typeof said === "object" && said !== null) {
    return Object.values(said).flatMap(everySentence);
  }
  return [];
}

/**
 * The two sentences the screens must not shorten, held against the copy modules
 * themselves.
 *
 * These are claims about words rather than about behaviour, which is why they
 * are read off the module instead of out of the DOM: what is being defended is
 * that a future edit cannot quietly make one of them shorter and truer-sounding.
 */
describe("what the two acts promise", () => {
  /**
   * An edit is two acts wearing one verb, and only one of them touches what a
   * verdict was decided by. Somebody who did not know that would read a
   * tightened bound as a rewriting of history.
   */
  it("says that changing a value starts a version", () => {
    expect(runningCopy.EDIT.lead.toLowerCase()).toContain("version");
  });

  /**
   * **`required` is the one live setting that reaches a page about the past.**
   * It rewrites no verdict; it moves this grader's rows between the lane that
   * decides a run and the lane that only reports, and the fold runs at read
   * time — so a run that failed on this grader alone reads as passed from the
   * moment the flag turns. Both positions have to say so, because turning it
   * either way has the same reach.
   */
  it("says that turning the required flag round re-counts runs already read", () => {
    expect(runningCopy.EDIT.requiredOn).toContain("cannot pass");
    expect(runningCopy.EDIT.requiredOff.toLowerCase()).toContain("diagnostic");

    for (const said of [
      runningCopy.EDIT.requiredOn,
      runningCopy.EDIT.requiredOff,
    ]) {
      expect(said.toLowerCase()).toContain("rewrites no verdict");
      expect(said.toLowerCase()).toContain("add up to");
    }
  });

  /** And the sentence after a save claims that and nothing wider. */
  it("claims only that no verdict was rewritten, never that nothing changed", () => {
    const saved = runningCopy.EDIT.saved("Latency").toLowerCase();
    expect(saved).toContain("verdict");
    expect(saved).not.toContain("is unchanged");
    expect(saved).not.toContain("nothing already judged");
  });

  /**
   * **Switching off has to say what stays, not only what stops.** It is the off
   * switch — there is no enable flag and no scope meaning nowhere — so the
   * button removes a project's judging, and the fear it raises is about the
   * runs already read. Every verdict the copy wrote stays readable because its
   * versions outlive it.
   */
  it("says plainly that what a switched-off grader already judged is unchanged", () => {
    expect(runningCopy.SWITCH_OFF.stops).toBeTruthy();
    expect(runningCopy.SWITCH_OFF.keeps.toLowerCase()).toContain(
      "already judged",
    );
    expect(
      runningCopy.SWITCH_OFF.done("Latency").toLowerCase(),
    ).toContain("already judged");
    // And what pressing it cannot be undone into, since there is no other
    // switch to put it back with.
    expect(runningCopy.SWITCH_OFF.again).toContain("Use");
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The one claim about these files a rendering cannot make: that the measure
 * catalog is **not** in them.
 *
 * Every other case here drives a component and reads the DOM. This one reads
 * the source, because what is being defended is an absence — a form that named
 * a measure itself would render exactly the same today and go stale the first
 * time egma's catalog changed. Both forms draw from the entry's declaration
 * through one component, so a parameter that learns a new kind of control
 * learns it once.
 */
describe("what the two forms are drawn from", () => {
  const WEB = `${import.meta.dirname}/../`;

  it("names no measure of its own, in either form", async () => {
    const { readFile } = await import("node:fs/promises");

    for (const file of [
      "app/projects/[projectId]/graders/use-form.tsx",
      "app/projects/[projectId]/graders/running/edit-form.tsx",
    ]) {
      const source = await readFile(`${WEB}${file}`, "utf8");

      // The comments are read past on purpose: prose explaining why the list is
      // not here is the opposite of the list being here.
      const rendered = source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
      for (const named of [
        "turn_response_latency",
        "first_response_latency",
        "milliseconds",
        "latency",
      ]) {
        expect(rendered, `${file} names ${named} itself`).not.toContain(named);
      }
    }
  });

  /**
   * And the edit form is the Use form's controls rather than a second copy of
   * them: one reading of the entry's declaration, in one component.
   */
  it("draws the edit form through the component Use is drawn with", async () => {
    const { readFile } = await import("node:fs/promises");
    const form = await readFile(
      `${WEB}app/projects/[projectId]/graders/running/edit-form.tsx`,
      "utf8",
    );

    expect(form).toContain("EntryFields");
    expect(form).toContain('from "../use-form.tsx"');
  });
});

/**
 * **Nothing in either copy file is a sentence its screen cannot reach**, which
 * is the rule both modules state about themselves and nothing enforced.
 *
 * A word nobody renders is worse than no word at all: the banned-list check
 * below reads it, so the file goes on reading as a screen whose whole
 * vocabulary is checked while part of that vocabulary is not on any screen. It
 * is also how copy written for a different shell survives a merge — two
 * `unreachable` sentences arrived with the edit-and-delete work, written for a
 * page that did its own fetching, and on this shell a refusal keeps the API's
 * own sentence and neither could ever be shown.
 *
 * Only the objects a screen addresses by name. `SCOPES`, `TYPES` and `OWNERS`
 * are lookup tables read with a stored word as the key — `SCOPES[copy.scope]` —
 * so no source file names their keys and none ever will. They are declared
 * `Readonly<Record<string, string>>` rather than `as const`, which is exactly
 * the difference, so the rule reads it off the declaration rather than holding
 * a list of exceptions.
 */
describe("what both screens can reach", () => {
  const WEB = `${import.meta.dirname}/../`;

  /** Every `.ts`/`.tsx` file a screen is built from. */
  async function everySource(): Promise<string> {
    const { readdir, readFile } = await import("node:fs/promises");
    const found: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const one of await readdir(dir, { withFileTypes: true })) {
        if (one.name === "node_modules" || one.name === ".next") continue;
        const at = `${dir}/${one.name}`;
        if (one.isDirectory()) await walk(at);
        else if (at.endsWith(".ts") || at.endsWith(".tsx")) found.push(at);
      }
    }

    await walk(`${WEB}app`);
    await walk(`${WEB}ui`);
    return (await Promise.all(found.map((at) => readFile(at, "utf8")))).join(
      "\n",
    );
  }

  for (const file of ["grader-library-copy.ts", "grader-running-copy.ts"]) {
    it(`renders every word ${file} holds`, async () => {
      const { readFile } = await import("node:fs/promises");
      const copy = await readFile(`${WEB}lib/${file}`, "utf8");
      const source = await everySource();

      const unrendered: string[] = [];
      for (const [, constant, body] of copy.matchAll(
        /export const (\w+) = \{([\s\S]*?)\n\} as const;/g,
      )) {
        for (const [, key] of (body ?? "").matchAll(/^ {2}(\w+):/gm)) {
          if (!source.includes(`${constant ?? ""}.${key ?? ""}`)) {
            unrendered.push(`${constant ?? ""}.${key ?? ""}`);
          }
        }
      }

      // A guard on the guard: a copy file rewritten out of this shape would
      // find nothing and pass while saying nothing.
      expect(copy).toContain("} as const;");
      // Named rather than counted: the fix is to delete the line or render it,
      // and a bare count sends somebody hunting for which.
      expect(unrendered).toEqual([]);
    });
  }
});

describe("the words both screens say", () => {
  for (const [where, module] of [
    ["the library screen", libraryCopy],
    ["the running-graders screen", runningCopy],
  ] as const) {
    it(`says nothing the domain model bans, on ${where}`, () => {
      const sentences = everySentence(module);
      expect(sentences.length).toBeGreaterThan(10);

      for (const sentence of sentences) {
        for (const banned of NEVER_SAID) {
          expect(
            sentence.toLowerCase().includes(banned),
            `"${sentence}" says "${banned}"`,
          ).toBe(false);
        }
      }
    });
  }
});
