// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PersonasPage from "../app/projects/[projectId]/personas/page.tsx";
import {
  PersonaCloneScreen,
  PersonaCreateScreen,
  PersonaReadScreen,
} from "../app/projects/[projectId]/personas/persona-screen.tsx";
import type { Me } from "../lib/me.ts";
import type { Persona, PersonaForm, PersonaModels } from "../lib/personas.ts";
import { DraftNavigationProvider } from "../ui/draft-navigation.tsx";
import { observeRequest, type FetchInput } from "./platform-request.ts";

const NativeRequest = Request;
class JsdomCompatibleRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init === undefined ? undefined : { ...init, signal: undefined });
  }
}

const routed = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  pathname: "/projects/prj_1/personas",
  projectId: "prj_1",
  personaId: "prs_live",
  sessionMe: null as Me | null,
  sessionSettled: true,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: routed.push, replace: routed.replace, back: vi.fn() }),
  useParams: () => ({ projectId: routed.projectId, personaId: routed.personaId }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => <a href={href} {...rest}>{children as never}</a>,
}));
vi.mock("next/image", () => ({ default: ({ alt }: { alt: string }) => <img alt={alt} /> }));
vi.mock("../ui/shell.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/shell.tsx")>();
  return {
    ...actual,
    useShellSession: () => ({
      me: routed.sessionMe,
      settled: routed.sessionSettled,
      refresh: vi.fn(),
      includeProject: vi.fn(),
    }),
  };
});

const CASCADED: PersonaModels = {
  mode: "separate",
  llm: { provider: "openai", model: "gpt-4o-mini" },
  stt: { provider: "deepgram", model: "nova-3-general" },
  tts: { provider: "cartesia", model: "sonic-3.5", voiceId: "calm" },
};
const LIVE: PersonaModels = {
  mode: "live",
  llm: { provider: "openai", model: "gpt-4o-mini" },
  live: { provider: "openai", model: "gpt-live-1", adapter: "openai_live", voiceId: "alloy" },
};

const FORM: PersonaForm = {
  modelCatalog: [
    { provider: "openai", job: "llm", model: "gpt-4o-mini", label: "OpenAI", modelLabel: "GPT 4o mini" },
    { provider: "anthropic", job: "llm", model: "claude-sonnet", label: "Anthropic", modelLabel: "Claude Sonnet" },
    { provider: "deepgram", job: "stt", model: "nova-3-general", label: "Deepgram", modelLabel: "Nova 3" },
    { provider: "cartesia", job: "tts", model: "sonic-3.5", label: "Cartesia", modelLabel: "Sonic 3.5", recommendedVoiceId: "calm" },
    { provider: "openai", job: "live", model: "gpt-live-1", label: "OpenAI", modelLabel: "GPT Live", recommendedVoiceId: "alloy" },
  ],
  recommendedModels: CASCADED,
};

const CASCADED_CONTROLS = {
  language: "en-US",
  backgroundSoundId: "none" as const,
  interruptionLevel: "occasional" as const,
};
const LIVE_CONTROLS = { language: "en-US", backgroundSoundId: "rain-v1" as const };

function contract(models: PersonaModels): Persona["parameterContract"] {
  const values = models.mode === "live"
    ? {
        speech_mode: "live", llm_provider: models.llm.provider, llm_model: models.llm.model,
        live_provider: models.live.provider, live_model: models.live.model,
        live_adapter: models.live.adapter, live_voice_id: models.live.voiceId,
        language: "en-US", background_sound_id: "rain-v1",
      }
    : {
        speech_mode: "separate", llm_provider: models.llm.provider, llm_model: models.llm.model,
        stt_provider: models.stt.provider, stt_model: models.stt.model,
        tts_provider: models.tts.provider, tts_model: models.tts.model,
        tts_voice_id: models.tts.voiceId, language: "en-US",
        background_sound_id: "none", interruption_level: "occasional",
      };
  return Object.entries(values).map(([key, defaultValue]) => ({
    key, label: key, valueType: "string", defaultValue,
    unit: null, minimum: null, maximum: null,
  }));
}

