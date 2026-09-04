/** The platform side of stable, project-owned test suites. */

import {
  createTestSuite as createTestSuiteRequest,
  deleteTestSuite as deleteTestSuiteRequest,
  getTestSuite as getTestSuiteRequest,
  listTestSuites as listTestSuitesRequest,
  type GetTestSuiteResponse,
} from "@egma/platform-api/client";

import { isSuiteId } from "../folder/egma-folder.ts";

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

export type GetTestSuiteAnswer =
  | { readonly kind: "suite"; readonly suite: PlatformTestSuite }
  | { readonly kind: "not-found"; readonly reason: string };

/** A successful create response did not prove that it created the requested Suite. */
export class TestSuiteCreationReceiptError extends Error {
  public readonly suiteId: string | null;

  public constructor(suiteId: string | null) {
    super(
      "Egma answered with a Suite receipt that did not match the requested Project and name.",
    );
    this.name = "TestSuiteCreationReceiptError";
    this.suiteId = suiteId;
  }
}

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
  signal?: AbortSignal,
): Promise<PlatformTestSuite> {
  const answer = await createTestSuiteRequest(
    { projectId: input.projectId, name: input.name },
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
  const suite = suiteFrom(answer.data);
  if (suite === null) {
    const returnedId = platformText(answer.data.id);
    throw new TestSuiteCreationReceiptError(returnedId === "" ? null : returnedId);
  }
  if (
    !isSuiteId(suite.id) ||
    suite.projectId !== input.projectId ||
    suite.name !== input.name
  ) {
    throw new TestSuiteCreationReceiptError(suite.id);
  }
  return suite;
}

/** Permanently remove one project-owned suite from authoring. */
export async function deleteTestSuite(
  signedIn: SignedIn,
  input: { readonly projectId: string; readonly suiteId: string },
  fetchImpl?: Fetch,
  signal?: AbortSignal,
): Promise<void> {
  const answer = await deleteTestSuiteRequest(
    { suiteId: input.suiteId, projectId: input.projectId },
    {
      client: platformClient(signedIn, fetchImpl),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const response = platformResponse(answer, signedIn.url);
  if (response.status !== 204) {
    throw new PlatformRefusedError(
      response.status,
      platformRefusalMessage(answer.error, response.status),
    );
  }
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
    const values = answer.data?.testSuites;
    const next = answer.data?.nextPageToken;
    if (
      !Array.isArray(values) ||
      (next !== null && typeof next !== "string")
    ) {
      throw new PlatformRefusedError(
        response.status,
        "Egma answered with a Test Suite collection this CLI cannot read. Check that this Egma platform is up to date.",
      );
    }
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
    if (next === null || next === "") return suites;
    pageToken = next;
  }
}

export async function getTestSuite(
  signedIn: SignedIn,
  suiteId: string,
  fetchImpl?: Fetch,
  signal?: AbortSignal,
): Promise<GetTestSuiteAnswer> {
  const answer = await getTestSuiteRequest(
    { suiteId },
    {
      client: platformClient(signedIn, fetchImpl),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const response = platformResponse(answer, signedIn.url);
  if (response.status === 404) {
    return {
      kind: "not-found",
      reason: platformRefusalMessage(answer.error, 404),
    };
  }
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
  return { kind: "suite", suite };
}
