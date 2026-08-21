/** The platform side of stable, project-owned test suites. */

import {
  createTestSuite as createTestSuiteRequest,
  getTestSuite as getTestSuiteRequest,
  listTestSuites as listTestSuitesRequest,
  type GetTestSuiteResponse,
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

export type PlatformTestSuite = Readonly<
  Pick<GetTestSuiteResponse, "id" | "projectId" | "name">
>;

function suiteFrom(value: GetTestSuiteResponse): PlatformTestSuite | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const id = platformText(body.id);
  const projectId = platformText(body.projectId);
  const name = platformText(body.name);
  if (id === "" || projectId === "" || name === "") return null;
  return { id, projectId, name };
}

export async function createTestSuite(
  signedIn: SignedIn,
  input: { readonly projectId: string; readonly name: string },
  fetchImpl?: Fetch,
): Promise<PlatformTestSuite> {
  const answer = await createTestSuiteRequest(
    { projectId: input.projectId, name: input.name },
    { client: platformClient(signedIn, fetchImpl) },
  );
  const response = platformResponse(answer, signedIn.url);
  if (!response.ok || answer.data === undefined) {
    throw new PlatformRefusedError(
      response.status,
      platformRefusalMessage(answer.error, response.status),
    );
  }
  const suite = suiteFrom(answer.data);
  if (suite === null) {
    throw new PlatformRefusedError(
      response.status,
      "Egma created a suite but did not answer with its stable identity. Pull to recover it, and check that this Egma instance is up to date.",
    );
  }
  return suite;
}

export async function listTestSuites(
  signedIn: SignedIn,
  projectId: string,
  fetchImpl?: Fetch,
): Promise<readonly PlatformTestSuite[]> {
  const suites: PlatformTestSuite[] = [];
  const client = platformClient(signedIn, fetchImpl);
  let pageToken: string | undefined;
  for (;;) {
    const answer = await listTestSuitesRequest(
      {
        projectId,
        ...(pageToken === undefined ? {} : { pageToken }),
      },
      { client },
    );
    const response = platformResponse(answer, signedIn.url);
    if (!response.ok) {
      throw new PlatformRefusedError(
        response.status,
        platformRefusalMessage(answer.error, response.status),
      );
    }
    const values = answer.data?.testSuites ?? [];
    for (const value of values) {
      const suite = suiteFrom(value);
      if (suite === null) {
        throw new PlatformRefusedError(
          response.status,
          "Egma answered with a suite this CLI cannot read. Check that this Egma platform is up to date.",
        );
      }
      suites.push(suite);
    }
    const next = answer.data?.nextPageToken ?? null;
    if (next === null || next === "") return suites;
    pageToken = next;
  }
}

export async function getTestSuite(
  signedIn: SignedIn,
  suiteId: string,
  fetchImpl?: Fetch,
): Promise<PlatformTestSuite | null> {
  const answer = await getTestSuiteRequest(
    { suiteId },
    { client: platformClient(signedIn, fetchImpl) },
  );
  const response = platformResponse(answer, signedIn.url);
  if (response.status === 404) return null;
  if (!response.ok || answer.data === undefined) {
    throw new PlatformRefusedError(
      response.status,
      platformRefusalMessage(answer.error, response.status),
    );
  }
  const suite = suiteFrom(answer.data);
  if (suite === null) {
    throw new PlatformRefusedError(
      response.status,
      "Egma answered with a suite this CLI cannot read. Check that this Egma platform is up to date.",
    );
  }
  return suite;
}
