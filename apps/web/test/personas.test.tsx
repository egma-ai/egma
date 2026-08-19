// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PersonaPage from "../app/projects/[projectId]/personas/[personaId]/page.tsx";
import NewPersonaPage from "../app/projects/[projectId]/personas/new/page.tsx";
import PersonasPage from "../app/projects/[projectId]/personas/page.tsx";
import type { Me } from "../lib/me.ts";
import type { Persona } from "../lib/personas.ts";

/**
 * The Personas pages, rendered and driven the way somebody with a keyboard
 * drives them.
 *
 * Nothing here asserts that a component exists or that a source file contains
 * a string. Every test puts the API's real answers in front of a real
 * component and reads what the DOM then says — which is the only kind of proof
 * that survives the page being rewritten.
 *
 * Three of these exist because ticket 02 shipped the defects they name and had
 * to fix them: a role guessed while the session is in flight, an answer
 * rendered into a project it was not fetched for, and a failed request
 * swallowed. Every list page after that one walks into all three.
 */

const routed = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/projects/prj_1/personas",
  projectId: "prj_1",
  personaId: "prs_1",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: routed.push, replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ projectId: routed.projectId, personaId: routed.personaId }),
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

/**
 * Whatever egma is standing in for, keyed by **method and path** — because
 * these pages read and write the same address, and a stub that could not tell
 * `GET /api/personas/prs_1` from `PATCH /api/personas/prs_1` would prove
 * nothing about either.
 *
 * A key may be given a list, answered in order and then repeating its last
 * entry: that is how a write that is refused and then succeeds is written.
 */
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

const RITA: Persona = {
  id: "prs_1",
  project_id: "prj_1",
  owner: "organization",
  name: "Impatient Rita",
  description: "Somebody in a hurry.",
  version: 1,
  version_id: "prsv_1",
  traits: {
    personality: "Seventy, hard of hearing, and gets louder when she mishears.",
  },
  revision: "revision-one",
  archived_at: null,
  is_default: false,
  created_at: "2026-08-15T10:00:00.000Z",
  updated_at: "2026-08-15T10:00:00.000Z",
};

const DEFAULT_PERSONA: Persona = {
  ...RITA,
  id: "prs_0",
  project_id: null,
  owner: "egma",
  name: "Default Persona",
  description: "Regular conversationalist persona",
  traits: {
    personality:
      "Speaks clear, natural english. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
  },
  revision: "revision-default-persona",
  is_default: true,
};

