/** `egma persona list`: list the identities repository tests may name. */

import { readConfig } from "../folder/egma-folder.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { listProjectPersonas } from "../platform/personas.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import { oneLineFactText } from "../ui/fact-value.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";
import { createPersona, deletePersona, forkPersona, getPersona, getPersonaCapabilities, usePersona, type GetPersonaResponse } from "@egma/platform-api/client";
import { platformClient, platformRefusalMessage, platformResponse } from "../platform/client.ts";

export type PersonaArguments = {
  readonly values: Readonly<Record<string, string>>;
  readonly positionals: readonly string[];
};

type PersonaModels = NonNullable<GetPersonaResponse["settings"]>["models"];
type PersonaControls = NonNullable<GetPersonaResponse["settings"]>["controls"];

class InvalidPersonaArgumentsError extends Error {}

const SEPARATE_SPEECH_FLAGS = ["--stt-provider", "--stt-model", "--tts-provider", "--tts-model"] as const;

function requireText(value: string, flag: string): string {
  if (value.trim() === "") throw new InvalidPersonaArgumentsError(`${flag} is required for this speech mode.`);
  return value;
}

function models(args: PersonaArguments, fallback?: PersonaModels) {
  const mode = args.values["--speech-mode"] ?? fallback?.mode ?? "separate";
  const llm = {
    provider: requireText(args.values["--llm-provider"] ?? fallback?.llm.provider ?? "", "--llm-provider"),
    model: requireText(args.values["--llm-model"] ?? fallback?.llm.model ?? "", "--llm-model"),
  };
  if (mode === "live") {
    if (SEPARATE_SPEECH_FLAGS.some((flag) => args.values[flag] !== undefined)) {
      throw new InvalidPersonaArgumentsError("STT and TTS flags cannot be used with --speech-mode live.");
    }
    return {
    mode: "live" as const,
    llm,
    live: { provider: "openai" as const, model: "gpt-live-1" as const, adapter: "openai_live" as const, voiceId: requireText(args.values["--voice"] ?? (fallback?.mode === "live" ? fallback.live.voiceId : "alloy"), "--voice") },
    };
  }
  return {
    mode: "separate" as const,
    stt: { provider: requireText(args.values["--stt-provider"] ?? (fallback !== undefined && fallback.mode !== "live" ? fallback.stt.provider : ""), "--stt-provider"), model: requireText(args.values["--stt-model"] ?? (fallback !== undefined && fallback.mode !== "live" ? fallback.stt.model : ""), "--stt-model") },
    tts: { provider: requireText(args.values["--tts-provider"] ?? (fallback !== undefined && fallback.mode !== "live" ? fallback.tts.provider : ""), "--tts-provider"), model: requireText(args.values["--tts-model"] ?? (fallback !== undefined && fallback.mode !== "live" ? fallback.tts.model : ""), "--tts-model"), voiceId: requireText(args.values["--voice"] ?? (fallback !== undefined && fallback.mode !== "live" ? fallback.tts.voiceId : ""), "--voice") },
    llm,
  };
}

function controls(args: PersonaArguments, mode: PersonaModels["mode"], fallback?: PersonaControls) {
  const shared = {
    language: args.values["--language"] ?? fallback?.language ?? "en-US",
    backgroundSoundId: (args.values["--background-sound"] ?? fallback?.backgroundSoundId ?? "none") as NonNullable<GetPersonaResponse["settings"]>["controls"]["backgroundSoundId"],
  };
  if (mode === "live") {
    if (args.values["--interruption-level"] !== undefined) throw new InvalidPersonaArgumentsError("--interruption-level cannot be used with --speech-mode live.");
    return shared;
  }
  const saved = fallback !== undefined && "interruptionLevel" in fallback ? fallback.interruptionLevel : "none";
  return { ...shared, interruptionLevel: (args.values["--interruption-level"] ?? saved) as "none" | "occasional" | "frequent" };
}

function effectiveSettings(persona: GetPersonaResponse) {
  if (persona.settings !== null) return { models: persona.settings.models, controls: persona.settings.controls };
  const values = Object.fromEntries(persona.parameterContract.map((field) => [field.key, field.defaultValue]));
  const live = values.speech_mode === "live";
  return {
    models: live ? {
      mode: "live" as const,
      llm: { provider: String(values.llm_provider), model: String(values.llm_model) },
      live: { provider: "openai" as const, model: "gpt-live-1" as const, adapter: "openai_live" as const, voiceId: String(values.live_voice_id) },
    } : {
      mode: "separate" as const,
      llm: { provider: String(values.llm_provider), model: String(values.llm_model) },
      stt: { provider: String(values.stt_provider), model: String(values.stt_model) },
      tts: { provider: String(values.tts_provider), model: String(values.tts_model), voiceId: String(values.tts_voice_id) },
    },
    controls: live ? {
      language: String(values.language ?? persona.language ?? "en-US"),
      backgroundSoundId: (values.background_sound_id ?? "none") as NonNullable<GetPersonaResponse["settings"]>["controls"]["backgroundSoundId"],
    } : {
      language: String(values.language ?? persona.language ?? "en-US"),
      backgroundSoundId: (values.background_sound_id ?? "none") as NonNullable<GetPersonaResponse["settings"]>["controls"]["backgroundSoundId"],
      interruptionLevel: (values.interruption_level === "off" ? "none" : values.interruption_level ?? "none") as "none" | "occasional" | "frequent",
    },
  };
}

