// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PersonasPage from "../app/projects/[projectId]/personas/page.tsx";
import {
  PersonaCloneScreen,
  PersonaCreateScreen,
} from "../app/projects/[projectId]/personas/persona-screen.tsx";
import type { Me } from "../lib/me.ts";
import type { Persona, PersonaForm, PersonaModels } from "../lib/personas.ts";
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

/** The settings subsection named on the page: a plain header over its fields. */
function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
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
  it("locks Live mode in setup and creates one persona with no interruption control", async () => {
    const asked = stubApi();
    render(<PersonaCreateScreen projectId="prj_1" />);
    fireEvent.click(await screen.findByRole("radio", { name: /Realtime voice/i }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByLabelText("Name*")).toBeTruthy();
    expect(screen.queryByLabelText(/Speech mode/i)).toBeNull();
    expect(screen.queryByLabelText(/Interruptions/i)).toBeNull();
    expect(screen.queryByLabelText(/Live speech model/i)).toBeNull();
    for (const named of ["Language*", "Realtime LLM", "Advanced Settings"]) {
      expect(section(named)).toBeTruthy();
    }
    expect(screen.queryByRole("region", { name: "Text-to-speech" })).toBeNull();
    const realtime = section("Realtime LLM");
    expect(within(realtime).getByLabelText("Provider*")).toBeTruthy();
    expect(within(realtime).getByLabelText("Model*")).toBeTruthy();
    expect(within(realtime).getByRole("combobox", { name: "Voice*" })).toBeTruthy();
    const reasoning = within(realtime).getByLabelText("Reasoning LLM*");
    reasoning.focus();
    fireEvent.keyDown(reasoning, { key: "Enter" });
    /* Only the supported reasoning provider's models are offered. */
    expect(await screen.findByRole("option", { name: "GPT 4o mini" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Claude Sonnet" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("option", { name: "GPT 4o mini" }), { key: "Escape" });

    fireEvent.change(screen.getByLabelText("Name*"), { target: { value: "Calm Lee" } });
    fireEvent.change(screen.getByLabelText("Identity name*"), { target: { value: "Lee" } });
    fireEvent.change(screen.getByLabelText("Personality prompt*"), { target: { value: "Calm and concise." } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Create persona" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create persona" }));

    await waitFor(() => expect(asked.filter((one) => one.method === "POST")).toHaveLength(1));
    const body = asked.find((one) => one.method === "POST")!.body as { models: PersonaModels; controls: Record<string, unknown> };
    expect(body.models).toMatchObject({ mode: "live", live: { model: "gpt-live-1" }, llm: { provider: "openai", model: "gpt-4o-mini" } });
    expect(body.controls).toEqual({ language: "en-US", backgroundSoundId: "none" });
    expect(routed.replace).toHaveBeenCalledWith("/projects/prj_1/personas/prs_created");
  });

  it("opens an editable clone draft without writing and submits one atomic clone", async () => {
    const asked = stubApi();
    render(<PersonaCloneScreen projectId="prj_1" personaId="prs_live" />);
    expect(await screen.findByDisplayValue("Live Lee copy")).toBeTruthy();
    expect(asked.filter((one) => one.method === "POST")).toHaveLength(0);
    expect(screen.queryByLabelText(/Interruptions/i)).toBeNull();
    for (const named of ["Language*", "Realtime LLM", "Advanced Settings"]) {
      expect(section(named)).toBeTruthy();
    }
    expect(screen.getByRole("heading", { level: 1, name: "Clone persona" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Create persona" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create persona" }));

    await waitFor(() => expect(asked.filter((one) => one.method === "POST")).toHaveLength(1));
    const write = asked.find((one) => one.method === "POST")!;
    expect(write.path).toBe("/v1/personas/prs_live/fork");
    expect(write.body).toMatchObject({ description: "", models: { mode: "live" }, controls: LIVE_CONTROLS });
  });

  it("updates the selected reasoning model when its provider changes and submits the linked pair", async () => {
    const asked = stubApi();
    render(<PersonaCreateScreen projectId="prj_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    const reasoning = await screen.findByRole("region", { name: "LLM" });
    const provider = within(reasoning).getByLabelText("Provider*");
    provider.focus();
    fireEvent.keyDown(provider, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Anthropic" }));
    const model = within(reasoning).getByLabelText("Model*");
    model.focus();
    fireEvent.keyDown(model, { key: "Enter" });
    const selectedModel = await screen.findByRole("option", { name: "Claude Sonnet" });
    expect(selectedModel.getAttribute("data-state")).toBe("checked");
    fireEvent.keyDown(selectedModel, { key: "Escape" });
    fireEvent.change(screen.getByLabelText("Name*"), { target: { value: "Linked model" } });
    fireEvent.change(screen.getByLabelText("Identity name*"), { target: { value: "Lin" } });
    fireEvent.change(screen.getByLabelText("Personality prompt*"), { target: { value: "Checks every choice." } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Create persona" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create persona" }));
    await waitFor(() => expect(asked.filter((one) => one.method === "POST")).toHaveLength(1));
    expect(asked.find((one) => one.method === "POST")?.body).toMatchObject({
      models: { llm: { provider: "anthropic", model: "claude-sonnet" } },
    });
  });

  it("shows an unavailable saved voice and disables submission", async () => {
    stubApi({
      "GET /v1/persona-capabilities": {
        status: 200,
        body: { ...CAPABILITIES, voices: { ...CAPABILITIES.voices, choices: CAPABILITIES.voices.choices.filter((voice) => voice.id !== "alloy") } },
      },
    });
    render(<PersonaCloneScreen projectId="prj_1" personaId="prs_live" />);
    const voice = await screen.findByRole("combobox", { name: "Voice*" });
    await waitFor(() => expect(voice).toHaveProperty("textContent", "alloy · Unavailable"));
    expect((screen.getByRole("button", { name: "Create persona" }) as HTMLButtonElement).disabled).toBe(true);
    /* The reason sits in the subsection header, and the picker points at it. */
    const reason = voice.getAttribute("aria-describedby");
    expect(reason).not.toBeNull();
    expect(document.getElementById(reason!)?.textContent).toContain("Choose an available voice");
    expect(screen.queryByText("Choose an available voice before creating this persona.")).toBeNull();
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
