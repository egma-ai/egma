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
  projectId: "prj_1",
  personaId: "prs_1",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
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

      const held =
        answers[key] ??
        (key === "GET /v1/persona-form"
          ? { status: 200, body: PERSONA_FORM }
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
  it("shows Type and Project default as separate facts", async () => {
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
    expect(
      within(table).getByRole("columnheader", { name: "Type" }),
    ).toBeDefined();
    expect(
      within(table).getByRole("columnheader", { name: "Project default" }),
    ).toBeDefined();

    const customRow = screen.getByText("Impatient Rita").closest("tr");
    const egmaProvidedRow = screen.getByText("Default Persona").closest("tr");
    expect(customRow).not.toBeNull();
    expect(egmaProvidedRow).not.toBeNull();
    expect(within(customRow!).getByText("Custom")).toBeDefined();
    expect(within(egmaProvidedRow!).getByText("Egma-provided")).toBeDefined();
    expect(within(customRow!).getByText("No")).toBeDefined();
    expect(within(egmaProvidedRow!).getByText("Yes")).toBeDefined();
    expect(screen.getAllByRole("table")).toHaveLength(1);
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

describe("one persona's page", () => {
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

    const stt = await screen.findByLabelText("Speech-to-text model");
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

    fireEvent.change(
      await screen.findByRole("textbox", { name: "Personality" }),
      {
        target: { value: "Patient at first, then asks for a person." },
      },
    );
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

  it("shows an older version on its own, without leaving the page", async () => {
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
    expect(
      await screen.findByText("Project default: Yes"),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Make project default" }),
    ).toBeNull();
  });

  it("offers Restore rather than Archive once somebody is archived", async () => {
    apiAnswers(reads({ ...RITA, archivedAt: "2026-08-14T09:00:00.000Z" }));
    render(<PersonaPage />);

    expect(
      await screen.findByRole("button", { name: "Restore" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0);
  });

  it("shows an Egma-provided persona as plain text with history in a sheet, then forks it", async () => {
    const egmaProvided: Persona = {
      ...DEFAULT_PERSONA,
      id: "prs_1",
    };
    const { asked } = apiAnswers({
      ...reads(egmaProvided),
      "POST /v1/personas/prs_1/fork": {
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
    if (header === null)
      throw new Error("the persona title needs a page header");
    expect(within(header).getByText("Type: Egma-provided")).toBeDefined();
    expect(within(header).getByText("Project default: Yes")).toBeDefined();
    expect(within(header).queryByText("v1")).toBeNull();
    expect(within(header).queryByText(/Updated/)).toBeNull();
    expect(
      within(header)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Version history", "Fork"]);

    const details = await screen.findByRole("region", {
      name: "Persona details",
    });
    expect(
      Array.from(details.querySelectorAll("dt"), (term) => term.textContent),
    ).toEqual([
      "Name",
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
      "Voice",
      "Speech rate",
    ]);
    expect(
      Array.from(
        details.querySelectorAll("dd"),
        (definition) => definition.textContent,
      ),
    ).toEqual([
      "Default Persona",
      "Regular conversationalist persona",
      "Speaks clear, natural English. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
      "en-US",
      "Clear, natural, and conversational.",
      "Starts patient and gives the agent time to explain.",
      "Neutral American English.",
      "None.",
      "Becomes firmer if the agent is confusing or repetitive, without becoming rude.",
      "openai — gpt-4o-mini",
      "openai — gpt-live-transcribe",
      "cartesia — sonic-3.5",
      "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
      "1",
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

    fireEvent.click(within(versions[0]!).getByRole("button", { name: "Read" }));
    const version = await screen.findByRole("dialog", { name: "Version 1" });
    expect(version.textContent).toContain("Version 1");
    expect(version.textContent).toContain("Speaks clear, natural English.");
    fireEvent.click(within(version).getByRole("button", { name: "Close" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Version history" })).getByRole(
        "button",
        { name: "Close" },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await vi.waitFor(() => {
      expect(asked.some((one) => one.path === "/v1/personas/prs_1/fork")).toBe(
        true,
      );
      expect(routed.push).toHaveBeenCalledWith(
        "/projects/prj_1/personas/prs_fork",
      );
    });
  });

  it("leaves a viewer every field genuinely inert, and every write control disabled", async () => {
    apiAnswers({
      ...reads(),
      "GET /api/me": { status: 200, body: meWith("viewer") },
    });
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
      const control = screen.getByRole("button", {
        name: label,
      }) as HTMLButtonElement;
      expect(control.disabled, label).toBe(true);
      expect(control.getAttribute("title"), label).toContain(
        "viewer role cannot",
      );
    }
    expect(
      (
        screen.getByRole("button", {
          name: "Version history",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
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
    expect(await screen.findByLabelText("Name")).toBeDefined();
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
  it("traps focus in version history, closes it with Escape, and restores its trigger", async () => {
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

    const trigger = await screen.findByRole("button", {
      name: "Version history",
    });
    trigger.focus();
    fireEvent.click(trigger);

    const sheet = await screen.findByRole("dialog", {
      name: "Version history",
    });
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
      "GET /v1/personas": [
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
    const dialog = await screen.findByRole("dialog");

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
      "GET /v1/personas/prs_1": { status: 200, body: RITA },
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
      "GET /v1/personas/prs_1": { status: 200, body: RITA },
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