beforeEach(() => {
  routed.push.mockReset();
  routed.pathname = "/projects/prj_1/personas";
  routed.projectId = "prj_1";
  routed.personaId = "prs_1";
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------------ */

describe("the Personas list", () => {
  it("names its project and says who owns each persona", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/personas": {
        status: 200,
        body: { items: [RITA, DEFAULT_PERSONA], next_cursor: null },
      },
    });
    render(<PersonasPage />);

    // Once, because the table changes layout without cloning the row.
    expect(await screen.findAllByText("Impatient Rita")).toHaveLength(1);
    expect(asked.map((one) => one.path)).toContain("/api/personas?project=prj_1");

    const table = screen.getByRole("table", {
      name: "Active personas in this project",
    });
    expect(
      within(table).getByRole("columnheader", { name: "Owner" }),
    ).toBeDefined();
    expect(
      within(table).getByRole("columnheader", { name: "Default" }),
    ).toBeDefined();

    const customRow = screen.getByText("Impatient Rita").closest("tr");
    const predefinedRow = screen.getByText("Default Persona").closest("tr");
    expect(customRow).not.toBeNull();
    expect(predefinedRow).not.toBeNull();
    expect(within(customRow!).getByText("You")).toBeDefined();
    expect(within(predefinedRow!).getByText("Egma")).toBeDefined();
    expect(within(customRow!).getByText("—")).toBeDefined();
    expect(within(predefinedRow!).getByText("Yes")).toBeDefined();

    expect(within(table).queryByText("Project default")).toBeNull();
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  it("shows the archive as a separate list, asked for separately", async () => {
    const archived: Persona = {
      ...RITA,
      id: "prs_9",
      name: "Retired Rex",
      archived_at: "2026-08-14T09:00:00.000Z",
    };
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/personas": [
        { status: 200, body: { items: [RITA], next_cursor: null } },
        { status: 200, body: { items: [archived], next_cursor: null } },
      ],
    });
    render(<PersonasPage />);

    expect(await screen.findAllByText("Impatient Rita")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("radio", { name: "Archived" }));

    expect(await screen.findAllByText("Retired Rex")).not.toHaveLength(0);
    expect(screen.queryByText("Impatient Rita")).toBeNull();
    expect(asked.map((one) => one.path)).toContain(
      "/api/personas?archived=true&project=prj_1",
    );
  });

  it("says an empty archive is empty rather than saying the project has no personas", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/personas": [
        { status: 200, body: { items: [RITA], next_cursor: null } },
        { status: 200, body: { items: [], next_cursor: null } },
      ],
    });
    render(<PersonasPage />);

    expect(await screen.findAllByText("Impatient Rita")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("radio", { name: "Archived" }));

    expect(
      await screen.findByText("Nothing has been archived here"),
    ).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /**
   * **An unanswered session is not a viewer.** A page that guessed the least
   * role would put a disabled control in front of every admin on every load,
   * with a sentence about a role they do not hold.
   */
  it("offers no authoring control at all while the session is still in flight", async () => {
    apiAnswers({
      "GET /api/me": "never",
      "GET /api/personas": {
        status: 200,
        body: { items: [RITA], next_cursor: null },
      },
    });
    render(<PersonasPage />);

    expect(await screen.findAllByText("Impatient Rita")).not.toHaveLength(0);
    expect(screen.queryByRole("link", { name: "New persona" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New persona" })).toBeNull();
    expect(screen.queryByText(/role cannot/)).toBeNull();
  });

  it("offers a member the way to author, and a viewer the same control genuinely disabled", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "GET /api/personas": {
        status: 200,
        body: { items: [RITA], next_cursor: null },
      },
    });
    const { unmount } = render(<PersonasPage />);
    expect(await screen.findAllByRole("link", { name: "New persona" })).not.toHaveLength(0);
    unmount();

    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("viewer") },
      "GET /api/personas": {
        status: 200,
        body: { items: [RITA], next_cursor: null },
      },
    });
    render(<PersonasPage />);

    const refused = await screen.findByRole("button", { name: "New persona" });
    expect((refused as HTMLButtonElement).disabled).toBe(true);
    expect(refused.getAttribute("title")).toContain("viewer role cannot");
    expect(screen.queryByRole("link", { name: "New persona" })).toBeNull();
  });

  /**
   * A next page that does not arrive is still something that happened.
   * Swallowing it leaves somebody pressing a control that re-enables itself,
   * says nothing, and never works.
   */
  it("says so when the next page fails, and lets somebody ask again on purpose", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/personas": [
        { status: 200, body: { items: [RITA], next_cursor: "prs_1" } },
        {
          status: 503,
          body: {
            error: "unavailable",
            message: "Egma could not reach the personas store.",
          },
        },
        {
          status: 200,
          body: {
            items: [{ ...RITA, id: "prs_2", name: "Patient Pat" }],
            next_cursor: null,
          },
        },
      ],
    });
    render(<PersonasPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));

    const said = await screen.findByRole("alert");
    expect(said.textContent).toContain("Egma could not reach the personas store.");

    fireEvent.click(within(said).getByRole("button", { name: "Try again" }));

    expect(await screen.findAllByText("Patient Pat")).not.toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /**
   * Press `Show more` in one project, change project before the answer comes
   * back, and the rows that arrive belong to the project nobody is looking at
   * any more. They were correctly scoped when they were sent — the server was
   * never wrong — and showing them under another project's name would make
   * somebody distrust everything else on the screen.
   */
  it("drops a next page that arrives after the project changed", async () => {
    let release: (answer: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const at = new URL(String(input), "http://egma.test");
        if (at.pathname === "/api/me") return json(200, meWith("admin"));
        if (at.searchParams.has("cursor")) return pending;
        const project = at.searchParams.get("project");
        return json(200, {
          items: [
            {
              ...RITA,
              id: `prs_${String(project)}`,
              project_id: String(project),
              name: project === "prj_1" ? "Impatient Rita" : "Night-shift Nell",
            },
          ],
          next_cursor: "prs_cursor",
        });
      }),
    );

    const { rerender } = render(<PersonasPage />);
    expect(await screen.findAllByText("Impatient Rita")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    // Somebody chooses another project while that read is still in flight. The
    // page is not remounted — it is the same route with another project in it.
    routed.projectId = "prj_2";
    routed.pathname = "/projects/prj_2/personas";
    rerender(<PersonasPage />);
    expect(await screen.findAllByText("Night-shift Nell")).not.toHaveLength(0);

    release(
      json(200, {
        items: [{ ...RITA, id: "prs_stale", name: "Somebody else's project" }],
        next_cursor: null,
      }),
    );
    await new Promise((settle) => setTimeout(settle, 0));

    expect(screen.queryByText("Somebody else's project")).toBeNull();
    expect(screen.queryAllByText("Impatient Rita")).toHaveLength(0);
  });

  /**
   * The same race, one filter across instead of one project across. Both are
   * the same component with another value in it, so the same state outlives
   * both changes — and an archived page rendered into the active list would be
   * a list of rows nobody can act on.
   */
  it("drops a next page that arrives after the filter changed", async () => {
    let release: (answer: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const at = new URL(String(input), "http://egma.test");
        if (at.pathname === "/api/me") return json(200, meWith("admin"));
        if (at.searchParams.has("cursor")) return pending;
        const archived = at.searchParams.get("archived") === "true";
        return json(200, {
          items: [
            {
              ...RITA,
              id: archived ? "prs_a" : "prs_b",
              name: archived ? "Retired Rex" : "Impatient Rita",
              archived_at: archived ? "2026-08-14T09:00:00.000Z" : null,
            },
          ],
          next_cursor: "prs_cursor",
        });
      }),
    );

    render(<PersonasPage />);
    expect(await screen.findAllByText("Impatient Rita")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    fireEvent.click(screen.getByRole("radio", { name: "Archived" }));
    expect(await screen.findAllByText("Retired Rex")).not.toHaveLength(0);

    release(
      json(200, {
        items: [{ ...RITA, id: "prs_stale", name: "An active persona" }],
        next_cursor: null,
      }),
    );
    await new Promise((settle) => setTimeout(settle, 0));

    expect(screen.queryByText("An active persona")).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */

describe("authoring a persona", () => {
  it("sends name, description, and personality, and lands on the persona it made", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "POST /api/personas": {
        status: 201,
        body: { ...RITA, id: "prs_new" },
      },
    });
    render(<NewPersonaPage />);

    for (const removed of [
      "Manner",
      "Patience",
      "Under friction",
      "Accent",
      "Background noise",
      "Language",
      "Voice provider",
      "Voice",
      "Speech rate",
    ]) {
      expect(screen.queryByLabelText(removed), removed).toBeNull();
    }

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Impatient Rita" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Personality" }), {
      target: { value: "Seventy, and gets louder when she mishears." },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Somebody in a hurry." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create persona" }));

    await screen.findByRole("button", { name: "Create persona" });

    const written = asked.find((one) => one.method === "POST");
    expect(written?.body).toMatchObject({
      project: "prj_1",
      name: "Impatient Rita",
      description: "Somebody in a hurry.",
      traits: {
        personality: "Seventy, and gets louder when she mishears.",
      },
    });
    expect(Object.keys((written?.body as { traits: object }).traits)).toEqual([
      "personality",
    ]);
    expect(asked.some((one) => one.path.startsWith("/api/persona-form"))).toBe(
      false,
    );
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/personas/prs_new");
  });

  it("keeps everything typed when egma refuses, and shows what it said", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "POST /api/personas": {
        status: 422,
        body: { error: "unprocessable", message: "a persona needs a name" },
      },
    });
    render(<NewPersonaPage />);

    fireEvent.change(
      await screen.findByRole("textbox", { name: "Personality" }),
      {
        target: { value: "Somebody in a hurry." },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Create persona" }));

    const said = await screen.findByRole("alert");
    expect(said.textContent).toContain("a persona needs a name");
    expect(
      (
        screen.getByRole("textbox", {
          name: "Personality",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Somebody in a hurry.");
    expect(routed.push).not.toHaveBeenCalled();
  });

  it("leaves a viewer the form to read and no way to submit it", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("viewer") },
    });
    render(<NewPersonaPage />);

    const submit = (await screen.findByRole("button", {
      name: "Create persona",
    })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute("title")).toContain("viewer role cannot");
  });
});

