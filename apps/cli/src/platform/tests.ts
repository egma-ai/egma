/**
 * Tests stored on the selected Egma platform.
 *
 * The generated client owns the HTTP contract. This module keeps repository
 * sync behavior: versions are pinned, identity and content conflicts stay
 * separate, and the committed file shape is translated at one boundary.
 */

import {
  createTest as createTestRequest,
  getTest as getTestRequest,
  getTestVersion as getTestVersionRequest,
  listTests as listTestsRequest,
  updateTest as updateTestRequest,
  type CreateTestData,
  type GetTestResponse,
  type GetTestVersionResponse,
} from "@egma/platform-api/client";

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
  readonly requiredCapabilities: readonly string[];
  readonly mockTools: readonly MockToolEntry[];
};

export type PlatformTest = PlatformContent & {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly versionId: string;
  readonly version: number;
  readonly revision: string;
  readonly agentIds: readonly string[];
};

export type PlatformTestVersion = PlatformContent & {
  readonly id: string;
  readonly testId: string;
  readonly testName: string;
  readonly version: number;
  readonly current: boolean;
};

export type WriteAnswer =
  | { readonly kind: "written"; readonly test: PlatformTest }
  | {
      readonly kind: "moved";
      readonly testName: string;
      readonly currentVersionId: string;
    }
  | { readonly kind: "identity-moved"; readonly reason: string }
  | { readonly kind: "not-applicable"; readonly reason: string }
  | { readonly kind: "turned-away"; readonly reason: string };

type TestBody = GetTestResponse;

function contentFrom(body: {
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  readonly personas: readonly { readonly id: string; readonly name: string }[];
  readonly requiredCapabilities: readonly string[];
  readonly mockTools: readonly {
    readonly tool: string;
    readonly answer?: unknown;
    readonly error?: unknown;
    readonly delayMs: number;
  }[];
}): PlatformContent {
  return {
    scenario: platformText(body.scenario),
    expectedBehaviors: body.expectedBehaviors
      .map(platformText)
      .filter((behavior) => behavior !== ""),
    personas: body.personas
      .map((persona) => ({
        id: platformText(persona.id),
        name: platformText(persona.name),
      }))
      .filter((persona) => persona.id !== "" || persona.name !== ""),
    requiredCapabilities: body.requiredCapabilities
      .map(platformText)
      .filter((capability) => capability !== ""),
    mockTools: body.mockTools.map(overrideFrom),
  };
}

function testFrom(body: TestBody): PlatformTest {
  return {
    ...contentFrom(body),
    id: platformText(body.id),
    name: platformText(body.name),
    description: body.description === null ? "" : platformText(body.description),
    versionId: platformText(body.versionId),
    version: body.version,
    revision: platformText(body.revision),
    agentIds: body.agents
      .map((agent) => platformText(agent.id))
      .filter((id) => id !== ""),
  };
}

export type ListOptions = {
  readonly agentId?: string | null;
  readonly fetchImpl?: Fetch;
};

/** Everything the credential reaches, newest first, following every page. */
export async function listTests(
  signedIn: SignedIn,
  options: ListOptions = {},
): Promise<readonly PlatformTest[]> {
  const { agentId = null, fetchImpl } = options;
  const found: PlatformTest[] = [];
  const client = platformClient(signedIn, fetchImpl);
  let pageToken: string | undefined;

  for (;;) {
    const answer = await listTestsRequest(
      {
        ...(agentId === null || agentId === "" ? {} : { agentId }),
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
    found.push(...(answer.data?.tests ?? []).map(testFrom));

    const next = answer.data?.nextPageToken ?? null;
    if (next === null || next === "") return found;
    pageToken = next;
  }
}

/** One test by its own id, whatever state it is in. */
export async function getTest(
  signedIn: SignedIn,
  testId: string,
  fetchImpl?: Fetch,
): Promise<{ readonly test: PlatformTest; readonly archived: boolean } | null> {
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
  return {
    test: testFrom(answer.data),
    archived: answer.data.archivedAt !== null,
  };
}

/** One frozen test version by its own id. */
export async function getTestVersion(
  signedIn: SignedIn,
  versionId: string,
  fetchImpl?: Fetch,
): Promise<PlatformTestVersion | null> {
  const answer = await getTestVersionRequest(
    { versionId },
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

  const body: GetTestVersionResponse = answer.data;
  return {
    ...contentFrom(body),
    id: platformText(body.id),
    testId: platformText(body.testId),
    testName: platformText(body.testName),
    version: body.version,
    current: body.current,
  };
}

export type TestInput = PlatformContent & {
  readonly name: string;
  readonly description: string;
};

export type CreateInput = TestInput & {
  readonly agentId: string | null;
};

function personaFor(persona: FilePersona): string {
  return persona.id.trim() === "" ? persona.name : persona.id;
}

type TestMockToolInput = NonNullable<CreateTestData["body"]["mockTools"]>[number];

function mockToolForApi(entry: MockToolEntry): TestMockToolInput {
  const { delay_ms: delayMs, error, ...says } = entry.says;
  // A repository file is deliberately read before it is trusted. Keep every
  // value so the platform can return its authoritative refusal for both,
  // neither, or an unknown key; the normal generated-client type stays strict
  // for callers that are not relaying an untrusted file.
  return {
    ...says,
    tool: entry.tool,
    ...(error === undefined ? {} : { error: platformText(error) }),
    ...(typeof delayMs === "number" ? { delayMs } : {}),
  } as unknown as TestMockToolInput;
}

function writeParameters(input: TestInput) {
  return {
    name: input.name,
    description: input.description,
    scenario: input.scenario,
    expectedBehaviors: [...input.expectedBehaviors],
    personas: input.personas.map(personaFor),
    requiredCapabilities: [...input.requiredCapabilities],
    mockTools: input.mockTools.map(mockToolForApi),
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
    const code = platformText(fieldIn(answer.error, "error"));
    if (code === "identity_conflict") {
      return {
        kind: "identity-moved",
        reason: platformRefusalMessage(answer.error, response.status),
      };
    }
    if (code === "repository_agent_not_applicable") {
      return {
        kind: "not-applicable",
        reason: platformRefusalMessage(answer.error, response.status),
      };
    }
    const test = fieldIn(answer.error, "test");
    return {
      kind: "moved",
      testName:
        typeof test === "object" && test !== null && "name" in test
          ? platformText(test.name)
          : platformText(fieldIn(answer.error, "name")),
      currentVersionId: platformText(fieldIn(answer.error, "currentVersionId")),
    };
  }
  return response.status === 422
    ? {
        kind: "turned-away",
        reason: platformRefusalMessage(answer.error, response.status),
      }
    : null;
}

export async function createTest(
  signedIn: SignedIn,
  input: CreateInput,
  fetchImpl?: Fetch,
): Promise<WriteAnswer> {
  const answer = await createTestRequest(
    {
      ...writeParameters(input),
      ...(input.agentId === null ? {} : { agents: [input.agentId] }),
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
  return { kind: "written", test: testFrom(answer.data) };
}

export type EditExpectations = {
  readonly versionId: string;
  readonly revision: string;
  readonly agentId: string | null;
};

/** Edit one test against the content and identity pins in the file. */
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
      ...writeParameters(input),
      expectedVersionId: expectations.versionId,
      ...(expectations.revision === ""
        ? {}
        : { expectedRevision: expectations.revision }),
      ...(expectations.agentId === null || expectations.agentId === ""
        ? {}
        : { repositoryAgentId: expectations.agentId }),
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
  return { kind: "written", test: testFrom(answer.data) };
}
