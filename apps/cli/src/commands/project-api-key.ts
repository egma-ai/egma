/** `egma project api-key create --name`: mint one ordinary Project key. */

import { readConfig } from "../folder/egma-folder.ts";
import { createProjectKey } from "../platform/api-keys.ts";
import { FOLDER_EXIT, readyToSync, type FolderCommandOptions } from "./folder-verbs.ts";

export type ProjectApiKeyCreateCommandOptions = FolderCommandOptions & {
  readonly name: string;
  readonly signal?: AbortSignal;
};

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
  const name = options.name.trim();
  if (name === "") {
    options.out("status: missing-name");
    options.fail("Give this Project API key a name with --name. Nothing was created.");
    return FOLDER_EXIT.nothing;
  }

  options.out(`url: ${options.access.url}`);
  const ready = await readyToSync(options);
  if (ready.kind === "stop") return ready.code;

  const config = await readConfig(ready.paths.config);
  if (config.project === null) {
    options.out("status: no-project");
    options.fail("egma/config.yaml does not name an Egma Project. Run egma init again.");
    return FOLDER_EXIT.nothing;
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
    case "created":
      options.out(`api_key_id: ${created.key.id}`);
      options.out(`api_key_name: ${created.key.name ?? name}`);
      // This is the only reveal in the command. It is intentionally not saved.
      options.out(`api_key: ${created.key.secret.reveal()}`);
      options.out("status: created");
      return FOLDER_EXIT.done;
    case "not-authenticated":
      options.out("status: not-signed-in");
      options.fail(
        `Egma did not accept the credential for ${options.access.url}. Run egma login, then try again.`,
      );
      return FOLDER_EXIT.notSignedIn;
    case "refused":
    case "unreachable":
      options.out("status: failed");
      options.out(`reason: ${created.reason}`);
      options.fail(created.reason);
      return FOLDER_EXIT.unreachable;
  }
}
