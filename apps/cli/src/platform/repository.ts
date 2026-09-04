/** One atomic, non-destructive repository push at the HTTP boundary. */

import {
  applyRepositoryChangeSet as applyRepositoryChangeSetRequest,
  type ApplyRepositoryChangeSetResponse,
} from "@egma/platform-api/client";

import { sameEnv } from "../folder/env.ts";
import { sameMockTools } from "../folder/mock-tools.ts";
import type { FilePersona } from "../folder/test-file.ts";
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

export type ReturnedRepositoryTestReceipt = {
  readonly clientRef: string | null;
  readonly test: Readonly<Pick<PlatformTest, "id" | "name" | "versionId">>;
};

/** Egma committed the change set but returned no safe one-to-one local mapping. */
export class RepositoryReceiptError extends PlatformRefusedError {
  public readonly receipts: readonly ReturnedRepositoryTestReceipt[];
  public readonly reason: string;

  public constructor(
    status: number,
    reason: string,
    receipts: readonly ReturnedRepositoryTestReceipt[],
  ) {
    const listed = receipts.map(
      ({ clientRef, test }) =>
        `- Test ${JSON.stringify(test.name)} (${JSON.stringify(test.id)}), version ${JSON.stringify(test.versionId)}, for ${clientRef === null ? "an unknown local file" : JSON.stringify(clientRef)}`,
    );
    super(
      status,
      [
        reason,
        ...(listed.length === 0 ? [] : ["Returned Test receipts:", ...listed]),
        "Run egma pull.",
      ].join("\n"),
    );
    this.name = "RepositoryReceiptError";
    this.receipts = receipts;
    this.reason = reason;
  }
}

function samePersonas(
  requested: readonly FilePersona[],
  returned: readonly FilePersona[],
): boolean {
  return requested.length === returned.length &&
    requested.every((persona, index) => {
      const found = returned[index];
      if (found === undefined) return false;
      return persona.id === "" || found.id === ""
        ? persona.name === found.name
        : persona.id === found.id;
    });
}

function confirmsTest(
  returned: PlatformTest,
  requested: RepositoryTestChange,
  projectId: string,
): boolean {
  return returned.projectId === projectId &&
    returned.suiteId === requested.suiteId &&
    returned.name === requested.input.name &&
    returned.description === requested.input.description &&
    returned.scenario === requested.input.scenario &&
    returned.expectedBehaviors.length === requested.input.expectedBehaviors.length &&
    returned.expectedBehaviors.every(
      (behavior, index) => behavior === requested.input.expectedBehaviors[index],
    ) &&
    samePersonas(requested.input.personas, returned.personas) &&
    sameMockTools(requested.input.mockTools, returned.mockTools) &&
    sameEnv(requested.input.env, returned.env);
}

function durableReceipt(value: unknown): ReturnedRepositoryTestReceipt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Readonly<Record<string, unknown>>;
  const held = row["test"];
  if (typeof held !== "object" || held === null || Array.isArray(held)) return null;
  const test = held as Readonly<Record<string, unknown>>;
  const clientRef = platformText(row["clientRef"]);
  const id = platformText(test["id"]);
  const name = platformText(test["name"]);
  const versionId = platformText(test["versionId"]);
  return id === "" || versionId === ""
    ? null
    : {
        clientRef: clientRef === "" ? null : clientRef,
        test: { id, name, versionId },
      };
}

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

  if (!Array.isArray(answer.data.tests)) {
    throw new RepositoryReceiptError(
      response.status,
      "Egma applied the repository but answered without a Test receipt collection this CLI can read.",
      [],
    );
  }

  const applied: AppliedRepositoryTest[] = [];
  const receipts = answer.data.tests.flatMap((value) => {
    const receipt = durableReceipt(value);
    return receipt === null ? [] : [receipt];
  });
  let incomplete = false;
  for (const value of answer.data.tests) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      incomplete = true;
      continue;
    }
    const row: ApplyRepositoryChangeSetResponse["tests"][number] = value;
    const clientRef = platformText(row.clientRef);
    const test = platformTestFrom(row.test);
    if (clientRef === "" || test === null) {
      incomplete = true;
      continue;
    }
    applied.push({ clientRef, test });
  }
  if (incomplete) {
    throw new RepositoryReceiptError(
      response.status,
      "Egma applied the repository but answered without every Test identity needed to update local pins.",
      receipts,
    );
  }

  const expected = new Set(changeSet.tests.map((test) => test.clientRef));
  const seen = new Set<string>();
  const duplicate = applied.find((receipt) => {
    if (seen.has(receipt.clientRef)) return true;
    seen.add(receipt.clientRef);
    return false;
  });
  const unexpected = applied.find((receipt) => !expected.has(receipt.clientRef));
  const missing = [...expected].find((clientRef) => !seen.has(clientRef));
  if (duplicate !== undefined || unexpected !== undefined || missing !== undefined) {
    const detail =
      duplicate !== undefined
        ? `duplicate file receipt ${JSON.stringify(duplicate.clientRef)}`
        : unexpected !== undefined
          ? `unknown file receipt ${JSON.stringify(unexpected.clientRef)}`
          : `no receipt for ${JSON.stringify(missing)}`;
    throw new RepositoryReceiptError(
      response.status,
      `Egma applied the repository but returned a ${detail}, so local Test pins were not changed.`,
      receipts,
    );
  }

  const requestedByRef = new Map(
    changeSet.tests.map((test) => [test.clientRef, test] as const),
  );
  const mismatched = applied.find((receipt) => {
    const requested = requestedByRef.get(receipt.clientRef);
    return requested === undefined ||
      !confirmsTest(receipt.test, requested, changeSet.projectId);
  });
  if (mismatched !== undefined) {
    throw new RepositoryReceiptError(
      response.status,
      `Egma applied the repository but returned Test content or ownership that does not match ${JSON.stringify(mismatched.clientRef)}, so local Test pins were not changed.`,
      receipts,
    );
  }
  return { tests: applied };
}
