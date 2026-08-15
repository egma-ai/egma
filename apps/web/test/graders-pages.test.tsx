// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  name: "Expected behaviors",
  description: "Judges a simulation against its test's expected behaviors.",
  type: "llm_as_judge",
  owner: "egma",
  params: [],
};

/** egma's latency entry: a measure from the catalog, and a bound. */
const LATENCY: LibraryEntry = {
  id: "grl_latency",
  name: "Latency",
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
  name: "Expected behaviors",
  description: null,
  type: "llm_as_judge",
  required: true,
  scope: "simulations",
  production_sample_rate: 0,
  config: { assertions: [] },
  created_at: "2026-08-15T10:00:00.000Z",
  updated_at: "2026-08-15T10:00:00.000Z",
};

const DIAGNOSTIC: RunningGrader = {
  ...SEEDED,
  id: "grd_2",
  library_id: "grl_latency",
  name: "Latency",
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

    // Twice, because one column definition draws the table and the list both.
    expect(await screen.findAllByText("Expected behaviors")).toHaveLength(2);
    expect(asked.map((one) => one.path)).toContain(
      "/api/grader-library?project=prj_1",
    );

    // The stored words turned into the ones a person reads, and never shown raw.
    expect(screen.getAllByText("Model judged")).not.toHaveLength(0);
    expect(screen.getAllByText("Computed")).not.toHaveLength(0);
    expect(screen.queryByText("llm_as_judge")).toBeNull();
    expect(screen.getAllByText("egma")).not.toHaveLength(0);
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
    const written = asked.find((one) => one.method === "POST");
    expect(written?.body).toEqual({
      library_id: "grl_behaviors",
      required: true,
      project: "prj_2",
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
    expect(asked.find((one) => one.method === "POST")?.body).toEqual({
      library_id: "grl_latency",
      required: true,
      project: "prj_1",
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
          message: "egma does not compute a measure called that.",
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
      await screen.findByText("egma does not compute a measure called that."),
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

describe("the running graders of one project", () => {
  it("names its project, and says where each copy applies and whether it blocks", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED, DIAGNOSTIC], next_cursor: null },
      },
    });
    render(<RunningGradersPage />);

    expect(await screen.findAllByText("Expected behaviors")).toHaveLength(2);
    expect(asked.map((one) => one.path)).toContain("/api/graders?project=prj_1");

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
   * Deleting a copy is how a grader is switched off, and there is no other
   * switch — so this is the one act on the screen, and it names the project it
   * is taken in.
   */
  it("deletes a copy, in the project in the address, and reads the list again", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": [
        { status: 200, body: { items: [SEEDED, DIAGNOSTIC], next_cursor: null } },
        { status: 200, body: { items: [SEEDED], next_cursor: null } },
      ],
      "DELETE /api/graders/grd_2": {
        status: 200,
        body: {
          id: "grd_2",
          name: "Latency",
          deleted_at: "2026-08-15T12:00:00.000Z",
        },
      },
    });
    render(<RunningGradersPage />);

    const deletes = await screen.findAllByRole("button", { name: "Delete" });
    // The table's rows are in answer order, so Latency's is the second.
    fireEvent.click(deletes[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Delete grader" }));

    expect((await screen.findByRole("status")).textContent).toContain(
      "Latency is no longer judging this project",
    );
    expect(asked.map((one) => one.path)).toContain(
      "/api/graders/grd_2?project=prj_1",
    );
    // Read again rather than edited here: what judges this project is the
    // server's answer, and there are two reads for one delete.
    expect(
      asked.filter((one) => one.path === "/api/graders?project=prj_1"),
    ).toHaveLength(2);
  });

  /**
   * A project may end up judged by nothing — the run door allows it — so
   * deleting the last copy is warned about and never refused.
   */
  it("warns before the last copy goes, and does not refuse it", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": [
        { status: 200, body: { items: [SEEDED], next_cursor: null } },
        { status: 200, body: { items: [], next_cursor: null } },
      ],
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
      (await screen.findAllByRole("button", { name: "Delete" }))[0]!,
    );
    expect(screen.getByText(runningCopy.REMOVE.theLastOne)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete grader" }));

    // Gone, and the page says what that means rather than pretending a project
    // with no graders is a project that has not finished setting up.
    expect(
      await screen.findByText("Nothing is judging this project"),
    ).toBeTruthy();
    expect(screen.getByText(runningCopy.RUNNING.empty)).toBeTruthy();
  });

  it("keeps the confirmation open and shows a refused delete", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED], next_cursor: null },
      },
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
      (await screen.findAllByRole("button", { name: "Delete" }))[0]!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete grader" }));

    expect(
      await screen.findByText("Your viewer role cannot author definitions."),
    ).toBeTruthy();
    // Still there to try again, and the row is still in the list.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getAllByText("Expected behaviors")).not.toHaveLength(0);
  });

  it("leaves Delete inert for a viewer, with the reason beside it", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("viewer") },
      "GET /api/graders": {
        status: 200,
        body: { items: [SEEDED], next_cursor: null },
      },
    });
    render(<RunningGradersPage />);

    const pressed = (await screen.findAllByRole("button", {
      name: "Delete",
    }))[0]!;
    expect((pressed as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getAllByText(runningCopy.REMOVE.notYours("viewer")),
    ).not.toHaveLength(0);
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
