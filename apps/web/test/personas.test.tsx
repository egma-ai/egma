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
 * The Personas screen, rendered and driven the way somebody with a keyboard
 * drives it.
 *
 * Nothing here asserts that a component exists or that a source file contains
 * a string. Every test puts the API's real answers in front of a real
 * component and reads what the DOM then says — which is the only kind of proof
 * that survives the page being rewritten.
 *
 * **The contract these hold to is the approved boards** (Paper page `03C —
 * Persona rework`, boards 01–06): one address with panels over it, a sectioned
 * form under the star-and-`[optional]` label grammar, Predefined and Custom as
 * square chips, `Fork` and `Delete` in a row's ⋮, the record's own actions in
 * the sheet's ⋮, one item per line when a persona is read, and the open row in
 * the grey soft surface rather than the wash.
 *
 * Three of these exist because ticket 02 shipped the defects they name and had
 * to fix them: a role guessed while the session is in flight, an answer
 * rendered into a project it was not fetched for, and a failed request
 * swallowed. Every list page after that one walks into all three.
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
  models: RECOMMENDED_MODELS,
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
  models: {
    ...RECOMMENDED_MODELS,
    llm: { provider: "openai", model: "gpt-5.6-terra" },
  },
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
    models: RECOMMENDED_MODELS,
    createdAt: "2026-08-20T10:00:00.000Z",
  },
  {
    id: "prsv_1",
    personaId: "prs_1",
    version: 1,
    identityName: "Rita",
    personality: "Rita, as she was first written.",
    language: "en-US",
    models: RECOMMENDED_MODELS,
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
function rowOf(name: string): HTMLElement {
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
    expect(await rowMenuItems("Impatient Rita")).toEqual(["Fork", "Delete"]);
    fireEvent.keyDown(
      await screen.findByRole("menu", {
        name: "Open the menu for Impatient Rita",
      }),
      { key: "Escape" },
    );
    /* A Predefined persona cannot be deleted, so it is not offered. */
    expect(await rowMenuItems("Everyday caller")).toEqual(["Fork"]);
  });

  it("marks the open record's row with the grey soft surface, not the wash", async () => {
    apiAnswers({
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
     * — which is the point of the grey, and would otherwise stop this reading
     * the state it is about. React updates the same node either way.
     */
    await screen.findByText("Impatient Rita");
    const open = rowOf("Impatient Rita");
    const other = rowOf("Everyday caller");

    await openRow("Impatient Rita");

    expect(open.getAttribute("aria-current")).toBe("true");
    expect(open.className).toContain("bg-surface-soft");
    /* Ember Wash is the primary action's fill and never an open row's. */
    expect(open.className).not.toContain("bg-surface-active");
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

    /* Two traits that no run ever read are gone from the form. */
    expect(within(sheet).queryByLabelText(/accent/iu)).toBeNull();
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
      language: "en-IN",
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
      target: { value: "en-IN" },
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
      language: "en-IN",
      models: RECOMMENDED_MODELS,
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

  it("reads a Custom persona one item per line, dated, with its versions last", async () => {
    ritaOpen();
    render(<PersonasPage />);
    const sheet = await openRow("Impatient Rita");

    expect(within(sheet).getByText("Custom · v3")).toBeTruthy();

    expect(readsUnder(sheet, "Who they are")).toEqual([
      "Description",
      "Identity name",
      "Personality",
      "Language",
    ]);
    expect(within(sheet).getByText("Rita")).toBeTruthy();

    expect(readsUnder(sheet, "Models")).toEqual([
      "Language model",
      "Speech-to-text",
      "Text-to-speech",
      "Speech rate",
      "Voice",
    ]);
    expect(within(sheet).getByText("OpenAI · gpt-4o-mini")).toBeTruthy();
    expect(within(sheet).getByText("1×")).toBeTruthy();

    /*
     * Created and Updated are ordinary fields, and they come before the
     * version list rather than as a line of small print under everything.
     */
    const terms = [...sheet.querySelectorAll("dt")].map(
      (term) => term.textContent,
    );
    expect(terms).toContain("Created");
    expect(terms).toContain("Updated");

    const dates = within(sheet).getByText("Created").closest("dl");
    const versions = within(sheet).getByRole("region", { name: "Versions" });
    expect(dates).toBeTruthy();
    expect(
      dates!.compareDocumentPosition(versions) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("carries Edit, Fork and Delete in the sheet's own ⋮", async () => {
    ritaOpen();
    render(<PersonasPage />);
    await openRow("Impatient Rita");

    const menu = await openSheetMenu("Impatient Rita");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Edit", "Fork", "Delete"]);
  });

  it("edits in place, sends the flat fields, and guards nothing with a revision", async () => {
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
      language: RITA.language,
    });
    expect(written).not.toHaveProperty("expectedRevision");
    expect(written).not.toHaveProperty("expectedVersionId");
    expect(written).not.toHaveProperty("traits");
    /* Untouched halves are not sent at all. */
    expect(written).not.toHaveProperty("name");
    expect(written).not.toHaveProperty("models");
  });

  it("reads an older version in the same panel and writes it forward", async () => {
    const { asked } = ritaOpen({
      "PATCH /v1/personas/prs_1": {
        status: 200,
        body: { ...RITA, version: 4, versionId: "prsv_4" },
      },
    });
    render(<PersonasPage />);
    const sheet = await openRow("Impatient Rita");

    fireEvent.click(within(sheet).getAllByRole("button", { name: "Read" })[0]!);

    expect(await within(sheet).findByText("Custom · v1 of 3")).toBeTruthy();
    expect(within(sheet).getByText("Older version")).toBeTruthy();
    expect(
      within(sheet).getByText("Rita, as she was first written."),
    ).toBeTruthy();

    fireEvent.click(
      within(sheet).getByRole("button", { name: "Use as new version" }),
    );

    await waitFor(() =>
      expect(asked.some((one) => one.method === "PATCH")).toBe(true),
    );
    expect(asked.find((one) => one.method === "PATCH")?.body).toMatchObject({
      identityName: "Rita",
      personality: "Rita, as she was first written.",
      language: "en-US",
    });
  });

  it("reads a Predefined persona as a shelf record with Fork as its one action", async () => {
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
    ).toEqual(["Fork"]);
    fireEvent.keyDown(menu, { key: "Escape" });

    /* No footer, no history, and nothing about who it is shared with. */
    expect(sheet.querySelector("[data-slot=sheet-footer]")).toBeNull();
    expect(within(sheet).queryByRole("region", { name: "Versions" })).toBeNull();
    expect(within(sheet).queryByRole("region", { name: "Used by" })).toBeNull();
    expect(within(sheet).queryByText(/shared with/iu)).toBeNull();
    expect(within(sheet).queryByText("Created")).toBeNull();
  });

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
   * **All three ways out ask the same question.** The boards give this panel a
   * close control, an outside click and Escape, and a draft that only one of
   * them protected would be a draft lost by whichever way somebody happened to
   * reach for. All three land on one `onOpenChange`, which is the gate.
   *
   * Escape is proved above and the close control here. **The outside click is
   * proved in the real browser instead**, in `apps/api/test/browser.test.ts`:
   * that gesture is Radix's own, dispatched from a document listener that
   * jsdom's synthetic events never reach, and a test that faked its way past
   * that would be proving the fake rather than the panel.
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
