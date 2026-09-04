/** `egma init`: bind this repository, then pull the Project into it. */

import {
  CONFIG_FORMAT,
  createEgmaFolder,
  folderPathsIn,
  readConfig,
  type FolderConfig,
  type PlatformBinding,
} from "../folder/egma-folder.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { listProjects, readProject } from "../platform/projects.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import { notSignedInRefusal, signedInAt } from "../platform/signed-in.ts";
import { pullRepository } from "../sync/pull.ts";
import { readProjectTargets } from "../sync/targets.ts";
import { oneLineFactText } from "../ui/fact-value.ts";
import { FOLDER_EXIT, type FolderCommandOptions } from "./folder-verbs.ts";

export type InitCommandOptions = FolderCommandOptions & {
  readonly binding: PlatformBinding;
  /** An explicit Project for an organization-scoped or legacy credential. */
  readonly projectId?: string;
};

const DIFFERENT_PROJECT = [
  "This repository is already initialized for another Egma Project.",
  "",
  "Move or delete egma/, then run egma init again.",
  "",
  "Nothing was changed.",
].join("\n");

async function existingConfig(file: string): Promise<FolderConfig | null> {
  try {
    return await readConfig(file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

function failRemote(
  result:
    | { readonly kind: "not-authenticated"; readonly reason: string }
    | { readonly kind: "refused" | "unreachable"; readonly reason: string },
  url: string,
): never {
  if (result.kind === "unreachable") {
    throw new PlatformUnreachableError(url, new Error(result.reason));
  }
  throw new PlatformRefusedError(
    result.kind === "not-authenticated" ? 401 : 400,
    result.kind === "not-authenticated"
      ? `${result.reason}\nRun egma login again.`
      : result.reason,
  );
}

/** Initialize or refresh one repository without creating a Project. */
export async function runInitCommand(options: InitCommandOptions): Promise<number> {
  const signedIn = await signedInAt(options.access);
  if (signedIn === null) {
    options.fail(notSignedInRefusal(options.access.url));
    return FOLDER_EXIT.nothing;
  }

  const paths = folderPathsIn(options.cwd);
  let held: FolderConfig | null;
  try {
    held = await existingConfig(paths.config);
  } catch (cause) {
    options.fail(
      `Egma could not read egma/config.yaml: ${cause instanceof Error ? cause.message : String(cause)} Nothing was changed.`,
    );
    return FOLDER_EXIT.nothing;
  }
  const askedProject = options.projectId?.trim() ?? "";
  const credentialProject = signedIn.projectId ?? "";

  if (
    held?.project !== null &&
    held?.project !== undefined &&
    ((askedProject !== "" && askedProject !== held.project.id) ||
      (credentialProject !== "" && credentialProject !== held.project.id))
  ) {
    options.fail(DIFFERENT_PROJECT);
    return FOLDER_EXIT.nothing;
  }

  if (credentialProject !== "" && askedProject !== "") {
    options.fail(
      `This login already identifies Project ${credentialProject}. Remove --project and run egma init again. Nothing was changed.`,
    );
    return FOLDER_EXIT.nothing;
  }

  let projectId = held?.project?.id ?? (credentialProject || askedProject);
  if (projectId === "") {
    const listed = await listProjects(signedIn, options.fetchImpl);
    if (listed.kind !== "projects") failRemote(listed, options.access.url);

    if (listed.projects.length === 0) {
      options.fail(
        "This Egma account has no Project. Create a Project in Egma, then run egma init again. Nothing was changed.",
      );
      return FOLDER_EXIT.nothing;
    }

    if (listed.projects.length === 1) {
      projectId = listed.projects[0]!.id;
    } else {
      options.out("Available Egma Projects:");
      for (const project of listed.projects) {
        options.out(
          `- ${oneLineFactText(project.name, "Unnamed Project")} (${oneLineFactText(project.id, "unknown Project ID")})`,
        );
      }
      options.fail(
        "This credential does not identify one Project. Run egma init --project <Project ID>.",
      );
      return FOLDER_EXIT.nothing;
    }
  }

  const project = await readProject(signedIn, projectId, options.fetchImpl);
  const folder =
    held === null
      ? await createEgmaFolder({
          repository: options.cwd,
          config: {
            format: CONFIG_FORMAT,
            platform: options.binding,
            project,
            agents: [],
          },
        })
      : { paths, created: false, config: held };

  const targets = await readProjectTargets(project.id, {
    ...signedIn,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  if (targets.kind !== "synced") failRemote(targets, options.access.url);

  const pulled = await pullRepository({
    signedIn,
    paths: folder.paths,
    config: {
      format: CONFIG_FORMAT,
      platform: folder.config.platform ?? options.binding,
      project,
      agents: targets.agents,
    },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  options.out(
    folder.created
      ? `Initialized Egma in ${oneLineFactText(folder.paths.root, "this repository")}.`
      : `Refreshed ${oneLineFactText(folder.paths.root, "this repository")} from Egma.`,
  );
  options.out(
    `Project: ${oneLineFactText(project.name, "Unnamed Project")} (${oneLineFactText(project.id, "unknown Project ID")})`,
  );
  options.out(`Agents: ${targets.agents.length}`);
  options.out(`Suites: ${pulled.suites.length}`);
  options.out(`Tests: ${pulled.tests.length}`);
  return FOLDER_EXIT.done;
}
