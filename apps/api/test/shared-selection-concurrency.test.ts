import { newId } from "@egma/ids";
import {
  getGradingPlan,
  getSimulation,
  GRADER_DEFINITION_CATALOG,
  PERSONA_LIBRARY_CATALOG,
  PREDEFINED_GRADERS,
  reconcileGraderCatalog,
  seedPersonaLibrary,
} from "@egma/db";
import { afterEach, expect, it } from "vitest";

import { openSingleConnection } from "../../../packages/db/test/support/database.ts";
import { CLAIMS_PATH } from "../src/routes/claims.ts";
import { createApi, type TestApi } from "./support/api.ts";
import { contextFor, signUp } from "./support/traces.ts";

let api: TestApi;
afterEach(async () => { await api?.close(); });

/** Wait for a database lock edge, never a timing guess about the release. */
async function blockedBy(pid: number): Promise<number> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await api.database.sql<{ pid: number }>(
      "select pid from pg_stat_activity where $1::integer = any(pg_blocking_pids(pid))", [pid],
    );
    if (rows[0] !== undefined) return rows[0].pid;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the concurrent operation did not reach the held publication");
}

it.each(["grader", "persona"] as const)("selects a coherent run after waiting for a %s publication", async (kind) => {
  api = await createApi(`concurrent_${kind}_publication`);
  const who = await signUp(api.app, `${kind}-publication@example.test`, "Concurrent publication");
  const headers = { cookie: who.cookie };
  async function request(method: "POST" | "GET" | "PATCH", url: string, payload?: object) {
    const response = await api.app.inject({ method, url: `${url}?projectId=${who.projectId}`, headers, ...(payload === undefined ? {} : { payload }) });
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(200);
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json();
  }
  const persona = PERSONA_LIBRARY_CATALOG[0]!;
  const personaCore = persona.versions.at(-1)!;
  await request("PATCH", `/v1/personas/${persona.id}`, {
    projectId: who.projectId,
    models: {
      llm: { provider: "openai", model: "gpt-5.6-terra" },
      stt: { provider: "openai", model: "gpt-live-transcribe" },
      tts: { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "alloy", speed: 1 },
    },
  });
  const grader = GRADER_DEFINITION_CATALOG.find((one) => one.id === PREDEFINED_GRADERS.expectedBehaviors)!;
  const suite = await request("POST", "/v1/test-suites", { name: "Concurrent release" });
  const test = await request("POST", "/v1/tests", { suiteId: suite.id, name: "Calls", scenario: "Ask for help", expectedBehaviors: ["Agent helps"], personas: [persona.id] });
  const registered = await request("POST", "/v1/agents", { agentPlatform: "livekit", name: "Support", connection: {
    agentPlatform: "livekit", connectionType: "livekit_room", accessVariant: "livekit_room.project_credentials", modality: "voice",
    config: { url: "wss://example.livekit.cloud", agentName: "support" }, credentials: { apiKey: "livekit-key-A1B2C3D4WXYZ", apiSecret: "livekit-secret-E5F6G7H8QRST" },
  } });
  const updatedPersonaVersionId = newId("prsv");
  const gate = await openSingleConnection(api.database.url);
  await gate.sql("begin");
  const { rows } = await gate.sql<{ pid: number }>("select pg_backend_pid() as pid");
  const gatePid = rows[0]!.pid;
  await gate.sql(kind === "grader"
    ? "select id from project_grader where project_id=$1 and grader_definition_id=$2 for update"
    : "select id from project_persona where project_id=$1 and persona_definition_id=$2 for update", [who.projectId, kind === "grader" ? grader.id : persona.id]);
  const publication = kind === "grader"
    ? reconcileGraderCatalog([{ ...grader, prompt: "Judge every expected behavior with exact evidence.", parameterContract: grader.parameterContract.map((field) => field.key === "llm_model" ? { ...field, defaultValue: "gpt-4o-mini" } : field) }])
    : seedPersonaLibrary([{ ...persona, versions: [...persona.versions, { ...personaCore, version: personaCore.version + 1, id: updatedPersonaVersionId, personality: "Wait for a complete answer.", parameterContract: personaCore.parameterContract.map((field) => field.key === "tts_speed" ? { ...field, defaultValue: 1.3 } : field) }] }]);
  let launch: ReturnType<typeof request> | undefined;
  try {
    const publisherPid = await blockedBy(gatePid);
    launch = request("POST", "/v1/runs", { suiteId: suite.id, agentId: registered.agent.id, connectionId: registered.connection.id, expectedTestVersions: [{ testId: test.id, versionId: test.versionId }] });
    await blockedBy(publisherPid);
    await gate.sql("commit");
    await publication;
    const run = await launch;
    const auth = contextFor(who, "admin");
    const plan = await getGradingPlan(auth, run.id);
    expect(plan?.groups[0]?.items).toEqual([expect.objectContaining({
      graderDefinitionVersion: kind === "grader" ? 2 : 1,
      parameterValues: { llm_provider: "openai", llm_model: "gpt-5.6-terra" },
      definition: expect.objectContaining({ prompt: kind === "grader" ? "Judge every expected behavior with exact evidence." : grader.prompt }),
    })]);
    const simulations = await request("GET", `/v1/runs/${run.id}/simulations`);
    const simulationId = simulations.simulations[0].id as string;
    expect(await getSimulation(auth, simulationId)).toMatchObject({ personaVersionId: kind === "persona" ? updatedPersonaVersionId : personaCore.id });
    const claim = await api.app.inject({ method: "POST", url: CLAIMS_PATH, headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` }, payload: { contract_versions: [5, 6], claimant: "after-concurrent-publication", capacity: 1, wait_seconds: 0 } });
    expect(claim.statusCode, claim.body).toBe(200);
    expect(claim.json().specs).toMatchObject([{ simulation_id: simulationId, persona: { personality: kind === "persona" ? "Wait for a complete answer." : personaCore.personality }, models: { llm: { model: "gpt-5.6-terra" }, tts: { speed: 1 } } }]);
  } finally {
    await gate.sql("rollback");
    await gate.close();
    await Promise.allSettled([publication, ...(launch === undefined ? [] : [launch])]);
  }
});

it("serializes an optional grader removal with a concurrent settings save", async () => {
  api = await createApi("concurrent_grader_removal");
  const who = await signUp(api.app, "grader-removal@example.test", "Concurrent removal");
  const headers = { cookie: who.cookie };
  const used = await api.app.inject({ method: "POST", url: `/v1/grader-library/${PREDEFINED_GRADERS.responseLatency}/use?projectId=${who.projectId}`, headers, payload: {
    scope: { simulations: [{ kind: "all" }], production: null }, settings: { maximum_response_time_ms: 2_500 }, passThreshold: 1,
  } });
  expect(used.statusCode, used.body).toBe(201);
  const graderId = used.json().id as string;
  const gate = await openSingleConnection(api.database.url);
  await gate.sql("begin");
  const { rows } = await gate.sql<{ pid: number }>("select pg_backend_pid() as pid");
  await gate.sql("select id from project_grader where id=$1 for update", [graderId]);
  const removed = api.app.inject({ method: "DELETE", url: `/v1/graders/${graderId}?projectId=${who.projectId}`, headers }).then((answer) => answer);
  let saved: typeof removed | undefined;
  try {
    const removalPid = await blockedBy(rows[0]!.pid);
    saved = api.app.inject({ method: "PATCH", url: `/v1/graders/${graderId}?projectId=${who.projectId}`, headers, payload: { settings: { maximum_response_time_ms: 3_000 } } }).then((answer) => answer);
    await blockedBy(removalPid);
    await gate.sql("commit");
    const [removal, edit] = await Promise.all([removed, saved]);
    expect(removal.statusCode, removal.body).toBe(204);
    expect(edit.statusCode, edit.body).toBe(404);
  } finally {
    await gate.sql("rollback");
    await gate.close();
    await Promise.allSettled([removed, ...(saved === undefined ? [] : [saved])]);
  }
});