async function projectContext(options: FolderCommandOptions) {
  const ready = await readyToSync(options);
  if (ready.kind === "stop") return ready;
  const config = await readConfig(ready.paths.config);
  const projectId = config.project?.id ?? "";
  if (projectId === "") {
    options.fail("This repository does not name its Egma Project. Run egma init here first.");
    return { kind: "stop" as const, code: FOLDER_EXIT.nothing };
  }
  return { kind: "ready" as const, ready, projectId };
}

/** Run one promptless persona read or write and print its public JSON response. */
export async function runPersonaActionCommand(options: FolderCommandOptions, action: "settings" | "capabilities" | "use" | "create" | "clone" | "delete", args: PersonaArguments): Promise<number> {
  const context = await projectContext(options);
  if (context.kind === "stop") return context.code;
  const client = platformClient(context.ready.signedIn, options.fetchImpl);
  const requestOptions = { client, ...(options.signal === undefined ? {} : { signal: options.signal }) };
  const id = args.positionals[0] ?? "";
  try {
    let saved: ReturnType<typeof effectiveSettings> | undefined;
    let source: GetPersonaResponse | undefined;
    if (action === "clone") {
      const read = await getPersona({ personaId: id, projectId: context.projectId }, requestOptions);
      const response = platformResponse(read, context.ready.signedIn.url);
      if (!response.ok || read.data === undefined) throw new PlatformRefusedError(response.status, platformRefusalMessage(read.error, response.status));
      source = read.data;
      saved = effectiveSettings(source);
    }
    let answer;
    if (action === "settings") answer = await getPersona({ personaId: id, projectId: context.projectId }, requestOptions);
    else if (action === "delete") {
      const deleted = await deletePersona({ personaId: id, projectId: context.projectId }, requestOptions);
      const response = platformResponse(deleted, context.ready.signedIn.url);
      if (!response.ok) throw new PlatformRefusedError(response.status, platformRefusalMessage(deleted.error, response.status));
      options.out(`Deleted persona ${id}.`);
      return FOLDER_EXIT.done;
    }
    else if (action === "use") answer = await usePersona({ personaId: id, projectId: context.projectId }, requestOptions);
    else {
      const selectedModels = models(args, saved?.models);
      const selectedControls = controls(args, selectedModels.mode, saved?.controls);
      const common = { projectId: context.projectId, models: selectedModels, controls: selectedControls };
      if (action === "capabilities") answer = await getPersonaCapabilities(selectedModels.mode === "live" ? { projectId: context.projectId, mode: "live", liveProvider: selectedModels.live.provider, liveModel: selectedModels.live.model, language: selectedControls.language, voiceId: selectedModels.live.voiceId } : { projectId: context.projectId, mode: "separate", ttsProvider: selectedModels.tts.provider, ttsModel: selectedModels.tts.model, sttProvider: selectedModels.stt.provider, sttModel: selectedModels.stt.model, language: selectedControls.language, ...(selectedModels.tts.voiceId === "" ? {} : { voiceId: selectedModels.tts.voiceId }) }, requestOptions);
      else if (action === "create") answer = await createPersona({ ...common, name: args.values["--name"] ?? "", identityName: args.values["--identity-name"] ?? "", personality: args.values["--personality"] ?? "", ...(args.values["--description"] === undefined ? {} : { description: args.values["--description"] }) } as Parameters<typeof createPersona>[0], requestOptions);
      else answer = await forkPersona({ personaId: id, ...common, name: args.values["--name"] ?? source!.name, description: args.values["--description"] ?? source!.description ?? undefined, identityName: args.values["--identity-name"] ?? source!.identityName, personality: args.values["--personality"] ?? source!.personality } as Parameters<typeof forkPersona>[0], requestOptions);
    }
    const response = platformResponse(answer, context.ready.signedIn.url);
    if (!response.ok || answer.data === undefined) throw new PlatformRefusedError(response.status, platformRefusalMessage(answer.error, response.status));
    options.out(JSON.stringify(answer.data, null, 2));
    return FOLDER_EXIT.done;
  } catch (cause) {
    if (options.signal?.aborted === true) {
      options.fail("The command was interrupted before it finished.");
      return FOLDER_EXIT.interrupted;
    }
    if (cause instanceof PlatformUnreachableError || cause instanceof PlatformRefusedError) { options.fail(cause.message); return FOLDER_EXIT.unreachable; }
    if (cause instanceof InvalidPersonaArgumentsError) { options.fail(cause.message); return FOLDER_EXIT.nothing; }
    throw cause;
  }
}

export async function runPersonasCommand(
  options: FolderCommandOptions,
): Promise<number> {
  const ready = await readyToSync(options);
  if (ready.kind === "stop") return ready.code;

  const config = await readConfig(ready.paths.config);
  const projectId = config.project?.id ?? "";
  if (projectId === "") {
    options.fail(
      "This repository does not name its Egma Project. Run egma init here first.",
    );
    return FOLDER_EXIT.nothing;
  }
  options.out(
    `Personas for Project ${oneLineFactText(projectId, "unknown Project ID")}:`,
  );

  try {
    const personas = await listProjectPersonas(
      ready.signedIn,
      projectId,
      options.fetchImpl,
    );
    for (const persona of personas) {
      options.out(
        `- ${oneLineFactText(persona.name, "Unnamed Persona")} (${oneLineFactText(persona.id, "unknown Persona ID")})`,
      );
    }
    options.out(`Listed ${String(personas.length)} personas.`);
    return FOLDER_EXIT.done;
  } catch (cause) {
    if (cause instanceof PlatformUnreachableError || cause instanceof PlatformRefusedError) {
      options.fail(cause.message);
      return FOLDER_EXIT.unreachable;
    }
    throw cause;
  }
}
