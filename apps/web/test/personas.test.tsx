// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PersonaPage from "../app/projects/[projectId]/personas/[personaId]/page.tsx";
import NewPersonaPage from "../app/projects/[projectId]/personas/new/page.tsx";
import PersonasPage from "../app/projects/[projectId]/personas/page.tsx";
import type { Me } from "../lib/me.ts";
import type { Persona, PersonaForm, PersonaModels } from "../lib/personas.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

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
  /** The query, because which of the two lists is shown is an address. */
  search: "",
  projectId: "prj_1",
  personaId: "prs_1",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useSearchParams: () => new URLSearchParams(routed.search),
  useRouter: () => ({ push: routed.push, replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({
    projectId: routed.projectId,
    personaId: routed.personaId,
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: unknown;
  }) => (
    <a href={href} {...rest}>
      {children as never}
    </a>
  ),
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const PROJECTS = [
  { id: "prj_1", name: "Default", slug: "default" },
  { id: "prj_2", name: "Outbound", slug: "outbound" },
];

const RECOMMENDED_MODELS: PersonaModels = {
  llm: { provider: "openai", model: "gpt-4o-mini" },
  stt: { provider: "openai", model: "gpt-live-transcribe" },
  tts: {
    provider: "cartesia",
    model: "sonic-3.5",
    voiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    speed: 1,
  },
};

const PERSONA_FORM: PersonaForm = {
  modelCatalog: [
    { provider: "openai", job: "llm", model: "gpt-4o-mini", label: "OpenAI" },
    {
      provider: "openai",
      job: "stt",
      model: "gpt-live-transcribe",
      label: "OpenAI",
    },
    {
      provider: "deepgram",
      job: "stt",
      model: "nova-3-general",
      label: "Deepgram",
    },
    {
      provider: "cartesia",
      job: "tts",
      model: "sonic-3.5",
      label: "Cartesia",
      recommendedVoiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    },
    {
      provider: "openai",
      job: "tts",
      model: "gpt-4o-mini-tts",
      label: "OpenAI",
      recommendedVoiceId: "alloy",
    },
  ],
  recommendedModels: RECOMMENDED_MODELS,
  speedRange: { slowest: 0.6, fastest: 1.5 },
};

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
 * `GET /v1/personas/prs_1` from `PATCH /v1/personas/prs_1` would prove
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
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = await observeRequest(input, init);
      const { address: at, method } = request;
      const key = `${method} ${at.pathname}`;
      asked.push({
        method,
        path: `${at.pathname}${at.search}`,
        body: request.body,
      });

      /*
       * Three reads every one of these screens makes, defaulted so that a case
       * about something else does not have to stub them: the authoring
       * choices, the list the panel is drawn over, and the tests that name one
       * persona. A case that is *about* one of them still stubs it, and its
       * stub wins.
       */
      const held =
        answers[key] ??
        (key === "GET /v1/persona-form"
          ? { status: 200, body: PERSONA_FORM }
          : key === "GET /v1/personas"
            ? { status: 200, body: { personas: [], nextPageToken: null } }
            : at.pathname.endsWith("/usage")
              ? { status: 200, body: { tests: [] } }
              : undefined);
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
  projectId: "prj_1",
  owner: "organization",
  name: "Impatient Rita",
  description: "Somebody in a hurry.",
  version: 1,
  versionId: "prsv_1",
  traits: {
    personality: "Seventy, hard of hearing, and gets louder when she mishears.",
    language: "en-US",
    manner: "Warm and direct.",
    patience: "Waits once before asking again.",
    accent: "Neutral American English.",
    backgroundNoise: "A quiet kitchen.",
    underFriction: "Gets louder when the agent mishears her.",
  },
  models: RECOMMENDED_MODELS,
  revision: "revision-one",
  archivedAt: null,
  isDefault: false,
  createdAt: "2026-08-15T10:00:00.000Z",
  updatedAt: "2026-08-15T10:00:00.000Z",
};

const DEFAULT_PERSONA: Persona = {
  ...RITA,
  id: "prs_0",
  projectId: null,
  owner: "egma",
  name: "Default Persona",
  description: "Regular conversationalist persona",
  traits: {
    personality:
      "Speaks clear, natural English. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
    language: "en-US",
    manner: "Clear, natural, and conversational.",
    patience: "Starts patient and gives the agent time to explain.",
    accent: "Neutral American English.",
    backgroundNoise: "None.",
    underFriction:
      "Becomes firmer if the agent is confusing or repetitive, without becoming rude.",
  },
  revision: "revision-default-persona",
  isDefault: true,
};

beforeEach(() => {
  routed.push.mockReset();
  routed.pathname = "/projects/prj_1/personas";
  routed.search = "";
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
  it("shows the columns the boards name, and marks the default on its own row", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /v1/personas": {
        status: 200,
        body: { personas: [RITA, DEFAULT_PERSONA], nextPageToken: null },
      },
    });
    render(<PersonasPage />);

    // Once, because the table changes layout without cloning the row.
    expect(await screen.findAllByText("Impatient Rita")).toHaveLength(1);
    expect(asked.map((one) => one.path)).toContain(
      "/v1/personas?projectId=prj_1",
    );

    const table = screen.getByRole("table", {
      name: "Active personas in this project",
    });
    for (const column of [
      "Name",
      "Type",
      "Language",
      "Description",
      "Version",
      "Updated",
    ]) {
      expect(
        within(table).getByRole("columnheader", { name: column }),
        column,
      ).toBeDefined();
    }
    /*
     * **The Yes/No column is gone and the fact is not.** "Project default" was
     * a column that said No on every row but one, which is a column of noise
     * with one fact in it. The chip says the same thing on the row it is true
     * of and nowhere else.
     */
    expect(
      within(table).queryByRole("columnheader", { name: "Project default" }),
    ).toBeNull();

    const customRow = screen.getByText("Impatient Rita").closest("tr");
    const egmaProvidedRow = screen.getByText("Default Persona").closest("tr");
    expect(customRow).not.toBeNull();
    expect(egmaProvidedRow).not.toBeNull();
    expect(within(customRow!).getByText("Custom")).toBeDefined();
    expect(within(egmaProvidedRow!).getByText("Egma-provided")).toBeDefined();
    expect(within(egmaProvidedRow!).getByText("Default")).toBeDefined();
    expect(within(customRow!).queryByText("Default")).toBeNull();
    expect(within(customRow!).getByText("en-US")).toBeDefined();
    expect(within(customRow!).getByText("v1")).toBeDefined();
    expect(
      within(customRow!).getByRole("button", {
        name: "Actions for Impatient Rita",
      }),
    ).toBeDefined();
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  /**
   * A search that matches nobody is not an empty project, and saying so with
   * the empty project's words would send somebody looking for a persona they
   * have not lost.
   */
  it("filters by name, and offers the way out of a search that matches nobody", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /v1/personas": [
        {
          status: 200,
          body: { personas: [RITA, DEFAULT_PERSONA], nextPageToken: null },
        },
        { status: 200, body: { personas: [], nextPageToken: null } },
        {
          status: 200,
          body: { personas: [RITA, DEFAULT_PERSONA], nextPageToken: null },
        },
      ],
    });
    render(<PersonasPage />);
    expect(await screen.findAllByText("Impatient Rita")).not.toHaveLength(0);

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search personas by name" }),
      { target: { value: "nobody" } },
    );

    expect(await screen.findByText("No persona here matches that")).toBeDefined();
    expect(
      asked.some((one) => one.path.includes("search=nobody")),
    ).toBe(true);
    expect(screen.queryByText("No personas in this project yet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(await screen.findAllByText("Impatient Rita")).not.toHaveLength(0);
  });

  /**
   * **The archive was unreachable and Restore was a dead end.** The filter's
   * control came off this page in an earlier batch and nothing replaced it, so
   * the branch that reads the archived half was written, correct, and
   * impossible to arrive at. The footer link is the way back to it, and it is
   * an address rather than a control so a link to it can be sent.
   */
  it("reaches the archived list from the footer, and comes back from it", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /v1/personas": [
        { status: 200, body: { personas: [RITA], nextPageToken: null } },
        {
          status: 200,
          body: {
            personas: [
              {
                ...RITA,
                id: "prs_old",
                name: "Retired Ray",
                archivedAt: "2026-08-12T09:00:00.000Z",
              },
            ],
            nextPageToken: null,
          },
        },
      ],
    });
    const { rerender } = render(<PersonasPage />);

    expect(await screen.findByText("1 active persona ·")).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Archived" })
        .getAttribute("href"),
    ).toBe("/projects/prj_1/personas?archived=1");

    // Following the link is a change of address, not a change of state.
    routed.search = "archived=1";
    rerender(<PersonasPage />);

    expect(await screen.findAllByText("Retired Ray")).not.toHaveLength(0);
    expect(
      asked.some((one) => one.path.includes("archived=true")),
    ).toBe(true);
    expect(
      screen.getByText(/Out of the lists a test is authored from/),
    ).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Back to active" })
        .getAttribute("href"),
    ).toBe("/projects/prj_1/personas");
  });

  /*
   * **Three tests stood here and all three pressed the Archived radio.** The
   * control came off every list page in this batch, so none of them could
   * survive it — a test that clicks a control that is not drawn is not a
   * weakened test, it is a broken one.
   *
   * What they proved, and where it still is:
   *
   * - *The archive is asked for separately.* Still true and still proven, on
   *   the side that owns it: `apps/api/test/personas-routes.test.ts` asks
   *   `/v1/personas?archived=true` and reads the archived half back, keyset
   *   cursor and all. `personasPath` and `personasAfter` still carry the flag.
   * - *An empty archive says it is empty rather than saying the project has no
   *   personas.* The branch is still written and still reachable the moment the
   *   control returns, and it is now the one thing here with no test on it.
   *   Recorded rather than quietly dropped.
   * - *A next page that arrives after the filter changed is dropped.* The guard
   *   is untouched, and the test directly above still drives the same guard
   *   across a project change — the same state, the same race, one value along.
   */

  /**
   * **An unanswered session is not a viewer.** A page that guessed the least
   * role would put a disabled control in front of every admin on every load,
   * with a sentence about a role they do not hold.
   */
  it("offers no authoring control at all while the session is still in flight", async () => {
    apiAnswers({
      "GET /api/me": "never",
      "GET /v1/personas": {
        status: 200,
        body: { personas: [RITA], nextPageToken: null },
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
      "GET /v1/personas": {
        status: 200,
        body: { personas: [RITA], nextPageToken: null },
      },
    });
    const { unmount } = render(<PersonasPage />);
    expect(
      await screen.findAllByRole("link", { name: "New persona" }),
    ).not.toHaveLength(0);
    unmount();

    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("viewer") },
      "GET /v1/personas": {
        status: 200,
        body: { personas: [RITA], nextPageToken: null },
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
      "GET /v1/personas": [
        { status: 200, body: { personas: [RITA], nextPageToken: "prs_1" } },
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
            personas: [{ ...RITA, id: "prs_2", name: "Patient Pat" }],
            nextPageToken: null,
          },
        },
      ],
    });
    render(<PersonasPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));

    const said = await screen.findByRole("alert");
    expect(said.textContent).toContain(
      "Egma could not reach the personas store.",
    );

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
      vi.fn(async (input: FetchInput) => {
        const { address: at } = await observeRequest(input);
        if (at.pathname === "/api/me") return json(200, meWith("admin"));
        if (at.searchParams.has("pageToken")) return pending;
        const project = at.searchParams.get("projectId");
        return json(200, {
          personas: [
            {
              ...RITA,
              id: `prs_${String(project)}`,
              projectId: String(project),
              name: project === "prj_1" ? "Impatient Rita" : "Night-shift Nell",
            },
          ],
          nextPageToken: "prs_cursor",
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
        personas: [{ ...RITA, id: "prs_stale", name: "Somebody else's project" }],
        nextPageToken: null,
      }),
    );
    await new Promise((settle) => setTimeout(settle, 0));

    expect(screen.queryByText("Somebody else's project")).toBeNull();
    expect(screen.queryAllByText("Impatient Rita")).toHaveLength(0);
  });

});

