/** The personas a project can name, as `/v1/personas` answers them. */

import { given, NOT_AUTHENTICATED, refuse } from "./reading.ts";
import type { FixtureAnswer, FixtureRequest, RouteGroup } from "./server.ts";

export type SeededPersona = {
  readonly id: string;
  readonly name: string;
};

export type PersonaControls = {
  add(name: string): SeededPersona;
  /** Take them all away, for the case a project answers with none. */
  clear(): void;
  readonly personas: readonly SeededPersona[];
};

/**
 * Expose the Egma-provided persona across organizations and projects.
 * clear() creates an empty-list case for refusal tests. No default persona is
 * selected implicitly; tests must name their personas.
 */
const EGMA_PREDEFINED = "Everyday Caller [Male]";

const DEFAULT_MODELS = {
  llm: { provider: "openai", model: "gpt-4o" },
  stt: { provider: "deepgram", model: "nova-3" },
  tts: { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "alloy", speed: 1 },
};

const DEFAULT_CONTROLS = {
  language: "en-US",
  emotion: "neutral",
  accent: "voice_default",
  speechVolume: 1,
  backgroundSoundId: "none",
  backgroundVolume: 0.0631,
};

function parameterContract() {
  return Object.entries({
    llm_provider: "openai",
    llm_model: "gpt-4o",
    stt_provider: "deepgram",
    stt_model: "nova-3",
    tts_provider: "openai",
    tts_model: "gpt-4o-mini-tts",
    tts_voice_id: "alloy",
    tts_speed: 1,
    language: "en-US",
    emotion: "neutral",
    accent: "voice_default",
    speech_volume: 1,
    background_sound_id: "none",
    background_volume: 0.0631,
  }).map(([key, defaultValue]) => ({ key, defaultValue }));
}

function bearer(request: FixtureRequest): string {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

export function personaRoutes(options: {
  readonly holdsKey: (key: string) => boolean;
  readonly projectId: string;
}): { readonly group: RouteGroup; readonly controls: PersonaControls } {
  let next = 1;
  const personas: SeededPersona[] = [
    { id: "prs_egma_default", name: EGMA_PREDEFINED },
  ];
  let settings: Record<string, unknown> | null = null;
  const behind = (request: FixtureRequest, action: () => FixtureAnswer): FixtureAnswer =>
    options.holdsKey(bearer(request)) ? action() : { status: 401, body: NOT_AUTHENTICATED };
  const projectGate = (id: string | undefined): FixtureAnswer | null =>
    id === options.projectId
      ? null
      : refuse(403, "not_authorized", `this credential may not act in project ${id ?? ""}`);

  const controls: PersonaControls = {
    add(name) {
      next += 1;
      const made = {
        id: `prs_fixture_${String(next)}`,
        name: name.trim(),
      };
      personas.push(made);
      return made;
    },
    clear() {
      personas.length = 0;
    },
    get personas() {
      return personas;
    },
  };

  return {
    controls,
    group: {
      name: "personas",
      routes: [
        {
          method: "GET",
          path: "/v1/personas",
          handle: (request) =>
            behind(request, () => {
              const gate = projectGate(given(request.url.searchParams.get("projectId")));
              return gate ?? {
                status: 200,
                body: {
                  personas: personas.map((one) => ({
                    id: one.id,
                    name: one.name,
                  })),
                  nextPageToken: null,
                },
              };
            }),
        },
        {
          method: "GET",
          path: "/v1/personas/:personaId",
          handle: (request) =>
            behind(request, () => {
              const gate = projectGate(given(request.url.searchParams.get("projectId")));
              if (gate !== null) return gate;
              const persona = personas.find((one) => one.id === request.params.personaId);
              return persona === undefined
                ? refuse(404, "not_found", "persona not found")
                : {
                    status: 200,
                    body: {
                      ...persona,
                      description: "A regular conversationalist.",
                      owner: "egma",
                      visibility: "global",
                      version: 1,
                      currentVersionId: "pvr_fixture_default",
                      identityName: "Naman",
                      personality: "Speaks clearly and asks one question at a time.",
                      language: "en-US",
                      parameterContract: parameterContract(),
                      settings,
                      createdAt: "2026-09-10T00:00:00.000Z",
                      updatedAt: "2026-09-10T00:00:00.000Z",
                    },
                  };
            }),
        },
        {
          method: "POST",
          path: "/v1/personas/:personaId/use",
          handle: (request) =>
            behind(request, () => {
              const gate = projectGate(given(request.body?.projectId));
              if (gate !== null) return gate;
              settings = {
                id: "pps_fixture_default",
                models: request.body?.models ?? DEFAULT_MODELS,
                controls: { ...(request.body?.controls as object ?? DEFAULT_CONTROLS), executionPolicyVersion: 1 },
                createdAt: "2026-09-10T00:00:00.000Z",
                updatedAt: "2026-09-10T00:00:00.000Z",
              };
              return { status: 200, body: { id: request.params.personaId, settings } };
            }),
        },
        {
          method: "PATCH",
          path: "/v1/personas/:personaId",
          handle: (request) =>
            behind(request, () => {
              const gate = projectGate(given(request.body?.projectId));
              if (gate !== null) return gate;
              settings = {
                id: "pps_fixture_default",
                models: request.body?.models ?? DEFAULT_MODELS,
                controls: { ...(request.body?.controls as object ?? DEFAULT_CONTROLS), executionPolicyVersion: 1 },
                createdAt: "2026-09-10T00:00:00.000Z",
                updatedAt: "2026-09-10T00:00:00.000Z",
              };
              return { status: 200, body: { id: request.params.personaId, settings } };
            }),
        },
      ],
    },
  };
}
