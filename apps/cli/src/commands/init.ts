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
    | { readonly kind: "not-authenticated" }
    | { readonly kind: "refused" | "unreachable"; readonly reason: string },
  url: string,
): never {
  if (result.kind === "unreachable") {
    throw new PlatformUnreachableError(url, new Error(result.reason));
  }
  throw new PlatformRefusedError(
    result.kind === "not-authenticated" ? 401 : 400,
    result.kind === "not-authenticated"
      ? "This Egma credential is not valid. Run egma login again."
      : result.reason,
  );
}

/** Initialize or refresh one repository without creating a Project. */
export async function runInitCommand(options: InitCommandOptions): Promise<number> {
  options.out(`url: ${options.binding.origin}`);
  const signedIn = await signedInAt(options.access);
  if (signedIn === null) {
    options.out("status: not-signed-in");
    options.fail(notSignedInRefusal(options.access.url));
    return FOLDER_EXIT.notSignedIn;
  }

  const paths = folderPathsIn(options.cwd);
  const held = await existingConfig(paths.config);
  const askedProject = options.projectId?.trim() ?? "";
  const credentialProject = signedIn.projectId ?? "";

  if (
    held?.project !== null &&
    held?.project !== undefined &&
    ((askedProject !== "" && askedProject !== held.project.id) ||
      (credentialProject !== "" && credentialProject !== held.project.id))
  ) {
    options.out("status: different-project");
    options.fail(DIFFERENT_PROJECT);
    return FOLDER_EXIT.nothing;
  }

  if (credentialProject !== "" && askedProject !== "") {
    options.out("status: project-option-not-used");
    options.fail(
      `This login already identifies Project ${credentialProject}. Remove --project and run egma init again. Nothing was changed.`,
    );
    return FOLDER_EXIT.nothing;
  }

  const projectId = held?.project?.id ?? (credentialProject || askedProject);
  if (projectId === "") {
    const listed = await listProjects(signedIn, options.fetchImpl);
    if (listed.kind !== "projects") failRemote(listed, options.access.url);
    for (const project of listed.projects) {
      options.out(`project-option: ${project.id} ${project.name}`);
    }
    options.out("status: project-required");
    options.fail(
      "This credential does not identify one Project. Run egma init --project <Project ID>.",
    );
    return FOLDER_EXIT.nothing;
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

  options.out(`folder: ${folder.paths.root}`);
  options.out(`project: ${project.id} ${project.name}`);
  options.out(`agents: ${targets.agents.length}`);
  options.out(`suites: ${pulled.suites.length}`);
  options.out(`tests: ${pulled.tests.length}`);
  options.out(`status: ${folder.created ? "initialized" : "pulled"}`);
  return FOLDER_EXIT.done;
}
