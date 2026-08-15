// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GradersPage from "../app/projects/[projectId]/graders/page.tsx";
import NewGraderPage from "../app/projects/[projectId]/graders/new/page.tsx";
import JudgeSettingsPage from "../app/projects/[projectId]/graders/judge/page.tsx";
import { ConfigFields, EvidenceFields, LiveFields } from "../app/projects/[projectId]/graders/editor.tsx";
import type { Me } from "../lib/me.ts";

/**
 * The grader shelf, the grader editor and the judge settings, rendered.
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

beforeEach(() => {
  sent = [];
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
    expect(builtIn.querySelectorAll("button, a")).toHaveLength(0);
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

/* ------------------------------------------------------------------------ */

describe("judge settings", () => {
  function settings(
    role = "admin",
    judge: unknown = {
      state: "needs_setup",
      provider: null,
      model: null,
      source: null,
      credential_id: null,
      hint: null,
    },
    credentials: unknown[] = [],
  ) {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/api/judge": { status: 200, body: judge },
      "/api/judge/registry": {
        status: 200,
        body: {
          providers: [{ provider: "openai", model_is_free_text: true }],
          platform_sentinel: "platform",
        },
      },
      "/api/judge-credentials": { status: 200, body: { items: credentials } },
    });
    render(<JudgeSettingsPage />);
  }

  /**
   * `needs_setup` is a state and not an empty form. A project in it cannot ask a
   * model anything, which means the built-in cannot judge — so a run started
   * this way comes back errored after real calls have been paid for.
   */
  it("says plainly that a project with no judge cannot grade with a model", async () => {
    settings();

    expect(await screen.findByText(/Needs setup/)).toBeTruthy();
    expect(
      screen.getByText(/LLM grading is unavailable/),
    ).toBeTruthy();
  });

  /**
   * The whole point of the credential design, asserted from the page: what is
   * shown is a label and four characters, and the typed key is never rendered
   * back anywhere.
   */
  it("shows a label and a hint, and never a stored key", async () => {
    settings("admin", undefined as never, [
      {
        id: "jcr_1",
        label: "Acme production",
        provider: "openai",
        hint: "1234",
        revision: "rev_1",
        created_at: "2026-08-01T10:00:00.000Z",
        updated_at: "2026-08-01T10:00:00.000Z",
      },
    ]);

    const keys = await screen.findByRole("region", { name: "Judge credentials" });
    expect(keys.textContent).toContain("Acme production");
    expect(keys.textContent).toContain("…1234");
    expect(keys.textContent).toContain("never the key itself");
  });

  it("sends a typed key once and does not keep it on the page", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/judge": {
        status: 200,
        body: {
          state: "needs_setup",
          provider: null,
          model: null,
          source: null,
          credential_id: null,
          hint: null,
        },
      },
      "/api/judge/registry": {
        status: 200,
        body: {
          providers: [{ provider: "openai", model_is_free_text: true }],
          platform_sentinel: "platform",
        },
      },
      "/api/judge-credentials": [
        { status: 200, body: { items: [] } },
        {
          status: 201,
          body: {
            id: "jcr_1",
            label: "Acme production",
            provider: "openai",
            hint: "1234",
            revision: "rev_1",
            created_at: "2026-08-01T10:00:00.000Z",
            updated_at: "2026-08-01T10:00:00.000Z",
          },
        },
      ],
    });
    render(<JudgeSettingsPage />);

    const label = await screen.findByLabelText("Label");
    fireEvent.change(label, { target: { value: "Acme production" } });
    fireEvent.change(screen.getByLabelText("OpenAI key"), {
      target: { value: "sk-typed-once-and-never-shown" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));

    await waitFor(() => {
      expect(
        (screen.getByLabelText("OpenAI key") as HTMLInputElement).value,
      ).toBe("");
    });

    const post = sent.find((request) => request.method === "POST");
    expect(post?.body).toMatchObject({
      label: "Acme production",
      provider: "openai",
      key: "sk-typed-once-and-never-shown",
    });
    // Sent once, and nowhere on the page afterwards.
    expect(document.body.textContent).not.toContain("sk-typed-once");
  });

  /**
   * Replacing a key is a write and never a read: the field starts empty,
   * nothing fills it in from what is stored, and the sentence beside it says
   * the old key is not available even to the person replacing it.
   */
  it("offers an empty field for a replacement and never prefills the stored key", async () => {
    settings("admin", undefined as never, [
      {
        id: "jcr_1",
        label: "Acme production",
        provider: "openai",
        hint: "1234",
        revision: "rev_1",
        created_at: "2026-08-01T10:00:00.000Z",
        updated_at: "2026-08-01T10:00:00.000Z",
      },
    ]);

    fireEvent.click(await screen.findByRole("button", { name: "Replace key" }));

    const field = screen.getByLabelText("New key") as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.type).toBe("password");
    expect(screen.getByText(/egma will not show it to you/)).toBeTruthy();
  });

  it("says the deployment's own judge has nothing to rotate", async () => {
    settings("admin", {
      state: "configured",
      project_id: "prj_1",
      provider: "openai",
      model: "gpt-4o",
      source: "platform",
      credential_id: null,
      hint: null,
      updated_at: "2026-08-01T10:00:00.000Z",
    });

    expect(
      await screen.findByText(/nothing here to rotate and no key to see/),
    ).toBeTruthy();
  });

  /**
   * Judge settings are administration. A member reads the page and every
   * control is present and genuinely inert — the server refuses their write
   * either way, which is where the boundary is.
   */
  it("leaves a member every control in place and truly disabled", async () => {
    settings("member");

    expect(
      await screen.findByText(/role cannot change judge settings/),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Provider") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Save judge" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Add key" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("sends the provider, the model and the credential, and no key at all", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/judge": [
        {
          status: 200,
          body: {
            state: "needs_setup",
            provider: null,
            model: null,
            source: null,
            credential_id: null,
            hint: null,
          },
        },
        {
          status: 200,
          body: {
            state: "configured",
            project_id: "prj_1",
            provider: "openai",
            model: "gpt-4.1-mini",
            source: "credential",
            credential_id: "jcr_1",
            hint: "1234",
            updated_at: "2026-08-01T10:00:00.000Z",
          },
        },
      ],
      "/api/judge/registry": {
        status: 200,
        body: {
          providers: [{ provider: "openai", model_is_free_text: true }],
          platform_sentinel: "platform",
        },
      },
      "/api/judge-credentials": {
        status: 200,
        body: {
          items: [
            {
              id: "jcr_1",
              label: "Acme production",
              provider: "openai",
              hint: "1234",
              revision: "rev_1",
              created_at: "2026-08-01T10:00:00.000Z",
              updated_at: "2026-08-01T10:00:00.000Z",
            },
          ],
        },
      },
    });
    render(<JudgeSettingsPage />);

    fireEvent.change(await screen.findByLabelText("Model"), {
      target: { value: "gpt-4.1-mini" },
    });
    fireEvent.change(screen.getByLabelText("Key"), {
      target: { value: "jcr_1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save judge" }));

    await waitFor(() => {
      expect(sent.some((request) => request.method === "PUT")).toBe(true);
    });

    const put = sent.find((request) => request.method === "PUT");
    expect(put?.body).toEqual({
      provider: "openai",
      model: "gpt-4.1-mini",
      source: "jcr_1",
      project: "prj_1",
    });
    expect(Object.keys(put?.body as Record<string, unknown>)).not.toContain("key");
  });
});
