import { newId } from "@egma/ids";
import {
  connectManagedAccess,
  createPersona,
  getSimulation,
  RECOMMENDED_GRADER_MODEL,
  RECOMMENDED_PERSONA_MODELS,
  storeModelProviderCredential,
  type ManagedDeployment,
} from "@egma/db";
import { specComplaints } from "@egma/simulation-contract";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { startLocalGateway, type LocalGateway } from "../../gateway/src/host/node.ts";
import { makeLog } from "../../gateway/src/record.ts";
import { judgesOnce, NoJudge } from "../../grader/src/judge/index.ts";
import { scriptedJudge } from "../../grader/test/support/scripted-judge.ts";
import { startEgmaCloudDoor } from "../../gateway/test/support/egma-cloud.ts";
import {
  EGMA_PROVIDER_KEY,
  startHttpUpstream,
  startSocketUpstream,
  type HttpUpstream,
  type SocketUpstream,
} from "../../gateway/test/support/upstreams.ts";
import { INFERENCE_KEY_HEADER } from "../src/auth/inference-key.ts";
import { CLAIMS_PATH } from "../src/routes/claims.ts";
import { INFERENCE_KEYS_PATH } from "../src/routes/inference-keys.ts";
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
 * The four ways an organization can pay for its model traffic, each conducted
 * for real.
 *
 * **hosted-managed, hosted-customer-owned, self-hosted-managed,
 * self-hosted-customer-owned.** Deployment type must not change what the
 * product can do, and neither must who supplies the credential — so all four
 * are set up through the real product interfaces, claimed from the real claim
 * door, and then *conducted*: the work order's own address and its own
 * credential are used to talk to the providers exactly as the simulator's
 * shipped adapters would.
 *
 * **The managed cells go through the real Egma model gateway application**,
 * started in this process against strict local provider servers, with the real
 * verifier — hosted Egma's signature checked on the spot, a self-hosted
 * installation's inference key asked about at the real hosted validation route.
 * The customer-owned cells call the same provider servers directly. What the
 * provider servers saw is what settles the question that matters: under managed
 * access they were shown *Egma's* credential and the work order carried none,
 * and under customer-owned access they were shown the organization's own.
 *
 * Nothing here reaches around into a helper to make a work order. Every one is
 * the document a simulator would have been handed.
 */

let api: TestApi;
let gateway: LocalGateway | undefined;
let openai: HttpUpstream | undefined;
let deepgram: SocketUpstream | undefined;
let cartesia: SocketUpstream | undefined;

afterEach(async () => {
  await api?.close();
  await gateway?.stop();
  await Promise.all([openai?.stop(), deepgram?.stop(), cartesia?.stop()]);
  gateway = undefined;
  openai = undefined;
  deepgram = undefined;
  cartesia = undefined;
});

/** Sentinels, so a leak anywhere is a string a scan can find. */
const CUSTOMER_KEY = {
  openai: "sk-sentinel-matrix-customer-openai-A1B2",
  deepgram: "dg-sentinel-matrix-customer-deepgram-C3D4",
  cartesia: "ct-sentinel-matrix-customer-cartesia-E5F6",
} as const;

const INTERNAL_KEY = "sentinel-matrix-internal-gateway-signing-G7H8";

const RETELL_VOICE = {
  type: "retell",
  modality: "voice",
  config: { retellAgentId: "agent_in_retell_1" },
  credentials: { apiKey: "retell-sentinel-matrix-J9K0" },
} as const;

const RESCHEDULING = {
  name: "Reschedules a booked appointment",
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expected_behaviors: ["confirms the new time back before finishing"],
} as const;

/**
 * The three provider-shaped servers, and the real gateway in front of them.
 *
 * Started before the API, because the API has to be told the gateway's address
 * and a deployment learns that at boot. The gateway is handed the provider
 * homes so its fixed routes reach these servers instead of the real providers —
 * deployment configuration, exactly as the shipped one takes it, and never
 * anything a caller can name.
 */
