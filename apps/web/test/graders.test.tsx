// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GraderDetailPage from "../app/projects/[projectId]/graders/[graderId]/page.tsx";
import GradersPage from "../app/projects/[projectId]/graders/page.tsx";
import NewGraderPage from "../app/projects/[projectId]/graders/new/page.tsx";
import { ConfigFields, EvidenceFields, LiveFields } from "../app/projects/[projectId]/graders/editor.tsx";
import type { Me } from "../lib/me.ts";

/**
 * The grader shelf and the grader editor, rendered.
 *
 * Judge settings used to be here and are now under Settings, beside the project
 * details they belong with — `settings.test.tsx` drives them.
 *
 * **Nothing here asserts that a component exists or that a source file contains
 * a string.** Every test drives a rendered page the way somebody with a
 * keyboard would and reads what the DOM then says — which is why these can
 * stand in for a browser journey rather than merely accompany one.
 *
 * The claims worth having in the fast lane are the ones a page decides for
 * itself: that a form only ever shows the fields that apply to the type in
 * front of it, that a viewer gets controls that are present and genuinely
 * inert, that a set which can never fire cannot be saved, and that no typed key
 * is ever rendered back.
 */

const routed = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/projects/prj_1/graders",
  projectId: "prj_1",
  graderId: "grd_1",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: routed.push, replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ projectId: routed.projectId, graderId: routed.graderId }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>
      {children as never}
    </a>
  ),
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const PROJECTS = [{ id: "prj_1", name: "Default", slug: "default" }];
const ACME = { id: "org_1", name: "Acme", slug: "acme", role: "admin" };

function meWith(role: string): Me {
  return {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [{ ...ACME, role }],
    projects: PROJECTS,
  };
}

const REGISTRY = {
  types: [
    {
      type: "llm_rubric",
      reads: ["transcript"],
      reads_are_fixed: false,
      modalities: ["voice", "chat"],
      judged: true,
    },
    {
      type: "metric_threshold",
      reads: ["measures"],
      reads_are_fixed: true,
      modalities: ["voice", "chat"],
      judged: false,
    },
    {
      type: "tool_calls",
      reads: ["tool_calls"],
      reads_are_fixed: true,
      modalities: ["voice", "chat"],
      judged: false,
    },
    {
      type: "phrase_match",
      reads: ["transcript"],
      reads_are_fixed: true,
      modalities: ["voice", "chat"],
      judged: false,
    },
  ],
  reads: ["transcript", "outcome", "tool_calls", "measures"],
  priorities: ["P0", "P1", "P2"],
  scopes: ["simulations", "production", "both"],
  built_in: [
    {
      key: "expected_behaviors_v1",
      name: "Expected behaviors",
      description:
        "Judges every simulation against the expected behaviors its own test wrote down.",
      reads: ["transcript", "outcome", "tool_calls", "measures"],
      modalities: ["voice", "chat"],
      judged: true,
      implicit: true,
      always_active: true,
      editable: false,
      removable: false,
    },
  ],
};

function graderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "grd_1",
    project_id: "prj_1",
    name: "Verified identity first",
    description: null,
    type: "llm_rubric",
    priority: "P0",
    scope: "simulations",
    production_sample_rate: 100,
    revision: "rev_1",
    archived_at: null,
    version: 1,
    version_id: "grv_1",
    config: { rubric: "The agent verified identity." },
    judge_model: null,
    reads: ["transcript"],
    modalities: ["voice", "chat"],
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Stubbed = { status: number; body: unknown } | "never";

/** Every request the browser makes, in the order it made them. */
let sent: { url: string; method: string; body: unknown }[] = [];

function apiAnswers(answers: Record<string, Stubbed | readonly Stubbed[]>): void {
  const asked: Record<string, number> = {};

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://egma.test");
      sent.push({
        url: input,
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as unknown)
            : undefined,
      });

      const held = answers[url.pathname];
      if (held === undefined) throw new Error(`nothing stubbed for ${url.pathname}`);

      const turn = asked[url.pathname] ?? 0;
      asked[url.pathname] = turn + 1;
      const answer = Array.isArray(held)
        ? ((held[Math.min(turn, held.length - 1)] ?? "never") as Stubbed)
        : (held as Stubbed);

      if (answer === "never") return new Promise<Response>(() => undefined);
      return json(answer.status, answer.body);
    }),
  );
}

