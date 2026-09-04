/** `egma project api-key create --name`: mint one ordinary Project key. */

import { readConfig } from "../folder/egma-folder.ts";
import { createProjectKey } from "../platform/api-keys.ts";
import { oneLineFactText } from "../ui/fact-value.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";

export type ProjectApiKeyCreateCommandOptions = FolderCommandOptions & {
  readonly name: string;
  readonly signal?: AbortSignal;
};

function wasInterrupted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sayCreatedProjectKey(
  created: Extract<Awaited<ReturnType<typeof createProjectKey>>, { readonly kind: "created" }>,
  requestedName: string,
  out: (line: string) => void,
): void {
  out(
    `Created Project API key ${oneLineFactText(created.key.name ?? requestedName, "Unnamed")}.`,
  );
  out(`Key ID: ${oneLineFactText(created.key.id, "unknown Project API key ID")}`);
  // This is the only reveal in the command. It is intentionally not saved.
  out(`API key: ${created.key.secret.reveal()}`);
  out("Copy this key now. Egma CLI does not save it.");
}

/**
 * Create a Project key and print its secret once.
 *
 * The repository binding supplies the Project. The key is not saved in the
 * repository or in Egma's machine-login file; the developer decides where its
 * one-time value belongs.
 */
export async function runProjectApiKeyCreateCommand(
  options: ProjectApiKeyCreateCommandOptions,
): Promise<number> {
  if (wasInterrupted(options.signal)) {
    options.fail("The command was interrupted before anything changed.");
    return FOLDER_EXIT.interrupted;
  }

  const name = options.name.trim();
  if (name === "") {
    options.fail("Give this Project API key a name with --name. Nothing was created.");
    return FOLDER_EXIT.nothing;
  }

  const ready = await readyToSync(options);
  if (ready.kind === "stop") return ready.code;

  const config = await readConfig(ready.paths.config);
  if (config.project === null) {
    options.fail("egma/config.yaml does not name an Egma Project. Run egma init again.");
    return FOLDER_EXIT.nothing;
  }

  if (wasInterrupted(options.signal)) {
    options.fail("The command was interrupted before anything changed.");
    return FOLDER_EXIT.interrupted;
  }

  const created = await createProjectKey(
    { name, projectId: config.project.id },
    {
      ...ready.signedIn,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    },
  );
  switch (created.kind) {
    case "created": {
      sayCreatedProjectKey(created, name, options.out);
      if (wasInterrupted(options.signal)) {
        options.fail(
          "The command was interrupted after Egma created this Project API key. The CLI did not save it. Copy it now, or revoke it before you create another key.",
        );
        return FOLDER_EXIT.interrupted;
      }
      return FOLDER_EXIT.done;
    }
    case "not-authenticated":
      options.fail(created.reason);
      options.fail(
        `Egma did not accept the credential for ${options.access.url}. Run egma login, then try again.`,
      );
      return FOLDER_EXIT.notSignedIn;
    case "uncertain":
      options.fail(created.reason);
      if (wasInterrupted(options.signal)) {
        options.fail(
          "The command was interrupted before it received a complete answer.",
        );
        return FOLDER_EXIT.interrupted;
      }
      return FOLDER_EXIT.unreachable;
    case "refused":
    case "unreachable":
      options.fail(created.reason);
      return FOLDER_EXIT.unreachable;
  }
}