async function standUpProviders(
  validationUrl: string | undefined,
): Promise<string> {
  openai = await startHttpUpstream({
    path: "/v1/chat/completions",
    expectAuthorization: `Bearer ${EGMA_PROVIDER_KEY.openai}`,
    chunks: ['{"choices":[{"message":{"content":"hello"}}]}'],
  });
  deepgram = await startSocketUpstream({
    path: "/v1/listen",
    expect: {
      at: "header",
      name: "authorization",
      value: `Token ${EGMA_PROVIDER_KEY.deepgram}`,
    },
    echo: true,
  });
  cartesia = await startSocketUpstream({
    path: "/tts/websocket",
    expect: { at: "query", name: "api_key", value: EGMA_PROVIDER_KEY.cartesia },
    echo: true,
  });

  gateway = await startLocalGateway(
    {
      EGMA_GATEWAY_INTERNAL_KEY: INTERNAL_KEY,
      ...(validationUrl === undefined
        ? {}
        : { EGMA_GATEWAY_VALIDATION_URL: validationUrl }),
      EGMA_GATEWAY_DEEPGRAM_KEY: EGMA_PROVIDER_KEY.deepgram,
      EGMA_GATEWAY_OPENAI_KEY: EGMA_PROVIDER_KEY.openai,
      EGMA_GATEWAY_CARTESIA_KEY: EGMA_PROVIDER_KEY.cartesia,
      EGMA_GATEWAY_DEEPGRAM_HOME: deepgram.origin,
      EGMA_GATEWAY_OPENAI_HOME: openai.origin,
      EGMA_GATEWAY_CARTESIA_HOME: cartesia.origin,
    },
    { log: makeLog("ERROR", () => undefined) },
  );
  return gateway.origin;
}

/**
 * Provider servers with no gateway in front of them, for the customer-owned
 * cells: the organization's own key travels, and Egma is not on the path.
 */
async function standUpDirectProviders(): Promise<void> {
  openai = await startHttpUpstream({
    path: "/v1/chat/completions",
    expectAuthorization: `Bearer ${CUSTOMER_KEY.openai}`,
    chunks: ['{"choices":[{"message":{"content":"hello"}}]}'],
  });
  deepgram = await startSocketUpstream({
    path: "/v1/listen",
    expect: {
      at: "header",
      name: "authorization",
      value: `Token ${CUSTOMER_KEY.deepgram}`,
    },
    echo: true,
  });
  cartesia = await startSocketUpstream({
    path: "/tts/websocket",
    expect: { at: "query", name: "api_key", value: CUSTOMER_KEY.cartesia },
    echo: true,
  });
}

type World = {
  readonly ada: Customer;
  readonly key: string;
  readonly connectionId: string;
  readonly versionId: string;
  readonly serviceToken: string;
};

