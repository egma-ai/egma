import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendSpans,
  claimGradingJobs,
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  finishGradingJob,
  readTraceGrades,
  readTraceGrading,
  reconcileGraderCatalog,
  requestGrading,
  type AuthContext,
  type NewSpan,
} from "@egma/db";

import {
  createMigratedDatabase,
  openSingleConnection,
  TEST_ENCRYPTION_KEY,
  type MigratedDatabase,
} from "../../../packages/db/test/support/database.ts";
import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "../../../packages/db/test/support/clickhouse.ts";
import { seedOrganization, seedUser } from "../../../packages/db/test/support/tenancy.ts";
import { gradeClaim } from "../src/grade.ts";

let database: MigratedDatabase;
let store: MigratedTraceStore;

const organizationId = newId("org");
const projectId = newId("prj");
const userId = newId("usr");
const definitionId = newId("grl");
const projectGraderId = newId("grd");
const traceId = "5555555555555555555555555555eeee";
const startedAt = new Date("2026-08-21T10:00:00.000Z");

const auth: AuthContext = {
  organizationId,
  projectId,
  userId,
  role: "member",
  via: "session",
};

function span(): NewSpan {
  return {
    traceId,
    spanId: "1111111111111111",
    parentSpanId: "",
    source: "production",
    emitter: "agent",
    environment: "production",
    startedAtMicroseconds: BigInt(startedAt.getTime()) * 1_000n,
    durationNanoseconds: 1_000_000_000n,
    name: "conversation",
    kind: "conversation",
    status: "ok",
    text: "",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: "call-fixture",
    agentPlatform: "retell",
    platformAgentId: "agent-fixture",
    platformAgentName: "Front desk",
    platformAgentVersion: "",
    connectionType: "phone_number",
    runId: "",
    agentId: "",
    agentVersionId: "",
    testVersionId: "",
    personaVersionId: "",
    payload: "{}",
    endsTrace: true,
  };
}

beforeAll(async () => {
  database = await createMigratedDatabase("grader_runtime_target");
  store = await createMigratedTraceStore("grader_runtime_target");
  connect({
    databaseUrl: database.url,
    encryptionKey: TEST_ENCRYPTION_KEY,
    maxConnections: 4,
  });
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 4 });

  await seedOrganization(database, organizationId, [
    { id: projectId, slug: "default" },
  ]);
  await seedUser(database, userId, "grader-worker@example.com");
  await reconcileGraderCatalog();

  const setup = await openSingleConnection(database.url);
  await setup.sql("begin");
  await setup.sql(
    `insert into grader_definition
       (id, name, description, type, scope_editable, current_definition_version)
     values ($1, 'Custom policy', 'Not executable in the first roster',
             'code', true, 1)`,
    [definitionId],
  );
  await setup.sql(
    `insert into grader_definition_version
       (definition_id, version, prompt, parameter_contract, output_contract,
        source_code, source_code_language, modalities, judge_model)
     values ($1, 1, null, '[]'::jsonb, '{}'::jsonb,
             'return 1', 'javascript', '["chat", "voice"]'::jsonb, null)`,
    [definitionId],
  );
  await setup.sql("commit");
  await setup.close();
  await database.sql(
    `insert into project_grader
       (id, organization_id, project_id, grader_definition_id, scope, pass_threshold)
     values ($1, $2, $3, $4,
             '{"simulations":[],"production":{"sample_percent":100}}'::jsonb,
             0.6)`,
    [projectGraderId, organizationId, projectId, definitionId],
  );
  await appendSpans(auth, [span()]);
});

afterAll(async () => {
  await disconnectClickHouse();
  await disconnect();
  await store.drop();
  await database.drop();
});

describe("the worker consumes one frozen trace plan", () => {
  it("turns an unsupported grader into its own error grade and cleans up the job", async () => {
    await requestGrading(auth, {
      source: "production",
      traceId,
      traceStartedAt: startedAt,
      endsTrace: true,
      evidenceReady: true,
      modality: "voice",
    });
    const [claim] = await claimGradingJobs({
      claimant: "grader-runtime-test",
      capacity: 50,
    });
    if (claim === undefined) throw new Error("the production trace was not claimed");

    await expect(gradeClaim(claim, {
      providerCredentials: {
        async load() {
          throw new Error("a code-only plan must not load model credentials");
        },
      },
    })).resolves.toEqual({
      source: "production",
      traceId,
      graders: 1,
      grades: 1,
    });

    const read = await readTraceGrades(auth, { source: "production", traceId });
    expect(read.current).toMatchObject([{
      projectGraderId,
      graderDefinitionId: definitionId,
      score: null,
      graderPassThreshold: 0.6,
      gradingSequence: claim.sequenceBase + claim.attempts,
      result: "errored",
      details: {
        error: expect.stringContaining("does not execute grader definition"),
      },
    }]);

    await finishGradingJob(claim.auth, claim.id, claim.claimedBy);
    await expect(readTraceGrading(auth, { source: "production", traceId }))
      .resolves.toMatchObject({
        state: "error",
        combinedScore: null,
        current: [{ graderName: "Custom policy", result: "errored" }],
      });
  });
});
