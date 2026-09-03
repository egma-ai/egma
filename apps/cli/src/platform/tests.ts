/** The platform adapter for versioned tests with immutable suite ownership. */

import {
  createTest as createTestRequest,
  getTest as getTestRequest,
  getTestVersion as getTestVersionRequest,
  listTests as listTestsRequest,
  updateTest as updateTestRequest,
  type GetTestResponse,
  type GetTestVersionResponse,
} from "@egma/platform-api/client";

type CreateTestParameters = Parameters<typeof createTestRequest>[0];
type TestMockTool = NonNullable<CreateTestParameters["mockTools"]>[number];
type TestWriteParameters = {
  readonly name: string;
  readonly description: string;
  readonly scenario: string;
  readonly expectedBehaviors: string[];
  readonly personas: string[];
  readonly mockTools: TestMockTool[];
};

import type { MockToolEntry } from "../folder/mock-tools.ts";
import type { ExpectedBehavior, FilePersona } from "../folder/test-file.ts";
import {
  platformClient,
  platformRefusalMessage,
  platformResponse,
  platformText,
} from "./client.ts";
import type { Fetch } from "./device-flow.ts";
import { overrideFrom } from "./mock-tools.ts";
import { PlatformRefusedError } from "./refused.ts";
import type { SignedIn } from "./signed-in.ts";

export type PlatformContent = {
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehavior[];
  readonly personas: readonly FilePersona[];
  readonly mockTools: readonly MockToolEntry[];
};

export type PlatformTest = PlatformContent & {
  readonly id: string;
  readonly suiteId: string;
  readonly name: string;
  readonly description: string;
  readonly versionId: string;
  readonly version: number;
  readonly revision: string;
};

export type PlatformTestVersion = PlatformContent & {
  readonly id: string;
  readonly testId: string;
  readonly suiteId: string;
  readonly testName: string;
  readonly version: number;
  readonly current: boolean;
};

export type WriteAnswer =
  | { readonly kind: "written"; readonly test: PlatformTest }
  | {
      readonly kind: "version-conflict";
      readonly testName: string;
      readonly currentVersionId: string;
    }
  | { readonly kind: "identity-conflict"; readonly reason: string }
  | { readonly kind: "turned-away"; readonly reason: string };

function personasIn(value: GetTestResponse["personas"]): readonly FilePersona[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const id = platformText(entry.id);
    const name = platformText(entry.name);
    return id === "" && name === "" ? [] : [{ id, name }];
  });
}

function behaviorsIn(
  value: GetTestResponse["expectedBehaviors"],
): readonly ExpectedBehavior[] {
  if (!Array.isArray(value)) return [];
  return value.map(platformText).filter((entry) => entry !== "");
}

function mockToolsIn(value: GetTestResponse["mockTools"]): readonly MockToolEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? [
          overrideFrom({
            tool: platformText(entry.tool),
            ...("error" in entry
              ? { error: entry.error }
              : { answer: entry.answer }),
            delayMs: typeof entry.delayMs === "number" ? entry.delayMs : 0,
          }),
        ]
      : [],
  );
}

function contentFrom(body: GetTestResponse | GetTestVersionResponse): PlatformContent {
  return {
    scenario: platformText(body.scenario),
    expectedBehaviors: behaviorsIn(body.expectedBehaviors),
    personas: personasIn(body.personas),
    mockTools: mockToolsIn(body.mockTools),
  };
}

export function platformTestFrom(value: GetTestResponse): PlatformTest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const test: PlatformTest = {
    ...contentFrom(value),
    id: platformText(value.id),
    suiteId: platformText(value.suiteId),
    name: platformText(value.name),
    description: platformText(value.description),
    versionId: platformText(value.versionId),
    version: typeof value.version === "number" ? value.version : 0,
    revision: platformText(value.revision),
  };
  return test.id === "" || test.suiteId === "" || test.versionId === "" ? null : test;
}

export type ListOptions = {
  readonly projectId: string;
  readonly suiteId: string;
  readonly fetchImpl?: Fetch;
  readonly signal?: AbortSignal;
};