/** A customer with a voice agent, a persona that selected its models, and a test. */
async function aCustomer(
  label: string,
  deployment: ManagedDeployment,
  options: { readonly validateInferenceKey?: (key: string) => Promise<never> } = {},
): Promise<World> {
  api = await createApi(label, {
    managedDeployment: deployment,
    ...options,
  });
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const registered = await ask(api.app, "POST", "/api/agents", key, {
    name: "Front desk",
    connection: RETELL_VOICE,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);

  await createPersona(contextFor(ada, "member"), {
    name: "Impatient Rita",
    traits: NEUTRAL_TRAITS,
    models: RECOMMENDED_PERSONA_MODELS,
  });

  const pushed = await ask(api.app, "POST", "/api/tests", key, {
    ...RESCHEDULING,
    personas: ["Impatient Rita"],
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  return {
    ada,
    key,
    connectionId: (registered.body.connection as { id: string }).id,
    versionId: String(pushed.body.version_id),
    serviceToken: api.config.simulatorServiceToken,
  };
}

/** One work order, off the door the shipped simulator knocks on. */
async function oneWorkOrder(world: World): Promise<Record<string, unknown>> {
  const started = await ask(api.app, "POST", "/api/runs", world.key, {
    connection: world.connectionId,
    test_versions: [world.versionId],
    idempotency_key: newId("run"),
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

  const claimed = await api.app.inject({
    method: "POST",
    url: CLAIMS_PATH,
    headers: { authorization: `Bearer ${world.serviceToken}` },
    payload: {
      claimant: "sim-1",
      capacity: 1,
      wait_seconds: 0,
      contract_versions: [1, 2],
    },
  });
  const specs = (claimed.json() as { specs?: Record<string, unknown>[] }).specs ?? [];
  const [spec] = specs;
  expect(spec, `no work order was claimed: ${claimed.body}`).toBeDefined();
  return spec as Record<string, unknown>;
}

type Models = {
  readonly access: string;
  readonly gateway?: { readonly address: string; readonly credential: string };
  readonly llm: { readonly provider: string; readonly model: string; readonly key?: string };
  readonly stt: { readonly provider: string; readonly model: string; readonly key?: string };
  readonly tts: {
    readonly provider: string;
    readonly model: string;
    readonly key?: string;
    readonly voice_id: string;
    readonly speed: number;
  };
};

/**
 * The three legs, conducted from the work order and from nothing else.
 *
 * This is the simulator's own arithmetic: under managed access each leg is told
 * the gateway's route for its provider and handed the gateway's credential in
 * the slot the shipped adapter puts a provider key in; under customer-owned
 * access it reaches the provider's own address with the organization's key. The
 * request is the same either way, which is the whole claim.
 */
async function conductEveryLeg(
  models: Models,
  direct: { readonly openai: string; readonly deepgram: string; readonly cartesia: string },
): Promise<{ readonly thought: number }> {
  const managed = models.gateway;

  const chat = managed === undefined ? `${direct.openai}/v1` : `${managed.address}/openai/v1`;
  const thinking = managed?.credential ?? models.llm.key;
  const thought = await fetch(`${chat}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${String(thinking)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: models.llm.model, messages: [] }),
  });

  await listenAndSpeak(models, direct, managed);
  return { thought: thought.status };
}

async function listenAndSpeak(
  models: Models,
  direct: { readonly deepgram: string; readonly cartesia: string },
  managed: Models["gateway"],
): Promise<void> {
  const ears =
    managed === undefined
      ? `${direct.deepgram.replace(/^http/, "ws")}/v1/listen?model=${models.stt.model}`
      : `${managed.address.replace(/^http/, "ws")}/deepgram/v1/listen?model=${models.stt.model}`;
  await opened(
    new WebSocket(ears, {
      headers: {
        authorization: `Token ${String(managed?.credential ?? models.stt.key)}`,
      },
    }),
  );

  const credential = String(managed?.credential ?? models.tts.key);
  const mouth =
    managed === undefined
      ? `${direct.cartesia.replace(/^http/, "ws")}/tts/websocket?api_key=${credential}`
      : `${managed.address.replace(/^http/, "ws")}/cartesia/tts/websocket?api_key=${credential}`;
  await opened(new WebSocket(mouth));
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.on("open", () => {
      socket.close(1000, "done");
      resolve();
    });
    socket.on("error", reject);
    socket.on(
      "unexpected-response",
      (_request: unknown, response: { statusCode?: number | undefined }) =>
        reject(new Error(`the socket was refused with ${String(response.statusCode)}`)),
    );
  });
}

const HOSTED = (gatewayAddress: string): ManagedDeployment => ({
  hosted: true,
  gatewayAddress,
  internalGatewayKey: INTERNAL_KEY,
});

const SELF_HOSTED = (gatewayAddress: string | undefined): ManagedDeployment => ({
  hosted: false,
  gatewayAddress,
  internalGatewayKey: undefined,
});

async function storeTheThreeKeys(ada: Customer): Promise<void> {
  const admin = contextFor(ada, "admin");
  for (const [provider, key] of Object.entries(CUSTOMER_KEY)) {
    await storeModelProviderCredential(admin, { provider, key });
  }
}

describe("hosted Egma, managed by Egma", () => {
  it("conducts every leg through the real gateway and carries no provider key", async () => {
    const address = await standUpProviders(undefined);
    const world = await aCustomer("matrix_hosted_managed", HOSTED(address));

    const spec = await oneWorkOrder(world);
    expect(specComplaints(spec)).toEqual([]);
    const models = spec.models as Models;

    expect(models.access).toBe("managed");
    expect(models.gateway?.address).toBe(address);
    expect(models.gateway?.credential.startsWith("egma_ig_")).toBe(true);
    // Nothing to paste, and nothing was pasted: this organization connected no
    // inference key and never will.
    expect(models.llm.key).toBeUndefined();
    expect(models.stt.key).toBeUndefined();
    expect(models.tts.key).toBeUndefined();
    // The selections are the pinned ones, untouched by who pays.
    expect(models.llm.model).toBe(RECOMMENDED_PERSONA_MODELS.llm.model);
    expect(models.stt.model).toBe(RECOMMENDED_PERSONA_MODELS.stt.model);

    const conducted = await conductEveryLeg(models, {
      openai: openai?.origin ?? "",
      deepgram: deepgram?.origin ?? "",
      cartesia: cartesia?.origin ?? "",
    });
    expect(conducted.thought).toBe(200);

    // What the providers saw: Egma's own credentials, put on by the gateway,
    // and never anything the work order carried.
    expect(openai?.seen[0]?.headers["authorization"]).toBe(
      `Bearer ${EGMA_PROVIDER_KEY.openai}`,
    );
    expect(deepgram?.seen[0]?.headers["authorization"]).toBe(
      `Token ${EGMA_PROVIDER_KEY.deepgram}`,
    );
    expect(cartesia?.seen[0]?.query.get("api_key")).toBe(
      EGMA_PROVIDER_KEY.cartesia,
    );
    // The gateway credential stopped at the gateway.
    expect(JSON.stringify(openai?.seen)).not.toContain(
      models.gateway?.credential,
    );
  });

  /**
   * The zero-setup first run, from a project nobody has touched.
   *
   * **Nothing in this case authors a persona or a grader.** It signs up,
   * registers an agent, writes one test naming nobody, and starts a run — so
   * the persona and the grader that execute are the ones project creation
   * seeded. That is the promise the whole effort is for, and it is the only
   * case here that would still pass if every Models form were deleted.
   */
  it("completes a first run on its seeded persona and grader, with nothing configured", async () => {
    const address = await standUpProviders(undefined);
    api = await createApi("matrix_hosted_first_run", {
      managedDeployment: HOSTED(address),
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    // Managed by Egma before anybody opens a settings screen, and no
    // credential stored anywhere.
    const access = await ask(api.app, "GET", "/api/model-access", key);
    expect(access.body["mode"]).toBe("managed");
    expect(access.body["managed_available"]).toBe(true);
    expect(access.body["credentials"]).toEqual([]);

    const registered = await ask(api.app, "POST", "/api/agents", key, {
      name: "Front desk",
      connection: RETELL_VOICE,
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);

    // A test that names no persona, which is what makes the seeded one the
    // one that runs.
    const pushed = await ask(api.app, "POST", "/api/tests", key, RESCHEDULING);
    expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

    const spec = await oneWorkOrder({
      ada,
      key,
      connectionId: (registered.body.connection as { id: string }).id,
      versionId: String(pushed.body.version_id),
      serviceToken: api.config.simulatorServiceToken,
    });
    expect(specComplaints(spec)).toEqual([]);
    const models = spec.models as Models;

    // The seeded persona chose for itself, so the work order carries its
    // selections rather than falling back to deployment settings hosted Egma
    // does not have.
    expect(models.access).toBe("managed");
    expect(models.gateway?.address).toBe(address);
    expect(models.llm.provider).toBe(RECOMMENDED_PERSONA_MODELS.llm.provider);
    expect(models.stt.model).toBe(RECOMMENDED_PERSONA_MODELS.stt.model);
    expect(models.tts.voice_id).toBe(RECOMMENDED_PERSONA_MODELS.tts.voiceId);
    expect(models.llm.key).toBeUndefined();

    // And every leg of it really conducts, through the real gateway, on Egma's
    // own provider accounts.
    expect(
      (
        await conductEveryLeg(models, {
          openai: openai?.origin ?? "",
          deepgram: deepgram?.origin ?? "",
          cartesia: cartesia?.origin ?? "",
        })
      ).thought,
    ).toBe(200);
    expect(openai?.seen[0]?.headers["authorization"]).toBe(
      `Bearer ${EGMA_PROVIDER_KEY.openai}`,
    );

    // The seeded grader has chosen its judge model too, so a verdict needs no
    // setup either — resolved through the engine's own door, which is the seam
    // the grading service reaches it by. The maker is a recorder rather than a
    // real provider: what is being asked here is which account and which
    // address a seeded grader is pointed at, not what a model says.
    const recorder = scriptedJudge({ answers: {} });
    const judged = await judgesOnce({
      userId: "engine",
      organizationId: ada.organizationId,
      projectId: ada.projectId,
      role: "viewer",
      via: "engine",
    }).judgeFor(
      { graderModel: RECOMMENDED_GRADER_MODEL, judgeModel: null },
      recorder.makers,
    );

    expect(judged).not.toBeInstanceOf(NoJudge);
    const asked = recorder.configured.at(-1) as {
      provider: string;
      model: string;
      key: string;
      endpoint: string;
    };
    expect(asked.provider).toBe(RECOMMENDED_GRADER_MODEL.provider);
    expect(asked.model).toBe(RECOMMENDED_GRADER_MODEL.model);
    // Egma's own signed credential and the gateway's route for it — never an
    // organization credential, because none was ever stored.
    expect(asked.key.startsWith("egma_ig_")).toBe(true);
    expect(asked.endpoint).toBe(`${address}/openai/v1`);
  });
});

describe("hosted Egma, customer-owned", () => {
  it("calls the providers directly with the organization's own keys", async () => {
    await standUpDirectProviders();
    const world = await aCustomer(
      "matrix_hosted_customer_owned",
      SELF_HOSTED(undefined),
    );
    await storeTheThreeKeys(world.ada);
    await ask(api.app, "PUT", "/api/model-access", world.key, {
      mode: "customer-owned",
    });

    const spec = await oneWorkOrder(world);
    expect(specComplaints(spec)).toEqual([]);
    const models = spec.models as Models;

    expect(models.access).toBe("customer-owned");
    // No gateway address and no gateway credential: Egma is not on this path.
    expect(models.gateway).toBeUndefined();
    expect(models.llm.key).toBe(CUSTOMER_KEY.openai);

    const conducted = await conductEveryLeg(models, {
      openai: openai?.origin ?? "",
      deepgram: deepgram?.origin ?? "",
      cartesia: cartesia?.origin ?? "",
    });
    expect(conducted.thought).toBe(200);
    expect(openai?.seen[0]?.headers["authorization"]).toBe(
      `Bearer ${CUSTOMER_KEY.openai}`,
    );
  });
});

describe("a self-hosted deployment, managed by Egma", () => {
  it("conducts every leg on the key it pasted, validated at the real hosted door", async () => {
    /**
     * The two deployments, one at a time, exactly as `inference-keys.test.ts`
     * takes them: a process holds one database and one identity. The key is
     * minted on the real hosted API and its real validation route answers the
     * real question; the self-hosted instance then connects on that answer, and
     * the *gateway* asks the same question again on every connection — of a
     * door that answers with the same contract.
     */
    api = await createApi("matrix_self_hosted_cloud", {
      managedDeployment: HOSTED("https://unused.example"),
    });
    const cloudAda = await signUp(api.app, "ada@egma.example", "Egma");
    const secret = (
      await ask(api.app, "POST", INFERENCE_KEYS_PATH, cloudAda.secret, {
        name: "Lakeside self-hosted",
      })
    ).body["key"] as string;
    const cloudOrganizationId = cloudAda.organizationId;
    await api.close();

    // A door speaking the validation contract, holding the key hosted Egma
    // really minted. It is what the gateway asks on every connection.
    const cloud = await startEgmaCloudDoor();
    cloud.issue(secret, cloudOrganizationId, "ifk_01K3XQ7M4E8YB2FVN0H9TZQWER");

    try {
      const address = await standUpProviders(cloud.validationUrl);
      const world = await aCustomer(
        "matrix_self_hosted_managed",
        SELF_HOSTED(address),
      );

      await connectManagedAccess(contextFor(world.ada, "admin"), {
        key: secret,
        cloudOrganizationId,
      });
      const chosen = await ask(api.app, "PUT", "/api/model-access", world.key, {
        mode: "managed",
      });
      expect(chosen.statusCode).toBe(200);

      const spec = await oneWorkOrder(world);
      expect(specComplaints(spec)).toEqual([]);
      const models = spec.models as Models;

      expect(models.access).toBe("managed");
      expect(models.gateway?.address).toBe(address);
      // The pasted key itself, opened only here — never a per-simulation grant
      // and never a provider credential.
      expect(models.gateway?.credential).toBe(secret);
      expect(models.llm.key).toBeUndefined();

      const conducted = await conductEveryLeg(models, {
        openai: openai?.origin ?? "",
        deepgram: deepgram?.origin ?? "",
        cartesia: cartesia?.origin ?? "",
      });
      expect(conducted.thought).toBe(200);
      expect(openai?.seen[0]?.headers["authorization"]).toBe(
        `Bearer ${EGMA_PROVIDER_KEY.openai}`,
      );
      // Asked once per connection, and content-free every time.
      expect(cloud.asks.length).toBeGreaterThan(0);
      for (const asked of cloud.asks) {
        expect(asked.body).toBe("");
        expect(asked.credential).toBe(secret);
      }
    } finally {
      await cloud.stop();
    }
  });
});

describe("a self-hosted deployment, customer-owned", () => {
  it("calls the providers directly and carries no gateway credential", async () => {
    await standUpDirectProviders();
    const world = await aCustomer(
      "matrix_self_hosted_customer_owned",
      SELF_HOSTED(undefined),
    );
    await storeTheThreeKeys(world.ada);

    const spec = await oneWorkOrder(world);
    expect(specComplaints(spec)).toEqual([]);
    const models = spec.models as Models;

    // Self-hosted starts here without anybody choosing, because nothing is
    // connected to Egma's provider accounts and nothing may spend from them.
    expect(models.access).toBe("customer-owned");
    expect(models.gateway).toBeUndefined();

    const conducted = await conductEveryLeg(models, {
      openai: openai?.origin ?? "",
      deepgram: deepgram?.origin ?? "",
      cartesia: cartesia?.origin ?? "",
    });
    expect(conducted.thought).toBe(200);
    expect(deepgram?.seen[0]?.headers["authorization"]).toBe(
      `Token ${CUSTOMER_KEY.deepgram}`,
    );
  });
});

describe("when managed access cannot be prepared or cannot be used", () => {
  it("stops the simulation with a reason and never a verdict, when nothing is connected", async () => {
    const address = await standUpProviders(undefined);
    const world = await aCustomer(
      "matrix_managed_not_connected",
      SELF_HOSTED(address),
    );

    // Connected, chosen, then disconnected: the mode stays, deliberately, so
    // the next claim lands as a visible error naming what to reconnect.
    await connectManagedAccess(contextFor(world.ada, "admin"), {
      key: "egma_ik_sentinel-about-to-be-disconnected-L1M2",
      cloudOrganizationId: newId("org"),
    });
    await ask(api.app, "PUT", "/api/model-access", world.key, { mode: "managed" });
    await ask(api.app, "DELETE", "/api/managed-access", world.key);

    const started = await ask(api.app, "POST", "/api/runs", world.key, {
      connection: world.connectionId,
      test_versions: [world.versionId],
      idempotency_key: newId("run"),
    });
    const simulationId = (started.body.simulations as { id: string }[])[0]?.id;

    const claimed = await api.app.inject({
      method: "POST",
      url: CLAIMS_PATH,
      headers: { authorization: `Bearer ${world.serviceToken}` },
      payload: { claimant: "sim-1", capacity: 1, wait_seconds: 0, contract_versions: [2] },
    });
    // Nothing is handed over: a work order with nowhere for the traffic to go
    // must not reach a simulator that would fall back to a provider.
    expect((claimed.json() as { specs: unknown[] }).specs).toEqual([]);

    const landed = await getSimulation(
      contextFor(world.ada, "member"),
      String(simulationId),
    );
    // An infrastructure error, and the word says so: `dispatch_failed` is the
    // platform's confession, never one of the ways a conversation ends badly
    // and never a verdict about the agent.
    expect(landed?.status).toBe("failed");
    expect(landed?.endingReason).toBe("dispatch_failed");
    expect(landed?.endingDetail).toContain("inference key");
    // And the person reading it is sent somewhere they can actually fix it.
    expect(landed?.endingRepair).toBe("model_providers");
  });

  it("refuses a revoked inference key at the gateway, on the very next connection", async () => {
    const cloud = await startEgmaCloudDoor();
    const key = "egma_ik_sentinel-matrix-revocable-N3P4";
    cloud.issue(key, "org_01K3XQ7M4E8YB2FVN0H9TZQWER", "ifk_01K3XQ7M4E8YB2FVN0H9TZQWER");

    try {
      const address = await standUpProviders(cloud.validationUrl);

      const asked = async (): Promise<number> =>
        (
          await fetch(`${address}/openai/v1/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [INFERENCE_KEY_HEADER]: key,
            },
            body: JSON.stringify({ model: "m", messages: [] }),
          })
        ).status;

      expect(await asked()).toBe(200);
      cloud.revoke(key);
      expect(await asked()).toBe(401);
    } finally {
      await cloud.stop();
    }
  });

  it("says the gateway could not be reached, rather than blaming a key", async () => {
    const cloud = await startEgmaCloudDoor();
    cloud.goDown();

    try {
      const address = await standUpProviders(cloud.validationUrl);

      const answered = await fetch(`${address}/openai/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INFERENCE_KEY_HEADER]: "egma_ik_sentinel-matrix-fine-key-Q5R6",
        },
        body: JSON.stringify({ model: "m", messages: [] }),
      });

      expect(answered.status).toBe(503);
      expect(
        ((await answered.json()) as { error: { code: string } }).error.code,
      ).toBe("gateway_authentication_unavailable");
      // The provider was never asked, so nothing was spent on a connection
      // nobody could authorize.
      expect(openai?.attempts()).toBe(0);
    } finally {
      await cloud.stop();
    }
  });
});
