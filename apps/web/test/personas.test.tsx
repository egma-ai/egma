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

import PersonasPage from "../app/projects/[projectId]/personas/page.tsx";
import type { Me } from "../lib/me.ts";
import type {
  Persona,
  PersonaForm,
  PersonaModels,
  PersonaVersion,
} from "../lib/personas.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

/**
 * Drive persona lists and sheets with stubbed API responses. Cover role
 * loading, project changes, refused reads, and persona actions through the DOM.
 */

/*
 * The page must keep a controlled sheet mounted while Radix finishes its exit.
 * jsdom has no stylesheet, so this gives Radix the same animation names that
 * the product theme gives the real sheet.
 */
function withClosingSheetAnimation(): void {
  const real = window.getComputedStyle.bind(window);
  vi.stubGlobal(
    "getComputedStyle",
    (element: Element, pseudo?: string | null) => {
      const styles = real(element, pseudo);
      const slot =
        element instanceof HTMLElement ? (element.dataset.slot ?? "") : "";
      if (!slot.startsWith("sheet-")) return styles;
      return new Proxy(styles, {
        get(target, key, receiver) {
          if (key !== "animationName") {
            return Reflect.get(target, key, receiver);
          }
          const closed = (element as HTMLElement).dataset.state === "closed";
          return slot === "sheet-overlay"
            ? closed
              ? "egma-fade-out"
              : "egma-fade-in"
            : closed
              ? "egma-sheet-out"
              : "egma-sheet-in";
        },
      });
    },
  );
}

const routed = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  pathname: "/projects/prj_1/personas",
  search: "",
  projectId: "prj_1",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useSearchParams: () => new URLSearchParams(routed.search),
  useRouter: () => ({
    push: routed.push,
    replace: routed.replace,
    back: vi.fn(),
  }),
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
const CONTROLS = { language: "en-US", emotion: "neutral" as const, accent: "neutral", speechVolume: 1, executionPolicyVersion: 1 };
const CAPABILITIES = {
  voices: { status: "supported" as const, choices: [
    { id: RECOMMENDED_MODELS.tts.voiceId, name: "Calm caller", source: "standard" as const, presentation: "unknown" as const, languages: ["en-US"], accents: ["neutral"] },
    { id: "male-voice", name: "Miles", source: "standard" as const, presentation: "male" as const, languages: ["en-US"], accents: ["neutral"] },
    { id: "female-voice", name: "Maya", source: "standard" as const, presentation: "female" as const, languages: ["en-US"], accents: ["neutral"] },
  ] },
  language: { status: "supported" as const, choices: ["en-US", "en-GB"] },
  accent: { status: "supported" as const, choices: ["neutral", "british"] },
  emotion: { status: "supported" as const, choices: ["neutral", "happy", "angry"] },
  speed: { status: "supported" as const, range: { minimum: 0.6, maximum: 1.5, step: 0.1 } },
  speechVolume: { status: "supported" as const, range: { minimum: 0.5, maximum: 1.5, step: 0.1 } },
};

const PARAMETER_CONTRACT: Persona["parameterContract"] = [
  ...Object.entries({
    llm_provider: "openai",
    llm_model: "gpt-4o-mini",
    stt_provider: "openai",
    stt_model: "gpt-live-transcribe",
    tts_provider: "cartesia",
    tts_model: "sonic-3.5",
    tts_voice_id: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
  }).map(([key, defaultValue]) => ({
    key, label: key, valueType: "string" as const, defaultValue,
    unit: null, minimum: null, maximum: null,
  })),
  { key: "tts_speed", label: "Speaking speed", valueType: "number", defaultValue: 1,
    unit: null, minimum: 0.6, maximum: 1.5 },
];

