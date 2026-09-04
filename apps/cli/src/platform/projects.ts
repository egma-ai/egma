/** The small project read the repository binding needs. */

import {
  getProject as getProjectRequest,
  listProjects as listProjectsRequest,
  type GetProjectResponse,
} from "@egma/platform-api/client";

import {
  platformClient,
  platformRefusalMessage,
  platformResponse,
  platformText,
} from "./client.ts";
import type { Fetch } from "./device-flow.ts";
import { PlatformRefusedError } from "./refused.ts";
import type { SignedIn } from "./signed-in.ts";

export type PlatformProject = Readonly<
  Pick<GetProjectResponse, "id" | "name">
>;

export type ListedProjects =
  | { readonly kind: "projects"; readonly projects: readonly PlatformProject[] }
  | { readonly kind: "not-authenticated"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string };

/** List the Projects this credential can select during init. */
export async function listProjects(
  signedIn: SignedIn,
  fetchImpl?: Fetch,
  signal?: AbortSignal,
): Promise<ListedProjects> {
  const answer = await listProjectsRequest({
    client: platformClient(signedIn, fetchImpl),
    ...(signal === undefined ? {} : { signal }),
  });
  const response = platformResponse(answer, signedIn.url);
  if (response.status === 401) {
    return {
      kind: "not-authenticated",
      reason: platformRefusalMessage(answer.error, response.status),
    };
  }
  if (!response.ok || answer.data === undefined) {
    return {
      kind: "refused",
      reason: platformRefusalMessage(answer.error, response.status),
    };
  }
  if (!Array.isArray(answer.data.projects)) {
    return {
      kind: "refused",
      reason:
        "Egma answered with a Project collection this CLI cannot read. Check that this Egma platform is up to date.",
    };
  }
  const projects: PlatformProject[] = [];
  for (const raw of answer.data.projects) {
    const id = platformText(raw.id);
    const name = platformText(raw.name);
    if (id === "" || name === "") {
      return {
        kind: "refused",
        reason:
          "Egma answered with an incomplete Project. Check that this Egma platform is up to date.",
      };
    }
    projects.push({ id, name });
  }
  return { kind: "projects", projects };
}

export async function readProject(
  signedIn: SignedIn,
  projectId: string,
  fetchImpl?: Fetch,
  signal?: AbortSignal,
): Promise<PlatformProject> {
  const answer = await getProjectRequest(
    { projectId },
    {
      client: platformClient(signedIn, fetchImpl),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const response = platformResponse(answer, signedIn.url);
  if (!response.ok || answer.data === undefined) {
    throw new PlatformRefusedError(
      response.status,
      platformRefusalMessage(answer.error, response.status),
    );
  }
  const id = platformText(answer.data.id);
  const name = platformText(answer.data.name);
  if (id === "" || name === "") {
    throw new PlatformRefusedError(
      response.status,
      "Egma answered without the project identity and name. Check that this Egma instance is up to date.",
    );
  }
  if (id !== projectId) {
    throw new PlatformRefusedError(
      response.status,
      "Egma answered with a different project ID. Check that this Egma instance is up to date.",
    );
  }
  return { id, name };
}
