import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  projectKeyFor,
  request,
  signUp,
  type Answer,
} from "./support/traces.ts";

/**
 * The world one test carries, over the door a customer integrates against.
 *
 * A test used to borrow its mocked world from the project and its variables
 * from nowhere at all. It carries both itself now: `mockTools` says what the
 * agent's tools answer during this scenario, and `env` says what the platform
 * is told before the conversation starts. Both are versioned content, so a
 * change to either mints a new test version exactly as an edited expected
 * behavior does — which is what lets an old result still say what world it was
 * conducted in.
 *
 * Everything here goes over HTTP for the reason the rest of this suite does:
 * the contract is what a customer meets, and a test that called the access
 * layer directly would prove the storage and none of the door.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const ENV = {
  retell_dynamic_variables: { caller_name: "Margaret" },
  job_dispatch_metadata: { tenant: "acme" },
} as const;

const TEST_BODY = {
  name: "Reschedules a booking",
  description: "A caller moves a booking.",
  scenario: "Move Thursday's booking to next week.",
  expectedBehaviors: ["confirms the new time before finishing"],
  personas: ["Everyday caller"],
} as const;

async function customer(label: string) {
  api = await createApi(label);
  const signedUp = await signUp(api.app, `${label}@acme.example`, "Acme");
  return { key: await projectKeyFor(api.app, signedUp) };
}

async function suiteFor(key: string): Promise<string> {
  const made = await request(api.app, "POST", "/v1/test-suites", key, {
    name: "Northside Ford",
  });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  return String(made.body.id);
}

async function createTest(
  key: string,
  suiteId: string,
  content: Record<string, unknown>,
): Promise<Answer> {
  return request(api.app, "POST", "/v1/tests", key, {
    ...TEST_BODY,
    suiteId,
    ...content,
  });
}

describe("the world a test carries", () => {
  it("returns its mock tools and its env on create, on read, and on the version", async () => {
    const { key } = await customer("test_world_read");
    const suiteId = await suiteFor(key);

    const created = await createTest(key, suiteId, {
      mockTools: [
        { tool: "get_availability", answer: { slots: [] } },
        { tool: "book", error: "calendar down" },
      ],
      env: ENV,
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body.mockTools).toEqual([
      { tool: "get_availability", answer: { slots: [] } },
      { tool: "book", error: "calendar down" },
    ]);
    expect(created.body.env).toEqual(ENV);
    // The count that used to ride beside the list is gone: a reader who has
    // the list can count it, and a second copy of one fact is a second copy
    // free to disagree.
    expect(created.body.overrideCount).toBeUndefined();

    const testId = String(created.body.id);
    const read = await request(api.app, "GET", `/v1/tests/${testId}`, key);
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
    expect(read.body.mockTools).toEqual(created.body.mockTools);
    expect(read.body.env).toEqual(ENV);

    const version = await request(
      api.app,
      "GET",
      `/v1/test-versions/${String(created.body.versionId)}`,
      key,
    );
    expect(version.statusCode, JSON.stringify(version.body)).toBe(200);
    expect(version.body.mockTools).toEqual(created.body.mockTools);
    expect(version.body.env).toEqual(ENV);
    expect(version.body.overrideCount).toBeUndefined();
  });

  it("carries neither when neither was authored", async () => {
    const { key } = await customer("test_world_absent");
    const suiteId = await suiteFor(key);

    const created = await createTest(key, suiteId, {});
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    // Always present on a read, and empty rather than missing: a client that
    // has to branch on absence would carry a second shape for "no world".
    expect(created.body.mockTools).toEqual([]);
    expect(created.body.env).toBeNull();
  });

  it("mints a new version when either field changes, and leaves the other alone", async () => {
    const { key } = await customer("test_world_versions");
    const suiteId = await suiteFor(key);

    const created = await createTest(key, suiteId, {
      mockTools: [{ tool: "get_availability", answer: { slots: [] } }],
      env: ENV,
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    const testId = String(created.body.id);
    const firstVersionId = String(created.body.versionId);
    expect(created.body.version).toBe(1);

    // A content edit names the version it was written against. Env is content
    // now, so an env-only edit has to name one — and mints the next version.
    const withoutPin = await request(
      api.app,
      "PATCH",
      `/v1/tests/${testId}`,
      key,
      { env: { retell_dynamic_variables: { caller_name: "Rosa" } } },
    );
    expect(withoutPin.statusCode, JSON.stringify(withoutPin.body)).toBe(422);
    expect(String(withoutPin.body.message)).toContain("expectedVersionId");

    const envEdited = await request(
      api.app,
      "PATCH",
      `/v1/tests/${testId}`,
      key,
      {
        env: { retell_dynamic_variables: { caller_name: "Rosa" } },
        expectedVersionId: firstVersionId,
      },
    );
    expect(envEdited.statusCode, JSON.stringify(envEdited.body)).toBe(200);
    expect(envEdited.body.version).toBe(2);
    expect(envEdited.body.versionId).not.toBe(firstVersionId);
    expect(envEdited.body.env).toEqual({
      retell_dynamic_variables: { caller_name: "Rosa" },
    });
    // Untouched, and carried into the new version rather than dropped.
    expect(envEdited.body.mockTools).toEqual([
      { tool: "get_availability", answer: { slots: [] } },
    ]);

    const secondVersionId = String(envEdited.body.versionId);
    const toolsEdited = await request(
      api.app,
      "PATCH",
      `/v1/tests/${testId}`,
      key,
      {
        mockTools: [{ tool: "get_availability", error: "calendar down" }],
        expectedVersionId: secondVersionId,
      },
    );
    expect(toolsEdited.statusCode, JSON.stringify(toolsEdited.body)).toBe(200);
    expect(toolsEdited.body.version).toBe(3);
    expect(toolsEdited.body.mockTools).toEqual([
      { tool: "get_availability", error: "calendar down" },
    ]);
    expect(toolsEdited.body.env).toEqual({
      retell_dynamic_variables: { caller_name: "Rosa" },
    });

    // An edit that clears the env is a content edit like any other.
    const cleared = await request(api.app, "PATCH", `/v1/tests/${testId}`, key, {
      env: null,
      expectedVersionId: String(toolsEdited.body.versionId),
    });
    expect(cleared.statusCode, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.version).toBe(4);
    expect(cleared.body.env).toBeNull();

    // The first version still says exactly what it always said.
    const frozen = await request(
      api.app,
      "GET",
      `/v1/test-versions/${firstVersionId}`,
      key,
    );
    expect(frozen.statusCode, JSON.stringify(frozen.body)).toBe(200);
    expect(frozen.body.env).toEqual(ENV);
    expect(frozen.body.mockTools).toEqual([
      { tool: "get_availability", answer: { slots: [] } },
    ]);
    expect(frozen.body.current).toBe(false);

    const versions = await request(
      api.app,
      "GET",
      `/v1/tests/${testId}/versions`,
      key,
    );
    expect(versions.statusCode, JSON.stringify(versions.body)).toBe(200);
    expect(versions.body.versions).toHaveLength(4);
  });

  it("deletes only while the Test content and identity still match the caller's read", async () => {
    const { key } = await customer("test_delete_version_guard");
    const suiteId = await suiteFor(key);
    const created = await createTest(key, suiteId, {});
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    const testId = String(created.body.id);
    const firstVersionId = String(created.body.versionId);
    const firstRevision = String(created.body.revision);

    const missing = await request(api.app, "DELETE", `/v1/tests/${testId}`, key);
    expect(missing.statusCode, JSON.stringify(missing.body)).toBe(422);
    expect(String(missing.body.message)).toContain("expectedVersionId");

    const missingRevision = await request(
      api.app,
      "DELETE",
      `/v1/tests/${testId}?expectedVersionId=${firstVersionId}`,
      key,
    );
    expect(missingRevision.statusCode, JSON.stringify(missingRevision.body)).toBe(422);
    expect(String(missingRevision.body.message)).toContain("expectedRevision");

    const missingVersion = await request(
      api.app,
      "DELETE",
      `/v1/tests/${testId}?expectedRevision=${firstRevision}`,
      key,
    );
    expect(missingVersion.statusCode, JSON.stringify(missingVersion.body)).toBe(422);
    expect(String(missingVersion.body.message)).toContain("expectedVersionId");

    const malformedVersion = await request(
      api.app,
      "DELETE",
      `/v1/tests/${testId}?expectedVersionId=not-a-version&expectedRevision=${firstRevision}`,
      key,
    );
    expect(malformedVersion.statusCode, JSON.stringify(malformedVersion.body)).toBe(422);

    const malformedRevision = await request(
      api.app,
      "DELETE",
      `/v1/tests/${testId}?expectedVersionId=${firstVersionId}&expectedRevision=not-a-revision`,
      key,
    );
    expect(malformedRevision.statusCode, JSON.stringify(malformedRevision.body)).toBe(422);

    const renamed = await request(api.app, "PATCH", `/v1/tests/${testId}`, key, {
      name: "Reschedules a renamed booking",
      expectedRevision: firstRevision,
    });
    expect(renamed.statusCode, JSON.stringify(renamed.body)).toBe(200);
    const renamedRevision = String(renamed.body.revision);
    expect(renamed.body.versionId).toBe(firstVersionId);

    const staleIdentity = await request(
      api.app,
      "DELETE",
      `/v1/tests/${testId}?expectedVersionId=${firstVersionId}&expectedRevision=${firstRevision}`,
      key,
    );
    expect(staleIdentity.statusCode, JSON.stringify(staleIdentity.body)).toBe(409);
    expect(staleIdentity.body).toEqual({
      error: "identity_conflict",
      message:
        `Test ${testId} changed after you opened it. Read it again before ` +
        "deciding whether to delete it.",
    });
    expect(
      await request(api.app, "GET", `/v1/tests/${testId}`, key),
    ).toMatchObject({
      statusCode: 200,
      body: {
        name: "Reschedules a renamed booking",
        revision: renamedRevision,
        versionId: firstVersionId,
      },
    });

    const edited = await request(api.app, "PATCH", `/v1/tests/${testId}`, key, {
      scenario: "Move Friday's booking to next week.",
      expectedVersionId: firstVersionId,
      expectedRevision: renamedRevision,
    });
    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
    const currentVersionId = String(edited.body.versionId);
    const currentRevision = String(edited.body.revision);

    const stale = await request(
      api.app,
      "DELETE",
      `/v1/tests/${testId}?expectedVersionId=${firstVersionId}&expectedRevision=${currentRevision}`,
      key,
    );
    expect(stale.statusCode, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body).toMatchObject({
      error: "version_conflict",
      test: { id: testId, name: "Reschedules a renamed booking" },
      expectedVersionId: firstVersionId,
      currentVersionId,
    });
    expect(
      await request(api.app, "GET", `/v1/tests/${testId}`, key),
    ).toMatchObject({ statusCode: 200, body: { versionId: currentVersionId } });

    const deleted = await api.app.inject({
      method: "DELETE",
      url:
        `/v1/tests/${testId}?expectedVersionId=${currentVersionId}` +
        `&expectedRevision=${currentRevision}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(deleted.body).toBe("");
    expect(
      await request(api.app, "GET", `/v1/tests/${testId}`, key),
    ).toMatchObject({ statusCode: 404 });
  });

  it("refuses every world a test cannot have, and says which one and why", async () => {
    const { key } = await customer("test_world_refusals");
    const suiteId = await suiteFor(key);

    // Egma's own words to the simulator. A test that could overwrite one could
    // lie to the simulator about which conversation it is in.
    const reserved = await createTest(key, suiteId, {
      env: { retell_dynamic_variables: { egma_simulation_id: "sim_1" } },
    });
    expect(reserved.statusCode, JSON.stringify(reserved.body)).toBe(422);
    expect(String(reserved.body.message)).toContain("egma_");

    const unknownEnvKey = await createTest(key, suiteId, {
      env: { shipping_address: { line1: "1 High Street" } },
    });
    expect(unknownEnvKey.statusCode, JSON.stringify(unknownEnvKey.body)).toBe(422);
    expect(String(unknownEnvKey.body.message)).toMatch(
      /shipping_address|env/,
    );

    const dispatchNotAnObject = await createTest(key, suiteId, {
      env: { job_dispatch_metadata: ["acme"] },
    });
    expect(
      dispatchNotAnObject.statusCode,
      JSON.stringify(dispatchNotAnObject.body),
    ).toBe(422);
    expect(String(dispatchNotAnObject.body.message)).toContain(
      "job_dispatch_metadata",
    );

    const variableNotText = await createTest(key, suiteId, {
      env: { retell_dynamic_variables: { caller_name: 7 } },
    });
    expect(
      variableNotText.statusCode,
      JSON.stringify(variableNotText.body),
    ).toBe(422);
    expect(String(variableNotText.body.message)).toMatch(
      /caller_name|retell_dynamic_variables/,
    );

    // Matching is by name alone, so two entries for one tool would be two
    // answers with no rule to choose between them.
    const twice = await createTest(key, suiteId, {
      mockTools: [
        { tool: "get_availability", answer: { slots: [] } },
        { tool: "get_availability", answer: { slots: ["noon"] } },
      ],
    });
    expect(twice.statusCode, JSON.stringify(twice.body)).toBe(422);
    expect(String(twice.body.message)).toMatch(/get_availability|twice|once/);

    const bothBranches = await createTest(key, suiteId, {
      mockTools: [
        { tool: "get_availability", answer: { slots: [] }, error: "calendar down" },
      ],
    });
    expect(bothBranches.statusCode, JSON.stringify(bothBranches.body)).toBe(422);
    expect(String(bothBranches.body.message)).toContain("answer");
    expect(String(bothBranches.body.message)).toContain("error");

    const neitherBranch = await createTest(key, suiteId, {
      mockTools: [{ tool: "get_availability" }],
    });
    expect(neitherBranch.statusCode, JSON.stringify(neitherBranch.body)).toBe(422);

    // Past the 15 KiB the exchange carries.
    const tooLarge = await createTest(key, suiteId, {
      mockTools: [
        { tool: "get_availability", answer: { note: "x".repeat(16 * 1024) } },
      ],
    });
    expect(tooLarge.statusCode, JSON.stringify(tooLarge.body)).toBe(422);
    expect(String(tooLarge.body.message)).toContain("answer");

    // The delay went with the project's mock tools: a made-up wait told nobody
    // anything true about the agent.
    const withDelay = await createTest(key, suiteId, {
      mockTools: [
        { tool: "get_availability", answer: { slots: [] }, delayMs: 200 },
      ],
    });
    expect(withDelay.statusCode, JSON.stringify(withDelay.body)).toBe(422);
    expect(String(withDelay.body.message)).toContain("delayMs");

    // Nothing was written by any of them.
    const listed = await request(
      api.app,
      "GET",
      `/v1/tests?suiteId=${suiteId}`,
      key,
    );
    expect(listed.statusCode, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.tests).toEqual([]);
  });

  it("no longer answers the project mock tool routes or the discovery route", async () => {
    const { key } = await customer("test_world_removed_routes");
    const mockToolId = "mtl_00000000000000000000000000";

    const gone: readonly Answer[] = [
      await request(api.app, "GET", "/v1/mock-tools", key),
      await request(api.app, "POST", "/v1/mock-tools", key, {
        tool: "get_availability",
        answer: { slots: [] },
      }),
      await request(api.app, "PATCH", `/v1/mock-tools/${mockToolId}`, key, {
        answer: { slots: [] },
      }),
      await request(api.app, "DELETE", `/v1/mock-tools/${mockToolId}`, key),
      await request(
        api.app,
        "POST",
        `/v1/agents/${newId("agt")}/mock-tools:discover`,
        key,
        { seed: false },
      ),
    ];
    for (const answer of gone) {
      expect(answer.statusCode, JSON.stringify(answer.body)).toBe(404);
    }
  });
});