const PERSONA_FORM: PersonaForm = {
  modelCatalog: [
    { provider: "openai", job: "llm", model: "gpt-4o-mini", label: "OpenAI" },
    { provider: "openai", job: "llm", model: "gpt-4o", label: "OpenAI" },
    { provider: "openai", job: "llm", model: "gpt-5.6-terra", label: "OpenAI" },
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
};

function meWith(role: string): Me {
  return {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [{ id: "org_1", name: "Acme", slug: "acme", role }],
    projects: PROJECTS,
  };
}

function json(status: number, body: unknown): Response {
  /*
   * A 204 carries no body, and the platform's delete answers 204. `Response`
   * refuses to be built with one, so a stub that always wrote JSON would fail
   * inside the fetch mock and the page would read a delete that worked as a
   * request that never arrived.
   */
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Stubbed = { status: number; body: unknown } | "never";

/**
 * Whatever egma is standing in for, keyed by **method and path** — because
 * this screen reads and writes the same address, and a stub that could not
 * tell `GET /v1/personas/prs_1` from `PATCH /v1/personas/prs_1` would prove
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
       * Three reads this screen makes, defaulted so that a case about something
       * else does not have to stub them: the authoring choices, the list the
       * panel is drawn over, and one persona's frozen versions. A case that is
       * *about* one of them still stubs it, and its stub wins.
       */
      const held =
        answers[key] ??
        (key === "GET /v1/persona-form"
          ? { status: 200, body: PERSONA_FORM }
          : key === "GET /v1/persona-capabilities"
            ? { status: 200, body: CAPABILITIES }
          : key === "GET /v1/personas"
            ? { status: 200, body: { personas: [], nextPageToken: null } }
            : at.pathname.endsWith("/versions")
              ? { status: 200, body: { versions: [], nextPageToken: null } }
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
  version: 3,
  versionId: "prsv_3",
  identityName: "Rita",
  personality: "Seventy, hard of hearing, and gets louder when she mishears.",
  language: "en-GB",
  parameterContract: PARAMETER_CONTRACT,
  settings: { id: "ppr_1", models: RECOMMENDED_MODELS, controls: CONTROLS, createdAt: "2026-08-15T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z" },
  archivedAt: null,
  createdAt: "2026-08-15T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
};

const PREDEFINED: Persona = {
  id: "prs_0",
  projectId: null,
  owner: "egma",
  name: "Everyday caller",
  description: "Regular conversationalist persona",
  version: 1,
  versionId: "prsv_0",
  identityName: "Alex Morgan",
  personality:
    "Speaks clear, natural English. Starts patient and cooperative, answers one question at a time.",
  language: "en-US",
  parameterContract: PARAMETER_CONTRACT.map(field => field.key === "llm_model" ? { ...field, defaultValue: "gpt-5.6-terra" } : field),
  settings: null,
  archivedAt: null,
  createdAt: "2026-08-19T23:09:01.674Z",
  updatedAt: "2026-08-19T23:09:01.674Z",
};

const RITA_VERSIONS: readonly PersonaVersion[] = [
  {
    id: "prsv_3",
    personaId: "prs_1",
    version: 3,
    identityName: "Rita",
    personality: "Seventy, hard of hearing, and gets louder when she mishears.",
    language: "en-GB",
    parameterContract: PARAMETER_CONTRACT,
    createdAt: "2026-08-20T10:00:00.000Z",
  },
  {
    id: "prsv_1",
    personaId: "prs_1",
    version: 1,
    identityName: "Rita",
    personality: "Rita, as she was first written.",
    language: "en-US",
    parameterContract: PARAMETER_CONTRACT,
    createdAt: "2026-08-15T10:00:00.000Z",
  },
];

/** The three reads a populated screen makes, with a role on the session. */
function screenWith(
  role: string,
  personas: readonly Persona[],
): Record<string, Stubbed | readonly Stubbed[]> {
  return {
    "GET /api/me": { status: 200, body: meWith(role) },
    "GET /v1/personas": {
      status: 200,
      body: { personas, nextPageToken: null },
    },
  };
}

async function openRowMenu(name: string): Promise<HTMLElement> {
  fireEvent.click(
    await screen.findByRole("button", { name: `Open the menu for ${name}` }),
  );
  return await screen.findByRole("menu", { name: `Open the menu for ${name}` });
}

/** The names a row's ⋮ offers, in the order it offers them. */
async function rowMenuItems(name: string): Promise<readonly string[]> {
  const menu = await openRowMenu(name);
  return within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}

/** Opening a row the way the boards do: by pressing the row's own name. */
async function openRow(name: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name }));
  return await screen.findByRole("dialog", { name });
}