/** Where the page sent an expired session, if it sent one anywhere. */
let wentTo: string[] = [];

beforeEach(() => {
  sent = [];
  wentTo = [];
  // jsdom refuses assignment to window.location, so the one method these pages
  // use is replaced. Reading it back is how "an expired session is sent to
  // sign-in" becomes an assertion rather than a claim in a comment.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      replace: (url: string) => wentTo.push(url),
    },
  });
  routed.push.mockReset();
  routed.pathname = "/projects/prj_1/graders";
  routed.projectId = "prj_1";
  routed.graderId = "grd_1";
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------------ */

describe("the grader shelf", () => {
  function shelf(role = "admin", graders: unknown[] = [graderRow()]) {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/api/graders": {
        status: 200,
        body: { items: graders, next_cursor: null },
      },
      "/api/grader-registry": { status: 200, body: REGISTRY },
    });
    render(<GradersPage />);
  }

  /**
   * The built-in is on the shelf, marked, and carries no control at all.
   *
   * A project's graders are not the whole of what it judges by: every test is
   * judged against its own expected behaviors from birth. A shelf that showed
   * only the rows would say the opposite, and one that made the built-in look
   * like a row would invite somebody to try to take it off.
   */
  it("shows the built-in as always active and offers nothing to edit or remove", async () => {
    shelf();

    const builtIn = await screen.findByRole("region", { name: "Built-in graders" });
    expect(builtIn.textContent).toContain("Expected behaviors");
    expect(builtIn.textContent).toContain("Always active");
    expect(builtIn.textContent).toContain("never attached or removed");

    // No control of any kind inside it: nothing to press, nothing to follow.
    // Asked by role rather than by tag, because a role is what a person meets.
    const { queryAllByRole } = within(builtIn);
    expect(queryAllByRole("button")).toHaveLength(0);
    expect(queryAllByRole("link")).toHaveLength(0);
  });

  it("lists authored graders beside it, with what each judges by", async () => {
    shelf();

    // Two layouts from one column definition — a dense table and a stack for a
    // narrow screen — so the name is on the page twice by design.
    expect(await screen.findAllByText("Verified identity first")).not.toHaveLength(
      0,
    );
    expect(
      screen.getAllByText("Asks a judge model to decide, against criteria you write."),
    ).not.toHaveLength(0);
  });

  /**
   * A viewer's control is present and genuinely inert — not hidden, and not an
   * anchor that still follows. Hiding it would leave somebody unable to see
   * what egma can do here; a greyed link that still navigates would be a lie.
   */
  it("leaves a viewer's authoring control in place and truly disabled", async () => {
    shelf("viewer");

    const write = await screen.findByRole("button", { name: "Write a grader" });
    expect(write.hasAttribute("disabled")).toBe(true);
    expect(write.getAttribute("title")).toContain("viewer role cannot write graders");
    expect(write.tagName).toBe("BUTTON");
  });

  it("gives an admin a link that goes somewhere", async () => {
    shelf();

    const write = await screen.findByRole("link", { name: "Write a grader" });
    expect(write.getAttribute("href")).toBe("/projects/prj_1/graders/new");
  });

  /**
   * The archived shelf is a different question and asks it of the server.
   * Filtering rows already on screen would silently answer about one page of
   * graders rather than about the project.
   */
  it("asks the server for archived graders rather than filtering what it has", async () => {
    shelf();
    await screen.findAllByText("Verified identity first");

    fireEvent.click(screen.getByRole("button", { name: "Show archived graders" }));

    await waitFor(() => {
      expect(
        sent.some((request) => request.url.includes("archived=true")),
      ).toBe(true);
    });
  });

  it("carries the project on every read it makes", async () => {
    shelf();
    await screen.findAllByText("Verified identity first");

    for (const request of sent.filter((one) => one.url.startsWith("/api/graders"))) {
      expect(request.url).toContain("project=prj_1");
    }
  });

  it("says so and offers a retry when egma refuses the list", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/graders": [
        { status: 500, body: { error: "broken", message: "Egma fell over." } },
        { status: 200, body: { items: [graderRow()], next_cursor: null } },
      ],
      "/api/grader-registry": { status: 200, body: REGISTRY },
    });
    render(<GradersPage />);

    expect(await screen.findByText("Egma fell over.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByText("Verified identity first")).not.toHaveLength(
      0,
    );
  });
});