/** Walk the complete project or suite list through bounded platform pages. */
export async function listTests(
  signedIn: SignedIn,
  options: ListOptions,
): Promise<readonly PlatformTest[]> {
  const found: PlatformTest[] = [];
  const client = platformClient(signedIn, options.fetchImpl);
  let pageToken: string | undefined;
  for (;;) {
    const answer = await listTestsRequest(
      {
        projectId: options.projectId,
        suiteId: options.suiteId,
        ...(pageToken === undefined ? {} : { pageToken }),
      },
      {
        client,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    const response = platformResponse(answer, signedIn.url);
    if (!response.ok) {
      throw new PlatformRefusedError(
        response.status,
        platformRefusalMessage(answer.error, response.status),
      );
    }
    for (const entry of answer.data?.tests ?? []) {
      const test = platformTestFrom(entry);
      if (test === null) {
        throw new PlatformRefusedError(
          response.status,
          "Egma answered with a test this CLI cannot read. Check that this Egma platform is up to date.",
        );
      }
      found.push(test);
    }
    const next = answer.data?.nextPageToken ?? null;
    if (next === null || next === "") return found;
    pageToken = next;
  }
}

export async function getTest(
  signedIn: SignedIn,
  testId: string,
  fetchImpl?: Fetch,
): Promise<PlatformTest | null> {
  const answer = await getTestRequest(
    { testId },
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
  const test = platformTestFrom(answer.data);
  if (test === null) {
    throw new PlatformRefusedError(
      response.status,
      "Egma answered with a test this CLI cannot read. Check that this Egma platform is up to date.",
    );
  }
  return test;
}

export async function getTestVersion(
  signedIn: SignedIn,
  versionId: string,
  fetchImpl?: Fetch,
  signal?: AbortSignal,
): Promise<PlatformTestVersion | null> {
  const answer = await getTestVersionRequest(
    { versionId },
    {
      client: platformClient(signedIn, fetchImpl),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const response = platformResponse(answer, signedIn.url);
  if (response.status === 404) return null;
  if (!response.ok || answer.data === undefined) {
    throw new PlatformRefusedError(
      response.status,
      platformRefusalMessage(answer.error, response.status),
    );
  }
  const body: GetTestVersionResponse = answer.data;
  const version: PlatformTestVersion = {
    ...contentFrom(body),
    id: platformText(body.id),
    testId: platformText(body.testId),
    suiteId: platformText(body.suiteId),
    testName: platformText(body.testName),
    version: typeof body.version === "number" ? body.version : 0,
    current: body.current === true,
  };
  return version.id === "" || version.testId === "" || version.suiteId === ""
    ? null
    : version;
}

export type TestInput = PlatformContent & {
  readonly name: string;
  readonly description: string;
};

export type CreateInput = TestInput & {
  readonly suiteId: string;
};

function personaFor(persona: FilePersona): string {
  return persona.id.trim() === "" ? persona.name : persona.id;
}

/** The exact authored test body shared by direct and atomic write adapters. */
export function testWriteBody(input: TestInput): TestWriteParameters {
  return {
    name: input.name,
    description: input.description,
    scenario: input.scenario,
    expectedBehaviors: [...input.expectedBehaviors],
    personas: input.personas.map(personaFor),
    mockTools: input.mockTools.map((entry): TestMockTool => {
      const { delay_ms: delayMs, ...says } = entry.says;
      return {
        ...says,
        tool: entry.tool,
        ...(typeof delayMs === "number" ? { delayMs } : {}),
      } as TestMockTool;
    }),
  };
}

function fieldIn(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null && key in error
    ? error[key as keyof typeof error]
    : undefined;
}

function answerFor(
  answer: { readonly error?: unknown; readonly response?: Response },
  signedIn: SignedIn,
): WriteAnswer | null {
  const response = platformResponse(answer, signedIn.url);
  if (response.status === 409) {
    if (platformText(fieldIn(answer.error, "error")) === "identity_conflict") {
      return {
        kind: "identity-conflict",
        reason: platformRefusalMessage(answer.error, response.status),
      };
    }
    const test = fieldIn(answer.error, "test");
    return {
      kind: "version-conflict",
      testName:
        typeof test === "object" && test !== null && "name" in test
          ? platformText(test.name)
          : platformText(fieldIn(answer.error, "name")),
      currentVersionId: platformText(fieldIn(answer.error, "currentVersionId")),
    };
  }
  if (response.status === 422) {
    return {
      kind: "turned-away",
      reason: platformRefusalMessage(answer.error, response.status),
    };
  }
  return null;
}

export async function createTest(
  signedIn: SignedIn,
  input: CreateInput,
  fetchImpl?: Fetch,
): Promise<WriteAnswer> {
  const answer = await createTestRequest(
    { suiteId: input.suiteId, ...testWriteBody(input) },
    { client: platformClient(signedIn, fetchImpl) },
  );
  const expected = answerFor(answer, signedIn);
  if (expected !== null) return expected;
  const response = platformResponse(answer, signedIn.url);
  if (!response.ok || answer.data === undefined) {
    throw new PlatformRefusedError(
      response.status,
      platformRefusalMessage(answer.error, response.status),
    );
  }
  const test = platformTestFrom(answer.data);
  if (test === null) {
    throw new PlatformRefusedError(response.status, "Egma wrote a test but did not answer with it.");
  }
  return { kind: "written", test };
}

export type EditExpectations = {
  readonly versionId: string;
  readonly revision: string;
};

export async function editTest(
  signedIn: SignedIn,
  testId: string,
  expectations: EditExpectations,
  input: TestInput,
  fetchImpl?: Fetch,
): Promise<WriteAnswer> {
  const answer = await updateTestRequest(
    {
      testId,
      ...testWriteBody(input),
      expectedVersionId: expectations.versionId,
      ...(expectations.revision === ""
        ? {}
        : { expectedRevision: expectations.revision }),
    },
    { client: platformClient(signedIn, fetchImpl) },
  );
  const expected = answerFor(answer, signedIn);
  if (expected !== null) return expected;
  const response = platformResponse(answer, signedIn.url);
  if (!response.ok || answer.data === undefined) {
    throw new PlatformRefusedError(
      response.status,
      platformRefusalMessage(answer.error, response.status),
    );
  }
  const test = platformTestFrom(answer.data);
  if (test === null) {
    throw new PlatformRefusedError(response.status, "Egma wrote a test but did not answer with it.");
  }
  return { kind: "written", test };
}
