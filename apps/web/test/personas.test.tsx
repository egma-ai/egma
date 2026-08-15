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
  name: "Impatient Rita",
  description: "Somebody in a hurry.",
  version: 1,
  version_id: "prsv_1",
  traits: {
    personality: "Seventy, hard of hearing, and gets louder when she mishears.",
    language: "en-US",
    voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 1 },
    manner: "Brisk, and talks over the end of a sentence.",
    backgroundNoise: "A busy kitchen.",
  },
  revision: "revision-one",
  archived_at: null,
  is_default: false,
  created_at: "2026-08-15T10:00:00.000Z",
  updated_at: "2026-08-15T10:00:00.000Z",
};

const STARTER: Persona = {
  ...RITA,
  id: "prs_0",
  name: "Starter",
  description: null,
  revision: "revision-starter",
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
  it("names its project in the request and marks the one a test naming nobody gets", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /api/personas": {
        status: 200,
        body: { items: [RITA, STARTER], next_cursor: null },
      },
    });
    render(<PersonasPage />);

    // Twice, because one column definition draws the table and the list both.
    expect(await screen.findAllByText("Impatient Rita")).toHaveLength(2);
    expect(asked.map((one) => one.path)).toContain("/api/personas?project=prj_1");

    // The default persona is an ordinary row that says what it is, and it is
    // the only one that says it.
    expect(screen.getAllByTitle(/names nobody/)).toHaveLength(2);
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
  it("sends the traits somebody typed, and lands on the persona it made", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "POST /api/personas": {
        status: 201,
        body: { ...RITA, id: "prs_new" },
      },
      "GET /api/persona-form": {
        status: 200,
        body: { voice_providers: ["elevenlabs", "cartesia"] },
      },
    });
    render(<NewPersonaPage />);

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Impatient Rita" },
    });
    fireEvent.change(screen.getByLabelText("Personality"), {
      target: { value: "Seventy, and gets louder when she mishears." },
    });
    fireEvent.change(screen.getByLabelText("Under friction"), {
      target: { value: "Asks to escalate." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create persona" }));

    await screen.findByRole("button", { name: "Create persona" });

    const written = asked.find((one) => one.method === "POST");
    expect(written?.body).toMatchObject({
      project: "prj_1",
      name: "Impatient Rita",
      traits: {
        personality: "Seventy, and gets louder when she mishears.",
        underFriction: "Asks to escalate.",
      },
    });
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/personas/prs_new");
  });

  it("keeps everything typed when egma refuses, and shows what it said", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "POST /api/personas": {
        status: 422,
        body: { error: "unprocessable", message: "a persona needs a name" },
      },
      "GET /api/persona-form": {
        status: 200,
        body: { voice_providers: ["elevenlabs"] },
      },
    });
    render(<NewPersonaPage />);

    fireEvent.change(await screen.findByLabelText("Personality"), {
      target: { value: "Somebody in a hurry." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create persona" }));

    const said = await screen.findByRole("alert");
    expect(said.textContent).toContain("a persona needs a name");
    expect(
      (screen.getByLabelText("Personality") as HTMLTextAreaElement).value,
    ).toBe("Somebody in a hurry.");
    expect(routed.push).not.toHaveBeenCalled();
  });

  it("leaves a viewer the form to read and no way to submit it", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("viewer") },
      "GET /api/persona-form": {
        status: 200,
        body: { voice_providers: ["elevenlabs"] },
      },
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
    "GET /api/personas/prs_1/usage": { status: 200, body: { tests: [] } },
    "GET /api/persona-form": {
      status: 200,
      body: { voice_providers: ["elevenlabs", "cartesia", "openai"] },
    },
  });

  it("saves the live fields with the revision, and no version expectation at all", async () => {
    const { asked } = apiAnswers({
      ...reads(),
      "PATCH /api/personas/prs_1": {
        status: 200,
        body: { ...RITA, name: "Rita", revision: "revision-two" },
      },
    });
    render(<PersonaPage />);

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Rita" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await screen.findByRole("button", { name: "Save name" });
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
  });

  it("saves traits with both expectations, because a traits edit moves both", async () => {
    const { asked } = apiAnswers({
      ...reads(),
      "PATCH /api/personas/prs_1": {
        status: 200,
        body: { ...RITA, version: 2, version_id: "prsv_2" },
      },
    });
    render(<PersonaPage />);

    fireEvent.change(await screen.findByLabelText("Accent"), {
      target: { value: "Glaswegian" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save traits" }));

    await screen.findByRole("button", { name: "Save traits" });
    const written = asked.find((one) => one.method === "PATCH")?.body as
      | Record<string, unknown>
      | undefined;

    expect(written).toMatchObject({
      expected_revision: "revision-one",
      expected_version_id: "prsv_1",
      traits: { accent: "Glaswegian" },
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

    fireEvent.change(await screen.findByLabelText("Accent"), {
      target: { value: "Glaswegian" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save traits" }));

    const said = await screen.findByRole("alert");
    expect(said.textContent).toContain("has moved on to prsv_2");
    expect(within(said).getByRole("button", { name: /Read this persona again/ }))
      .toBeDefined();
    expect((screen.getByLabelText("Accent") as HTMLInputElement).value).toBe(
      "Glaswegian",
    );
  });

  it("shows an older version on its own, without leaving the page", async () => {
    apiAnswers(reads());
    render(<PersonaPage />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Read" }))[0]!);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Version 1");
    expect(dialog.textContent).toContain("hard of hearing");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
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

  it("names the active tests that would refuse an Archive", async () => {
    apiAnswers({
      ...reads(),
      "GET /api/personas/prs_1/usage": {
        status: 200,
        body: { tests: [{ id: "tst_1", name: "Reschedules an appointment" }] },
      },
    });
    render(<PersonaPage />);

    expect(await screen.findByText(/Reschedules an appointment/)).toBeDefined();
  });

  it("leaves a viewer every field genuinely inert, and every write control disabled", async () => {
    apiAnswers({ ...reads(), "GET /api/me": { status: 200, body: meWith("viewer") } });
    render(<PersonaPage />);

    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect((screen.getByLabelText("Personality") as HTMLTextAreaElement).disabled)
      .toBe(true);

    for (const label of ["Save name", "Save traits", "Clone", "Archive"]) {
      const control = screen.getByRole("button", { name: label }) as HTMLButtonElement;
      expect(control.disabled, label).toBe(true);
      expect(control.getAttribute("title"), label).toContain("viewer role cannot");
    }
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
      "GET /api/personas/prs_1/usage": {
        status: 404,
        body: { error: "not_found", message: "There is no persona prs_1." },
      },
      "GET /api/persona-form": {
        status: 200,
        body: { voice_providers: ["elevenlabs"] },
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

  it("puts focus inside an older-version read, and closes it with Escape", async () => {
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
      "GET /api/personas/prs_1/usage": { status: 200, body: { tests: [] } },
      "GET /api/persona-form": {
        status: 200,
        body: { voice_providers: ["elevenlabs"] },
      },
    });
    render(<PersonaPage />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Read" }))[0]!);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
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
    "GET /api/personas/prs_1/usage": { status: 200, body: { tests: [] } },
    "GET /api/persona-form": {
      status: 200,
      body: { voice_providers: ["elevenlabs"] },
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
        if (at.pathname === "/api/persona-form") {
          return json(200, { voice_providers: ["elevenlabs"] });
        }
        if ((init?.method ?? "GET") !== "GET") return pending;
        if (at.pathname.endsWith("/versions")) {
          return json(200, { items: [], next_cursor: null });
        }
        if (at.pathname.endsWith("/usage")) return json(200, { tests: [] });
        return personaFor(at.pathname.split("/").pop() ?? "prs_1");
      }),
    );

    const { rerender } = render(<PersonaPage />);
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Rita" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

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
    expect(screen.queryByRole("button", { name: "Save name" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save traits" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByText(/role cannot/)).toBeNull();
  });

  it("gives a viewer the reason without a pointer, not only in a tooltip", async () => {
    apiAnswers({
      ...reading,
      "GET /api/me": { status: 200, body: meWith("viewer") },
      "GET /api/personas/prs_1": { status: 200, body: RITA },
    });
    render(<PersonaPage />);

    const save = (await screen.findByRole("button", {
      name: "Save name",
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
 * egma trims a described trait and drops one that is only whitespace, so what
 * a save stores is not always what was typed. Leaving the typed text in the
 * field would put the author in front of words the system did not accept —
 * disagreeing with the facts on the same page, and not what the next save
 * would be compared against.
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
      "GET /api/personas/prs_1/usage": { status: 200, body: { tests: [] } },
      "GET /api/persona-form": {
        status: 200,
        body: { voice_providers: ["elevenlabs"] },
      },
      "PATCH /api/personas/prs_1": {
        status: 200,
        body: {
          ...RITA,
          version: 2,
          version_id: "prsv_2",
          revision: "revision-two",
          traits: { ...RITA.traits, accent: "calm" },
        },
      },
    });
    render(<PersonaPage />);

    fireEvent.change(await screen.findByLabelText("Accent"), {
      target: { value: "  calm  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save traits" }));

    // Sent as typed, because what may be trimmed is the server's rule.
    const written = asked.find((one) => one.method === "PATCH")?.body as
      | { traits: Record<string, unknown> }
      | undefined;
    expect(written?.traits.accent).toBe("  calm  ");

    // Shown as kept, because that is what egma is holding now.
    //
    // The value is read off the element rather than matched through a query:
    // a matcher normalizes whitespace, and whitespace is the whole difference
    // this test is about. The element is looked up again on each attempt
    // because the read that follows a save remounts the form.
    await vi.waitFor(() => {
      const field = screen.getByLabelText("Accent") as HTMLInputElement;
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
        if (at.pathname === "/api/persona-form") {
          return json(200, { voice_providers: ["elevenlabs"] });
        }
        if ((init?.method ?? "GET") !== "GET") return pending;
        if (at.pathname.endsWith("/versions")) {
          return json(200, { items: [], next_cursor: null });
        }
        if (at.pathname.endsWith("/usage")) return json(200, { tests: [] });
        return json(200, RITA);
      }),
    );

    render(<PersonaPage />);

    // A name that egma will trim, sent.
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "  A  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

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

/* ------------------------------------------------------------------------ */

/**
 * The third property, and the one that states the whole rule.
 *
 * This page has two forms with two saves. A reply carries the whole persona,
 * but for a field the request never mentioned that value is a stale read
 * rather than an answer — so adopting it would quietly undo an edit sitting
 * unsaved in the other form.
 *
 * **Adoption may touch exactly the fields the request carried, and among
 * those, only where the draft still holds what was sent.** The three tests in
 * this file are that sentence: this one is the first clause, the two above are
 * the second, and none of them is safe without the others.
 */
describe("a save from one form while the other holds an unsaved edit", () => {
  it("adopts what it asked about, and leaves the other form alone", async () => {
    let release: (answer: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const at = new URL(String(input), "http://egma.test");
        if (at.pathname === "/api/me") return json(200, meWith("member"));
        if (at.pathname === "/api/persona-form") {
          return json(200, { voice_providers: ["elevenlabs"] });
        }
        if ((init?.method ?? "GET") !== "GET") return pending;
        if (at.pathname.endsWith("/versions")) {
          return json(200, { items: [], next_cursor: null });
        }
        if (at.pathname.endsWith("/usage")) return json(200, { tests: [] });
        return json(200, RITA);
      }),
    );

    render(<PersonaPage />);

    // An accent typed into the traits form and deliberately not saved.
    fireEvent.change(await screen.findByLabelText("Accent"), {
      target: { value: "Glaswegian" },
    });

    // Then a name saved from the form above it, carrying no traits at all.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  A  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    // The reply carries the whole persona, accent and all — as every read of a
    // persona does. For the accent that value is a stale read, not an answer.
    release(json(200, { ...RITA, name: "A", revision: "revision-two" }));

    await vi.waitFor(() => {
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("A");
    });

    expect((screen.getByLabelText("Accent") as HTMLInputElement).value).toBe(
      "Glaswegian",
    );
  });
});
