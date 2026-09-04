/** One atomic, non-destructive repository push at the HTTP boundary. */

import {
  applyRepositoryChangeSet as applyRepositoryChangeSetRequest,
  type ApplyRepositoryChangeSetResponse,
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
import {
  platformTestFrom,
  testWriteBody,
  type PlatformTest,
  type TestInput,
} from "./tests.ts";

export type RepositorySuiteChange = {
  readonly id: string;
  readonly name: string;
};

export type RepositoryTestChange = {
  /** Local path used only to match the response. Never stored as product data. */
  readonly clientRef: string;
  readonly suiteId: string;
  readonly input: TestInput;
  readonly expectedVersionId: string | null;
  readonly expectedRevision: string | null;
};

export type RepositoryChangeSet = {
  readonly projectId: string;
  readonly suites: readonly RepositorySuiteChange[];
  readonly tests: readonly RepositoryTestChange[];
};

export type AppliedRepositoryTest = {
  readonly clientRef: string;
  readonly test: PlatformTest;
};

export type AppliedRepositoryChangeSet = {
  readonly tests: readonly AppliedRepositoryTest[];
};

export async function applyRepositoryChangeSet(
  signedIn: SignedIn,
  changeSet: RepositoryChangeSet,
  fetchImpl?: Fetch,
  signal?: AbortSignal,
): Promise<AppliedRepositoryChangeSet> {
  const answer = await applyRepositoryChangeSetRequest(
    {
      projectId: changeSet.projectId,
      suites: changeSet.suites.map((suite) => ({ id: suite.id, name: suite.name })),
      tests: changeSet.tests.map((test) => ({
        clientRef: test.clientRef,
        suiteId: test.suiteId,
        ...testWriteBody(test.input),
        ...(test.expectedVersionId === null
          ? {}
          : { expectedVersionId: test.expectedVersionId }),
        ...(test.expectedRevision === null || test.expectedRevision === ""
          ? {}
          : { expectedRevision: test.expectedRevision }),
      })),
    },
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

  const applied: AppliedRepositoryTest[] = [];
  for (const value of answer.data.tests) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const row: ApplyRepositoryChangeSetResponse["tests"][number] = value;
    const clientRef = platformText(row.clientRef);
    const test = platformTestFrom(row.test);
    if (clientRef === "" || test === null) {
      throw new PlatformRefusedError(
        response.status,
        "Egma applied the repository but answered without the test identities needed to update local pins. Pull to recover them.",
      );
    }
    applied.push({ clientRef, test });
  }
  if (applied.length !== changeSet.tests.length) {
    throw new PlatformRefusedError(
      response.status,
      "Egma applied the repository but did not answer every test needed to update local pins. Pull to recover them.",
    );
  }
  return { tests: applied };
}