function persona(id: string, owner: Persona["owner"], models: PersonaModels): Persona {
  const controls = models.mode === "live" ? LIVE_CONTROLS : CASCADED_CONTROLS;
  return {
    id,
    projectId: owner === "egma" ? null : "prj_1",
    owner,
    name: models.mode === "live" ? "Live Lee" : "Patient Priya",
    description: "A stable caller.",
    version: 1,
    versionId: `${id}_v1`,
    identityName: models.mode === "live" ? "Lee" : "Priya",
    personality: "Patient and concise.",
    language: null,
    parameterContract: contract(models),
    settings: owner === "egma" ? null : {
      id: `${id}_settings`, models, controls,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    archivedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

const LIVE_PERSONA = persona("prs_live", "organization", LIVE);
const BUILTIN = { ...persona("prs_builtin", "egma", CASCADED), name: "Built-in Priya" };
const CUSTOM = { ...persona("prs_custom", "organization", CASCADED), name: "Custom Priya" };

const CAPABILITIES = {
  voices: {
    status: "supported" as const,
    choices: [
      { id: "alloy", name: "Alloy", source: "standard" as const, presentation: "neutral" as const, languages: ["en-US"] },
      { id: "calm", name: "Calm caller", source: "standard" as const, presentation: "unknown" as const, languages: ["en-US"] },
      { id: "maya", name: "Maya", source: "standard" as const, presentation: "female" as const, languages: ["en-US"] },
    ],
  },
  language: { status: "supported" as const, choices: ["en-US", "en-GB"] },
};

function me(): Me {
  return {
    user: { id: "usr_1", email: "ada@example.com" },
    organizations: [{ id: "org_1", name: "Acme", slug: "acme", role: "admin" }],
    projects: [{ id: "prj_1", name: "Default", slug: "default" }],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? undefined : { "content-type": "application/json" },
  });
}

type StubResponse = { readonly status: number; readonly body: unknown };
type StubAnswer = StubResponse | (() => Promise<Response>);

function stubApi(overrides: Record<string, StubAnswer> = {}) {
  const asked: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: FetchInput, init?: RequestInit) => {
    const request = await observeRequest(input, init);
    const key = `${request.method} ${request.address.pathname}`;
    asked.push({ method: request.method, path: request.address.pathname, body: request.body });
    const held = overrides[key] ?? (
      key === "GET /api/me" ? { status: 200, body: me() } :
      key === "GET /v1/persona-form" ? { status: 200, body: FORM } :
      key === "GET /v1/persona-capabilities" ? { status: 200, body: CAPABILITIES } :
      key === "GET /v1/personas/prs_live" ? { status: 200, body: LIVE_PERSONA } :
      key === "GET /v1/personas" ? { status: 200, body: { personas: [BUILTIN, CUSTOM], nextPageToken: null } } :
      key === "POST /v1/personas" ? { status: 201, body: { ...LIVE_PERSONA, id: "prs_created" } } :
      key === "POST /v1/personas/prs_live/fork" ? { status: 201, body: { ...LIVE_PERSONA, id: "prs_clone", name: "Live Lee copy" } } :
      undefined
    );
    if (held === undefined) throw new Error(`No response for ${key}`);
    if (typeof held === "function") return held();
    return json(held.status, held.body);
  }));
  return asked;
}

