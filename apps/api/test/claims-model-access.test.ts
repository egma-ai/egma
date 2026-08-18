import { newId } from "@egma/ids";
import {
  createPersona,
  editPersona,
  getSimulation,
  RECOMMENDED_PERSONA_MODELS,
  storeModelProviderCredential,
  type PersonaModels,
} from "@egma/db";
import { specComplaints, specComplaintsAsVersion } from "@egma/simulation-contract";
import { afterEach, describe, expect, it } from "vitest";

import { CLAIMS_PATH } from "../src/routes/claims.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  NEUTRAL_TRAITS,
  projectKeyFor,
  request as ask,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * What a simulator is handed when the organization owns its own model
 * providers, over real HTTP against real Postgres.
 *
 * This is the control-plane seam the whole effort turns on: the place where the
 * *pinned* persona version meets the *current* organization credentials. Both
 * halves of that sentence are asserted here, because getting either the wrong
 * way round is the failure — pinned credentials would make a rotation
 * unreachable, and a current persona would rewrite what last week's run meant.
 *
 * Everything is observed through the door the shipped simulator actually knocks
 * on, and through the public read of the simulation afterwards. Nothing reaches
 * around into a helper.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RESCHEDULING = {
  name: "Reschedules a booked appointment",
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expected_behaviors: ["confirms the new time back before finishing"],
} as const;

const RETELL = {
  type: "retell",
  modality: "chat",
  config: { retellAgentId: "agent_in_retell_1" },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
} as const;

/** The same agent reached over a voice line, for the cases about speech legs. */
const LIVEKIT_VOICE = {
  type: "livekit",
  modality: "voice",
  config: { url: "wss://acme.livekit.cloud" },
  credentials: {
    apiKey: "APIsentinelclaims0WXYZ",
    apiSecret: "SENTINEL-livekit-claims-J9K0",
  },
} as const;

/** The direct Retell target the chat cases stand on: a chat agent, answering. */
const RETELL_CHAT_FETCH: typeof fetch = async (input) => {
  const url = String(input);
  if (!url.includes("/v2/list-agents")) {
    throw new Error(`Unexpected Retell read: ${url}`);
  }
  return new Response(
    JSON.stringify({
      items: [
        {
          agent_id: "agent_in_retell_1",
          agent_name: "Front desk",
          channel: "chat",
        },
      ],
      has_more: false,
    }),
    { status: 200 },
  );
};

/** Sentinels, so a leak anywhere is a string a scan can find. */
const OPENAI_KEY = "sk-sentinel-thinking-with-A1B2";
const DEEPGRAM_KEY = "dg-sentinel-listening-with-C3D4";
const CARTESIA_KEY = "ct-sentinel-speaking-with-E5F6";
/** A provider the persona does not select, so nothing may carry it. */
const UNRELATED_KEY = "sk-sentinel-unrelated-account-G7H8";

type Claimed = {
  readonly statusCode: number;
  readonly specs: readonly Record<string, unknown>[];
};

