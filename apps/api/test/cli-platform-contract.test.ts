import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { Fetch } from "../../cli/src/platform/device-flow.ts";
import {
  applyRepositoryChangeSet,
} from "../../cli/src/platform/repository.ts";
import {
  listRunSimulations,
  startRun,
} from "../../cli/src/platform/runs.ts";
import type { SignedIn } from "../../cli/src/platform/signed-in.ts";
import { createTestSuite } from "../../cli/src/platform/test-suites.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  mintKey,
  request,
  signUp,
} from "./support/traces.ts";

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

type WireCall = {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
};

/** The CLI's real fetch seam, answered by the real API in this process. */
function fetchThrough(app: FastifyInstance, calls: WireCall[]): Fetch {
  return async (input, init) => {
    const address = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const body = init?.body === undefined
      ? undefined
      : JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({
      method: init?.method ?? "GET",
      path: `${address.pathname}${address.search}`,
      body,
    });

    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const answered = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE",
      url: `${address.pathname}${address.search}`,
      headers,
      ...(init?.body === undefined ? {} : { payload: String(init.body) }),
    });
    return new Response(answered.body, {
      status: answered.statusCode,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("the CLI and API suite contract", () => {
  it("creates a suite, pushes one atomic repository change, and starts that suite", async () => {
    api = await createApi("cli_api_suite_contract");
    const customer = await signUp(
      api.app,
      "cli-contract@acme.example",
      "Acme",
    );
    const key = await mintKey(
      api.app,
      customer.cookie,
      "the CLI contract",
      customer.projectId,
    );
    const signedIn: SignedIn = { url: "http://egma.test", key };
    const calls: WireCall[] = [];
    const fetchImpl = fetchThrough(api.app, calls);

    const suite = await createTestSuite(
      signedIn,
      { projectId: customer.projectId, name: "Release" },
      fetchImpl,
    );
    expect(suite).toMatchObject({
      projectId: customer.projectId,
      name: "Release",
    });
    expect(suite.id).toMatch(/^ste_/u);

    const applied = await applyRepositoryChangeSet(
      signedIn,
      {
        projectId: customer.projectId,
        suites: [{ id: suite.id, name: suite.name }],
        tests: [{
          clientRef: "egma/tests/release/books-a-visit.md",
          suiteId: suite.id,
          input: {
            name: "Books a visit",
            description: "The ordinary booking path.",
            scenario: "The caller asks for Tuesday.",
            expectedBehaviors: ["The agent books Tuesday."],
            // The CLI names its callers by name and the platform resolves
            // them, which is the path a real repository file takes. A test
            // names at least one persona from birth, so a push that named
            // none is refused rather than given the project's default.
            // A repository file that has only ever carried names carries an
            // empty id, and the CLI sends the name for the platform to
            // resolve. A test names at least one persona from birth, so a push
            // naming none is refused rather than given the project's default.
            personas: [{ id: "", name: "Everyday caller" }],
            mockTools: [],
          },
          expectedVersionId: null,
          expectedRevision: null,
        }],
        mockTools: [{
          tool: "calendar",
          says: { answer: { open: true } },
        }],
      },
      fetchImpl,
    );
    expect(applied.tests).toHaveLength(1);
    const pushed = applied.tests[0]?.test;
    if (pushed === undefined) throw new Error("the atomic push returned no test");
    expect(pushed).toMatchObject({
      suiteId: suite.id,
      name: "Books a visit",
      version: 1,
    });

    const registered = await request(api.app, "POST", "/v1/agents", key, {
      agentPlatform: "retell",
      name: "Front desk",
      connection: {
        agentPlatform: "retell",
        connectionType: "retell_chat_api",
        accessVariant: "retell_chat_api.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_cli_contract" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const agentId = (registered.body.agent as { id: string }).id;
    const connectionId = (registered.body.connection as { id: string }).id;

    const started = await startRun(
      signedIn,
      {
        suiteId: suite.id,
        agentId,
        connectionId,
        expectedTestVersions: [{
          testId: pushed.id,
          versionId: pushed.versionId,
        }],
        name: "CLI release run",
        idempotencyKey: "cli-api-suite-run",
      },
      fetchImpl,
    );
    expect(started.kind).toBe("started");
    if (started.kind !== "started") throw new Error(started.reason);
    expect(started.run).toMatchObject({
      agentId,
      connectionId,
      expectedSimulationCount: 1,
      simulations: [],
    });

    const simulations = await listRunSimulations(
      signedIn,
      started.run.id,
      fetchImpl,
    );
    expect(simulations).toEqual([
      expect.objectContaining({
        testVersionId: pushed.versionId,
        testName: "Books a visit",
        status: "queued",
      }),
    ]);

    const detail = await request(
      api.app,
      "GET",
      `/v1/runs/${started.run.id}`,
      key,
    );
    expect(detail.body).toMatchObject({
      suiteId: suite.id,
      suiteName: "Release",
      suiteDeleted: false,
      name: "CLI release run",
    });

    const writes = calls.filter((call) => call.method === "POST");
    expect(writes.map((call) => call.path)).toEqual([
      `/v1/test-suites?projectId=${customer.projectId}`,
      `/v1/repository/change-set?projectId=${customer.projectId}`,
      "/v1/runs",
    ]);
    expect(writes[0]?.body).toEqual({
      name: "Release",
    });
    expect(writes[1]?.body).toMatchObject({
      suites: [{ id: suite.id, name: "Release" }],
      tests: [{
        clientRef: "egma/tests/release/books-a-visit.md",
        suiteId: suite.id,
      }],
      mockTools: [{ tool: "calendar", answer: { open: true } }],
    });
    expect(writes[2]?.body).toMatchObject({
      suiteId: suite.id,
      agentId: agentId,
      connectionId: connectionId,
      expectedTestVersions: [{
        testId: pushed.id,
        versionId: pushed.versionId,
      }],
      name: "CLI release run",
      idempotencyKey: "cli-api-suite-run",
    });
  });
});