/* ------------------------------------------------------------------------ */

describe("one persona's page", () => {
  const reads = (persona: Persona = RITA) => ({
    "GET /api/me": { status: 200, body: meWith("member") },
    "GET /api/personas/prs_1": { status: 200, body: persona },
    "GET /api/personas/prs_1/versions": {
      status: 200,
      body: {
        items: [
          {
            id: "prsv_1",
            persona_id: "prs_1",
            version: 1,
            traits: persona.traits,
            created_at: "2026-08-15T10:00:00.000Z",
          },
        ],
        next_cursor: null,
      },
    },
  });

  it("keeps one save disabled until a live field changes, then sends no version expectation", async () => {
    const { asked } = apiAnswers({
      ...reads(),
      "PATCH /api/personas/prs_1": {
        status: 200,
        body: { ...RITA, name: "Rita", revision: "revision-two" },
      },
    });
    render(<PersonaPage />);

    const name = await screen.findByLabelText("Name");
    const save = screen.getByRole("button", { name: "Save changes" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(name, {
      target: { value: "Rita" },
    });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);

    await vi.waitFor(() => {
      expect(asked.filter((one) => one.method === "PATCH")).toHaveLength(1);
    });
    const written = asked.find((one) => one.method === "PATCH")?.body as
      | Record<string, unknown>
      | undefined;

    expect(written).toMatchObject({
      project: "prj_1",
      expected_revision: "revision-one",
      name: "Rita",
    });
    // A rename is not a content change, so it names no version — sending one
    // would make a rename fail because somebody else edited the traits.
    expect(written).not.toHaveProperty("expected_version_id");
    expect(written).not.toHaveProperty("traits");
    expect(written).not.toHaveProperty("description");
  });

  it("saves personality with both expectations, because it mints a version", async () => {
    const { asked } = apiAnswers({
      ...reads(),
      "PATCH /api/personas/prs_1": {
        status: 200,
        body: { ...RITA, version: 2, version_id: "prsv_2" },
      },
    });
    render(<PersonaPage />);

    fireEvent.change(
      await screen.findByRole("textbox", { name: "Personality" }),
      {
        target: { value: "Patient at first, then asks for a person." },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await vi.waitFor(() => {
      expect(asked.filter((one) => one.method === "PATCH")).toHaveLength(1);
    });
    const written = asked.find((one) => one.method === "PATCH")?.body as
      | Record<string, unknown>
      | undefined;

    expect(written).toMatchObject({
      expected_revision: "revision-one",
      expected_version_id: "prsv_1",
      traits: { personality: "Patient at first, then asks for a person." },
    });
    expect(written).not.toHaveProperty("name");
    expect(written).not.toHaveProperty("description");
  });

  it("sends every changed field in one write and one version request", async () => {
    const personality = "Patient at first, then asks for a person.";
    const { asked } = apiAnswers({
      ...reads(),
      "PATCH /api/personas/prs_1": {
        status: 200,
        body: {
          ...RITA,
          name: "Rita",
          description: "Wants a quick answer.",
          traits: { personality },
          version: 2,
          version_id: "prsv_2",
          revision: "revision-two",
        },
      },
    });
    render(<PersonaPage />);

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Rita" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Wants a quick answer." },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Personality" }), {
      target: { value: personality },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await vi.waitFor(() => {
      expect(asked.filter((one) => one.method === "PATCH")).toHaveLength(1);
    });
    expect(asked.find((one) => one.method === "PATCH")?.body).toMatchObject({
      project: "prj_1",
      expected_revision: "revision-one",
      expected_version_id: "prsv_1",
      name: "Rita",
      description: "Wants a quick answer.",
      traits: { personality },
    });
  });

  /**
   * A conflict is recoverable or it is a lost afternoon. What somebody typed
   * stays exactly where it is, the refusal says what to do next, and reading
   * the persona again is a control rather than a page reload.
   */
  it("keeps the edit when a stale write is refused, and offers the way back", async () => {
    apiAnswers({
      ...reads(),
      "PATCH /api/personas/prs_1": {
        status: 409,
        body: {
          error: "version_conflict",
          message:
            "this persona edit was written against version prsv_1, and it has moved on to prsv_2.",
        },
      },
    });
    render(<PersonaPage />);

    fireEvent.change(
      await screen.findByRole("textbox", { name: "Personality" }),
      {
        target: { value: "Patient at first, then asks for a person." },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const said = await screen.findByRole("alert");
    expect(said.textContent).toContain("has moved on to prsv_2");
    expect(within(said).getByRole("button", { name: /Read this persona again/ }))
      .toBeDefined();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Personality",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Patient at first, then asks for a person.");
  });

  it("shows an older version on its own, without leaving the page", async () => {
    const current = {
      ...RITA,
      version: 2,
      version_id: "prsv_2",
      traits: { personality: "Patient now, but still hard of hearing." },
    };
    apiAnswers({
      ...reads(current),
      "GET /api/personas/prs_1/versions": {
        status: 200,
        body: {
          items: [
            {
              id: "prsv_2",
              persona_id: "prs_1",
              version: 2,
              traits: current.traits,
              created_at: "2026-08-16T10:00:00.000Z",
            },
            {
              id: "prsv_1",
              persona_id: "prs_1",
              version: 1,
              traits: RITA.traits,
              created_at: "2026-08-15T10:00:00.000Z",
            },
          ],
          next_cursor: null,
        },
      },
    });
    render(<PersonaPage />);

    const historyButton = await screen.findByRole("button", {
      name: "Version history",
    });
    expect(screen.queryByRole("button", { name: "Read" })).toBeNull();
    fireEvent.click(historyButton);

    const history = await screen.findByRole("dialog", {
      name: "Version history",
    });
    expect(history.getAttribute("data-kind")).toBe("sheet");
    expect(history.textContent).toContain(
      "Newest first. Past versions do not change and stay readable.",
    );
    const versions = within(history).getAllByRole("listitem");
    expect(versions).toHaveLength(2);
    expect(versions[0]?.textContent).toContain("v2");
    expect(versions[0]?.textContent).toContain("Current");
    expect(versions[1]?.textContent).toContain("v1");

    fireEvent.click(within(versions[1]!).getByRole("button", { name: "Read" }));

    const version = await screen.findByRole("dialog", { name: "Version 1" });
    expect(version.textContent).toContain("hard of hearing");

    fireEvent.click(within(version).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Version 1" })).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Version history" }),
    ).toBeDefined();
  });

  it("asks who takes the pointer before archiving the project's default", async () => {
    const { asked } = apiAnswers({
      ...reads({ ...RITA, is_default: true }),
      "GET /api/personas": {
        status: 200,
        body: {
          items: [
            { ...RITA, is_default: true },
            { ...RITA, id: "prs_2", name: "Taking-Over Tam", is_default: false },
          ],
          next_cursor: null,
        },
      },
      "POST /api/personas/prs_1/archive": {
        status: 200,
        body: { ...RITA, archived_at: "2026-08-15T12:00:00.000Z" },
      },
    });
    render(<PersonaPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByLabelText("Replacement default persona"),
    ).toBeDefined();

    fireEvent.change(within(dialog).getByLabelText("Replacement default persona"), {
      target: { value: "prs_2" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Archive persona" }),
    );

    await screen.findByRole("button", { name: "Archive" });
    const written = asked.find((one) => one.path.endsWith("/archive"))?.body;
    expect(written).toMatchObject({
      expected_revision: "revision-one",
      replacement_persona_id: "prs_2",
    });
  });

  it("asks nobody anything before archiving a persona that is not the default", async () => {
    const { asked } = apiAnswers({
      ...reads(),
      "POST /api/personas/prs_1/archive": {
        status: 200,
        body: { ...RITA, archived_at: "2026-08-15T12:00:00.000Z" },
      },
    });
    render(<PersonaPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("Replacement default persona")).toBeNull();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Archive persona" }),
    );

    await screen.findByRole("button", { name: "Archive" });
    const written = asked.find((one) => one.path.endsWith("/archive"))?.body as
      | Record<string, unknown>
      | undefined;
    expect(written).toMatchObject({ expected_revision: "revision-one" });
    expect(written).not.toHaveProperty("replacement_persona_id");
  });

  it("offers Restore rather than Archive once somebody is archived", async () => {
    apiAnswers(reads({ ...RITA, archived_at: "2026-08-14T09:00:00.000Z" }));
    render(<PersonaPage />);

    expect(await screen.findByRole("button", { name: "Restore" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0);
  });

  it("shows an Egma-owned persona as plain text with history in a sheet, then forks it", async () => {
    const egmaProvided: Persona = {
      ...DEFAULT_PERSONA,
      id: "prs_1",
    };
    const { asked } = apiAnswers({
      ...reads(egmaProvided),
      "POST /api/personas/prs_1/fork": {
        status: 201,
        body: { ...RITA, id: "prs_fork" },
      },
    });
    render(<PersonaPage />);

    const title = await screen.findByRole("heading", {
      level: 1,
      name: "Default Persona",
    });
    const header = title.closest("header");
    if (header === null) throw new Error("the persona title needs a page header");
    expect(within(header).queryByText("Egma")).toBeNull();
    expect(within(header).getByText("Project default")).toBeDefined();
    expect(within(header).queryByText("v1")).toBeNull();
    expect(within(header).queryByText(/Updated/)).toBeNull();
    expect(
      within(header).getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Version history", "Fork"]);

    const details = await screen.findByRole("region", {
      name: "Persona details",
    });
    expect(
      Array.from(details.querySelectorAll("dt"), (term) => term.textContent),
    ).toEqual(["Name", "Description", "Personality"]);
    expect(
      Array.from(details.querySelectorAll("dd"), (definition) =>
        definition.textContent
      ),
    ).toEqual([
      "Default Persona",
      "Regular conversationalist persona",
      "Speaks clear, natural english. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
    ]);
    expect(
      screen.getAllByText("Regular conversationalist persona"),
    ).toHaveLength(1);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Personality" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Read" })).toBeNull();

    fireEvent.click(
      within(header).getByRole("button", { name: "Version history" }),
    );
    const history = await screen.findByRole("dialog", {
      name: "Version history",
    });
    expect(history.getAttribute("data-kind")).toBe("sheet");
    const versions = within(history).getAllByRole("listitem");
    expect(versions).toHaveLength(1);
    expect(within(versions[0]!).getByText("v1")).toBeDefined();
    expect(within(versions[0]!).getByText("Current")).toBeDefined();

    fireEvent.click(
      within(versions[0]!).getByRole("button", { name: "Read" }),
    );
    const version = await screen.findByRole("dialog", { name: "Version 1" });
    expect(version.textContent).toContain("Version 1");
    expect(version.textContent).toContain("Speaks clear, natural english.");
    fireEvent.click(within(version).getByRole("button", { name: "Close" }));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Version history" }),
      ).getByRole("button", { name: "Close" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await vi.waitFor(() => {
      expect(asked.some((one) => one.path === "/api/personas/prs_1/fork")).toBe(
        true,
      );
      expect(routed.push).toHaveBeenCalledWith(
        "/projects/prj_1/personas/prs_fork",
      );
    });
  });

  it("leaves a viewer every field genuinely inert, and every write control disabled", async () => {
    apiAnswers({ ...reads(), "GET /api/me": { status: 200, body: meWith("viewer") } });
    render(<PersonaPage />);

    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(
      (
        screen.getByRole("textbox", {
          name: "Personality",
        }) as HTMLTextAreaElement
      ).disabled,
    ).toBe(true);

    for (const label of ["Save changes", "Fork", "Archive"]) {
      const control = screen.getByRole("button", { name: label }) as HTMLButtonElement;
      expect(control.disabled, label).toBe(true);
      expect(control.getAttribute("title"), label).toContain("viewer role cannot");
    }
    expect(
      (screen.getByRole("button", {
        name: "Version history",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows a persona this project has not got as an absence, in egma's words", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "GET /api/personas/prs_1": {
        status: 404,
        body: {
          error: "not_found",
          message:
            "There is no persona prs_1 available in this project. Check the link, or choose it from the current project.",
        },
      },
      "GET /api/personas/prs_1/versions": {
        status: 404,
        body: { error: "not_found", message: "There is no persona prs_1." },
      },
    });
    render(<PersonaPage />);

    expect(await screen.findByText("Not available here")).toBeDefined();
    expect(screen.getByText(/available in this project/)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says a failed read failed, and offers a deliberate retry", async () => {
    apiAnswers({
      ...reads(),
      "GET /api/personas/prs_1": [
        {
          status: 503,
          body: {
            error: "unavailable",
            message: "Egma could not reach the personas store.",
          },
        },
        { status: 200, body: RITA },
      ],
    });
    render(<PersonaPage />);

    const said = await screen.findByRole("alert");
    expect(said.textContent).toContain("Egma could not reach the personas store.");

    fireEvent.click(within(said).getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Name")).toBeDefined();
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The keyboard, on the two controls this area adds to the shared system.
 *
 * Neither is a link and neither is a native radio, so neither gets any of this
 * for free — and a filter that only a pointer can reach is a filter half the
 * people using egma do not have.
 */
describe("driving the Personas area without a pointer", () => {
  it("chooses the other list from the keyboard, and says which is chosen", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/personas": [
        { status: 200, body: { items: [RITA], next_cursor: null } },
        { status: 200, body: { items: [], next_cursor: null } },
      ],
    });
    render(<PersonasPage />);

    const archived = await screen.findByRole("radio", { name: "Archived" });
    const active = screen.getByRole("radio", { name: "Active" });
    expect(active.getAttribute("aria-checked")).toBe("true");
    expect(archived.getAttribute("aria-checked")).toBe("false");

    // One Tab stop for the group, and an arrow key moves inside it — which is
    // what announcing a radiogroup promises anybody using a screen reader.
    expect(active.getAttribute("tabindex")).toBe("0");
    expect(archived.getAttribute("tabindex")).toBe("-1");

    active.focus();
    fireEvent.keyDown(active, { key: "ArrowRight" });

    expect(await screen.findByText("Nothing has been archived here")).toBeDefined();
    const now = screen.getByRole("radio", { name: "Archived" });
    expect(now.getAttribute("aria-checked")).toBe("true");
    expect(now.getAttribute("tabindex")).toBe("0");
    // Selection follows focus, so the keyboard and the announcement agree.
    expect(document.activeElement).toBe(now);
  });

  it("traps focus in version history, closes it with Escape, and restores its trigger", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "GET /api/personas/prs_1": { status: 200, body: RITA },
      "GET /api/personas/prs_1/versions": {
        status: 200,
        body: {
          items: [
            {
              id: "prsv_1",
              persona_id: "prs_1",
              version: 1,
              traits: RITA.traits,
              created_at: "2026-08-15T10:00:00.000Z",
            },
          ],
          next_cursor: null,
        },
      },
    });
    render(<PersonaPage />);

    const trigger = await screen.findByRole("button", {
      name: "Version history",
    });
    trigger.focus();
    fireEvent.click(trigger);

    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    expect(sheet.getAttribute("data-kind")).toBe("sheet");
    expect(sheet.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The three failures ticket 02 shipped, asked of this area's own paths.
 *
 * Each one is written as the thing somebody would actually do — press Archive
 * while the store is down, save and then open another persona, arrive before
 * `/api/me` answers — because each of them once looked like nothing happening
 * at all.
 */
describe("what this page does when something goes wrong underneath it", () => {
  const reading = {
    "GET /api/me": { status: 200, body: meWith("member") },
    "GET /api/personas/prs_1/versions": {
      status: 200,
      body: { items: [], next_cursor: null },
    },
  } as const;

  /**
   * **A read that fails silently takes the default persona out of the
   * product.** The choice never arrives, Archive stays disabled, and the one
   * persona a project cannot do without becomes the one nobody can archive.
   */
  it("says why the replacements could not be read, and lets somebody ask again", async () => {
    apiAnswers({
      ...reading,
      "GET /api/personas/prs_1": {
        status: 200,
        body: { ...RITA, is_default: true },
      },
      "GET /api/personas": [
        {
          status: 503,
          body: {
            error: "unavailable",
            message: "Egma could not reach the personas store.",
          },
        },
        {
          status: 200,
          body: {
            items: [
              { ...RITA, is_default: true },
              { ...RITA, id: "prs_2", name: "Taking-Over Tam", is_default: false },
            ],
            next_cursor: null,
          },
        },
      ],
    });
    render(<PersonaPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog");

    const said = await within(dialog).findByRole("alert");
    expect(said.textContent).toContain("Egma could not reach the personas store.");
    expect(
      (within(dialog).getByRole("button", {
        name: "Archive persona",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(within(said).getByRole("button", { name: "Try again" }));

    expect(
      await within(dialog).findByLabelText("Replacement default persona"),
    ).toBeDefined();
    expect(
      (within(dialog).getByRole("button", {
        name: "Archive persona",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("sends an expired session where the rest of the application sends one", async () => {
    const replaced = vi.fn();
    vi.stubGlobal("location", { replace: replaced, assign: vi.fn() });
    apiAnswers({
      ...reading,
      "GET /api/personas/prs_1": {
        status: 200,
        body: { ...RITA, is_default: true },
      },
      "GET /api/personas": {
        status: 401,
        body: { error: "not_authenticated", message: "sign in" },
      },
    });
    render(<PersonaPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    await screen.findByRole("dialog");
    await new Promise((settle) => setTimeout(settle, 0));

    expect(replaced).toHaveBeenCalledWith("/sign-in");
  });

  /**
   * Save on persona A, open persona B while the write is in flight, and A's
   * refusal lands on B — a sentence about work nobody can see, over fields it
   * does not describe. The list page carries the project with its data for the
   * same reason; this is that rule on the write path.
   */
  it("drops a write's refusal that arrives after another persona was opened", async () => {
    let release: (answer: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });

    const personaFor = (id: string) =>
      json(200, { ...RITA, id, name: id === "prs_1" ? "Impatient Rita" : "Patient Pat" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const at = new URL(String(input), "http://egma.test");
        if (at.pathname === "/api/me") return json(200, meWith("member"));
        if ((init?.method ?? "GET") !== "GET") return pending;
        if (at.pathname.endsWith("/versions")) {
          return json(200, { items: [], next_cursor: null });
        }
        return personaFor(at.pathname.split("/").pop() ?? "prs_1");
      }),
    );

    const { rerender } = render(<PersonaPage />);
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Rita" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // Somebody opens another persona while that write is still in flight. The
    // page is not remounted — it is the same route with another id in it.
    routed.personaId = "prs_2";
    routed.pathname = "/projects/prj_1/personas/prs_2";
    rerender(<PersonaPage />);
    expect(await screen.findByDisplayValue("Patient Pat")).toBeDefined();

    release(
      json(409, {
        error: "identity_conflict",
        message: "Persona prs_1 changed after you opened it.",
      }),
    );
    await new Promise((settle) => setTimeout(settle, 0));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Persona prs_1 changed/)).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Patient Pat",
    );
  });

  /**
   * **An unanswered session is not a viewer.** A disabled field is a claim,
   * and while `/api/me` is in flight there is nobody to make that claim about.
   */
  it("offers no editor at all until it knows whose page this is", async () => {
    apiAnswers({
      ...reading,
      "GET /api/me": "never",
      "GET /api/personas/prs_1": { status: 200, body: RITA },
    });
    render(<PersonaPage />);

    // The persona is readable, which is the half that does not depend on a role.
    expect(await screen.findAllByText(/hard of hearing/)).not.toHaveLength(0);

    // And nothing claims anything about a role egma has not been told yet.
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByText(/role cannot/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Version history" }),
    ).toBeDefined();
  });

  it("gives a viewer the reason without a pointer, not only in a tooltip", async () => {
    apiAnswers({
      ...reading,
      "GET /api/me": { status: 200, body: meWith("viewer") },
      "GET /api/personas/prs_1": { status: 200, body: RITA },
    });
    render(<PersonaPage />);

    const save = (await screen.findByRole("button", {
      name: "Save changes",
    })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // The sentence is on the page and the control names it, so it reaches a
    // screen reader and a keyboard — not only a hovering mouse.
    const described = save.getAttribute("aria-describedby");
    expect(described).not.toBeNull();
    expect(document.getElementById(String(described))?.textContent).toContain(
      "viewer role cannot",
    );
  });
});

/* ------------------------------------------------------------------------ */

/**
 * What the editor shows after a save.
 *
 * The API normalizes authored text. Leaving the typed text in the field would
 * put the author in front of words the system did not accept — disagreeing
 * with the facts on the same page, and not what the next save would be
 * compared against.
 */
describe("after a save lands", () => {
  it("shows what egma kept, not what was typed at it", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "GET /api/personas/prs_1": { status: 200, body: RITA },
      "GET /api/personas/prs_1/versions": {
        status: 200,
        body: { items: [], next_cursor: null },
      },
      "PATCH /api/personas/prs_1": {
        status: 200,
        body: {
          ...RITA,
          version: 2,
          version_id: "prsv_2",
          revision: "revision-two",
          traits: { personality: "calm" },
        },
      },
    });
    render(<PersonaPage />);

    fireEvent.change(
      await screen.findByRole("textbox", { name: "Personality" }),
      {
        target: { value: "  calm  " },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // Sent as typed, because what may be trimmed is the server's rule.
    const written = asked.find((one) => one.method === "PATCH")?.body as
      | { traits: Record<string, unknown> }
      | undefined;
    expect(written?.traits.personality).toBe("  calm  ");

    // Shown as kept, because that is what egma is holding now.
    //
    // The value is read off the element rather than matched through a query:
    // a matcher normalizes whitespace, and whitespace is the whole difference
    // this test is about. The element is looked up again on each attempt
    // because the read that follows a save remounts the form.
    await vi.waitFor(() => {
      const field = screen.getByRole("textbox", {
        name: "Personality",
      }) as HTMLTextAreaElement;
      expect(field.value).toBe("calm");
    });
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The other half of adopting a save's answer, and the half it is easy to
 * break while fixing the first.
 *
 * A save takes a moment. Somebody typing in the next field during that moment
 * has written something the server has never seen, so its reply says nothing
 * about it — and adopting the whole reply would eat those keystrokes to fix a
 * trim. Both properties have to hold at once, which is why this sits beside
 * the trim test rather than replacing it.
 */
describe("a save answering while the author is still typing", () => {
  it("takes the server's word for what it saw, and nobody else's field", async () => {
    let release: (answer: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const at = new URL(String(input), "http://egma.test");
        if (at.pathname === "/api/me") return json(200, meWith("member"));
        if ((init?.method ?? "GET") !== "GET") return pending;
        if (at.pathname.endsWith("/versions")) {
          return json(200, { items: [], next_cursor: null });
        }
        return json(200, RITA);
      }),
    );

    render(<PersonaPage />);

    // A name that egma will trim, sent.
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "  A  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const saving = screen.getByRole("button", { name: "Saving…" });
    expect((saving as HTMLButtonElement).disabled).toBe(true);
    expect(saving.getAttribute("aria-busy")).toBe("true");

    // And a description typed while that save is still in the air. The server
    // has never seen this text.
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Typed while saving" },
    });

    release(
      json(200, {
        ...RITA,
        name: "A",
        description: "Somebody in a hurry.",
        revision: "revision-two",
      }),
    );

    // The name takes what egma kept…
    await vi.waitFor(() => {
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("A");
    });

    // …and the description keeps the newer keystrokes, rather than the value
    // the reply carried for a field it was never told about.
    expect(
      (screen.getByLabelText("Description") as HTMLInputElement).value,
    ).toBe("Typed while saving");
  });
});