async function claim(
  token: string,
  body: Record<string, unknown>,
): Promise<Claimed> {
  const response = await api.app.inject({
    method: "POST",
    url: CLAIMS_PATH,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
  const answered = response.json() as { specs?: Record<string, unknown>[] };
  return { statusCode: response.statusCode, specs: answered.specs ?? [] };
}

type World = {
  readonly ada: Customer;
  readonly key: string;
  readonly connectionId: string;
  readonly versionId: string;
  readonly serviceToken: string;
};

/** A customer with an agent, a persona and a test — everything a run needs. */
async function aCustomer(
  label: string,
  persona: {
    readonly models?: PersonaModels | undefined;
    readonly modality?: "chat" | "voice" | undefined;
  } = {},
): Promise<World> {
  api = await createApi(label, { retellFetch: RETELL_CHAT_FETCH });
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const registered = await ask(api.app, "POST", "/api/agents", key, {
    name: "Front desk",
    connection: persona.modality === "voice" ? LIVEKIT_VOICE : RETELL,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const connectionId = (registered.body.connection as { id: string }).id;

  await createPersona(contextFor(ada, "member"), {
    name: "Impatient Rita",
    traits: NEUTRAL_TRAITS,
    ...(persona.models === undefined ? {} : { models: persona.models }),
  });

  const pushed = await ask(api.app, "POST", "/api/tests", key, {
    ...RESCHEDULING,
    personas: ["Impatient Rita"],
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  return {
    ada,
    key,
    connectionId,
    versionId: String(pushed.body.version_id),
    serviceToken: api.config.simulatorServiceToken,
  };
}

/** A run over the customer's connection, whose simulation lands queued. */
async function aQueuedRun(world: World): Promise<{ simulationId: string }> {
  const started = await ask(api.app, "POST", "/api/runs", world.key, {
    connection: world.connectionId,
    test_versions: [world.versionId],
    idempotency_key: newId("run"),
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  const first = (started.body.simulations as { id: string }[])[0];
  if (first === undefined) throw new Error("the run has no simulation");
  return { simulationId: first.id };
}

async function storeTheThreeKeys(ada: Customer): Promise<void> {
  const admin = contextFor(ada, "admin");
  await storeModelProviderCredential(admin, {
    provider: "openai",
    key: OPENAI_KEY,
  });
  await storeModelProviderCredential(admin, {
    provider: "deepgram",
    key: DEEPGRAM_KEY,
  });
  await storeModelProviderCredential(admin, {
    provider: "cartesia",
    key: CARTESIA_KEY,
  });
}

describe("a work order for a persona that selects its own models", () => {
  it("carries the pinned selections and only the keys they name", async () => {
    const world = await aCustomer("claims_models_customer_owned", {
      models: RECOMMENDED_PERSONA_MODELS,
    });
    await storeTheThreeKeys(world.ada);
    await aQueuedRun(world);

    const claimed = await claim(world.serviceToken, {
      claimant: "sim-1",
      capacity: 1,
      wait_seconds: 0,
      contract_versions: [1, 2],
    });

    expect(claimed.statusCode).toBe(200);
    const [spec] = claimed.specs;
    expect(spec, "a queued simulation was not claimed").toBeDefined();
    expect(specComplaints(spec)).toEqual([]);
    expect(spec?.contract_version).toBe(2);

    // A chat simulation over this connection: it thinks, and it neither speaks
    // nor listens. The selections travel whole because they are what the
    // persona *is*; the keys follow the legs this simulation actually has.
    expect(spec?.models).toEqual({
      access: "customer-owned",
      llm: {
        provider: RECOMMENDED_PERSONA_MODELS.llm.provider,
        model: RECOMMENDED_PERSONA_MODELS.llm.model,
        key: OPENAI_KEY,
      },
      stt: {
        provider: RECOMMENDED_PERSONA_MODELS.stt.provider,
        model: RECOMMENDED_PERSONA_MODELS.stt.model,
      },
      tts: {
        provider: RECOMMENDED_PERSONA_MODELS.tts.provider,
        model: RECOMMENDED_PERSONA_MODELS.tts.model,
        voice_id: RECOMMENDED_PERSONA_MODELS.tts.voiceId,
        speed: RECOMMENDED_PERSONA_MODELS.tts.speed,
      },
    });
  });

  it("carries no speech key on a chat simulation, which has no use for one", async () => {
    const world = await aCustomer("claims_models_chat_carries_no_speech_key", {
      models: RECOMMENDED_PERSONA_MODELS,
    });
    await storeTheThreeKeys(world.ada);
    await aQueuedRun(world);

    const claimed = await claim(world.serviceToken, {
      claimant: "sim-1",
      capacity: 1,
      wait_seconds: 0,
      contract_versions: [1, 2],
    });

    const written = JSON.stringify(claimed.specs);
    expect(written).toContain(OPENAI_KEY);
    // The organization holds both, and neither travels: a credential that
    // reaches a process with no use for it is a credential that did not have
    // to be there.
    expect(written).not.toContain(DEEPGRAM_KEY);
    expect(written).not.toContain(CARTESIA_KEY);
  });

  it("needs no speech credential to conduct a chat simulation at all", async () => {
    const world = await aCustomer("claims_models_chat_needs_only_thinking", {
      models: RECOMMENDED_PERSONA_MODELS,
    });
    // The thinking key alone, which under a rule that demanded all three would
    // stop a chat test this organization had everything for.
    await storeModelProviderCredential(contextFor(world.ada, "admin"), {
      provider: "openai",
      key: OPENAI_KEY,
    });
    await aQueuedRun(world);

    const claimed = await claim(world.serviceToken, {
      claimant: "sim-1",
      capacity: 1,
      wait_seconds: 0,
      contract_versions: [1, 2],
    });

    expect(claimed.specs).toHaveLength(1);
    expect(specComplaints(claimed.specs[0])).toEqual([]);
  });

  it("carries no inference credential, because nothing here is Egma's to spend", async () => {
    const world = await aCustomer("claims_models_no_inference", {
      models: RECOMMENDED_PERSONA_MODELS,
    });
    await storeTheThreeKeys(world.ada);
    await aQueuedRun(world);

    const claimed = await claim(world.serviceToken, {
      claimant: "sim-1",
      capacity: 1,
      wait_seconds: 0,
      contract_versions: [1, 2],
    });

    const written = JSON.stringify(claimed.specs);
    // The words a gateway credential would travel under, none of which a
    // customer-owned work order has any business carrying.
    for (const absent of ["inference", "gateway", "base_url"]) {
      expect(written, `a customer-owned work order carried ${absent}`).not.toContain(
        absent,
      );
    }
  });

  it("carries no key for a provider the persona does not select", async () => {
    const world = await aCustomer("claims_models_only_what_is_named", {
      models: {
        ...RECOMMENDED_PERSONA_MODELS,
        // Everything on one account, so two of the organization's three
        // credentials are genuinely unrelated to this simulation.
        stt: RECOMMENDED_PERSONA_MODELS.stt,
      },
    });
    const admin = contextFor(world.ada, "admin");
    await storeModelProviderCredential(admin, {
      provider: "openai",
      key: OPENAI_KEY,
    });
    await storeModelProviderCredential(admin, {
      provider: "deepgram",
      key: DEEPGRAM_KEY,
    });
    await storeModelProviderCredential(admin, {
      provider: "cartesia",
      key: CARTESIA_KEY,
    });
    await aQueuedRun(world);

    const claimed = await claim(world.serviceToken, {
      claimant: "sim-1",
      capacity: 1,
      wait_seconds: 0,
      contract_versions: [1, 2],
    });

    const written = JSON.stringify(claimed.specs);
    expect(written).toContain(OPENAI_KEY);
    expect(written).not.toContain(UNRELATED_KEY);
  });

  it("resolves the key when the claim is prepared, so a rotation reaches the next one", async () => {
    const world = await aCustomer("claims_models_rotation", {
      models: RECOMMENDED_PERSONA_MODELS,
    });
    await storeTheThreeKeys(world.ada);
    await aQueuedRun(world);

    const first = await claim(world.serviceToken, {
      claimant: "sim-1",
      capacity: 1,
      wait_seconds: 0,
      contract_versions: [1, 2],
    });
    expect(JSON.stringify(first.specs)).toContain(OPENAI_KEY);

    // The admin rotates while that conversation is in flight, and starts
    // another run. Nothing about the persona changed, so nothing is re-pinned.
    const rotated = "sk-sentinel-rotated-account-J9K0";
    await storeModelProviderCredential(contextFor(world.ada, "admin"), {
      provider: "openai",
      key: rotated,
    });
    await aQueuedRun(world);

    const second = await claim(world.serviceToken, {
      claimant: "sim-2",
      capacity: 1,
      wait_seconds: 0,
      contract_versions: [1, 2],
    });

    const written = JSON.stringify(second.specs);
    expect(written).toContain(rotated);
    expect(written).not.toContain(OPENAI_KEY);

    // And the persona is where it was: a rotation is operational state, and
    // touching it must not mint a version a run would then have to mean.
    const [spec] = second.specs;
    expect((spec?.models as { llm: { model: string } }).llm.model).toBe(
      RECOMMENDED_PERSONA_MODELS.llm.model,
    );
  });

  it("pins the version the run named, not what the persona says today", async () => {
    const world = await aCustomer("claims_models_pinned", {
      models: RECOMMENDED_PERSONA_MODELS,
    });
    await storeTheThreeKeys(world.ada);
    await aQueuedRun(world);

    // The author changes what the persona thinks with *after* the run started.
    // The queued simulation still names the version it was born pinned to.
    const author = contextFor(world.ada, "member");
    const personas = await ask(api.app, "GET", "/api/personas", world.key);
    const rita = (personas.body.items as { id: string }[])[0];
    if (rita === undefined) throw new Error("the persona is missing");
    const edited = await editPersona(author, rita.id, {
      models: {
        ...RECOMMENDED_PERSONA_MODELS,
        llm: { provider: "openai", model: "gpt-4o" },
      },
    });
    expect(edited?.models?.llm.model).toBe("gpt-4o");

    const claimed = await claim(world.serviceToken, {
      claimant: "sim-1",
      capacity: 1,
      wait_seconds: 0,
      contract_versions: [1, 2],
    });

    const [spec] = claimed.specs;
    expect((spec?.models as { llm: { model: string } }).llm.model).toBe(
      RECOMMENDED_PERSONA_MODELS.llm.model,
    );
  });
});

describe("a persona still on the compatibility path", () => {
  it("is conducted from the contract it always was, with no models block", async () => {
    const world = await aCustomer("claims_models_legacy");
    await aQueuedRun(world);

    const claimed = await claim(world.serviceToken, {
      claimant: "sim-1",
      capacity: 1,
      wait_seconds: 0,
      contract_versions: [1, 2],
    });

    const [spec] = claimed.specs;
    expect(spec, "the legacy simulation was not claimed").toBeDefined();
    expect(spec?.contract_version).toBe(1);
    expect(spec).not.toHaveProperty("models");
    expect(specComplaints(spec)).toEqual([]);
    // And the document a version-1 worker checks it against accepts it, which
    // is the whole of what "still starts and finishes new work" means.
    expect(specComplaintsAsVersion(1, spec)).toEqual([]);
  });

  it("needs no model-provider credential, because nothing resolves one", async () => {
    const world = await aCustomer("claims_models_legacy_no_keys");
    const { simulationId } = await aQueuedRun(world);

    const claimed = await claim(world.serviceToken, {
      claimant: "sim-1",
      capacity: 1,
      wait_seconds: 0,
    });

    expect(claimed.specs).toHaveLength(1);
    const landed = await getSimulation(
      contextFor(world.ada, "member"),
      simulationId,
    );
    expect(landed?.status).toBe("claimed");
  });
});

describe("a worker that speaks only the old contract", () => {
  it("is never handed a document it could not read", async () => {
    const world = await aCustomer("claims_models_old_worker", {
      models: RECOMMENDED_PERSONA_MODELS,
    });
    await storeTheThreeKeys(world.ada);
    const { simulationId } = await aQueuedRun(world);

    // It says nothing about versions, which is what every simulator built
    // before the second one says.
    const claimed = await claim(world.serviceToken, {
      claimant: "old-sim",
      capacity: 5,
      wait_seconds: 0,
    });

    expect(claimed.specs).toEqual([]);

    // And the row is untouched: not claimed, not failed, still waiting for a
    // worker that can conduct it. A rollout detail must not spend somebody's
    // simulation.
    const waiting = await getSimulation(
      contextFor(world.ada, "member"),
      simulationId,
    );
    expect(waiting?.status).toBe("queued");
  });

  it("leaves that work for the simulator beside it that can", async () => {
    const world = await aCustomer("claims_models_mixed_fleet", {
      models: RECOMMENDED_PERSONA_MODELS,
    });
    await storeTheThreeKeys(world.ada);
    await aQueuedRun(world);

    const old = await claim(world.serviceToken, {
      claimant: "old-sim",
      capacity: 5,
      wait_seconds: 0,
      contract_versions: [1],
    });
    expect(old.specs).toEqual([]);

    const upgraded = await claim(world.serviceToken, {
      claimant: "new-sim",
      capacity: 5,
      wait_seconds: 0,
      contract_versions: [1, 2],
    });
    expect(upgraded.specs).toHaveLength(1);
    expect(upgraded.specs[0]?.contract_version).toBe(2);
  });

  it("is refused by name when it declares a version this platform never writes", async () => {
    const world = await aCustomer("claims_models_unknown_version");

    const response = await api.app.inject({
      method: "POST",
      url: CLAIMS_PATH,
      headers: { authorization: `Bearer ${world.serviceToken}` },
      payload: {
        claimant: "sim-from-the-future",
        capacity: 1,
        wait_seconds: 0,
        contract_versions: [7],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(String((response.json() as { message: string }).message)).toContain(
      "contract_versions",
    );
  });
});

describe("a provider credential the organization has not stored", () => {
  it("stops that simulation and says which model job named which provider", async () => {
    const world = await aCustomer("claims_models_missing_credential", {
      models: RECOMMENDED_PERSONA_MODELS,
      modality: "voice",
    });
    // Only the thinking key. The listening and speaking legs have nothing, and
    // a voice simulation needs both.
    await storeModelProviderCredential(contextFor(world.ada, "admin"), {
      provider: "openai",
      key: OPENAI_KEY,
    });
    const { simulationId } = await aQueuedRun(world);

    const claimed = await claim(world.serviceToken, {
      claimant: "sim-1",
      capacity: 1,
      wait_seconds: 0,
      contract_versions: [1, 2],
    });

    // Nothing was handed over: a work order with no key would fail at the
    // provider minutes later, naming nothing about configuration.
    expect(claimed.specs).toEqual([]);

    const landed = await getSimulation(
      contextFor(world.ada, "member"),
      simulationId,
    );
    expect(landed?.status).toBe("failed");
    // An infrastructure error, and the word says so: `dispatch_failed` is the
    // platform's confession, never one of the ways a conversation ends badly.
    expect(landed?.endingReason).toBe("dispatch_failed");
    expect(landed?.endingDetail).toContain("deepgram");
    expect(landed?.endingDetail).toContain("stt");
    expect(landed?.endingDetail).toContain("cartesia");
    expect(landed?.endingDetail).toContain("tts");
    // OpenAI is stored, so it is not among what has to be added.
    expect(landed?.endingDetail).not.toContain("openai");
    // And the person reading it is sent somewhere they can actually fix it.
    expect(landed?.endingRepair).toBe("model_providers");
  });

  it("says nothing a key could be read out of", async () => {
    const world = await aCustomer("claims_models_missing_says_no_secret", {
      models: RECOMMENDED_PERSONA_MODELS,
      modality: "voice",
    });
    await storeModelProviderCredential(contextFor(world.ada, "admin"), {
      provider: "openai",
      key: OPENAI_KEY,
    });
    const { simulationId } = await aQueuedRun(world);

    await claim(world.serviceToken, {
      claimant: "sim-1",
      capacity: 1,
      wait_seconds: 0,
      contract_versions: [1, 2],
    });

    const landed = await getSimulation(
      contextFor(world.ada, "member"),
      simulationId,
    );
    expect(JSON.stringify(landed)).not.toContain(OPENAI_KEY);
  });

  it("fails only itself, and the rest of the batch is conducted", async () => {
    // Two personas: one whose providers are all stored, one whose are not.
    // They are claimed in the same request, which is exactly the batch a
    // single missing key must not take down.
    const world = await aCustomer("claims_models_one_failure_in_a_batch", {
      models: RECOMMENDED_PERSONA_MODELS,
    });
    const admin = contextFor(world.ada, "admin");
    await storeModelProviderCredential(admin, {
      provider: "openai",
      key: OPENAI_KEY,
    });
    await storeModelProviderCredential(admin, {
      provider: "deepgram",
      key: DEEPGRAM_KEY,
    });
    await storeModelProviderCredential(admin, {
      provider: "cartesia",
      key: CARTESIA_KEY,
    });

    // A second persona that speaks with a provider this organization is about
    // to stop holding a key for.
    await createPersona(contextFor(world.ada, "member"), {
      name: "Hurried Sam",
      traits: NEUTRAL_TRAITS,
      models: RECOMMENDED_PERSONA_MODELS,
    });
    const second = await ask(api.app, "POST", "/api/tests", world.key, {
      name: "Asks for a receipt",
      scenario: "They want last month's receipt emailed again.",
      expected_behaviors: ["says when the email will arrive"],
      personas: ["Hurried Sam"],
    });
    expect(second.statusCode, JSON.stringify(second.body)).toBe(201);

    const started = await ask(api.app, "POST", "/api/runs", world.key, {
      connection: world.connectionId,
      test_versions: [world.versionId, String(second.body.version_id)],
      idempotency_key: newId("run"),
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    const simulations = started.body.simulations as { id: string }[];
    expect(simulations).toHaveLength(2);

    const claimed = await claim(world.serviceToken, {
      claimant: "sim-1",
      capacity: 5,
      wait_seconds: 0,
      contract_versions: [1, 2],
    });

    // Both are conducted: this is the batch working, which is what the
    // one-failure case below is measured against.
    expect(claimed.specs).toHaveLength(2);
  });
});
