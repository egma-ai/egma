import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  projectKeyFor,
  request,
  signUp,
  type Answer,
} from "./support/traces.ts";

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RETELL = {
  agentPlatform: "retell",
  connectionKind: "retell_chat_api",
  accessVariant: "retell_chat_api.api_key",
  modality: "chat",
  config: { retellAgentId: "agent_in_retell_1" },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
} as const;

const TEST_BODY = {
  name: "Reschedules a booking",
  description: "A caller moves a booking.",
  scenario: "Move Thursday's booking to next week.",
  expectedBehaviors: ["confirms the new time before finishing"],
  personas: [],
  mockTools: [],
} as const;

async function customer(label: string, traceStore = false) {
  api = await createApi(label, traceStore ? { traceStore: true } : {});
  const signedUp = await signUp(api.app, `${label}@acme.example`, "Acme");
  return {
    signedUp,
    key: await projectKeyFor(api.app, signedUp),
  };
}

async function createSuite(key: string, name: string): Promise<Answer> {
  return request(api.app, "POST", "/v1/test-suites", key, { name });
}

async function createTest(key: string, suiteId: string, name: string): Promise<Answer> {
  return request(api.app, "POST", "/v1/tests", key, {
    ...TEST_BODY,
    suiteId,
    name,
  });
}

