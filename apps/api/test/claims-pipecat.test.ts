import { readFile } from "node:fs/promises";

import { createPersona, getSimulation } from "@egma/db";
import { specComplaints } from "@egma/simulation-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLAIMS_PATH } from "../src/routes/claims.ts";
import type { DaytonaClaimRuntime } from "../src/voice-fleet-daytona.ts";
import { createApi, type TestApi, type TestApiOptions } from "./support/api.ts";
import {
  contextFor,
  projectKeyFor,
  request as ask,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * Claims for Daily room connections: every Pipecat spec is contract version
 * 8, handed only to a worker that lists 8, built from the same pinned test,
 * persona and connection as the golden spec fixtures describe.
 */

type Json = Record<string, unknown>;

async function goldenSpec(name: string): Promise<Json> {
  return JSON.parse(
    await readFile(
      new URL(
        `../../../packages/simulation-contract/fixtures/spec/valid/${name}`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Json;
}

const VOICE_PIPECAT_CLOUD = await goldenSpec("voice-pipecat-cloud.json");
const VOICE_PIPECAT_CLOUD_HOSTED = await goldenSpec("voice-pipecat-cloud-hosted.json");
const CHAT_PIPECAT_SELF_HOSTED = await goldenSpec("chat-pipecat-self-hosted.json");

let api: TestApi;

afterEach(async () => {
  vi.restoreAllMocks();
  await api?.close();
});

type Ready = {
  readonly ada: Customer;
  readonly key: string;
  readonly simulationId: string;
};

/**
 * One queued simulation authored to be the golden fixture's own world: the
 * same connection, persona, scenario, mock tools and body params, so the only
 * things a claim can add are the simulation's id and the persona's models.
 */
async function aQueuedSimulationLike(
  label: string,
  golden: Json,
  options: TestApiOptions = {},
  connection?: Json,
): Promise<Ready> {
  api = await createApi(label, options);
  const ada = await signUp(api.app, "ada@lakeside.example", "Lakeside");
  const key = await projectKeyFor(api.app, ada);

  const wire = golden.connection as Json;
  const registered = await ask(api.app, "POST", "/v1/agents", key, {
    agentPlatform: "pipecat",
    name: "Lakeside front desk",
    connection: connection ?? {
      agentPlatform: wire.agent_platform,
      connectionType: wire.connection_type,
      accessVariant: wire.access_variant,
      modality: golden.modality,
      config: wire.config,
      credentials: wire.credentials,
    },
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const agentId = (registered.body.agent as { id: string }).id;
  const connectionId = (registered.body.connection as { id: string }).id;

  const suite = await ask(api.app, "POST", "/v1/test-suites", key, {
    name: "Rescheduling",
  });
  expect(suite.statusCode, JSON.stringify(suite.body)).toBe(201);

  const persona = golden.persona as { name: string; personality: string };
  await createPersona(contextFor(ada, "member"), {
    name: "Eleanor",
    identityName: persona.name,
    personality: persona.personality,
    language: "en-US",
  });
  const mockTools = ((golden.mock_tools ?? []) as { tool_name: string; answer: Json }[]).map(
    (entry) =>
      "error" in entry.answer
        ? { tool: entry.tool_name, error: entry.answer.error }
        : { tool: entry.tool_name, answer: entry.answer.answer },
  );
  const pushed = await ask(api.app, "POST", "/v1/tests", key, {
    name: "Moves a check-up",
    scenario: (golden.scenario as { instructions: string }).instructions,
    expectedBehaviors: ["reads the new date back before finishing"],
    suiteId: String(suite.body.id),
    personas: ["Eleanor"],
    ...(mockTools.length === 0 ? {} : { mockTools }),
    ...(golden.pipecat_body_params === undefined
      ? {}
      : {
          env: {
            pipecat_body_params: golden.pipecat_body_params,
            // Another platform's words, which a Daily room never carries.
            retell_dynamic_variables: { caller_name: "Eleanor" },
            job_dispatch_metadata: { tenant: "lakeside" },
          },
        }),
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  const started = await ask(api.app, "POST", "/v1/runs", key, {
    suiteId: String(suite.body.id),
    agentId,
    connectionId,
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  const page = await ask(
    api.app,
    "GET",
    `/v1/runs/${String(started.body.id)}/simulations?pageSize=1`,
    key,
  );
  const simulationId = (page.body.simulations as { id: string }[])[0]?.id;
  if (simulationId === undefined) throw new Error("the run has no simulation");
  return { ada, key, simulationId };
}

async function claim(body: Json): Promise<{ statusCode: number; body: Json }> {
  const response = await api.app.inject({
    method: "POST",
    url: CLAIMS_PATH,
    headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
    payload: { claimant: "egma-simulator-1", capacity: 1, wait_seconds: 0, ...body },
  });
  return { statusCode: response.statusCode, body: response.json() as Json };
}

describe("a Daily room claim", () => {
  it("is the golden Pipecat Cloud voice spec, version 8, for a worker that lists 8", async () => {
    const { simulationId } = await aQueuedSimulationLike(
      "claims_pipecat_cloud_voice",
      VOICE_PIPECAT_CLOUD,
    );

    const answered = await claim({ contract_versions: [5, 6, 7, 8] });
    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);
    const [spec] = answered.body.specs as Json[];
    if (spec === undefined) throw new Error("no spec came back");

    expect(specComplaints(spec)).toEqual([]);
    expect(spec.contract_version).toBe(8);
    expect(spec.simulation_id).toBe(simulationId);
    // Everything but the id and the persona's current models is the fixture,
    // byte for byte: no dispatch metadata, no Retell variables, no version,
    // no carrier and no runtime.
    expect({
      ...spec,
      simulation_id: VOICE_PIPECAT_CLOUD.simulation_id,
      models: VOICE_PIPECAT_CLOUD.models,
    }).toEqual(VOICE_PIPECAT_CLOUD);
    expect(spec.models).toMatchObject({
      mode: "separate",
      llm: { key: "openai-key-held-by-this-test-suite" },
      stt: { key: expect.any(String) },
      tts: { key: expect.any(String) },
    });
  });

  it("is the golden self-hosted chat spec, with no body params where the test wrote none", async () => {
    await aQueuedSimulationLike("claims_pipecat_self_hosted_chat", CHAT_PIPECAT_SELF_HOSTED);

    const answered = await claim({ contract_versions: [8], modalities: ["chat"] });
    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);
    const [spec] = answered.body.specs as Json[];
    if (spec === undefined) throw new Error("no spec came back");

    expect(specComplaints(spec)).toEqual([]);
    expect("pipecat_body_params" in spec).toBe(false);
    expect({
      ...spec,
      simulation_id: CHAT_PIPECAT_SELF_HOSTED.simulation_id,
      models: CHAT_PIPECAT_SELF_HOSTED.models,
    }).toEqual(CHAT_PIPECAT_SELF_HOSTED);
  });

  it("stays queued for a worker that does not list version 8", async () => {
    const { ada, simulationId } = await aQueuedSimulationLike(
      "claims_pipecat_old_worker",
      VOICE_PIPECAT_CLOUD,
    );

    const deferred = await claim({ contract_versions: [5, 6, 7] });
    expect(deferred.statusCode).toBe(200);
    expect(deferred.body.specs).toEqual([]);
    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row?.status).toBe("queued");

    // The next worker that can conduct it gets it.
    const answered = await claim({ contract_versions: [7, 8] });
    expect((answered.body.specs as Json[]).map((spec) => spec.simulation_id)).toEqual([
      simulationId,
    ]);
  });

  it("carries the hosted runtime when the hosted voice runtime claims it", async () => {
    const hosted = VOICE_PIPECAT_CLOUD_HOSTED.runtime as Json;
    const daytonaClaimRuntime = vi.fn<DaytonaClaimRuntime>(async () => structuredClone(hosted) as never);
    const { ada, simulationId } = await aQueuedSimulationLike(
      "claims_pipecat_daytona",
      VOICE_PIPECAT_CLOUD,
      { daytonaClaimRuntime },
    );

    const answered = await claim({
      claimant: "egma-voice-runtime-1",
      contract_versions: [5, 6, 7, 8],
      modalities: ["voice"],
      runtime: "daytona",
    });
    expect(answered.statusCode, JSON.stringify(answered.body)).toBe(200);
    const [spec] = answered.body.specs as Json[];
    if (spec === undefined) throw new Error("no spec came back");

    expect(specComplaints(spec)).toEqual([]);
    expect(spec.contract_version).toBe(8);
    expect(spec.runtime).toEqual(hosted);
    expect(daytonaClaimRuntime).toHaveBeenCalledWith(
      "egma-voice-runtime-1",
      simulationId,
      expect.any(AbortSignal),
    );
    // The golden hosted work order, apart from the id and the persona's models.
    expect({
      ...spec,
      simulation_id: VOICE_PIPECAT_CLOUD_HOSTED.simulation_id,
      models: VOICE_PIPECAT_CLOUD_HOSTED.models,
    }).toEqual(VOICE_PIPECAT_CLOUD_HOSTED);

    const row = await getSimulation(contextFor(ada, "member"), simulationId);
    expect(row).toMatchObject({ status: "claimed", claimedBy: "egma-voice-runtime-1" });
  });

  it("leaves a LiveKit claim at version 7 for a worker that also lists 8", async () => {
    const livekit = {
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "voice",
      config: { url: "wss://lakeside.livekit.cloud", agentName: "front-desk" },
      credentials: { apiKey: "livekit-key-A1B2C3D4WXYZ", apiSecret: "livekit-secret-E5F6G7H8QRST" },
    };
    api = await createApi("claims_livekit_beside_pipecat");
    const ada = await signUp(api.app, "ada@lakeside.example", "Lakeside");
    const key = await projectKeyFor(api.app, ada);
    const registered = await ask(api.app, "POST", "/v1/agents", key, {
      agentPlatform: "livekit",
      name: "LiveKit desk",
      connection: livekit,
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const suite = await ask(api.app, "POST", "/v1/test-suites", key, { name: "Rescheduling" });
    await createPersona(contextFor(ada, "member"), {
      name: "Eleanor",
      identityName: "Eleanor",
      personality: "Polite and thorough.",
      language: "en-US",
    });
    const pushed = await ask(api.app, "POST", "/v1/tests", key, {
      name: "Moves a check-up",
      scenario: "Wants the check-up moved to Thursday.",
      expectedBehaviors: ["reads the new date back"],
      suiteId: String(suite.body.id),
      personas: ["Eleanor"],
      env: {
        job_dispatch_metadata: { tenant: "lakeside" },
        pipecat_body_params: { tenant: "lakeside" },
      },
    });
    expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);
    const started = await ask(api.app, "POST", "/v1/runs", key, {
      suiteId: String(suite.body.id),
      agentId: (registered.body.agent as { id: string }).id,
      connectionId: (registered.body.connection as { id: string }).id,
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

    const answered = await claim({ contract_versions: [5, 6, 7, 8] });
    const [spec] = answered.body.specs as Json[];
    if (spec === undefined) throw new Error("no spec came back");
    expect(specComplaints(spec)).toEqual([]);
    expect(spec.contract_version).toBe(7);
    expect(spec.job_dispatch_metadata).toEqual({ tenant: "lakeside" });
    expect("pipecat_body_params" in spec).toBe(false);
  });

  it("refuses a worker that lists no version this control plane sends", async () => {
    api = await createApi("claims_pipecat_versions_refused");
    const refused = await claim({ contract_versions: [9] });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toMatchObject({
      error: "invalid_request",
      message: expect.stringContaining("5, 6, 7, and 8"),
    });
  });
});