/* ------------------------------------------------------------------------ */

describe("one grader's detail page", () => {
  const USAGE = { direct_tests: [], applies_to_every_test_by_default: true };
  const HISTORY = {
    items: [
      {
        id: "grv_1",
        version: 1,
        type: "llm_rubric",
        config: { rubric: "The agent verified identity." },
        judge_model: null,
        reads: ["transcript"],
        modalities: ["voice", "chat"],
        created_at: "2026-08-01T10:00:00.000Z",
      },
    ],
  };

  function detail(
    role = "admin",
    overrides: {
      readonly grader?: Record<string, unknown>;
      readonly usage?: Stubbed;
      readonly patch?: Stubbed;
    } = {},
  ) {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/api/grader-registry": { status: 200, body: REGISTRY },
      "/api/graders/grd_1": [
        { status: 200, body: overrides.grader ?? graderRow() },
        overrides.patch ?? {
          status: 200,
          body: { ...(overrides.grader ?? graderRow()), revision: "rev_2" },
        },
      ],
      "/api/graders/grd_1/versions": { status: 200, body: HISTORY },
      "/api/graders/grd_1/usage": overrides.usage ?? { status: 200, body: USAGE },
      "/api/graders/grd_1/clone": {
        status: 201,
        body: graderRow({ id: "grd_2", name: "Verified identity first copy" }),
      },
      "/api/graders/grd_1/archive": {
        status: 200,
        body: graderRow({ archived_at: "2026-08-02T10:00:00.000Z", revision: "rev_2" }),
      },
      "/api/graders/grd_1/restore": { status: 200, body: graderRow() },
    });
    render(<GraderDetailPage />);
  }

  it("shows the current content, the history and what asks for it by name", async () => {
    detail();

    expect(
      (await screen.findByLabelText("Rubric")) as HTMLTextAreaElement,
    ).toHaveProperty("value", "The agent verified identity.");

    const history = screen.getByRole("region", { name: "Version history" });
    expect(history.textContent).toContain("v1");
    expect(history.textContent).toContain("current");

    const usage = screen.getByRole("region", { name: "Used by" });
    expect(usage.textContent).toContain("applies to every test in the project");
    expect(usage.textContent).toContain("not a use that blocks");
    expect(usage.textContent).toContain("No test adds it directly.");
  });

  /**
   * The crash the reviewer found: a usage answer whose shape is not the one
   * this page expects took the whole detail page down, and with it the version
   * history and the editor somebody actually came for. Usage is a footnote.
   */
  it("survives a usage answer in a shape it does not expect", async () => {
    detail("admin", { usage: { status: 200, body: { direct_tests: null } } });

    // The page is still there, and so is everything that is not the footnote.
    expect(await screen.findByLabelText("Rubric")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Version history" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Used by" }).textContent).toContain(
      "No test adds it directly.",
    );
  });

  it("names the tests that would block archiving, and says the default use does not", async () => {
    detail("admin", {
      usage: {
        status: 200,
        body: {
          direct_tests: [{ id: "tst_1", name: "Refund on a closed account" }],
          applies_to_every_test_by_default: true,
        },
      },
    });

    const usage = await screen.findByRole("region", { name: "Used by" });
    expect(usage.textContent).toContain("Refund on a closed account");
    expect(usage.textContent).toContain("Archiving is refused");
  });

  /**
   * The split, from the outside. The live save carries the revision alone and
   * the content save carries the version alone, so a rename in one tab cannot
   * make a rubric edit somebody is typing in another one stale.
   */
  it("saves settings with the revision and content with the version, never both", async () => {
    detail();

    fireEvent.change(await screen.findByLabelText("Priority"), {
      target: { value: "P1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(sent.some((one) => one.method === "PATCH")).toBe(true);
    });

    const live = sent.find((one) => one.method === "PATCH")?.body as Record<
      string,
      unknown
    >;
    expect(live).toMatchObject({ priority: "P1", expected_revision: "rev_1" });
    expect(Object.keys(live)).not.toContain("expected_version_id");
    expect(Object.keys(live)).not.toContain("config");
  });

  it("carries the version and not the revision when the rubric changes", async () => {
    detail();

    fireEvent.change(await screen.findByLabelText("Rubric"), {
      target: { value: "Two facts before any balance." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    await waitFor(() => {
      expect(sent.some((one) => one.method === "PATCH")).toBe(true);
    });

    const content = sent.find((one) => one.method === "PATCH")?.body as Record<
      string,
      unknown
    >;
    expect(content).toMatchObject({
      config: { rubric: "Two facts before any balance." },
      expected_version_id: "grv_1",
    });
    expect(Object.keys(content)).not.toContain("expected_revision");
  });

  it("shows a stale-write refusal without throwing the draft away", async () => {
    detail("admin", {
      patch: {
        status: 409,
        body: {
          error: "identity_conflict",
          message: "Grader grd_1 changed after you opened it.",
        },
      },
    });

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Renamed in this tab" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(
      await screen.findByText("Grader grd_1 changed after you opened it."),
    ).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Renamed in this tab",
    );
  });

  it("goes to the copy after cloning", async () => {
    detail();

    fireEvent.click(await screen.findByRole("button", { name: "Clone" }));

    await waitFor(() => {
      expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/graders/grd_2");
    });
  });

  it("offers Restore rather than Archive once it is archived", async () => {
    detail("admin", {
      grader: graderRow({ archived_at: "2026-08-02T10:00:00.000Z" }),
    });

    expect(await screen.findByRole("button", { name: "Restore" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("leaves a viewer every control in place and truly disabled", async () => {
    detail("viewer");

    const save = await screen.findByRole("button", { name: "Save settings" });
    expect(save.hasAttribute("disabled")).toBe(true);
    for (const name of ["Save version", "Clone", "Archive"]) {
      expect(
        screen.getByRole("button", { name }).hasAttribute("disabled"),
        name,
      ).toBe(true);
    }
    expect(
      (screen.getByLabelText("Rubric") as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/role cannot change graders/)).toBeTruthy();
  });

  it("says so, and offers a way back, when the grader is not available here", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/grader-registry": { status: 200, body: REGISTRY },
      "/api/graders/grd_1": {
        status: 404,
        body: {
          error: "not_found",
          message: "There is no grader grd_1 available in this project.",
        },
      },
      "/api/graders/grd_1/versions": {
        status: 404,
        body: { error: "not_found", message: "gone" },
      },
      "/api/graders/grd_1/usage": {
        status: 404,
        body: { error: "not_found", message: "gone" },
      },
    });
    render(<GraderDetailPage />);

    expect(
      await screen.findByText("There is no grader grd_1 available in this project."),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Back to graders" }).getAttribute("href"),
    ).toBe("/projects/prj_1/graders");
  });

  it("sends an expired session to sign-in rather than showing a retry that cannot work", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/grader-registry": { status: 200, body: REGISTRY },
      "/api/graders/grd_1": { status: 401, body: {} },
      "/api/graders/grd_1/versions": { status: 401, body: {} },
      "/api/graders/grd_1/usage": { status: 401, body: {} },
    });
    render(<GraderDetailPage />);

    await waitFor(() => {
      expect(wentTo).toContain("/sign-in");
    });
  });
});