/** The row a named persona is on, so one cell's word is read where it belongs. */
function rowOf(name: string): HTMLTableRowElement {
  const row = screen.getByRole("button", { name }).closest("tr");
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

/** The record's own ⋮, in the head of the sheet showing it. */
async function openSheetMenu(name: string): Promise<HTMLElement> {
  fireEvent.click(
    await screen.findByRole("button", { name: `Actions for ${name}` }),
  );
  return await screen.findByRole("menu", { name: `Actions for ${name}` });
}

/** One labelled group's values, in the order the sheet lists them. */
function readsUnder(sheet: HTMLElement, label: string): readonly string[] {
  const section = within(sheet).getByRole("region", { name: label });
  return [...section.querySelectorAll("dt")].map(
    (term) => term.textContent ?? "",
  );
}

beforeEach(() => {
  routed.push.mockReset();
  routed.replace.mockReset();
  routed.pathname = "/projects/prj_1/personas";
  routed.search = "";
  routed.projectId = "prj_1";
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  /*
   * A case that drives the search debounce takes the clock, and a case that
   * fails while holding it would leave every case after it waiting on a clock
   * that never moves. Handing it back here rather than at the end of that one
   * case is what keeps one failure from reading as twenty.
   */
  vi.useRealTimers();
});

/* ------------------------------------------------------------------------ */

describe("the Personas list", () => {
  it("names every column the boards draw, and says Predefined or Custom in a chip", async () => {
    apiAnswers(screenWith("admin", [RITA, PREDEFINED]));
    render(<PersonasPage />);

    const table = await screen.findByRole("table", {
      name: "Personas in this project",
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual([
      "Name",
      "Type",
      "Language",
      "Description",
      "Version",
      "Updated",
      "Row actions",
    ]);

    expect(within(rowOf("Impatient Rita")).getByText("Custom")).toBeTruthy();
    expect(within(rowOf("Everyday caller")).getByText("Predefined")).toBeTruthy();
    /* The word every screen retired: personas and graders say Predefined. */
    expect(screen.queryByText("Egma-provided")).toBeNull();

    /* The row reads its own language and version off the flat persona. */
    expect(within(rowOf("Impatient Rita")).getByText("en-GB")).toBeTruthy();
    expect(within(rowOf("Impatient Rita")).getByText("v3")).toBeTruthy();
  });

  it("carries no Default chip, no archived footer line, and no second list", async () => {
    const { asked } = apiAnswers(screenWith("admin", [RITA, PREDEFINED]));
    render(<PersonasPage />);

    const table = await screen.findByRole("table", {
      name: "Personas in this project",
    });

    /* Scoped to the table: the sidebar's project is also called "Default". */
    expect(within(table).queryByText("Default")).toBeNull();
    expect(screen.queryByText("Archived")).toBeNull();
    expect(screen.queryByRole("link", { name: "Archived" })).toBeNull();
    expect(screen.queryByText(/personas? ·/u)).toBeNull();

    /*
     * The list operation has no `archived` key and refuses one by name, so the
     * screen must never send it — the generated client would drop it silently
     * and the list would quietly be the wrong list.
     */
    for (const request of asked) {
      expect(request.path).not.toContain("archived");
    }
  });

  it("offers exactly Fork and Delete on a Custom row, and Fork alone on a Predefined one", async () => {
    apiAnswers(screenWith("admin", [RITA, PREDEFINED]));
    render(<PersonasPage />);

    expect(await screen.findByText("Impatient Rita")).toBeTruthy();
    expect(await rowMenuItems("Impatient Rita")).toEqual(["Clone", "Delete"]);
    fireEvent.keyDown(
      await screen.findByRole("menu", {
        name: "Open the menu for Impatient Rita",
      }),
      { key: "Escape" },
    );
    /* An Egma-provided persona cannot be deleted, so it is not offered. */
    expect(await rowMenuItems("Everyday caller")).toEqual(["Clone"]);
  });

  it("marks the open record's row with Ember Wash and a leading mark", async () => {
    const { asked } = apiAnswers({
      ...screenWith("admin", [RITA, PREDEFINED]),
      "GET /v1/personas/prs_1": { status: 200, body: RITA },
      "GET /v1/personas/prs_1/versions": {
        status: 200,
        body: { versions: RITA_VERSIONS, nextPageToken: null },
      },
    });
    render(<PersonasPage />);

    /*
     * Held before the sheet opens: an open sheet makes the page behind it
     * inert, so the row is no longer reachable through the accessibility tree
     * — which is the point of the wash, and would otherwise stop this reading
     * the state it is about. React updates the same node either way.
     */
    await screen.findByText("Impatient Rita");
    const open = rowOf("Impatient Rita");
    const other = rowOf("Everyday caller");

    await openRow("Impatient Rita");

    expect(open.getAttribute("aria-current")).toBe("true");
    expect(open.className).toContain("bg-selected");
    const mark = open.cells[0]?.querySelector(
      '[data-slot="current-row-mark"]',
    );
    expect(mark).not.toBeNull();
    expect(mark?.className).toContain("w-(--active-edge-width)");
    expect(mark?.className).toContain("bg-brand");
    expect(mark?.className).not.toContain("w-0.5");
    expect(open.className).not.toContain("before:");
    expect(other.getAttribute("aria-current")).toBeNull();
  });

  it("searches by name, and answers a search that matches nothing", async () => {
    const { asked } = apiAnswers({
      ...screenWith("admin", [RITA]),
      "GET /v1/personas": [
        { status: 200, body: { personas: [RITA], nextPageToken: null } },
        { status: 200, body: { personas: [], nextPageToken: null } },
      ],
    });
    render(<PersonasPage />);

    expect(await screen.findByText("Impatient Rita")).toBeTruthy();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search personas by name" }),
      { target: { value: "nobody" } },
    );

    /* The typing settles for 300ms before egma is asked anything. */
    expect(
      await screen.findByText("No persona here matches that"),
    ).toBeTruthy();
    expect(asked.map((one) => one.path)).toContain(
      "/v1/personas?projectId=prj_1&search=nobody",
    );
  });
});

/* ------------------------------------------------------------------------ */

describe("authoring a persona", () => {
  it("opens the New persona sheet over the list without navigating", async () => {
    apiAnswers(screenWith("admin", [RITA]));
    render(<PersonasPage />);

    fireEvent.click(await screen.findByRole("button", { name: "New persona" }));

    const sheet = await screen.findByRole("dialog", { name: "New persona" });
    expect(sheet).toBeTruthy();
    /* The list is still there behind it, and the address never moved. */
    expect(screen.getByText("Impatient Rita")).toBeTruthy();
    expect(routed.push).not.toHaveBeenCalled();
    expect(routed.replace).not.toHaveBeenCalled();

    /* No subtitle line under the title: the boards took it out. */
    expect(sheet.querySelector("[data-slot=sheet-description]")).toBeNull();
  });

  it("stars every mandatory label, means it, and marks the one optional field", async () => {
    apiAnswers(screenWith("admin", [RITA]));
    render(<PersonasPage />);
    fireEvent.click(await screen.findByRole("button", { name: "New persona" }));
    const sheet = await screen.findByRole("dialog", { name: "New persona" });

    for (const starred of [
      "Name*",
      "Identity name*",
      "Personality*",
      "Language*",
      "Language model*",
      "Speech-to-text*",
      "Text-to-speech*",
      "Speech rate*",
      "Voice*",
    ]) {
      const field = within(sheet).getByLabelText(starred);
      expect(field.getAttribute("aria-required"), starred).toBe("true");
    }

    const description = within(sheet).getByLabelText("Description [optional]");
    expect(description.tagName).toBe("INPUT");
    expect(description.getAttribute("aria-required")).toBeNull();

    /* The three lines the developer struck off the boards. */
    expect(within(sheet).queryByText(/release defaults/iu)).toBeNull();
    expect(within(sheet).queryByText(/multiple of the natural pace/iu)).toBeNull();
    expect(within(sheet).queryByText(/makes a new version/iu)).toBeNull();

    /* Background arrives in the later environment-controls ticket. */
    expect(within(sheet).getByLabelText("Accent*")).toBeTruthy();
    expect(within(sheet).queryByLabelText(/background noise/iu)).toBeNull();
  });

  it("sends the flat create body, identity name included, and opens what it made", async () => {
    const made: Persona = {
      ...RITA,
      id: "prs_9",
      name: "Brisk Priya",
      description: "",
      version: 1,
      versionId: "prsv_9",
      identityName: "Priya",
      language: "en-GB",
    };
    const { asked } = apiAnswers({
      ...screenWith("admin", [RITA]),
      "POST /v1/personas": { status: 201, body: made },
      "GET /v1/personas/prs_9": { status: 200, body: made },
    });
    render(<PersonasPage />);
    fireEvent.click(await screen.findByRole("button", { name: "New persona" }));
    const sheet = await screen.findByRole("dialog", { name: "New persona" });

    fireEvent.change(within(sheet).getByLabelText("Name*"), {
      target: { value: "Brisk Priya" },
    });
    fireEvent.change(within(sheet).getByLabelText("Identity name*"), {
      target: { value: "Priya" },
    });
    fireEvent.change(within(sheet).getByLabelText("Personality*"), {
      target: { value: "Wants the answer in one sentence." },
    });
    fireEvent.change(within(sheet).getByLabelText("Language*"), {
      target: { value: "en-GB" },
    });
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Create persona" }),
    );

    await screen.findByRole("dialog", { name: "Brisk Priya" });

    const written = asked.find((one) => one.method === "POST")?.body;
    expect(written).toMatchObject({
      projectId: "prj_1",
      name: "Brisk Priya",
      identityName: "Priya",
      personality: "Wants the answer in one sentence.",
      models: RECOMMENDED_MODELS,
      controls: { language: "en-GB", emotion: "neutral", accent: "neutral", speechVolume: 1 },
    });
    /* No traits wrapper, and no description nobody typed. */
    expect(written).not.toHaveProperty("traits");
    expect(written).not.toHaveProperty("description");
    /* Still no navigation: the whole flow happened over the list. */
    expect(routed.push).not.toHaveBeenCalled();
  });

  it("keeps everything typed when a create is refused", async () => {
    apiAnswers({
      ...screenWith("admin", [RITA]),
      "POST /v1/personas": {
        status: 422,
        body: {
          error: "invalid_input",
          message: "A persona needs an identity name.",
        },
      },
    });
    render(<PersonasPage />);
    fireEvent.click(await screen.findByRole("button", { name: "New persona" }));
    const sheet = await screen.findByRole("dialog", { name: "New persona" });

    fireEvent.change(within(sheet).getByLabelText("Name*"), {
      target: { value: "Half typed" },
    });
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Create persona" }),
    );

    expect(
      await within(sheet).findByText("A persona needs an identity name."),
    ).toBeTruthy();
    expect(
      (within(sheet).getByLabelText("Name*") as HTMLInputElement).value,
    ).toBe("Half typed");
  });

  it("gives a viewer the reason rather than the control", async () => {
    apiAnswers(screenWith("viewer", [RITA]));
    render(<PersonasPage />);

    const author = await screen.findByRole("button", { name: "New persona" });
    expect(author.hasAttribute("disabled")).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */

describe("one persona's sheet", () => {
  function ritaOpen(extra: Record<string, Stubbed | readonly Stubbed[]> = {}) {
    return apiAnswers({
      ...screenWith("admin", [RITA, PREDEFINED]),
      "GET /v1/personas/prs_1": { status: 200, body: RITA },
      "GET /v1/personas/prs_1/versions": {
        status: 200,
        body: { versions: RITA_VERSIONS, nextPageToken: null },
      },
      ...extra,
    });
  }

  it("opens inline settings while keeping identity readable and the current version visible", async () => {
    const { asked } = ritaOpen();
    render(<PersonasPage />);
    const sheet = await openRow("Impatient Rita");

    expect(within(sheet).getByText("Custom · v3")).toBeTruthy();
    expect(readsUnder(sheet, "Who they are")).toEqual([
      "Description", "Identity name", "Personality",
    ]);
    expect(within(sheet).getByText("Rita")).toBeTruthy();
    const settings = within(sheet).getByRole("region", { name: "Settings" });
    expect((within(settings).getByLabelText("Language model*") as HTMLSelectElement).value).toBe("openai::gpt-4o-mini");
    expect((within(settings).getByLabelText("Speech rate*") as HTMLInputElement).value).toBe("1");
    expect((within(sheet).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).queryByText("Created")).toBeNull();
    expect(within(sheet).queryByText("Updated")).toBeNull();
    expect(within(sheet).queryByRole("region", { name: "Versions" })).toBeNull();
    expect(within(sheet).queryByText("Project settings")).toBeNull();
    expect(asked.some(request => request.path.includes("/versions"))).toBe(false);
  });

  it("saves inline settings without changing the persona core", async () => {
    const updatedModels = { ...RECOMMENDED_MODELS, llm: { provider: "openai", model: "gpt-4o" } };
    const saved = { ...RITA, settings: { ...RITA.settings!, models: updatedModels } };
    const { asked } = ritaOpen({
      "GET /v1/personas/prs_1": [{ status: 200, body: RITA }, { status: 200, body: saved }],
      "PATCH /v1/personas/prs_1": { status: 200, body: saved },
    });
    render(<PersonasPage />);
    const sheet = await openRow("Impatient Rita");
    fireEvent.change(within(sheet).getByLabelText("Language model*"), { target: { value: "openai::gpt-4o" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(asked.find(request => request.method === "PATCH")?.body).toEqual({ projectId: "prj_1", models: updatedModels, controls: { language: "en-US", emotion: "neutral", accent: "neutral", speechVolume: 1 } }));
    await waitFor(() => expect((within(sheet).getByRole("button", { name: "Saved" }) as HTMLButtonElement).disabled).toBe(true));
    expect(within(sheet).getByRole("status").textContent).toBe("Persona saved.");
    expect(within(sheet).getByText("Custom · v3")).toBeTruthy();
  });

  it("protects inline settings and resets a discarded draft when reopened", async () => {
    ritaOpen();
    render(<PersonasPage />);
    const sheet = await openRow("Impatient Rita");
    fireEvent.change(within(sheet).getByLabelText("Voice*"), { target: { value: "male-voice" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    const confirmation = await screen.findByRole("dialog", { name: "Leave without saving?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Impatient Rita" })).toBeNull());
    const reopened = await openRow("Impatient Rita");
    expect((within(reopened).getByLabelText("Voice*") as HTMLInputElement).value).toBe(RECOMMENDED_MODELS.tts.voiceId);
    expect((within(reopened).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(["Clone", "Delete"])("protects inline settings before %s", async (action) => {
    const { asked } = ritaOpen();
    render(<PersonasPage />);
    const sheet = await openRow("Impatient Rita");
    const voice = within(sheet).getByLabelText("Voice*") as HTMLSelectElement;
    await waitFor(() => expect(voice.disabled).toBe(false));
    fireEvent.change(voice, { target: { value: "male-voice" } });
    await openSheetMenu("Impatient Rita");
    fireEvent.click(await screen.findByRole("menuitem", { name: action }));
    const confirmation = await screen.findByRole("dialog", { name: "Leave without saving?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Keep editing" }));
    expect((within(sheet).getByLabelText("Voice*") as HTMLSelectElement).value).toBe("male-voice");
    expect(asked.every(request => request.method === "GET")).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Delete Impatient Rita?" })).toBeNull();
  });

  it("keeps inline settings disabled for viewers", async () => {
    apiAnswers({
      ...screenWith("viewer", [RITA]),
      "GET /v1/personas/prs_1": { status: 200, body: RITA },
    });
    render(<PersonasPage />);
    const sheet = await openRow("Impatient Rita");
    for (const label of ["Language model*", "Speech-to-text*", "Text-to-speech*", "Speech rate*", "Voice*"]) {
      expect((within(sheet).getByLabelText(label) as HTMLInputElement).disabled).toBe(true);
    }
    expect((within(sheet).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("carries Edit, Clone and Delete in the sheet's own ⋮", async () => {
    ritaOpen();
    render(<PersonasPage />);
    await openRow("Impatient Rita");

    const menu = await openSheetMenu("Impatient Rita");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Edit", "Clone", "Delete"]);
  });

  it("edits the current core and sends its version as the edit base", async () => {
    const saved: Persona = {
      ...RITA,
      version: 4,
      versionId: "prsv_4",
      identityName: "Margaret",
    };
    const { asked } = ritaOpen({
      "PATCH /v1/personas/prs_1": { status: 200, body: saved },
    });
    render(<PersonasPage />);
    await openRow("Impatient Rita");

    await openSheetMenu("Impatient Rita");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));

    const sheet = await screen.findByRole("dialog", { name: "Impatient Rita" });
    expect(within(sheet).getByText("Custom · v3 · Editing")).toBeTruthy();
    /* The one line of version arithmetic left on the surface. */
    expect(
      within(sheet).getByText(
        "Name and description save in place. They do not make a new version.",
      ),
    ).toBeTruthy();

    fireEvent.change(within(sheet).getByLabelText("Identity name*"), {
      target: { value: "Margaret" },
    });
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() =>
      expect(asked.some((one) => one.method === "PATCH")).toBe(true),
    );
    const written = asked.find((one) => one.method === "PATCH")?.body;
    expect(written).toMatchObject({
      projectId: "prj_1",
      identityName: "Margaret",
      personality: RITA.personality,
    });
    expect(written).not.toHaveProperty("expectedRevision");
    expect(written).toHaveProperty("expectedVersionId", RITA.versionId);
    expect(written).not.toHaveProperty("traits");
    /* Untouched halves are not sent at all. */
    expect(written).not.toHaveProperty("name");
    expect(written).not.toHaveProperty("models");
  });

  it("keeps a conflicted draft until cancel, then edits the current core", async () => {
    const current = { ...RITA, version: 4, versionId: "prsv_4", personality: "The saved newer behavior." };
    const { asked } = ritaOpen({
      "GET /v1/personas/prs_1": [{ status: 200, body: RITA }, { status: 200, body: current }],
      "PATCH /v1/personas/prs_1": { status: 409, body: { error: "version_conflict", message: "The persona core changed. Read its current version before editing." } },
    });
    render(<PersonasPage />);
    const sheet = await openRow("Impatient Rita");
    await openSheetMenu("Impatient Rita");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    fireEvent.change(within(sheet).getByLabelText("Personality*"), { target: { value: "My unsaved behavior." } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save changes" }));
    await within(sheet).findByText("The persona core changed. Read its current version before editing.");
    await waitFor(() => expect(asked.filter(request => request.method === "GET" && request.path.startsWith("/v1/personas/prs_1?")).length).toBe(2));
    expect((within(sheet).getByLabelText("Personality*") as HTMLTextAreaElement).value).toBe("My unsaved behavior.");
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    const confirmation = await screen.findByRole("dialog", { name: "Leave without saving?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Discard changes" }));
    await within(sheet).findByText("Custom · v4");
    await openSheetMenu("Impatient Rita");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    expect((within(sheet).getByLabelText("Personality*") as HTMLTextAreaElement).value).toBe(current.personality);
  });

  it("offers inline settings and cloning while keeping a shared identity read-only", async () => {
    apiAnswers({
      ...screenWith("admin", [RITA, PREDEFINED]),
      "GET /v1/personas/prs_0": { status: 200, body: PREDEFINED },
    });
    render(<PersonasPage />);
    const sheet = await openRow("Everyday caller");

    expect(within(sheet).getByText("Predefined · v1")).toBeTruthy();
    expect(within(sheet).getByText("Alex Morgan")).toBeTruthy();

    const menu = await openSheetMenu("Everyday caller");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Clone"]);
    fireEvent.keyDown(menu, { key: "Escape" });

    expect(within(sheet).getByRole("button", { name: "Use persona" })).toBeTruthy();
    expect(within(sheet).getByRole("region", { name: "Settings" })).toBeTruthy();
    expect(within(sheet).queryByLabelText("Identity name*")).toBeNull();
    expect(within(sheet).queryByRole("region", { name: "Versions" })).toBeNull();
    expect(within(sheet).queryByText("Created")).toBeNull();
    expect(within(sheet).queryByText("Updated")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Leave without saving?" })).toBeNull();
  });

  it("adopts a library persona with the selected settings", async () => {
    const updatedModels = { ...RECOMMENDED_MODELS, llm: { provider: "openai", model: "gpt-4o" } };
    const saved = { ...PREDEFINED, settings: { id: "ppr_0", models: updatedModels, controls: CONTROLS, createdAt: PREDEFINED.createdAt, updatedAt: PREDEFINED.updatedAt } };
    const { asked } = apiAnswers({
      ...screenWith("admin", [PREDEFINED]),
      "GET /v1/personas/prs_0": [{ status: 200, body: PREDEFINED }, { status: 200, body: saved }],
      "POST /v1/personas/prs_0/use": { status: 200, body: saved },
    });
    render(<PersonasPage />);
    const sheet = await openRow("Everyday caller");
    fireEvent.change(within(sheet).getByLabelText("Language model*"), { target: { value: "openai::gpt-4o" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Use persona" }));
    await waitFor(() => expect(asked.find(request => request.method === "POST")?.body).toEqual({ projectId: "prj_1", models: updatedModels, controls: { language: "en-US", emotion: "neutral", accent: "neutral", speechVolume: 1 } }));
    expect(await within(sheet).findByRole("button", { name: "Saved" })).toBeTruthy();
    expect(within(sheet).getByText("Predefined · v1")).toBeTruthy();
  });

  it("keeps the voice draft across model changes and keeps unknown voices in gender filters", async () => {
    const { asked } = apiAnswers({
      ...screenWith("admin", [PREDEFINED]),
      "GET /v1/personas/prs_0": { status: 200, body: PREDEFINED },
    });
    render(<PersonasPage />);
    const sheet = await openRow("Everyday caller");
    const stt = await within(sheet).findByLabelText("Speech-to-text*");
    const tts = within(sheet).getByLabelText("Text-to-speech*");
    const llm = within(sheet).getByLabelText("Language model*");
    expect(stt.compareDocumentPosition(tts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tts.compareDocumentPosition(llm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const voice = within(sheet).getByLabelText("Voice*") as HTMLSelectElement;
    await waitFor(() => expect(voice.disabled, asked.map((request) => request.path).join("\n")).toBe(false));
    const original = voice.value;
    fireEvent.change(tts, { target: { value: "openai::gpt-4o-mini-tts" } });
    expect(voice.value).toBe(original);
    await waitFor(() => expect(voice.disabled).toBe(false));

    fireEvent.change(within(sheet).getByLabelText("Voice type"), { target: { value: "female" } });
    expect(within(voice).getByRole("option", { name: /Maya/u })).toBeTruthy();
    expect(within(voice).getByRole("option", { name: /Calm caller/u })).toBeTruthy();
    expect(within(voice).queryByRole("option", { name: /Miles/u })).toBeNull();
  });

  it.each(["library", "active"])(
    "recovers inline %s settings after the model catalog request fails",
    async (action) => {
      const persona: Persona = {
        ...PREDEFINED,
        settings: action === "library" ? null : {
          id: "ppr_0",
          models: RECOMMENDED_MODELS,
          controls: CONTROLS,
          createdAt: PREDEFINED.createdAt,
          updatedAt: PREDEFINED.updatedAt,
        },
      };
      const { asked } = apiAnswers({
        ...screenWith("admin", [persona]),
        "GET /v1/personas/prs_0": { status: 200, body: persona },
        "GET /v1/persona-form": [
          { status: 503, body: {
            error: "unavailable",
            message: "The model catalog could not be loaded. Try again.",
          } },
          { status: 200, body: PERSONA_FORM },
        ],
      });
      render(<PersonasPage />);
      const sheet = await openRow("Everyday caller");

      const failure = await within(sheet).findByRole("alert");
      expect(within(failure).getByText(
        "The model catalog could not be loaded. Try again.",
      )).toBeTruthy();
      expect(within(sheet).queryByText("Loading the supported persona models…")).toBeNull();
      fireEvent.click(within(failure).getByRole("button", { name: "Try again" }));

      const model = await within(sheet).findByLabelText("Language model*");
      expect((model as HTMLSelectElement).value).toBe(
        action === "library" ? "openai::gpt-5.6-terra" : "openai::gpt-4o-mini",
      );
      expect(within(sheet).queryByRole("alert")).toBeNull();
      expect(asked.filter(request => request.path === "/v1/persona-form?projectId=prj_1")).toHaveLength(2);
      expect(asked.every(request => request.method === "GET")).toBe(true);
    },
  );

  /** The editor, open on Rita, with one unsaved change in it. */
  async function aDirtyEditor(): Promise<HTMLElement> {
    await openRow("Impatient Rita");
    await openSheetMenu("Impatient Rita");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const sheet = await screen.findByRole("dialog", { name: "Impatient Rita" });
    fireEvent.change(within(sheet).getByLabelText("Identity name*"), {
      target: { value: "Somebody else" },
    });
    return sheet;
  }

  it("closes on Escape, and asks first when there is a draft to lose", async () => {
    withClosingSheetAnimation();
    ritaOpen();
    render(<PersonasPage />);
    const sheet = await aDirtyEditor();

    /*
     * The product's own question, not the browser's: the shell mounts the
     * draft-navigation provider, so a sheet with something to lose asks in the
     * same dialog every other unsaved change in this product asks in.
     */
    fireEvent.keyDown(sheet, { key: "Escape" });
    const asks = await screen.findByRole("dialog", {
      name: "Leave without saving?",
    });

    fireEvent.click(within(asks).getByRole("button", { name: "Keep editing" }));
    /* Kept, so the panel and the draft are both still there. */
    expect(sheet.getAttribute("data-state")).toBe("open");
    expect(
      (within(sheet).getByLabelText("Identity name*") as HTMLInputElement)
        .value,
    ).toBe("Somebody else");

    fireEvent.keyDown(sheet, { key: "Escape" });
    const again = await screen.findByRole("dialog", {
      name: "Leave without saving?",
    });
    fireEvent.click(
      within(again).getByRole("button", { name: "Discard changes" }),
    );

    await waitFor(() =>
      expect(sheet.getAttribute("data-state")).toBe("closed"),
    );
    /* Closing a panel is not navigation. */
    expect(routed.push).not.toHaveBeenCalled();
  });

  /*
   * All dismissal paths use the draft guard. This file drives Escape and the
   * close control; apps/api/test/browser.test.ts covers outside-click dismissal.
   */
  it("asks before discarding when the close control is pressed", async () => {
    withClosingSheetAnimation();
    ritaOpen();
    render(<PersonasPage />);
    const sheet = await aDirtyEditor();

    /* The head's own ✕, which is the last Close in the panel. */
    const close = within(sheet)
      .getAllByRole("button", { name: "Close" })
      .at(-1);
    if (close === undefined) throw new Error("the sheet has no close control");
    fireEvent.click(close);

    const asks = await screen.findByRole("dialog", {
      name: "Leave without saving?",
    });
    fireEvent.click(within(asks).getByRole("button", { name: "Keep editing" }));

    expect(sheet.getAttribute("data-state")).toBe("open");
    expect(
      (within(sheet).getByLabelText("Identity name*") as HTMLInputElement)
        .value,
    ).toBe("Somebody else");
  });

  /**
   * Project changes must close a persona sheet without reading the old
   * project's persona under the new project ID.
   */
  it("closes the panel when the project changes, and asks the next project for nothing of the last one", async () => {
    const { asked } = ritaOpen({
      "GET /v1/personas": [
        {
          status: 200,
          body: { personas: [RITA, PREDEFINED], nextPageToken: null },
        },
        { status: 200, body: { personas: [PREDEFINED], nextPageToken: null } },
      ],
    });
    const view = render(<PersonasPage />);
    await openRow("Impatient Rita");

    routed.projectId = "prj_2";
    view.rerender(<PersonasPage />);

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Impatient Rita" }),
      ).toBeNull(),
    );

    /* The next project's own list, drawn clean. */
    expect(await screen.findByText("Everyday caller")).toBeTruthy();
    expect(screen.queryByText("Impatient Rita")).toBeNull();
    expect(screen.queryByText(/not found/iu)).toBeNull();

    /*
     * The whole point: the last project's persona was never asked of this one.
     * A cleanup that only ran in an effect would already have sent this.
     */
    expect(
      asked.filter(
        (one) => one.path.includes("prs_1") && one.path.includes("prj_2"),
      ),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */

describe("deleting a persona", () => {
  it("names the persona in the confirmation and sends one DELETE", async () => {
    const { asked } = apiAnswers({
      ...screenWith("admin", [RITA, PREDEFINED]),
      "DELETE /v1/personas/prs_1": { status: 204, body: null },
      "GET /v1/personas": [
        {
          status: 200,
          body: { personas: [RITA, PREDEFINED], nextPageToken: null },
        },
        { status: 200, body: { personas: [PREDEFINED], nextPageToken: null } },
      ],
    });
    render(<PersonasPage />);

    await openRowMenu("Impatient Rita");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const confirm = await screen.findByRole("dialog", {
      name: "Delete Impatient Rita?",
    });
    expect(
      within(confirm).getByText(/leave every list and picker/u),
    ).toBeTruthy();
    /* The word is Delete, everywhere it is said. */
    expect(within(confirm).queryByText(/archive/iu)).toBeNull();

    fireEvent.click(
      within(confirm).getByRole("button", { name: "Delete persona" }),
    );

    await waitFor(() =>
      expect(screen.queryByText("Impatient Rita")).toBeNull(),
    );
    const removed = asked.filter((one) => one.method === "DELETE");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.path).toBe("/v1/personas/prs_1?projectId=prj_1");
  });

  it("shows the server's refusal when a Predefined persona is deleted anyway", async () => {
    apiAnswers({
      ...screenWith("admin", [RITA]),
      "GET /v1/personas/prs_1": { status: 200, body: RITA },
      "DELETE /v1/personas/prs_1": {
        status: 409,
        body: {
          error: "egma_provided_persona",
          message:
            "Persona prs_1 is Predefined and cannot be changed or deleted.",
        },
      },
    });
    render(<PersonasPage />);

    await openRowMenu("Impatient Rita");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog", {
      name: "Delete Impatient Rita?",
    });
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Delete persona" }),
    );

    expect(
      await within(confirm).findByText(
        "Persona prs_1 is Predefined and cannot be changed or deleted.",
      ),
    ).toBeTruthy();
    /* The row is still there, because nothing was deleted. */
    expect(screen.getByText("Impatient Rita")).toBeTruthy();
  });
});

/* ------------------------------------------------------------------------ */

describe("what this page does when something goes wrong underneath it", () => {
  it("draws no authoring control at all while the session is still in flight", async () => {
    apiAnswers({
      "GET /api/me": "never",
      "GET /v1/personas": {
        status: 200,
        body: { personas: [RITA], nextPageToken: null },
      },
    });
    render(<PersonasPage />);

    expect(await screen.findByText("Impatient Rita")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New persona" })).toBeNull();
  });

  it("says what happened when the list cannot be read, and offers it again", async () => {
    apiAnswers({
      ...screenWith("admin", []),
      "GET /v1/personas": {
        status: 500,
        body: { error: "unavailable", message: "Egma could not read that." },
      },
    });
    render(<PersonasPage />);

    expect(await screen.findByText("Egma could not read that.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("sends an expired session to sign in rather than drawing an empty list", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { replace, origin: "http://localhost" });
    apiAnswers({
      ...screenWith("admin", []),
      "GET /v1/personas": {
        status: 401,
        body: { error: "unauthenticated", message: "Sign in again." },
      },
    });
    render(<PersonasPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"));
  });
});