/* ------------------------------------------------------------------------ */

describe("authoring a persona", () => {
  it("sends identity and complete human traits, and lands on the persona it made", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "GET /v1/persona-form": { status: 200, body: PERSONA_FORM },
      "POST /v1/personas": {
        status: 201,
        body: { ...RITA, id: "prs_new" },
      },
    });
    render(<NewPersonaPage />);

    for (const humanTrait of [
      "Manner",
      "Patience",
      "Under friction",
      "Accent",
      "Background noise",
      "Language",
    ]) {
      expect(await screen.findByLabelText(humanTrait), humanTrait).toBeDefined();
    }
    expect(screen.queryByLabelText("Voice provider")).toBeNull();

    expect(await screen.findAllByLabelText("Voice")).toHaveLength(1);
    expect(screen.getByLabelText("Language model")).toBeDefined();
    expect(screen.getByLabelText("Speech-to-text model")).toBeDefined();
    expect(screen.getByLabelText("Text-to-speech model")).toBeDefined();
    expect(screen.getByLabelText("Speech rate")).toBeDefined();
    expect(
      screen.getByText(
        "A multiple of the natural pace, from 0.6 to 1.5.",
      ),
    ).toBeDefined();

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
      projectId: "prj_1",
      name: "Impatient Rita",
      description: "Somebody in a hurry.",
      traits: {
        personality: "Seventy, and gets louder when she mishears.",
        language: "en-US",
        manner: "",
        patience: "",
        accent: "",
        backgroundNoise: "",
        underFriction: "",
      },
      models: RECOMMENDED_MODELS,
    });
    expect(Object.keys((written?.body as { traits: object }).traits)).toEqual([
      "personality",
      "language",
      "manner",
      "patience",
      "accent",
      "backgroundNoise",
      "underFriction",
    ]);
    expect(asked.map((one) => one.path)).toContain(
      "/v1/persona-form?projectId=prj_1",
    );
    expect(routed.push).toHaveBeenCalledWith(
      "/projects/prj_1/personas/prs_new",
    );
  });

  it("keeps everything typed when egma refuses, and shows what it said", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "GET /v1/persona-form": { status: 200, body: PERSONA_FORM },
      "POST /v1/personas": {
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
      "GET /v1/persona-form": { status: 200, body: PERSONA_FORM },
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

describe("one persona's sheet", () => {
  /**
   * The panel opens on the read view, which is what the boards draw, so every
   * case about the editor presses the one control that opens it first. A
   * viewer never gets past this line, and that is the point of it.
   */
  async function openEditor(): Promise<void> {
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByLabelText("Name");
  }

  const reads = (persona: Persona = RITA) => ({
    "GET /api/me": { status: 200, body: meWith("member") },
    "GET /v1/persona-form": { status: 200, body: PERSONA_FORM },
    "GET /v1/personas/prs_1": { status: 200, body: persona },
    "GET /v1/personas/prs_1/versions": {
      status: 200,
      body: {
        versions: [
          {
            id: "prsv_1",
            personaId: "prs_1",
            version: 1,
            traits: persona.traits,
            models: persona.models,
            createdAt: "2026-08-15T10:00:00.000Z",
          },
        ],
        nextPageToken: null,
      },
    },
  });

  it("keeps one save disabled until a live field changes, then sends no version expectation", async () => {
    const { asked } = apiAnswers({
      ...reads(),
      "PATCH /v1/personas/prs_1": {
        status: 200,
        body: { ...RITA, name: "Rita", revision: "revision-two" },
      },
    });
    render(<PersonaPage />);

    await openEditor();
    const name = screen.getByLabelText("Name");
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
      Record<string, unknown> | undefined;

    expect(written).toMatchObject({
      projectId: "prj_1",
      expectedRevision: "revision-one",
      name: "Rita",
    });
    // A rename is not a content change, so it names no version — sending one
    // would make a rename fail because somebody else edited the traits.
    expect(written).not.toHaveProperty("expectedVersionId");
    expect(written).not.toHaveProperty("traits");
    expect(written).not.toHaveProperty("description");

    expect(await screen.findByText("Saved.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Rita again" },
    });
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it("saves personality with both expectations, because it mints a version", async () => {
    const { asked } = apiAnswers({
      ...reads(),
      "PATCH /v1/personas/prs_1": {
        status: 200,
        body: { ...RITA, version: 2, versionId: "prsv_2" },
      },
    });
    render(<PersonaPage />);

    await openEditor();
    fireEvent.change(screen.getByRole("textbox", { name: "Personality" }), {
      target: { value: "Patient at first, then asks for a person." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await vi.waitFor(() => {
      expect(asked.filter((one) => one.method === "PATCH")).toHaveLength(1);
    });
    const written = asked.find((one) => one.method === "PATCH")?.body as
      Record<string, unknown> | undefined;

    expect(written).toMatchObject({
      expectedRevision: "revision-one",
      expectedVersionId: "prsv_1",
      traits: {
        ...RITA.traits,
        personality: "Patient at first, then asks for a person.",
      },
    });
    expect(written).not.toHaveProperty("name");
    expect(written).not.toHaveProperty("description");
  });

  it("selects exact model pairs and sends one complete models value", async () => {
    const changedModels: PersonaModels = {
      ...RECOMMENDED_MODELS,
      stt: { provider: "deepgram", model: "nova-3-general" },
      tts: {
        provider: "openai",
        model: "gpt-4o-mini-tts",
        voiceId: "alloy",
        speed: 1,
      },
    };
    const { asked } = apiAnswers({
      ...reads(),
      "PATCH /v1/personas/prs_1": {
        status: 200,
        body: {
          ...RITA,
          models: changedModels,
          version: 2,
          versionId: "prsv_2",
        },
      },
    });
    render(<PersonaPage />);

    await openEditor();
    const stt = screen.getByLabelText("Speech-to-text model");
    fireEvent.change(stt, {
      target: { value: JSON.stringify(["deepgram", "nova-3-general"]) },
    });
    fireEvent.change(screen.getByLabelText("Text-to-speech model"), {
      target: { value: JSON.stringify(["openai", "gpt-4o-mini-tts"]) },
    });
    expect((screen.getByLabelText("Voice") as HTMLInputElement).value).toBe(
      "alloy",
    );
    expect(screen.getAllByLabelText("Voice")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await vi.waitFor(() => {
      expect(asked.filter((one) => one.method === "PATCH")).toHaveLength(1);
    });
    expect(asked.find((one) => one.method === "PATCH")?.body).toMatchObject({
      projectId: "prj_1",
      expectedRevision: "revision-one",
      expectedVersionId: "prsv_1",
      models: changedModels,
    });
  });

  it("sends every changed field in one write and one version request", async () => {
    const personality = "Patient at first, then asks for a person.";
    const { asked } = apiAnswers({
      ...reads(),
      "PATCH /v1/personas/prs_1": {
        status: 200,
        body: {
          ...RITA,
          name: "Rita",
          description: "Wants a quick answer.",
          traits: { ...RITA.traits, personality },
          version: 2,
          versionId: "prsv_2",
          revision: "revision-two",
        },
      },
    });
    render(<PersonaPage />);

    await openEditor();
    fireEvent.change(screen.getByLabelText("Name"), {
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
      projectId: "prj_1",
      expectedRevision: "revision-one",
      expectedVersionId: "prsv_1",
      name: "Rita",
      description: "Wants a quick answer.",
      traits: { ...RITA.traits, personality },
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
      "PATCH /v1/personas/prs_1": {
        status: 409,
        body: {
          error: "version_conflict",
          message:
            "this persona edit was written against version prsv_1, and it has moved on to prsv_2.",
        },
      },
    });
    render(<PersonaPage />);

    await openEditor();
    fireEvent.change(screen.getByRole("textbox", { name: "Personality" }), {
      target: { value: "Patient at first, then asks for a person." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const said = await screen.findByRole("alert");
    expect(said.textContent).toContain("has moved on to prsv_2");
    expect(
      within(said).getByRole("button", { name: /Read this persona again/ }),
    ).toBeDefined();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Personality",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Patient at first, then asks for a person.");
  });

  /**
   * **The history stopped being a second panel over the first one.** It used
   * to be a sheet opened from a page that was already a sheet's worth of
   * reading, then a dialog over that sheet to read one version. "Which version
   * is this, and what were the others" is one question; the boards fold it
   * into the panel and this holds them to it.
   */
  it("reads an older version inside the same panel, and comes back from it", async () => {
    const current = {
      ...RITA,
      version: 2,
      versionId: "prsv_2",
      traits: {
        ...RITA.traits,
        personality: "Patient now, but still hard of hearing.",
      },
    };
    apiAnswers({
      ...reads(current),
      "GET /v1/personas/prs_1/versions": {
        status: 200,
        body: {
          versions: [
            {
              id: "prsv_2",
              personaId: "prs_1",
              version: 2,
              traits: current.traits,
              models: current.models,
              createdAt: "2026-08-16T10:00:00.000Z",
            },
            {
              id: "prsv_1",
              personaId: "prs_1",
              version: 1,
              traits: RITA.traits,
              models: RITA.models,
              createdAt: "2026-08-15T10:00:00.000Z",
            },
          ],
          nextPageToken: null,
        },
      },
    });
    render(<PersonaPage />);

    const panel = await screen.findByRole("dialog", { name: "Impatient Rita" });
    expect(screen.queryAllByRole("dialog")).toHaveLength(1);

    const versions = within(panel).getAllByRole("listitem");
    expect(versions).toHaveLength(2);
    expect(versions[0]?.textContent).toContain("v2");
    expect(versions[0]?.textContent).toContain("Current");
    expect(versions[1]?.textContent).toContain("v1");
    // The version this panel is already showing is not offered to be read.
    expect(within(versions[0]!).queryByRole("button", { name: "Read" })).toBeNull();

    fireEvent.click(within(versions[1]!).getByRole("button", { name: "Read" }));

    // The same panel, showing the frozen version rather than a second panel.
    expect(screen.queryAllByRole("dialog")).toHaveLength(1);
    expect(within(panel).getByText("Custom · v1 of 2")).toBeDefined();
    expect(within(panel).getByText("Older version")).toBeDefined();
    expect(within(panel).getByText(/hard of hearing/)).toBeDefined();
    expect(
      within(panel).getByText(
        "This version is frozen. Runs that used it read exactly this.",
      ),
    ).toBeDefined();
    expect(within(panel).getByText("Reading")).toBeDefined();
    /*
     * A frozen version carries no description — identity is live — so the
     * panel does not print today's description under a sentence saying this
     * one cannot change.
     */
    expect(within(panel).queryByText("Description")).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: "Back to v2" }));
    expect(within(panel).getByText("Custom · v2")).toBeDefined();
    expect(within(panel).queryByText("Older version")).toBeNull();
  });

  /**
   * Writing an old version forward needs no operation of its own: a version is
   * exactly its traits and its models, so the ordinary update is what "use
   * this again" means — and it arrives as a new version, so every run that
   * pinned the old one still reads the old one.
   */
  it("writes an older version forward as a new one", async () => {
    const current = { ...RITA, version: 2, versionId: "prsv_2" };
    const { asked } = apiAnswers({
      ...reads(current),
      "GET /v1/personas/prs_1/versions": {
        status: 200,
        body: {
          versions: [
            {
              id: "prsv_2",
              personaId: "prs_1",
              version: 2,
              traits: current.traits,
              models: current.models,
              createdAt: "2026-08-16T10:00:00.000Z",
            },
            {
              id: "prsv_1",
              personaId: "prs_1",
              version: 1,
              traits: {
                ...RITA.traits,
                personality: "Seventy, and out of patience.",
              },
              models: RITA.models,
              createdAt: "2026-08-15T10:00:00.000Z",
            },
          ],
          nextPageToken: null,
        },
      },
      "PATCH /v1/personas/prs_1": {
        status: 200,
        body: { ...current, version: 3, versionId: "prsv_3" },
      },
    });
    render(<PersonaPage />);

    const panel = await screen.findByRole("dialog", { name: "Impatient Rita" });
    const versions = within(panel).getAllByRole("listitem");
    fireEvent.click(within(versions[1]!).getByRole("button", { name: "Read" }));
    expect(within(panel).getByText("Writes v1 as v3.")).toBeDefined();

    fireEvent.click(
      within(panel).getByRole("button", { name: "Use as new version" }),
    );

    await vi.waitFor(() => {
      expect(asked.filter((one) => one.method === "PATCH")).toHaveLength(1);
    });
    expect(asked.find((one) => one.method === "PATCH")?.body).toMatchObject({
      expectedRevision: "revision-one",
      expectedVersionId: "prsv_2",
      traits: { personality: "Seventy, and out of patience." },
      models: RITA.models,
    });
  });

  it("asks who takes the pointer before archiving the project's default", async () => {
    const { asked } = apiAnswers({
      ...reads({ ...RITA, isDefault: true }),
      "GET /v1/personas": {
        status: 200,
        body: {
          personas: [
            { ...RITA, isDefault: true },
            {
              ...RITA,
              id: "prs_2",
              name: "Taking-Over Tam",
              isDefault: false,
            },
          ],
          nextPageToken: null,
        },
      },
      "POST /v1/personas/prs_1/archive": {
        status: 200,
        body: { ...RITA, archivedAt: "2026-08-15T12:00:00.000Z" },
      },
    });
    render(<PersonaPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByLabelText("Replacement default persona"),
    ).toBeDefined();

    fireEvent.change(
      within(dialog).getByLabelText("Replacement default persona"),
      {
        target: { value: "prs_2" },
      },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Archive persona" }),
    );

    await screen.findByRole("button", { name: "Archive" });
    const written = asked.find((one) => one.path.endsWith("/archive"))?.body;
    expect(written).toMatchObject({
      expectedRevision: "revision-one",
      replacementPersonaId: "prs_2",
    });
  });

  it("asks nobody anything before archiving a persona that is not the default", async () => {
    const { asked } = apiAnswers({
      ...reads(),
      "POST /v1/personas/prs_1/archive": {
        status: 200,
        body: { ...RITA, archivedAt: "2026-08-15T12:00:00.000Z" },
      },
    });
    render(<PersonaPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).queryByLabelText("Replacement default persona"),
    ).toBeNull();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Archive persona" }),
    );

    await screen.findByRole("button", { name: "Archive" });
    const written = asked.find((one) => one.path.endsWith("/archive"))?.body as
      Record<string, unknown> | undefined;
    expect(written).toMatchObject({ expectedRevision: "revision-one" });
    expect(written).not.toHaveProperty("replacementPersonaId");
  });

  /**
   * **The write refuses a persona an active test still names, and it refuses
   * by naming ids.** That is the right answer for an API and a useless one for
   * a person deciding, so the names are read before the confirmation is
   * offered and the button that cannot work is not offered at all.
   */
  it("names the tests that would be left naming nobody, and refuses to archive", async () => {
    const { asked } = apiAnswers({
      ...reads(),
      "GET /v1/personas/prs_1/usage": {
        status: 200,
        body: {
          tests: [
            { id: "tst_1", name: "Reschedule a visit" },
            { id: "tst_2", name: "Late arrival" },
          ],
        },
      },
    });
    render(<PersonaPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Archive Impatient Rita?",
    });

    expect(
      await within(dialog).findByText(
        /2 active tests name them: Reschedule a visit, Late arrival/,
      ),
    ).toBeDefined();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Archive persona",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(asked.some((one) => one.path.endsWith("/archive"))).toBe(false);
  });

  it("says plainly when nothing else changes", async () => {
    apiAnswers(reads());
    render(<PersonaPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Archive Impatient Rita?",
    });

    expect(
      await within(dialog).findByText(
        "No active test names them. Nothing else changes.",
      ),
    ).toBeDefined();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Archive persona",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("makes any active available persona the project default", async () => {
    const selected = { ...RITA, isDefault: true };
    const { asked } = apiAnswers({
      ...reads(),
      "GET /v1/personas/prs_1": [
        { status: 200, body: RITA },
        { status: 200, body: selected },
      ],
      "POST /v1/personas/prs_1/default": {
        status: 200,
        body: selected,
      },
    });
    render(<PersonaPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Make project default" }),
    );

    await vi.waitFor(() => {
      expect(
        asked.find((one) => one.path === "/v1/personas/prs_1/default")?.body,
      ).toEqual({ projectId: "prj_1" });
    });

    // The pointer is a chip on the record it points at, not a Yes/No line.
    expect(await screen.findByText("Project default")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Make project default" }),
    ).toBeNull();
  });

  it("offers Restore rather than Archive once somebody is archived", async () => {
    apiAnswers(reads({ ...RITA, archivedAt: "2026-08-14T09:00:00.000Z" }));
    render(<PersonaPage />);

    const panel = await screen.findByRole("dialog", { name: "Impatient Rita" });
    expect(within(panel).getByRole("button", { name: "Restore" })).toBeDefined();
    expect(within(panel).queryByRole("button", { name: "Archive" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(panel).getByText(/^Archived/)).toBeDefined();
    // Nothing names an archived persona, and the panel says so rather than
    // leaving the section empty.
    expect(
      within(panel).getByText("No active test names them."),
    ).toBeDefined();
  });

  it("shows an Egma-provided persona as plain text, with its versions in the panel, then forks it", async () => {
    const egmaProvided: Persona = {
      ...DEFAULT_PERSONA,
      id: "prs_1",
      isDefault: false,
    };
    const { asked } = apiAnswers({
      ...reads(egmaProvided),
      "POST /v1/personas/prs_1/fork": {
        status: 201,
        body: { ...RITA, id: "prs_fork" },
      },
    });
    render(<PersonaPage />);

    const panel = await screen.findByRole("dialog", {
      name: "Default Persona",
    });
    expect(within(panel).getByText("Egma-provided · v1")).toBeDefined();
    expect(
      within(panel).getByText("Provided by Egma · Shared with every project"),
    ).toBeDefined();

    // The catalog's own word for a provider, rather than the id a persona
    // stores. It arrives with the authoring choices, so it is waited for.
    await within(panel).findByText("OpenAI · gpt-4o-mini");

    expect(
      Array.from(panel.querySelectorAll("dt"), (term) => term.textContent),
    ).toEqual([
      "Description",
      "Personality",
      "Language",
      "Manner",
      "Patience",
      "Accent",
      "Background noise",
      "Under friction",
      "Language model",
      "Speech-to-text model",
      "Text-to-speech model",
      "Speech rate",
      "Voice",
    ]);
    expect(
      Array.from(
        panel.querySelectorAll("dd"),
        (definition) => definition.textContent,
      ),
    ).toEqual([
      "Regular conversationalist persona",
      "Speaks clear, natural English. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
      "en-US",
      "Clear, natural, and conversational.",
      "Starts patient and gives the agent time to explain.",
      "Neutral American English.",
      "None.",
      "Becomes firmer if the agent is confusing or repetitive, without becoming rude.",
      "OpenAI · gpt-4o-mini",
      "OpenAI · gpt-live-transcribe",
      "Cartesia · sonic-3.5",
      "1×",
      "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    ]);

    // Nothing here is editable, and nothing pretends to be.
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Archive" })).toBeNull();
    expect(
      within(panel).getByText("Read-only. Fork makes an editable copy."),
    ).toBeDefined();

    // Versions are a section of this panel now, not a panel over it.
    const versions = within(panel).getAllByRole("listitem");
    expect(versions).toHaveLength(1);
    expect(within(versions[0]!).getByText("v1")).toBeDefined();
    expect(within(versions[0]!).getByText("Current")).toBeDefined();
    expect(screen.queryAllByRole("dialog")).toHaveLength(1);

    // The default pointer is a quiet link in the meta line, because a shared
    // persona has no footer of its own to put it in.
    expect(
      within(panel).getByRole("button", { name: "Make project default" }),
    ).toBeDefined();

    fireEvent.click(within(panel).getByRole("button", { name: "Fork" }));

    await vi.waitFor(() => {
      expect(asked.some((one) => one.path === "/v1/personas/prs_1/fork")).toBe(
        true,
      );
      expect(routed.push).toHaveBeenCalledWith(
        "/projects/prj_1/personas/prs_fork",
      );
    });
  });

  /**
   * **A viewer never reaches a field, because the panel opens on the read
   * view.** The old page put a whole form in front of them with every control
   * disabled; the panel says the same thing once, on the control that would
   * have opened it, and says it where a keyboard and a screen reader can
   * reach it.
   */
  it("leaves a viewer the facts, and every write control disabled with its reason", async () => {
    apiAnswers({
      ...reads(),
      "GET /api/me": { status: 200, body: meWith("viewer") },
    });
    render(<PersonaPage />);

    const panel = await screen.findByRole("dialog", { name: "Impatient Rita" });
    expect(within(panel).getByText(/hard of hearing/)).toBeDefined();
    expect(within(panel).queryByRole("textbox")).toBeNull();

    for (const label of ["Edit", "Fork", "Archive"]) {
      const control = within(panel).getByRole("button", {
        name: label,
      }) as HTMLButtonElement;
      expect(control.disabled, label).toBe(true);
      expect(control.getAttribute("title"), label).toContain(
        "viewer role cannot",
      );
    }

    // Reading the history is not authoring, so it is not refused.
    expect(within(panel).getAllByRole("listitem")).toHaveLength(1);
  });

  it("shows a persona this project has not got as an absence, in egma's words", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "GET /v1/personas/prs_1": {
        status: 404,
        body: {
          error: "not_found",
          message:
            "There is no persona prs_1 available in this project. Check the link, or choose it from the current project.",
        },
      },
      "GET /v1/personas/prs_1/versions": {
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
      "GET /v1/personas/prs_1": [
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
    expect(said.textContent).toContain(
      "Egma could not reach the personas store.",
    );

    fireEvent.click(within(said).getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("dialog", { name: "Impatient Rita" }),
    ).toBeDefined();
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The keyboard, on the control this area adds to the shared system.
 *
 * It is not a link and not a native dialog, so it gets none of this for free.
 *
 * A second test sat here, on the archive filter: one Tab stop for the group, an
 * arrow key moving inside it, and selection following focus. The control came
 * off every list page in this batch, so it could not stay on a page that no
 * longer draws it. It was **moved, not deleted** — it is now
 * `describe("a choice between two lists")` in
 * `apps/web/test/components.test.tsx`, which renders `Choice` directly and
 * drives the same radiogroup semantics.
 *
 * An earlier draft of this comment said that file already proved the control.
 * It did not. Its `describe("a binary choice")` is about `Checkbox`, which is a
 * different component with native semantics, and between the removal and the
 * move there was no test anywhere asking `Choice` for any of this.
 */
describe("driving the Personas area without a pointer", () => {
  it("moves focus into the persona panel, and Escape leaves it for the list", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "GET /v1/personas/prs_1": { status: 200, body: RITA },
      "GET /v1/personas/prs_1/versions": {
        status: 200,
        body: {
          versions: [
            {
              id: "prsv_1",
              personaId: "prs_1",
              version: 1,
              traits: RITA.traits,
              models: RITA.models,
              createdAt: "2026-08-15T10:00:00.000Z",
            },
          ],
          nextPageToken: null,
        },
      },
    });
    render(<PersonaPage />);

    const panel = await screen.findByRole("dialog", { name: "Impatient Rita" });
    expect(panel.getAttribute("data-slot")).toBe("sheet-content");
    expect(panel.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });

    // Closing the panel is going back to the list, because the panel is an
    // address rather than a piece of state.
    await vi.waitFor(() => {
      expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/personas");
    });
  });

  /**
   * **The keyboard goes back to the row control, on the press.** That is what
   * makes the panel restore it afterwards: the panel remembers whatever had
   * focus when it opened, and this is what puts the ⋮ there first.
   */
  it("hands the keyboard back to the row control its menu was opened from", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("member") },
      "GET /v1/personas": {
        status: 200,
        body: { personas: [RITA], nextPageToken: null },
      },
    });
    render(<PersonasPage />);

    const trigger = await screen.findByRole("button", {
      name: "Actions for Impatient Rita",
    });
    trigger.focus();
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu", {
      name: "Actions for Impatient Rita",
    });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Open", "Edit", "Fork", "Make project default", "Archive"]);

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open" }));
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
    "GET /v1/personas/prs_1/versions": {
      status: 200,
      body: { versions: [], nextPageToken: null },
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
      "GET /v1/personas/prs_1": {
        status: 200,
        body: { ...RITA, isDefault: true },
      },
      /*
       * Three reads of the same address, in the order they happen: the list
       * behind the panel, the confirmation's own read of who could take the
       * pointer, and the deliberate second attempt at it.
       */
      "GET /v1/personas": [
        {
          status: 200,
          body: {
            personas: [{ ...RITA, isDefault: true }],
            nextPageToken: null,
          },
        },
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
            personas: [
              { ...RITA, isDefault: true },
              {
                ...RITA,
                id: "prs_2",
                name: "Taking-Over Tam",
                isDefault: false,
              },
            ],
            nextPageToken: null,
          },
        },
      ],
    });
    render(<PersonaPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Archive Impatient Rita?",
    });

    const said = await within(dialog).findByRole("alert");
    expect(said.textContent).toContain(
      "Egma could not reach the personas store.",
    );
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Archive persona",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.click(within(said).getByRole("button", { name: "Try again" }));

    expect(
      await within(dialog).findByLabelText("Replacement default persona"),
    ).toBeDefined();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Archive persona",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("sends an expired session where the rest of the application sends one", async () => {
    const replaced = vi.fn();
    vi.stubGlobal("location", { replace: replaced, assign: vi.fn() });
    apiAnswers({
      ...reading,
      "GET /v1/personas/prs_1": {
        status: 200,
        body: { ...RITA, isDefault: true },
      },
      "GET /v1/personas": {
        status: 401,
        body: { error: "not_authenticated", message: "sign in" },
      },
    });
    render(<PersonaPage />);

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
      json(200, {
        ...RITA,
        id,
        name: id === "prs_1" ? "Impatient Rita" : "Patient Pat",
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: RequestInit) => {
        const request = await observeRequest(input, init);
        const { address: at } = request;
        if (at.pathname === "/api/me") return json(200, meWith("member"));
        if (at.pathname === "/v1/persona-form") {
          return json(200, PERSONA_FORM);
        }
        if (request.method !== "GET") return pending;
        if (at.pathname.endsWith("/versions")) {
          return json(200, { versions: [], nextPageToken: null });
        }
        if (at.pathname.endsWith("/usage")) return json(200, { tests: [] });
        if (at.pathname === "/v1/personas") {
          return json(200, { personas: [], nextPageToken: null });
        }
        return personaFor(at.pathname.split("/").pop() ?? "prs_1");
      }),
    );

    const { rerender } = render(<PersonaPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Rita" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // Somebody opens another persona while that write is still in flight. The
    // screen is not remounted — it is the same route with another id in it.
    routed.personaId = "prs_2";
    routed.pathname = "/projects/prj_1/personas/prs_2";
    rerender(<PersonaPage />);
    expect(
      await screen.findByRole("dialog", { name: "Patient Pat" }),
    ).toBeDefined();
    // The panel is named the moment the read lands and offers its footer one
    // render later, when the editor has been filled from it.
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
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
      "GET /v1/personas/prs_1": { status: 200, body: RITA },
    });
    render(<PersonaPage />);

    // The persona is readable, which is the half that does not depend on a role.
    expect(await screen.findAllByText(/hard of hearing/)).not.toHaveLength(0);

    // And nothing claims anything about a role egma has not been told yet.
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByText(/role cannot/)).toBeNull();
  });

  it("gives a viewer the reason without a pointer, not only in a tooltip", async () => {
    apiAnswers({
      ...reading,
      "GET /api/me": { status: 200, body: meWith("viewer") },
      "GET /v1/personas/prs_1": { status: 200, body: RITA },
    });
    render(<PersonaPage />);

    const edit = (await screen.findByRole("button", {
      name: "Edit",
    })) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);

    // The sentence is on the page and the control names it, so it reaches a
    // screen reader and a keyboard — not only a hovering mouse.
    const described = edit.getAttribute("aria-describedby");
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
      "GET /v1/personas/prs_1": { status: 200, body: RITA },
      "GET /v1/personas/prs_1/versions": {
        status: 200,
        body: { versions: [], nextPageToken: null },
      },
      "PATCH /v1/personas/prs_1": {
        status: 200,
        body: {
          ...RITA,
          version: 2,
          versionId: "prsv_2",
          revision: "revision-two",
          traits: { ...RITA.traits, personality: "calm" },
        },
      },
    });
    render(<PersonaPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Personality" }),
      {
        target: { value: "  calm  " },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // Sent as typed, because what may be trimmed is the server's rule.
    await vi.waitFor(() => {
      expect(asked.filter((one) => one.method === "PATCH")).toHaveLength(1);
    });
    const written = asked.find((one) => one.method === "PATCH")?.body as
      { traits: Record<string, unknown> } | undefined;
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
      vi.fn(async (input: FetchInput, init?: RequestInit) => {
        const request = await observeRequest(input, init);
        const { address: at } = request;
        if (at.pathname === "/api/me") return json(200, meWith("member"));
        if (at.pathname === "/v1/persona-form") {
          return json(200, PERSONA_FORM);
        }
        if (request.method !== "GET") return pending;
        if (at.pathname.endsWith("/versions")) {
          return json(200, { versions: [], nextPageToken: null });
        }
        if (at.pathname.endsWith("/usage")) return json(200, { tests: [] });
        if (at.pathname === "/v1/personas") {
          return json(200, { personas: [], nextPageToken: null });
        }
        return json(200, RITA);
      }),
    );

    render(<PersonaPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
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
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
        "A",
      );
    });

    // …and the description keeps the newer keystrokes, rather than the value
    // the reply carried for a field it was never told about.
    expect(
      (screen.getByLabelText("Description") as HTMLInputElement).value,
    ).toBe("Typed while saving");
    expect(screen.queryByText("Saved.")).toBeNull();
  });
});
