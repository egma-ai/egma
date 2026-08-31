/** `egma validate`: read the complete folder and check its persona references. */

import {
  RepositoryValidationError,
  folderPathsIn,
  readRepository,
  type RepositoryContents,
} from "../folder/egma-folder.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import {
  listProjectPersonas,
  type PlatformPersona,
} from "../platform/personas.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";

/** The platform-persona problems in one otherwise readable repository. */
export function personaReferenceIssues(
  repository: RepositoryContents,
  personas: readonly PlatformPersona[],
): readonly string[] {
  const byId = new Map(personas.map((persona) => [persona.id, persona] as const));
  const byName = new Map<string, PlatformPersona[]>();
  for (const persona of personas) {
    const named = byName.get(persona.name) ?? [];
    named.push(persona);
    byName.set(persona.name, named);
  }

  const issues: string[] = [];
  for (const file of repository.suites.flatMap((suite) => suite.tests)) {
    if (file.test.personas.length === 0) {
      issues.push(`${file.shown} names no persona.`);
      continue;
    }

    const resolved = new Set<string>();
    for (const reference of file.test.personas) {
      const id = reference.id.trim();
      const name = reference.name.trim();
      const written = id === "" ? name : id;

      // The platform resolves a string as an id before considering names. The
      // same order matters for the rare but valid case where one persona's
      // display name is another persona's stable id.
      const exactId = byId.get(written);
      const matches = exactId === undefined ? (byName.get(written) ?? []) : [exactId];
      if (matches.length === 0) {
        issues.push(
          id === ""
            ? `${file.shown} names unknown persona ${JSON.stringify(name)}.`
            : `${file.shown} names unknown persona id ${id}.`,
        );
        continue;
      }
      if (matches.length > 1) {
        issues.push(
          `${file.shown} persona name ${JSON.stringify(written)} matches more than one project persona. Use a stable persona id.`,
        );
        continue;
      }

      const persona = matches[0] as PlatformPersona;
      if (resolved.has(persona.id)) {
        issues.push(`${file.shown} names persona ${persona.id} more than once.`);
        continue;
      }
      resolved.add(persona.id);
    }
  }
  return issues;
}

export async function runValidateCommand(
  options: FolderCommandOptions,
): Promise<number> {
  options.out(`url: ${options.access.url}`);
  const paths = folderPathsIn(options.cwd);
  options.out(`folder: ${paths.root}`);

  // Parse the complete value before authentication or network work. A local
  // syntax problem is the first useful fact and this command never writes.
  let repository: RepositoryContents;
  try {
    repository = await readRepository(paths);
  } catch (cause) {
    const issues =
      cause instanceof RepositoryValidationError
        ? cause.issues
        : [cause instanceof Error ? cause.message : String(cause)];
    options.out("status: invalid-repository");
    for (const issue of issues) options.out(`issue: ${issue}`);
    options.fail(
      "The Egma repository is invalid. Fix the issues above and validate again. Nothing was written.",
    );
    return FOLDER_EXIT.nothing;
  }

  const projectId = repository.config.project?.id ?? "";
  if (projectId === "") {
    options.out("status: no-project");
    options.fail(
      "This repository does not name its Egma project. Run egma connect here first.",
    );
    return FOLDER_EXIT.nothing;
  }

  const ready = await readyToSync(options);
  if (ready.kind === "stop") return ready.code;
  options.out(`project: ${projectId}`);

  let personas: readonly PlatformPersona[];
  try {
    personas = await listProjectPersonas(
      ready.signedIn,
      projectId,
      options.fetchImpl,
    );
  } catch (cause) {
    if (cause instanceof PlatformUnreachableError || cause instanceof PlatformRefusedError) {
      const status = cause instanceof PlatformRefusedError ? "refused" : "unreachable";
      options.out(`status: ${status}`);
      options.out(`reason: ${cause.message}`);
      options.fail(cause.message);
      return FOLDER_EXIT.unreachable;
    }
    throw cause;
  }

  const issues = personaReferenceIssues(repository, personas);
  if (issues.length > 0) {
    options.out("status: invalid-personas");
    for (const issue of issues) options.out(`issue: ${issue}`);
    options.fail(
      "The Egma repository names personas this project cannot use. Nothing was written.",
    );
    return FOLDER_EXIT.nothing;
  }

  const tests = repository.suites.flatMap((suite) => suite.tests);
  const references = tests.reduce(
    (total, test) => total + test.test.personas.length,
    0,
  );
  options.out(`suites: ${String(repository.suites.length)}`);
  options.out(`tests: ${String(tests.length)}`);
  options.out(`persona-references: ${String(references)}`);
  options.out("status: valid");
  return FOLDER_EXIT.done;
}
