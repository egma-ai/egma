/** The small project read the repository binding needs. */

import {
  getProject as getProjectRequest,
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
  return { id, name };
}
