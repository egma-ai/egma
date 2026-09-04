/** Read every active persona a project may name in a repository test. */

import { listPersonas as listPersonasRequest } from "@egma/platform-api/client";

import {
  platformClient,
  platformRefusalMessage,
  platformResponse,
  platformText,
} from "./client.ts";
import type { Fetch } from "./device-flow.ts";
import { PlatformRefusedError } from "./refused.ts";
import type { SignedIn } from "./signed-in.ts";

export type PlatformPersona = {
  readonly id: string;
  readonly name: string;
};

/**
 * Follow the public persona list to its end.
 *
 * A repository may name a persona from any page. Returning a first page as the
 * whole catalog would make a valid file become invalid as soon as a project
 * gained enough personas to paginate.
 */
export async function listProjectPersonas(
  signedIn: SignedIn,
  projectId: string,
  fetchImpl?: Fetch,
): Promise<readonly PlatformPersona[]> {
  const found: PlatformPersona[] = [];
  const seenIds = new Set<string>();
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  while (true) {
    const answer = await listPersonasRequest(
      {
        projectId,
        ...(pageToken === undefined ? {} : { pageToken }),
      },
      { client: platformClient(signedIn, fetchImpl) },
    );
    const response = platformResponse(answer, signedIn.url);
    if (!response.ok || answer.data === undefined) {
      throw new PlatformRefusedError(
        response.status,
        platformRefusalMessage(answer.error, response.status),
      );
    }

    const values = answer.data.personas;
    const next = answer.data.nextPageToken;
    if (
      !Array.isArray(values) ||
      (next !== null && typeof next !== "string")
    ) {
      throw new PlatformRefusedError(
        response.status,
        "Egma answered with a Persona collection this CLI cannot read. Check that this Egma platform is up to date.",
      );
    }

    for (const persona of values) {
      const id = platformText(persona.id);
      const name = platformText(persona.name);
      if (id === "" || name === "") {
        throw new PlatformRefusedError(
          response.status,
          "Egma answered with a persona that has no stable id or name. Check that this Egma instance is up to date.",
        );
      }
      if (seenIds.has(id)) {
        throw new PlatformRefusedError(
          response.status,
          `Egma listed persona ${id} more than once. Check that this Egma instance is up to date.`,
        );
      }
      seenIds.add(id);
      found.push({ id, name });
    }

    if (next === null || next === "") return found;
    if (seenTokens.has(next)) {
      throw new PlatformRefusedError(
        response.status,
        `Egma repeated persona page token ${next}. Check that this Egma instance is up to date.`,
      );
    }
    seenTokens.add(next);
    pageToken = next;
  }
}