/* ------------------------------------------------------------------------ */

describe("writing a grader", () => {
  function editor(role = "admin") {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/api/grader-registry": { status: 200, body: REGISTRY },
      "/api/graders": { status: 201, body: graderRow({ id: "grd_new" }) },
    });
    render(<NewGraderPage />);
  }

  /**
   * The form shows the fields of the chosen type and nothing else. Four types
   * made of four different things, all on one form, would ask everybody for
   * three sets of fields they must leave blank — and a blank that means "not
   * applicable" is indistinguishable from one somebody forgot.
   */
  it("shows only the fields the chosen type is made of, and swaps them when it changes", async () => {
    editor();

    expect(await screen.findByLabelText("Rubric")).toBeTruthy();
    expect(screen.queryByLabelText("Measure")).toBeNull();
    expect(screen.queryByLabelText("Threshold")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /metric_threshold/ }));

    expect(screen.getByLabelText("Measure")).toBeTruthy();
    expect(screen.getByLabelText("Threshold")).toBeTruthy();
    expect(screen.queryByLabelText("Rubric")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /phrase_match/ }));

    expect(screen.getByLabelText("Words that must be said")).toBeTruthy();
    expect(screen.queryByLabelText("Measure")).toBeNull();
  });

  /**
   * A deterministic type's reads are a fact rather than a choice, so the form
   * states them and offers no control. Offering one would let somebody build a
   * grader the server then refuses.
   */
  it("offers a reads choice for a rubric and states the fact for a threshold", async () => {
    editor();

    await screen.findByLabelText("Rubric");
    expect(screen.getByRole("group", { name: "Reads" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /metric_threshold/ }));

    expect(screen.queryByRole("group", { name: "Reads" })).toBeNull();
    expect(screen.getByText(/Reads measures\./)).toBeTruthy();
  });

  /**
   * Production sampling is a promise about traffic egma did not cause, so it
   * means nothing until production is in scope.
   */
  it("shows production sampling only once production is in scope", async () => {
    editor();

    await screen.findByLabelText("Rubric");
    expect(screen.queryByLabelText("Production sampling (%)")).toBeNull();

    fireEvent.change(screen.getByLabelText("Applies to"), {
      target: { value: "both" },
    });

    expect(screen.getByLabelText("Production sampling (%)")).toBeTruthy();
  });

  it("will not write a grader with no name or an unusable judgment", async () => {
    editor();

    const write = await screen.findByRole("button", { name: "Write grader" });
    expect(write.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Verified identity first" },
    });
    // Still nothing to judge by.
    expect(
      screen.getByRole("button", { name: "Write grader" }).hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("Rubric"), {
      target: { value: "The agent verified identity." },
    });
    expect(
      screen.getByRole("button", { name: "Write grader" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("sends the type, the config and the project, and goes to what it wrote", async () => {
    editor();

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Verified identity first" },
    });
    fireEvent.change(screen.getByLabelText("Rubric"), {
      target: { value: "The agent verified identity." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Write grader" }));

    await waitFor(() => {
      expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/graders/grd_new");
    });

    const write = sent.find((request) => request.method === "POST");
    expect(write?.body).toMatchObject({
      name: "Verified identity first",
      type: "llm_rubric",
      config: { rubric: "The agent verified identity." },
      project: "prj_1",
      modalities: ["voice", "chat"],
    });
  });

  it("says so and keeps the draft when egma refuses the write", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/grader-registry": { status: 200, body: REGISTRY },
      "/api/graders": {
        status: 422,
        body: {
          error: "unprocessable",
          message: "an llm_rubric grader needs a rubric.",
        },
      },
    });
    render(<NewGraderPage />);

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Verified identity first" },
    });
    fireEvent.change(screen.getByLabelText("Rubric"), {
      target: { value: "The agent verified identity." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Write grader" }));

    expect(
      await screen.findByText("an llm_rubric grader needs a rubric."),
    ).toBeTruthy();
    // The work is still there to fix rather than retype.
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Verified identity first",
    );
    expect(routed.push).not.toHaveBeenCalled();
  });

  /**
   * The third of the defects the shell had to fix, and this page had it too: a
   * session that ended showed a sentence and a Try again that could only ever
   * be refused the same way — somebody pressing a button forever on a page that
   * can no longer read anything.
   */
  it("sends an expired session to sign-in rather than offering a retry that cannot work", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/grader-registry": { status: 401, body: {} },
      "/api/graders": { status: 401, body: {} },
    });
    render(<NewGraderPage />);

    await waitFor(() => {
      expect(wentTo).toContain("/sign-in");
    });
  });

  it("disables every field for a viewer rather than hiding the page", async () => {
    editor("viewer");

    const write = await screen.findByRole("button", { name: "Write grader" });
    expect(write.hasAttribute("disabled")).toBe(true);
    expect(
      (screen.getByLabelText("Rubric") as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/role cannot write graders/)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------------ */

describe("the evidence fields", () => {
  /**
   * A grader that scores no modality can never fire — it is a check somebody
   * wrote, believes in, and that will never say anything. So the last box
   * cannot be cleared, and the control says why rather than letting the save
   * fail at the server.
   */
  it("will not let the last modality be cleared", () => {
    const chosen: string[][] = [];
    render(
      <EvidenceFields
        registry={REGISTRY as never}
        type="llm_rubric"
        reads={["transcript"]}
        modalities={["voice"]}
        disabled={false}
        onReads={() => undefined}
        onModalities={(next) => chosen.push([...next])}
      />,
    );

    const voice = screen.getByRole("checkbox", { name: "voice" });
    expect((voice as HTMLInputElement).disabled).toBe(true);
    expect(voice.getAttribute("title")).toContain("at least one thing");

    // The other one is still free to be added, which is what makes this a floor
    // rather than a freeze.
    const chat = screen.getByRole("checkbox", { name: "chat" });
    expect((chat as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(chat);
    expect(chosen).toEqual([["voice", "chat"]]);
  });

  it("hands sets back in the settled order, so two orders are one set", () => {
    const chosen: string[][] = [];
    render(
      <EvidenceFields
        registry={REGISTRY as never}
        type="llm_rubric"
        reads={["measures"]}
        modalities={["voice", "chat"]}
        disabled={false}
        onReads={(next) => chosen.push([...next])}
        onModalities={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "transcript" }));
    // Chosen second, answered first: the order is the registry's.
    expect(chosen).toEqual([["transcript", "measures"]]);
  });

  it("says a skip is not a failure, where somebody is deciding to narrow", () => {
    render(
      <EvidenceFields
        registry={REGISTRY as never}
        type="llm_rubric"
        reads={["transcript"]}
        modalities={["voice", "chat"]}
        disabled={false}
        onReads={() => undefined}
        onModalities={() => undefined}
      />,
    );

    expect(screen.getByText(/skipped, never failed/)).toBeTruthy();
  });
});

describe("the config fields", () => {
  it("reads a tool list back as the lines somebody typed", () => {
    let held: Record<string, unknown> = { required: [], forbidden: [] };
    const { rerender } = render(
      <ConfigFields
        type="tool_calls"
        config={held}
        disabled={false}
        onChange={(next) => {
          held = next;
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Tools that must have fired"), {
      target: { value: "check_availability\nbook_appointment" },
    });

    expect(held.required).toEqual([
      { tool: "check_availability" },
      { tool: "book_appointment" },
    ]);

    rerender(
      <ConfigFields
        type="tool_calls"
        config={held}
        disabled={false}
        onChange={() => undefined}
      />,
    );
    expect(
      (screen.getByLabelText("Tools that must have fired") as HTMLTextAreaElement)
        .value,
    ).toBe("check_availability\nbook_appointment");
  });
});

describe("the live fields", () => {
  it("keeps sampling out of sight until production is in scope", () => {
    const { rerender } = render(
      <LiveFields
        name="A grader"
        description=""
        priority="P0"
        scope="simulations"
        sampleRate={100}
        disabled={false}
        onChange={() => undefined}
      />,
    );
    expect(screen.queryByLabelText("Production sampling (%)")).toBeNull();

    rerender(
      <LiveFields
        name="A grader"
        description=""
        priority="P0"
        scope="production"
        sampleRate={100}
        disabled={false}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByLabelText("Production sampling (%)")).toBeTruthy();
  });
});
