/**
 * The project's mock tools on the platform.
 *
 * The generated client owns paths, verbs, and wire field names. This module
 * only translates between the platform contract and the committed Markdown
 * format, where `delay_ms` remains file syntax.
 */

import {
  createMockTool as createMockToolRequest,
  listMockTools as listMockToolsRequest,
  updateMockTool as updateMockToolRequest,
  type CreateMockToolData,
  type CreateMockToolResponse,
} from "@egma/platform-api/client";

import type { MockToolEntry } from "../folder/mock-tools.ts";
import {
  platformClient,
  platformRefusalMessage,
  platformResponse,
  platformText,
} from "./client.ts";
import type { Fetch } from "./device-flow.ts";
import { PlatformRefusedError } from "./refused.ts";
import type { SignedIn } from "./signed-in.ts";

type MockToolBody = CreateMockToolResponse;
type MockToolInput = NonNullable<CreateMockToolData["body"]>;

/** A mock tool as the platform currently has it. */
export type PlatformMockTool = {
  readonly id: string;
  /** What a file writes, so a folder and a read are compared as written. */
  readonly entry: MockToolEntry;
};

type MockToolWriteAnswer =
  | { readonly kind: "written"; readonly mockTool: PlatformMockTool }
  | { readonly kind: "turned-away"; readonly reason: string };

function agentNames(agents: readonly { readonly name: string }[]): readonly string[] {
  return agents
    .map((agent) => platformText(agent.name))
    .filter((name) => name !== "");
}

function saysFrom(
  body: {
    readonly answer?: unknown;
    readonly error?: unknown;
    readonly delayMs: number;
    readonly agents?: readonly { readonly name: string }[];
  },
  options: { readonly withAgents: boolean },
): Readonly<Record<string, unknown>> {
  const agents = options.withAgents ? agentNames(body.agents ?? []) : [];
  return {
    ...("error" in body ? { error: body.error } : { answer: body.answer }),
    ...(body.delayMs === 0 ? {} : { delay_ms: body.delayMs }),
    ...(agents.length === 0 ? {} : { agents: [...agents] }),
  };
}

/** One override in the committed file shape. */
export function overrideFrom(body: {
  readonly tool: string;
  readonly answer?: unknown;
  readonly error?: unknown;
  readonly delayMs: number;
}): MockToolEntry {
  return {
    tool: platformText(body.tool),
    says: saysFrom(body, { withAgents: false }),
  };
}

function mockToolFrom(body: MockToolBody): PlatformMockTool {
  return {
    id: platformText(body.id),
    entry: {
      tool: platformText(body.tool),
      says: saysFrom(body, { withAgents: true }),
    },
  };
}

/**
 * Translate the file block to the lowerCamelCase API contract.
 *
 * The platform remains responsible for validating the values.
 */
function writeParameters(entry: MockToolEntry): MockToolInput {
  const { delay_ms: delayMs, ...says } = entry.says;

  return {
    ...says,
    tool: entry.tool,
    ...("delay_ms" in entry.says ? { delayMs } : {}),
  } as MockToolInput;
}

function turnedAway(
  answer: { readonly error?: unknown; readonly response?: Response },
  signedIn: SignedIn,
): MockToolWriteAnswer | null {
  const response = platformResponse(answer, signedIn.url);
  return response.status === 400 ||
    response.status === 404 ||
    response.status === 409 ||
    response.status === 422
    ? {
        kind: "turned-away",
        reason: platformRefusalMessage(answer.error, response.status),
      }
    : null;
}

/** Every mock tool this project answers with, following every page. */
export async function listMockTools(
  signedIn: SignedIn,
  fetchImpl?: Fetch,
): Promise<readonly PlatformMockTool[]> {
  const found: PlatformMockTool[] = [];
  const client = platformClient(signedIn, fetchImpl);
  let pageToken: string | undefined;

  for (;;) {
    const answer = await listMockToolsRequest(
      pageToken === undefined ? undefined : { pageToken },
      { client },
    );
    const response = platformResponse(answer, signedIn.url);
    if (!response.ok) {
      throw new PlatformRefusedError(
        response.status,
        platformRefusalMessage(answer.error, response.status),
      );
    }
    found.push(...(answer.data?.mockTools ?? []).map(mockToolFrom));

    const next = answer.data?.nextPageToken ?? null;
    if (next === null || next === "") return found;
    pageToken = next;
  }
}

export async function createMockTool(
  signedIn: SignedIn,
  entry: MockToolEntry,
  fetchImpl?: Fetch,
): Promise<MockToolWriteAnswer> {
  const answer = await createMockToolRequest({ body: writeParameters(entry) }, {
    client: platformClient(signedIn, fetchImpl),
  });
  const refused = turnedAway(answer, signedIn);
  if (refused !== null) return refused;

  const response = platformResponse(answer, signedIn.url);
  if (!response.ok || answer.data === undefined) {
    throw new PlatformRefusedError(
      response.status,
      platformRefusalMessage(answer.error, response.status),
    );
  }
  return { kind: "written", mockTool: mockToolFrom(answer.data) };
}

/** Edit one mock tool in place. */
export async function editMockTool(
  signedIn: SignedIn,
  mockToolId: string,
  entry: MockToolEntry,
  fetchImpl?: Fetch,
): Promise<MockToolWriteAnswer> {
  const answer = await updateMockToolRequest(
    {
      mockToolId,
      body: {
        delayMs: 0,
        agents: [],
        ...writeParameters(entry),
      },
    },
    { client: platformClient(signedIn, fetchImpl) },
  );
  const refused = turnedAway(answer, signedIn);
  if (refused !== null) return refused;

  const response = platformResponse(answer, signedIn.url);
  if (!response.ok || answer.data === undefined) {
    throw new PlatformRefusedError(
      response.status,
      platformRefusalMessage(answer.error, response.status),
    );
  }
  return { kind: "written", mockTool: mockToolFrom(answer.data) };
}
