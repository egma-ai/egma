/** `egma persona list`: list the identities repository tests may name. */

import { readConfig } from "../folder/egma-folder.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { listProjectPersonas } from "../platform/personas.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import { oneLineFactText } from "../ui/fact-value.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";
import { createPersona, forkPersona, getPersona, getPersonaCapabilities, previewPersona, updatePersona, usePersona } from "@egma/platform-api/client";
import { platformClient, platformRefusalMessage, platformResponse } from "../platform/client.ts";

export type PersonaArguments = {
  readonly values: Readonly<Record<string, string>>;
  readonly positionals: readonly string[];
};

function numberValue(args: PersonaArguments, name: string, fallback: number): number {
  const value = args.values[name];
  return value === undefined ? fallback : Number(value);
}

function models(args: PersonaArguments) {
  return {
    stt: { provider: args.values["--stt-provider"] ?? "", model: args.values["--stt-model"] ?? "" },
    tts: { provider: args.values["--tts-provider"] ?? "", model: args.values["--tts-model"] ?? "", voiceId: args.values["--voice"] ?? "", speed: numberValue(args, "--speed", 1) },
    llm: { provider: args.values["--llm-provider"] ?? "", model: args.values["--llm-model"] ?? "" },
  };
}

function controls(args: PersonaArguments) {
  return {
    language: args.values["--language"] ?? "en-US",
    emotion: (args.values["--emotion"] ?? "neutral") as "neutral" | "happy" | "angry" | "frustrated" | "sad" | "anxious",
    accent: args.values["--accent"] ?? "neutral",
    speechVolume: numberValue(args, "--speech-volume", 1),
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
export async function runPersonaActionCommand(options: FolderCommandOptions, action: "settings" | "capabilities" | "use" | "create" | "clone" | "update" | "preview", args: PersonaArguments): Promise<number> {
  const context = await projectContext(options);
  if (context.kind === "stop") return context.code;
  const client = platformClient(context.ready.signedIn, options.fetchImpl);
  const id = args.positionals[0] ?? "";
  try {
    const common = { projectId: context.projectId, models: models(args), controls: controls(args), ...(args.values["--voice-access-proof"] === undefined ? {} : { voiceAccessProof: args.values["--voice-access-proof"] }) };
    const answer = action === "settings" ? await getPersona({ personaId: id, projectId: context.projectId }, { client })
      : action === "capabilities" ? await getPersonaCapabilities({ projectId: context.projectId, ttsProvider: common.models.tts.provider, ttsModel: common.models.tts.model, sttProvider: common.models.stt.provider, sttModel: common.models.stt.model, language: common.controls.language, ...(common.models.tts.voiceId === "" ? {} : { voiceId: common.models.tts.voiceId }) }, { client })
      : action === "use" ? await usePersona({ personaId: id, ...common } as Parameters<typeof usePersona>[0], { client })
      : action === "create" ? await createPersona({ ...common, name: args.values["--name"] ?? "", identityName: args.values["--identity-name"] ?? "", personality: args.values["--personality"] ?? "", ...(args.values["--description"] === undefined ? {} : { description: args.values["--description"] }) } as Parameters<typeof createPersona>[0], { client })
      : action === "clone" ? await forkPersona({ personaId: id, projectId: context.projectId }, { client })
      : action === "update" ? await updatePersona({ personaId: id, ...common, ...(args.values["--name"] === undefined ? {} : { name: args.values["--name"] }), ...(args.values["--description"] === undefined ? {} : { description: args.values["--description"] }), ...(args.values["--identity-name"] === undefined ? {} : { identityName: args.values["--identity-name"] }), ...(args.values["--personality"] === undefined ? {} : { personality: args.values["--personality"] }), ...(args.values["--expected-version"] === undefined ? {} : { expectedVersionId: args.values["--expected-version"] }) } as Parameters<typeof updatePersona>[0], { client })
      : await previewPersona(common as Parameters<typeof previewPersona>[0], { client });
    const response = platformResponse(answer, context.ready.signedIn.url);
    if (!response.ok || answer.data === undefined) throw new PlatformRefusedError(response.status, platformRefusalMessage(answer.error, response.status));
    options.out(JSON.stringify(answer.data, null, 2));
    return FOLDER_EXIT.done;
  } catch (cause) {
    if (cause instanceof PlatformUnreachableError || cause instanceof PlatformRefusedError) { options.fail(cause.message); return FOLDER_EXIT.unreachable; }
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