describe("the Test Suites cutover", () => {
  it("owns suite CRUD, immutable test membership, and rejects retired test filters", async () => {
    const { key } = await customer("suite_crud");
    const first = await createSuite(key, "Northside Ford");
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    const suiteId = String(first.body.id);

    const duplicate = await createSuite(key, "Northside Ford");
    expect(duplicate.statusCode, JSON.stringify(duplicate.body)).toBe(201);
    expect(await createSuite(key, "   ")).toMatchObject({ statusCode: 422 });

    const made = await createTest(key, suiteId, "Books an appointment");
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    expect(made.body.suiteId).toBe(suiteId);
    const testId = String(made.body.id);
    const duplicateSuiteId = String(duplicate.body.id);
    const other = await createTest(key, duplicateSuiteId, "Moves an appointment");
    expect(other.statusCode, JSON.stringify(other.body)).toBe(201);

    const missingSuite = await request(api.app, "GET", "/v1/tests?pageSize=1", key);
    expect(missingSuite.statusCode, JSON.stringify(missingSuite.body)).toBe(422);
    const retiredSuiteQuery = await request(
      api.app,
      "GET",
      "/v1/test-suites?agentId=agt_retired",
      key,
    );
    expect(
      retiredSuiteQuery.statusCode,
      JSON.stringify(retiredSuiteQuery.body),
    ).toBe(422);
    for (const path of [
      "/v1/test-suites?pageSize=0",
      "/v1/test-suites?pageToken=not-a-suite",
      `/v1/tests?suiteId=${suiteId}&pageSize=201`,
      `/v1/tests?suiteId=${suiteId}&pageToken=not-a-test`,
    ]) {
      const invalidPage = await request(api.app, "GET", path, key);
      expect(
        invalidPage.statusCode,
        `${path}: ${JSON.stringify(invalidPage.body)}`,
      ).toBe(422);
    }
    for (const wantedSuiteId of [suiteId, duplicateSuiteId]) {
      const page = await request(
        api.app,
        "GET",
        `/v1/tests?suiteId=${wantedSuiteId}&pageSize=1`,
        key,
      );
      expect(page.statusCode, JSON.stringify(page.body)).toBe(200);
      expect(page.body).toHaveProperty("nextPageToken");
      expect(page.body.tests).toHaveLength(1);
      expect((page.body.tests as Array<Record<string, unknown>>)[0]?.suiteId)
        .toBe(wantedSuiteId);
    }

    const globex = await signUp(api.app, "suite-crud@globex.example", "Globex");
    const globexKey = await projectKeyFor(api.app, globex);
    expect(
      (await request(api.app, "GET", `/v1/test-suites/${suiteId}`, globexKey))
        .statusCode,
    ).toBe(404);
    expect(
      (await request(api.app, "GET", `/v1/tests/${testId}`, globexKey))
        .statusCode,
    ).toBe(404);
    const crossTenantCreate = await createTest(
      globexKey,
      suiteId,
      "Cannot cross customers",
    );
    expect(
      crossTenantCreate.statusCode,
      JSON.stringify(crossTenantCreate.body),
    ).toBe(422);

    for (const retiredField of [
      "agents",
      "repository_agent",
      "applicability_revision",
      "requiredCapabilities",
    ]) {
      const refused = await request(api.app, "POST", "/v1/tests", key, {
        ...TEST_BODY,
        suiteId: suiteId,
        name: `Retired ${retiredField}`,
        [retiredField]: [],
      });
      expect(
        refused.statusCode,
        `${retiredField}: ${JSON.stringify(refused.body)}`,
      ).toBe(422);
    }

    const contentWithoutPin = await request(
      api.app,
      "PATCH",
      `/v1/tests/${testId}`,
      key,
      { scenario: "A stale browser edit" },
    );
    expect(contentWithoutPin.statusCode, JSON.stringify(contentWithoutPin.body)).toBe(422);
    const malformedRevision = await request(
      api.app,
      "PATCH",
      `/v1/tests/${testId}`,
      key,
      { name: "Still the same test", expectedRevision: 7 },
    );
    expect(malformedRevision.statusCode, JSON.stringify(malformedRevision.body)).toBe(422);
    const malformedRevisionId = await request(
      api.app,
      "PATCH",
      `/v1/tests/${testId}`,
      key,
      { name: "Still the same test", expectedRevision: "not-a-revision" },
    );
    expect(malformedRevisionId.statusCode, JSON.stringify(malformedRevisionId.body)).toBe(422);
    const staleContent = await request(
      api.app,
      "PATCH",
      `/v1/tests/${testId}`,
      key,
      { scenario: "A stale browser edit", expectedVersionId: newId("tstv") },
    );
    expect(staleContent.statusCode, JSON.stringify(staleContent.body)).toBe(409);

    for (const field of ["suite", "suiteId"] as const) {
      const refused = await request(api.app, "PATCH", `/v1/tests/${testId}`, key, {
        [field]: duplicateSuiteId,
      });
      expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    }
    for (const query of ["agent=agt_dead", "archived=true", "name=Books"]) {
      const refused = await request(
        api.app,
        "GET",
        `/v1/tests?suiteId=${suiteId}&${query}`,
        key,
      );
      expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    }

    const renamed = await request(
      api.app,
      "PATCH",
      `/v1/test-suites/${suiteId}`,
      key,
      { name: "Northside Service" },
    );
    expect(renamed.statusCode, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.name).toBe("Northside Service");
  });

  it("applies suites, tests, and Mock Tools atomically without creating suite identities", async () => {
    const { key } = await customer("repository_change_set");
    const suite = await createSuite(key, "Northside Ford");
    const suiteId = String(suite.body.id);

    const applied = await request(
      api.app,
      "POST",
      "/v1/repository/change-set",
      key,
      {
        suites: [{ id: suiteId, name: "Northside Ford" }],
        tests: [{
          clientRef: "egma/tests/northside/books.md",
          suiteId: suiteId,
          ...TEST_BODY,
        }],
        mockTools: [{ tool: "check_availability", answer: { slots: [] } }],
      },
    );
    expect(applied.statusCode, JSON.stringify(applied.body)).toBe(200);
    const written = (applied.body.tests as Array<Record<string, unknown>>)[0];
    expect(written?.clientRef).toBe("egma/tests/northside/books.md");
    const test = written?.test as Record<string, unknown>;
    expect(test.suiteId).toBe(suiteId);

    const unknownSuiteId = newId("ste");
    const refused = await request(
      api.app,
      "POST",
      "/v1/repository/change-set",
      key,
      {
        suites: [
          { id: suiteId, name: "A rename that must roll back" },
          { id: unknownSuiteId, name: "Hand authored" },
        ],
        tests: [{
          clientRef: "egma/tests/northside/books.md",
          suiteId: suiteId,
          ...TEST_BODY,
          expectedVersionId: test.versionId,
          expectedRevision: test.revision,
        }],
        mockTools: [{ tool: "check_availability", answer: { slots: ["noon"] } }],
      },
    );
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    expect(String(refused.body.message)).toContain("create the suite first");

    const suites = await request(api.app, "GET", "/v1/test-suites", key);
    expect(suites.statusCode).toBe(200);
    const byId = (suites.body.testSuites as Array<Record<string, unknown>>)
      .find((entry) => entry.id === suiteId);
    expect(byId?.name).toBe("Northside Ford");
    expect((suites.body.testSuites as Array<Record<string, unknown>>)
      .some((entry) => entry.id === unknownSuiteId)).toBe(false);

    const mockTools = await request(api.app, "GET", "/v1/mock-tools", key);
    expect((mockTools.body.mockTools as Array<Record<string, unknown>>)[0]?.answer)
      .toEqual({ slots: [] });

    const missingRevision = await request(
      api.app,
      "POST",
      "/v1/repository/change-set",
      key,
      {
        suites: [{ id: suiteId, name: "A rename that must not land" }],
        tests: [{
          clientRef: "egma/tests/northside/books.md",
          suiteId: suiteId,
          ...TEST_BODY,
          expectedVersionId: test.versionId,
        }],
        mockTools: [{ tool: "check_availability", answer: { slots: ["late"] } }],
      },
    );
    expect(missingRevision.statusCode, JSON.stringify(missingRevision.body)).toBe(422);
    const afterMissingPin = await request(api.app, "GET", "/v1/test-suites", key);
    expect((afterMissingPin.body.testSuites as Array<Record<string, unknown>>)
      .find((entry) => entry.id === suiteId)?.name).toBe("Northside Ford");
    const toolsAfterMissingPin = await request(api.app, "GET", "/v1/mock-tools", key);
    expect((toolsAfterMissingPin.body.mockTools as Array<Record<string, unknown>>)[0]?.answer)
      .toEqual({ slots: [] });

    const retiredRepositoryAgent = await request(
      api.app,
      "POST",
      "/v1/repository/change-set",
      key,
      {
        suites: [{ id: suiteId, name: "Northside Ford" }],
        tests: [{
          clientRef: "egma/tests/northside/books.md",
          suiteId: suiteId,
          ...TEST_BODY,
          expectedVersionId: test.versionId,
          expectedRevision: test.revision,
          repository_agent: "Front desk",
        }],
        mockTools: [{ tool: "check_availability", answer: { slots: [] } }],
      },
    );
    expect(
      retiredRepositoryAgent.statusCode,
      JSON.stringify(retiredRepositoryAgent.body),
    ).toBe(422);

    const omitted = await request(
      api.app,
      "POST",
      "/v1/repository/change-set",
      key,
      { suites: [], tests: [], mockTools: [] },
    );
    expect(omitted.statusCode, JSON.stringify(omitted.body)).toBe(422);

    const unknownQuery = await request(
      api.app,
      "POST",
      "/v1/repository/change-set?agentId=agt_retired",
      key,
      { suites: [], tests: [], mockTools: [] },
    );
    expect(unknownQuery.statusCode, JSON.stringify(unknownQuery.body)).toBe(422);
  });

  it("runs one complete suite through bounded headers and paged exact evidence", async () => {
    const { key } = await customer("suite_run", true);
    const suite = await createSuite(key, "Northside Ford");
    const suiteId = String(suite.body.id);
    const first = await createTest(key, suiteId, "Books an appointment");
    const second = await createTest(key, suiteId, "Moves an appointment");
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    expect(second.statusCode, JSON.stringify(second.body)).toBe(201);

    const registered = await request(api.app, "POST", "/v1/agents", key, {
      name: "Front desk",
      connection: RETELL,
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const agent = registered.body.agent as { id: string };
    const connection = registered.body.connection as { id: string };

    const started = await request(api.app, "POST", "/v1/runs", key, {
      suiteId: suiteId,
      agentId: agent.id,
      connectionId: connection.id,
      idempotencyKey: "suite-run-once",
      name: "Friday regression",
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({
      suiteId: suiteId,
      suiteName: "Northside Ford",
      suiteDeleted: false,
      name: "Friday regression",
      expectedSimulationCount: 2,
    });
    expect(started.body.simulations).toBeUndefined();
    expect(started.body.gradingPlan).toBeUndefined();
    const runId = String(started.body.id);

    const replayed = await request(api.app, "POST", "/v1/runs", key, {
      suiteId: suiteId,
      agentId: agent.id,
      connectionId: connection.id,
      idempotencyKey: "suite-run-once",
      name: "Friday regression",
    });
    expect(replayed.statusCode, JSON.stringify(replayed.body)).toBe(201);
    expect(replayed.body.id).toBe(runId);
    const conflictingReplay = await request(api.app, "POST", "/v1/runs", key, {
      suiteId: suiteId,
      agentId: agent.id,
      connectionId: connection.id,
      idempotencyKey: "suite-run-once",
      name: "A different request",
    });
    expect(
      conflictingReplay.statusCode,
      JSON.stringify(conflictingReplay.body),
    ).toBe(409);

    const listed = await request(api.app, "GET", "/v1/runs?pageSize=1", key);
    expect(listed.statusCode, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.runs).toHaveLength(1);
    expect(listed.body).toHaveProperty("nextPageToken");

    const detail = await request(api.app, "GET", `/v1/runs/${runId}`, key);
    expect(detail.statusCode, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.simulations).toBeUndefined();
    expect(detail.body.gradingPlan).toBeUndefined();
    expect(detail.body.mockTools).toBeUndefined();

    const pageOne = await request(
      api.app,
      "GET",
      `/v1/runs/${runId}/simulations?pageSize=1`,
      key,
    );
    expect(pageOne.statusCode, JSON.stringify(pageOne.body)).toBe(200);
    expect(pageOne.body.simulations).toHaveLength(1);
    expect(pageOne.body.nextPageToken).toBeTypeOf("string");
    const pageTwo = await request(
      api.app,
      "GET",
      `/v1/runs/${runId}/simulations?pageSize=1&pageToken=${String(pageOne.body.nextPageToken)}`,
      key,
    );
    expect(pageTwo.statusCode, JSON.stringify(pageTwo.body)).toBe(200);
    expect(pageTwo.body.simulations).toHaveLength(1);
    expect(pageTwo.body.nextPageToken).toBeNull();
    const simulations = [
      ...(pageOne.body.simulations as Array<Record<string, unknown>>),
      ...(pageTwo.body.simulations as Array<Record<string, unknown>>),
    ];
    expect(new Set(simulations.map((entry) => entry.testVersionId))).toEqual(
      new Set([first.body.versionId, second.body.versionId]),
    );

    const simulation = await request(
      api.app,
      "GET",
      `/v1/simulations/${String(simulations[0]?.id)}`,
      key,
    );
    expect(simulation.statusCode, JSON.stringify(simulation.body)).toBe(200);
    expect(simulation.body.runName).toBe("Friday regression");
    expect(simulation.body.runLabel).toBeUndefined();

    for (const [method, path] of [
      ["POST", `/v1/tests/${String(first.body.id)}/clone`],
      ["POST", `/v1/tests/${String(first.body.id)}/archive`],
      ["POST", `/v1/tests/${String(first.body.id)}/restore`],
      ["POST", `/v1/tests/${String(first.body.id)}/agents`],
      ["GET", "/v1/capabilities"],
      ["POST", `/v1/agents/${agent.id}/connections/${connection.id}/capabilities/refresh`],
      ["GET", `/v1/run-plan?suiteId=${suiteId}&agentId=${agent.id}&connectionId=${connection.id}`],
      ["POST", `/v1/runs/${runId}/retry`],
      ["POST", `/v1/simulations/${String(simulations[0]?.id)}/rerun`],
    ] as const) {
      const retired = await request(api.app, method, path, key, {});
      expect(retired.statusCode, `${method} ${path}: ${JSON.stringify(retired.body)}`).toBe(404);
    }
    for (const retired of [
      { test_versions: [first.body.versionId] },
      { label: "old name" },
      { test: first.body.id },
      { tests: [first.body.id] },
      { suites: [suiteId] },
      { suiteId: [suiteId, suiteId] },
      { retry_of_run_id: runId },
    ]) {
      const answer = await request(api.app, "POST", "/v1/runs", key, {
        suiteId: suiteId,
        agentId: agent.id,
        connectionId: connection.id,
        idempotencyKey: `retired-${Object.keys(retired)[0]}`,
        ...retired,
      });
      expect(answer.statusCode, JSON.stringify(answer.body)).toBe(422);
    }
    const retiredRunQuery = await request(
      api.app,
      "POST",
      `/v1/runs?testId=${String(first.body.id)}`,
      key,
      {
        suiteId: suiteId,
        agentId: agent.id,
        connectionId: connection.id,
        idempotencyKey: "retired-direct-test-query",
      },
    );
    expect(retiredRunQuery.statusCode, JSON.stringify(retiredRunQuery.body)).toBe(422);

    const renamed = await request(
      api.app,
      "PATCH",
      `/v1/test-suites/${suiteId}`,
      key,
      { name: "Northside Service" },
    );
    expect(renamed.statusCode).toBe(200);
    expect((await request(api.app, "GET", `/v1/runs/${runId}`, key)).body)
      .toMatchObject({ suiteName: "Northside Service", suiteDeleted: false });

    const removed = await api.app.inject({
      method: "DELETE",
      url: `/v1/test-suites/${suiteId}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await request(api.app, "GET", `/v1/runs/${runId}`, key)).body)
      .toMatchObject({ suiteName: "Northside Service", suiteDeleted: true });
    const replayAfterDelete = await request(api.app, "POST", "/v1/runs", key, {
      suiteId: suiteId,
      agentId: agent.id,
      connectionId: connection.id,
      idempotencyKey: "suite-run-once",
      name: "Friday regression",
    });
    expect(replayAfterDelete.statusCode, JSON.stringify(replayAfterDelete.body)).toBe(201);
    expect(replayAfterDelete.body).toMatchObject({
      id: runId,
      suiteName: "Northside Service",
      suiteDeleted: true,
    });
  });
});