beforeEach(() => {
  routed.push.mockReset();
  routed.replace.mockReset();
  routed.pathname = "/projects/prj_1/personas";
  routed.sessionMe = me();
  routed.sessionSettled = true;
  vi.stubGlobal("Request", JsdomCompatibleRequest);
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("persona full-page flows", () => {
  it("cancels setup without creating a record", async () => {
    const asked = stubApi();
    render(<PersonaCreateScreen projectId="prj_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/personas");
    expect(asked.filter((one) => one.method === "POST")).toHaveLength(0);
  });

  it("keeps Cascaded architecture fixed and exposes its separate provider and model fields", async () => {
    stubApi();
    render(<PersonaCreateScreen projectId="prj_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    const name = await screen.findByLabelText("Name*");
    expect(name.getAttribute("placeholder")).toBe("Ex Angry Spanish caller");
    expect(screen.getByLabelText("Identity name*").getAttribute("placeholder")).toBe("John Doe");
    const description = screen.getByLabelText("Description");
    expect(description.getAttribute("placeholder")).toBeNull();
    expect(description.getAttribute("aria-required")).toBeNull();
    expect(screen.queryByText("The human name they give the agent in every simulation.")).toBeNull();
    expect(screen.queryByText("Describe who they are and how they speak. Put their situation and goal in the test scenario.")).toBeNull();
    expect(screen.queryByText("Tips for a useful persona")).toBeNull();
    for (const section of ["Language", "Text to speech", "Speech to text", "Reasoning", "Advanced"]) {
      const trigger = screen.getByRole("button", { name: section });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(trigger.firstElementChild?.tagName.toLocaleLowerCase()).toBe("svg");
    }
    fireEvent.click(screen.getByRole("button", { name: "Text to speech" }));
    expect(screen.getByLabelText("Voice provider*")).toBeTruthy();
    expect(screen.getByLabelText("Voice model*")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Speech to text" }));
    expect(screen.getByLabelText("Transcription provider*")).toBeTruthy();
    expect(screen.getByLabelText("Transcription model*")).toBeTruthy();
    expect(screen.queryByLabelText(/Speech mode/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByLabelText("Interruptions*")).toBeTruthy();
  });

  it("locks Live mode in setup and creates one persona with no interruption control", async () => {
    const asked = stubApi();
    render(<PersonaCreateScreen projectId="prj_1" />);
    fireEvent.click(await screen.findByRole("radio", { name: /Realtime voice/i }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByLabelText("Name*")).toBeTruthy();
    expect(screen.queryByLabelText(/Speech mode/i)).toBeNull();
    expect(screen.queryByLabelText(/Interruptions/i)).toBeNull();
    expect(screen.queryByLabelText(/Live speech model/i)).toBeNull();
    for (const section of ["Language", "Realtime voice", "Advanced"]) {
      expect(screen.getByRole("button", { name: section }).getAttribute("aria-expanded")).toBe("false");
    }
    fireEvent.click(screen.getByRole("button", { name: "Realtime voice" }));
    const reasoning = screen.getByLabelText("Reasoning model*");
    reasoning.focus();
    fireEvent.keyDown(reasoning, { key: "Enter" });
    const placeholder = await screen.findByRole("option", { name: "GPT 5.6 Terra" });
    expect(placeholder.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(placeholder, { key: "Escape" });

    fireEvent.change(screen.getByLabelText("Name*"), { target: { value: "Calm Lee" } });
    fireEvent.change(screen.getByLabelText("Identity name*"), { target: { value: "Lee" } });
    fireEvent.change(screen.getByLabelText("Personality*"), { target: { value: "Calm and concise." } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Create persona" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create persona" }));

    await waitFor(() => expect(asked.filter((one) => one.method === "POST")).toHaveLength(1));
    const body = asked.find((one) => one.method === "POST")!.body as { models: PersonaModels; controls: Record<string, unknown> };
    expect(body.models).toMatchObject({ mode: "live", live: { model: "gpt-live-1" } });
    expect(body.controls).toEqual({ language: "en-US", backgroundSoundId: "none" });
    expect(routed.replace).toHaveBeenCalledWith("/projects/prj_1/personas/prs_created");
  });

  it("opens an editable clone draft without writing and submits one atomic clone", async () => {
    const asked = stubApi();
    render(<PersonaCloneScreen projectId="prj_1" personaId="prs_live" />);
    expect(await screen.findByDisplayValue("Live Lee copy")).toBeTruthy();
    expect(asked.filter((one) => one.method === "POST")).toHaveLength(0);
    expect(screen.queryByLabelText(/Interruptions/i)).toBeNull();
    for (const section of ["Language", "Realtime voice", "Advanced"]) {
      expect(screen.getByRole("button", { name: section }).getAttribute("aria-expanded")).toBe("false");
    }
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Clone persona" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Clone persona" }));

    await waitFor(() => expect(asked.filter((one) => one.method === "POST")).toHaveLength(1));
    const write = asked.find((one) => one.method === "POST")!;
    expect(write.path).toBe("/v1/personas/prs_live/fork");
    expect(write.body).toMatchObject({ description: "", models: { mode: "live" }, controls: LIVE_CONTROLS });
  });

  it("discards a clone draft without creating a persona", async () => {
    const asked = stubApi();
    render(
      <DraftNavigationProvider>
        <PersonaCloneScreen projectId="prj_1" personaId="prs_live" />
      </DraftNavigationProvider>,
    );
    expect(await screen.findByDisplayValue("Live Lee copy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/personas");
    expect(asked.filter((one) => one.method === "POST")).toHaveLength(0);
  });

  it("updates the selected reasoning model when its provider changes and submits the linked pair", async () => {
    const asked = stubApi();
    render(<PersonaCreateScreen projectId="prj_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reasoning" }));
    const provider = await screen.findByLabelText("Reasoning provider*");
    provider.focus();
    fireEvent.keyDown(provider, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Anthropic" }));
    const model = screen.getByLabelText("Reasoning model*");
    model.focus();
    fireEvent.keyDown(model, { key: "Enter" });
    const selectedModel = await screen.findByRole("option", { name: "Claude Sonnet" });
    expect(selectedModel.getAttribute("data-state")).toBe("checked");
    fireEvent.keyDown(selectedModel, { key: "Escape" });
    fireEvent.change(screen.getByLabelText("Name*"), { target: { value: "Linked model" } });
    fireEvent.change(screen.getByLabelText("Identity name*"), { target: { value: "Lin" } });
    fireEvent.change(screen.getByLabelText("Personality*"), { target: { value: "Checks every choice." } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Create persona" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create persona" }));
    await waitFor(() => expect(asked.filter((one) => one.method === "POST")).toHaveLength(1));
    expect(asked.find((one) => one.method === "POST")?.body).toMatchObject({
      models: { llm: { provider: "anthropic", model: "claude-sonnet" } },
    });
  });

  it("searches and chooses a supported language", async () => {
    stubApi();
    render(<PersonaCloneScreen projectId="prj_1" personaId="prs_live" />);
    fireEvent.click(await screen.findByRole("button", { name: "Language" }));
    const language = await screen.findByRole("combobox", { name: "Language*" });
    fireEvent.click(language);
    expect(document.querySelector("[data-slot='popover-content']")?.getAttribute("data-side")).toBe("bottom");
    fireEvent.change(await screen.findByPlaceholderText("Search languages"), { target: { value: "kingdom" } });
    const choice = await screen.findByRole("option", { name: /English \(United Kingdom\)/u });
    fireEvent.click(choice);
    await waitFor(() => expect(language.textContent).toBe("English (United Kingdom)"));
  });

  it("keeps the selected language and voice labels while capabilities refresh", async () => {
    stubApi({
      "GET /v1/persona-capabilities": () => new Promise<Response>(() => undefined),
    });
    render(<PersonaCloneScreen projectId="prj_1" personaId="prs_live" />);
    fireEvent.click(await screen.findByRole("button", { name: "Language" }));
    fireEvent.click(screen.getByRole("button", { name: "Realtime voice" }));
    expect((await screen.findByRole("combobox", { name: "Language*" })).textContent).toBe("English (United States)");
    expect(screen.getByRole("combobox", { name: "Voice*" }).textContent).toBe("alloy");
    expect(screen.queryByText(/Unavailable/u)).toBeNull();
  });

  it("does not expose create or clone controls before the session role is known", async () => {
    const asked = stubApi();
    routed.sessionMe = null;
    routed.sessionSettled = false;
    const create = render(<PersonaCreateScreen projectId="prj_1" />);
    await waitFor(() => expect(asked.some((one) => one.path === "/v1/persona-form")).toBe(true));
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(create.container.querySelector("form")).toBeNull();
    create.unmount();

    render(<PersonaCloneScreen projectId="prj_1" personaId="prs_live" />);
    await waitFor(() => expect(asked.some((one) => one.path === "/v1/personas/prs_live")).toBe(true));
    expect(document.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clone persona" })).toBeNull();
  });

  it("keeps clone values after the server refuses the write", async () => {
    const asked = stubApi({
      "POST /v1/personas/prs_live/fork": {
        status: 422,
        body: { error: "unprocessable", message: "This mode cannot be changed." },
      },
    });
    render(<PersonaCloneScreen projectId="prj_1" personaId="prs_live" />);
    const name = await screen.findByLabelText("Name*");
    fireEvent.change(name, { target: { value: "Still here" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Clone persona" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Clone persona" }));
    expect(await screen.findByText("This mode cannot be changed.")).toBeTruthy();
    expect((name as HTMLInputElement).value).toBe("Still here");
    expect(asked.filter((one) => one.method === "POST")).toHaveLength(1);
  });

  it("keeps navigation disabled while a clone write is in flight", async () => {
    stubApi({
      "POST /v1/personas/prs_live/fork": () => new Promise<Response>(() => undefined),
    });
    render(<PersonaCloneScreen projectId="prj_1" personaId="prs_live" />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Clone persona" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Clone persona" }));
    expect(await screen.findByRole("button", { name: "Cloning…" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect(routed.push).not.toHaveBeenCalled();
  });

  it("renders saved Live personas as read-only and omits fixed backend details", async () => {
    stubApi();
    const view = render(<PersonaReadScreen projectId="prj_1" personaId="prs_live" />);
    expect(await screen.findByText("Patient and concise.")).toBeTruthy();
    expect(view.container.querySelector("[data-slot='persona-read'] input, [data-slot='persona-read'] select, [data-slot='persona-read'] textarea")).toBeNull();
    for (const section of ["Language", "Realtime voice", "Advanced"]) {
      expect(screen.getByRole("button", { name: section }).getAttribute("aria-expanded")).toBe("false");
    }
    expect(screen.queryByRole("link", { name: "Clone" })).toBeNull();
    expect(screen.queryByText("Interruptions")).toBeNull();
    expect(screen.queryByText("gpt-live-1")).toBeNull();
  });

  it("keeps provider and model as separate read facts for Cascaded personas", async () => {
    stubApi({ "GET /v1/personas/prs_live": { status: 200, body: CUSTOM } });
    render(<PersonaReadScreen projectId="prj_1" personaId="prs_live" />);
    fireEvent.click(await screen.findByRole("button", { name: "Text to speech" }));
    const speech = await screen.findByRole("region", { name: "Text to speech" });
    expect(within(speech).getByText("Provider")).toBeTruthy();
    expect(within(speech).getByText("Cartesia")).toBeTruthy();
    expect(within(speech).getByText("Model")).toBeTruthy();
    expect(within(speech).getByText("Sonic 3.5")).toBeTruthy();
  });

  it("makes searchable required voice choices keyboard-readable and keeps Unknown filtering", async () => {
    stubApi();
    render(<PersonaCloneScreen projectId="prj_1" personaId="prs_live" />);
    fireEvent.click(await screen.findByRole("button", { name: "Realtime voice" }));
    const voice = await screen.findByRole("combobox", { name: "Voice*" });
    await waitFor(() => expect(voice.getAttribute("aria-required")).toBe("true"));
    fireEvent.click(voice);
    const filters = await screen.findByRole("group", { name: "Filter voice type" });
    fireEvent.click(within(filters).getByRole("button", { name: "Unknown" }));
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByText("Alloy")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Search voices"), { target: { value: "missing" } });
    expect(await screen.findByText("No voices found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(within(listbox).getByText("Maya")).toBeTruthy();
  });

  it("shows an unavailable saved voice and disables submission", async () => {
    stubApi({
      "GET /v1/persona-capabilities": {
        status: 200,
        body: { ...CAPABILITIES, voices: { ...CAPABILITIES.voices, choices: CAPABILITIES.voices.choices.filter((voice) => voice.id !== "alloy") } },
      },
    });
    render(<PersonaCloneScreen projectId="prj_1" personaId="prs_live" />);
    fireEvent.click(await screen.findByRole("button", { name: "Realtime voice" }));
    const voice = await screen.findByRole("combobox", { name: "Voice*" });
    await waitFor(() => expect(voice).toHaveProperty("textContent", "alloy · Unavailable"));
    expect((screen.getByRole("button", { name: "Clone persona" }) as HTMLButtonElement).disabled).toBe(true);
    expect(voice.getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByText("Choose an available voice before creating this persona.")).toBeNull();
  });

  it("retries a transient capability failure without losing the Live draft", async () => {
    let attempts = 0;
    const asked = stubApi({
      "GET /v1/persona-capabilities": async () => {
        attempts += 1;
        return attempts === 1
          ? json(503, { error: "unavailable", message: "Voice choices are unavailable." })
          : json(200, CAPABILITIES);
      },
    });
    render(<PersonaCloneScreen projectId="prj_1" personaId="prs_live" />);
    expect(await screen.findByText("Voice choices are unavailable.")).toBeTruthy();
    const name = screen.getByDisplayValue("Live Lee copy");
    fireEvent.change(name, { target: { value: "Retry Lee" } });
    expect((screen.getByRole("button", { name: "Clone persona" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry options" }));
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect((screen.getByRole("button", { name: "Clone persona" }) as HTMLButtonElement).disabled).toBe(false));
    expect((name as HTMLInputElement).value).toBe("Retry Lee");
    expect(asked.filter((one) => one.path === "/v1/persona-capabilities")).toHaveLength(2);
  });

  it("offers Clone for built-ins and Clone plus Delete for custom personas", async () => {
    stubApi();
    render(<PersonasPage />);
    const builtIn = await screen.findByRole("link", { name: "Built-in Priya" });
    expect(builtIn.getAttribute("data-slot")).toBe("persona-name-link");
    fireEvent.click(await screen.findByRole("button", { name: "Open the menu for Built-in Priya" }));
    let menu = await screen.findByRole("menu", { name: "Open the menu for Built-in Priya" });
    expect(within(menu).getByRole("menuitem", { name: "Clone" }).getAttribute("href")).toBe("/projects/prj_1/personas/prs_builtin/clone");
    expect(within(menu).queryByRole("menuitem", { name: "Delete" })).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.click(await screen.findByRole("button", { name: "Open the menu for Custom Priya" }));
    menu = await screen.findByRole("menu", { name: "Open the menu for Custom Priya" });
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });

  it("keeps authoring controls disabled for a viewer", async () => {
    routed.sessionMe = { ...me(), organizations: [{ ...me().organizations[0]!, role: "viewer" }] };
    stubApi({
      "GET /api/me": {
        status: 200,
        body: { ...me(), organizations: [{ ...me().organizations[0]!, role: "viewer" }] },
      },
    });
    render(<PersonasPage />);
    const create = await screen.findByRole("button", { name: "New persona" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(create.getAttribute("title")).toContain("viewer");
  });

  it("sends an expired persona list session to sign in", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { origin: "http://localhost", replace });
    stubApi({
      "GET /v1/personas": {
        status: 401,
        body: { error: "unauthenticated", message: "Sign in again." },
      },
    });
    render(<PersonasPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"));
  });

  it("shows a persona list failure and retries the read", async () => {
    const asked = stubApi({
      "GET /v1/personas": {
        status: 503,
        body: { error: "unavailable", message: "Personas are unavailable." },
      },
    });
    render(<PersonasPage />);
    expect(await screen.findByText("Personas are unavailable.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(asked.filter((one) => one.path === "/v1/personas")).toHaveLength(2));
  });

  it("stops pagination after the final accumulated page", async () => {
    let pages = 0;
    const asked = stubApi({
      "GET /v1/personas": async () => {
        pages += 1;
        return pages === 1
          ? json(200, { personas: [BUILTIN], nextPageToken: "next-page" })
          : json(200, { personas: [CUSTOM], nextPageToken: null });
      },
    });
    render(<PersonasPage />);
    expect(await screen.findByRole("link", { name: "Built-in Priya" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("link", { name: "Custom Priya" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show more" })).toBeNull());
    expect(asked.filter((one) => one.path === "/v1/personas")).toHaveLength(2);
  });
});
