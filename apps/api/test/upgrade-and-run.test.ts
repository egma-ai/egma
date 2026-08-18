import { newId } from "@egma/ids";
import {
  completeSimulation,
  createPersona,
  getGradingPlan,
  getGrader,
  getPersona,
  listGraders,
  listModelUpgradeActions,
  readModelUpgradeCompletion,
  recordModelUpgradeCompletion,
  seedPlatformSettings,
  startSimulation,
  upgradeModelSetup,
  type PersonaTraits,
} from "@egma/db";
import { specComplaints } from "@egma/simulation-contract";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { judgesOnce, NoJudge } from "../../grader/src/judge/index.ts";
import { scriptedJudge } from "../../grader/test/support/scripted-judge.ts";
import {
  startHttpUpstream,
  startSocketUpstream,
  type HttpUpstream,
  type SocketUpstream,
} from "../../gateway/test/support/upstreams.ts";
import { CLAIMS_PATH } from "../src/routes/claims.ts";
import {
  MODEL_CREDENTIAL_CANDIDATE_PATH,
  MODEL_UPGRADE_PATH,
} from "../src/routes/model-access.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  projectKeyFor,
  request as ask,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * An installation that existed before model selections did, upgraded and then
 * put to work — the release candidate's own migration path, end to end.
 *
 * **The two halves have to be true at the same time, and that is the whole
 * case.** A persona the upgrade could answer for runs its *next* simulation
 * from its own explicit selections, on the key the upgrade found and an
 * administrator confirmed. A persona it could not answer for runs its next
 * simulation exactly as it always did, from the deployment's own settings, on
 * the old work-order contract — because the compatibility period is what makes
 * an upgrade something other than an outage.
 *
 * **Then the mixed-version rule, which is the same fact seen from the worker.**
 * A simulator built before selections existed declares version 1 and is offered
 * only the work it can conduct. It is never handed a document it cannot read.
 *
 * **And then the marker.** It stays unwritten while one persona is still on the
 * old path, and it stays unwritten after that persona is given selections while
 * a simulation pinned to its *old* version is still queued — because that work
 * order is on the old contract and removing the legacy path would strand it.
 *
 * Every key is a sentinel, so every answer can be scanned for all of them.
 */

let api: TestApi;
let openai: HttpUpstream | undefined;
let deepgram: SocketUpstream | undefined;
let cartesia: SocketUpstream | undefined;

afterEach(async () => {
  await api?.close();
  await Promise.all([openai?.stop(), deepgram?.stop(), cartesia?.stop()]);
  openai = undefined;
  deepgram = undefined;
  cartesia = undefined;
});

/** The keys the previous release kept, one in each of its three places. */
const LEGACY = {
  thinking: "sk-sentinel-upgraded-run-model-key-A1B2",
  listening: "dg-sentinel-upgraded-run-listening-C3D4",
  speaking: "ct-sentinel-upgraded-run-speaking-E5F6",
} as const;

/** What the deployment was configured with before the catalog existed. */
const CONFIGURED_BEFORE_THE_CATALOG = {
  persona_model_provider: "openai",
  persona_model: "gpt-4o-mini",
  persona_model_key: LEGACY.thinking,
  persona_model_reasoning_effort: "high",
  speech_to_text_provider: "deepgram",
  speech_to_text_model: "nova-2-phonecall",
  speech_to_text_key: LEGACY.listening,
  text_to_speech_provider: "cartesia",
  text_to_speech_model: "sonic-2",
  text_to_speech_voice: "a-deployment-wide-voice",
  text_to_speech_key: LEGACY.speaking,
  voice_activity_provider: "silero",
  media_backend: "livekit",
} as const;

/** Speaks with the provider the deployment speaks with, so she has a successor. */
const RITA: PersonaTraits = {
  personality: "Books three cleans a month and knows the schedule better than the agent.",
  language: "en-US",
  voice: { provider: "cartesia", voiceId: "ritas-own-voice", speed: 1.15 },
};

const LIVEKIT_VOICE = {
  type: "livekit",
  modality: "voice",
  config: { url: "wss://acme.livekit.cloud" },
  credentials: {
    apiKey: "APIsentinelupgraded0WXYZ",
    apiSecret: "SENTINEL-livekit-upgraded-run-J9K0",
  },
} as const;

type Models = {
  readonly access: string;
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

type World = {
  readonly ada: Customer;
  readonly key: string;
  readonly connectionId: string;
  readonly ritaTestVersion: string;
  readonly starterTestVersion: string;
  readonly ritaId: string;
  readonly starterId: string;
  readonly serviceToken: string;
};

/** Provider servers with nothing in front of them: customer-owned access. */
async function standUpProviders(): Promise<void> {
  openai = await startHttpUpstream({
    path: "/v1/chat/completions",
    expectAuthorization: `Bearer ${LEGACY.thinking}`,
    chunks: ['{"choices":[{"message":{"content":"hello"}}]}'],
  });
  deepgram = await startSocketUpstream({
    path: "/v1/listen",
    expect: {
      at: "header",
      name: "authorization",
      value: `Token ${LEGACY.listening}`,
    },
    echo: true,
  });
  cartesia = await startSocketUpstream({
    path: "/tts/websocket",
    expect: { at: "query", name: "api_key", value: LEGACY.speaking },
    echo: true,
  });
}

/**
 * An installation as the previous release left it, taken through the upgrade
 * and through the one choice the upgrade would not make.
 *
 * The two OpenAI keys are real: the deployment's own model key and the
 * deployment's own judge key on the project's platform judge. Egma cannot tell
 * whether they are one account without reading them, so it activates neither
 * and asks — and this walks the asking and the answering through the product's
 * own doors, because that is the loop a real administrator walks.
 */
async function anUpgradedInstallation(label: string): Promise<World> {
  api = await createApi(label, { singleOrganization: true });
  await seedPlatformSettings(CONFIGURED_BEFORE_THE_CATALOG);

  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const registered = await ask(api.app, "POST", "/api/agents", key, {
    name: "Front desk",
    connection: LIVEKIT_VOICE,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);

  // A persona written the way the previous release wrote one: traits, and
  // nothing else, because there was nothing else to say.
  const rita = await createPersona(contextFor(ada, "member"), {
    name: "Rita",
    traits: RITA,
  });
  const listed = (await ask(api.app, "GET", "/api/personas", key)).body
    .items as { id: string; name: string }[];
  const seeded = listed.find((one) => one.name !== "Rita");

  const ritaTest = await ask(api.app, "POST", "/api/tests", key, {
    name: "Reschedules a booked appointment",
    scenario: "Their cleaning is booked for Thursday and has to move.",
    expected_behaviors: ["confirms the new time back before finishing"],
    personas: ["Rita"],
  });
  expect(ritaTest.statusCode, JSON.stringify(ritaTest.body)).toBe(201);
  const starterTest = await ask(api.app, "POST", "/api/tests", key, {
    name: "Asks about the plan",
    scenario: "Wants to know what the current plan covers.",
    expected_behaviors: ["says what the plan covers"],
    personas: [String(seeded?.name)],
  });
  expect(starterTest.statusCode, JSON.stringify(starterTest.body)).toBe(201);

  await upgradeModelSetup({ singleOrganization: true });

  // The one choice the upgrade would not make, made through the product.
  const outstanding = await ask(api.app, "GET", MODEL_UPGRADE_PATH, ada.secret);
  const deploymentsOwn = (
    outstanding.body.candidates as {
      id: string;
      provider: string;
      source_name: string;
    }[]
  ).find((one) => one.source_name === "persona_model_key");
  const chosen = await ask(
    api.app,
    "PUT",
    MODEL_CREDENTIAL_CANDIDATE_PATH.replace(":id", String(deploymentsOwn?.id)),
    ada.secret,
  );
  expect(chosen.statusCode, JSON.stringify(chosen.body)).toBe(200);

  return {
    ada,
    key,
    connectionId: (registered.body.connection as { id: string }).id,
    ritaTestVersion: String(ritaTest.body.version_id),
    starterTestVersion: String(starterTest.body.version_id),
    ritaId: rita.id,
    starterId: String(seeded?.id),
    serviceToken: api.config.simulatorServiceToken,
  };
}

/** One run's work orders, off the door the shipped simulator knocks on. */
async function claim(
  world: World,
  testVersion: string,
  versions: readonly number[] = [1, 2],
): Promise<{ runId: string; specs: Record<string, unknown>[] }> {
  const started = await ask(api.app, "POST", "/api/runs", world.key, {
    connection: world.connectionId,
    test_versions: [testVersion],
    idempotency_key: newId("run"),
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

  const claimed = await api.app.inject({
    method: "POST",
    url: CLAIMS_PATH,
    headers: { authorization: `Bearer ${world.serviceToken}` },
    payload: {
      claimant: "sim-1",
      capacity: 5,
      wait_seconds: 0,
      contract_versions: versions,
    },
  });
  return {
    runId: String(started.body.id),
    specs: (claimed.json() as { specs?: Record<string, unknown>[] }).specs ?? [],
  };
}

/** The three legs, conducted from the work order and from nothing else. */
async function conductEveryLeg(models: Models): Promise<number> {
  const thought = await fetch(`${openai?.origin ?? ""}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${String(models.llm.key)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: models.llm.model, messages: [] }),
  });

  await opened(
    new WebSocket(
      `${(deepgram?.origin ?? "").replace(/^http/u, "ws")}/v1/listen?model=${models.stt.model}`,
      { headers: { authorization: `Token ${String(models.stt.key)}` } },
    ),
  );
  await opened(
    new WebSocket(
      `${(cartesia?.origin ?? "").replace(/^http/u, "ws")}/tts/websocket?api_key=${String(models.tts.key)}`,
    ),
  );
  return thought.status;
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

describe("a persona the upgrade could answer for", () => {
  it("conducts its next simulation from its own selections, on the key the upgrade found", async () => {
    await standUpProviders();
    const world = await anUpgradedInstallation("upgraded_run_migrated");

    const migrated = await getPersona(contextFor(world.ada, "member"), world.ritaId);
    expect(migrated?.version).toBe(2);

    const { specs } = await claim(world, world.ritaTestVersion);
    const [spec] = specs;
    expect(spec, "no work order was claimed").toBeDefined();
    expect(specComplaints(spec ?? {})).toEqual([]);

    // Version 2, because this persona has explicit selections now.
    expect(spec?.contract_version).toBe(2);
    const models = spec?.models as Models;
    expect(models.access).toBe("customer-owned");
    expect(models.llm).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      key: LEGACY.thinking,
    });
    expect(models.stt).toMatchObject({
      provider: "deepgram",
      model: "nova-2-phonecall",
      key: LEGACY.listening,
    });
    // Her own voice and her own pace, not the deployment-wide ones.
    expect(models.tts).toMatchObject({
      provider: "cartesia",
      model: "sonic-2",
      voice_id: "ritas-own-voice",
      speed: 1.15,
      key: LEGACY.speaking,
    });
    // The retired setting reaches nothing, and neither does any other legacy
    // model or speech setting: a persona that chose for itself is sent the
    // carrier settings and none of the deployment's provider keys.
    expect(JSON.stringify(spec)).not.toContain("reasoning");
    const platform = spec?.platform as Record<string, unknown> | undefined;
    expect(platform?.model).toBeUndefined();
    expect(platform?.speech).toBeUndefined();
    expect(platform?.carrier).toBeDefined();

    // And it really conducts, on the keys the upgrade found and an
    // administrator confirmed.
    expect(await conductEveryLeg(models)).toBe(200);
    expect(openai?.seen[0]?.headers["authorization"]).toBe(
      `Bearer ${LEGACY.thinking}`,
    );
    expect(deepgram?.seen[0]?.query.get("model")).toBe("nova-2-phonecall");
  });

  it("judges its next verdict from its grader's own selection", async () => {
    await standUpProviders();
    const world = await anUpgradedInstallation("upgraded_run_grader");
    const admin = contextFor(world.ada, "admin");

    const seeded = (await listGraders(admin)).items.find(
      (one) => one.name === "expected_behaviors",
    );
    const upgraded = await getGrader(admin, String(seeded?.id));

    // The project's judge configuration, said out loud on the grader's own
    // version — so nothing consults the project any more.
    expect(upgraded?.version).toBe(2);
    expect(upgraded?.graderModel).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });

    const recorder = scriptedJudge({ answers: {} });
    const judged = await judgesOnce({
      userId: "engine",
      organizationId: world.ada.organizationId,
      projectId: world.ada.projectId,
      role: "viewer",
      via: "engine",
    }).judgeFor(
      { graderModel: upgraded?.graderModel ?? null, judgeModel: null },
      recorder.makers,
    );

    if (judged instanceof NoJudge) throw new Error(String(judged.message ?? judged));
    expect(judged).not.toBeInstanceOf(NoJudge);
    const asked = recorder.configured.at(-1) as {
      provider: string;
      model: string;
      key: string;
      endpoint?: string;
    };
    expect(asked.model).toBe("gpt-4o-mini");
    // The organization's own credential — the one the administrator chose from
    // the keys the upgrade found — and no gateway, because this organization
    // pays for its own model traffic.
    expect(asked.key).toBe(LEGACY.thinking);
    expect(asked.endpoint).toBeUndefined();
  });
});

describe("a persona the upgrade would not guess for", () => {
  it("conducts its next simulation exactly as it always did", async () => {
    await standUpProviders();
    const world = await anUpgradedInstallation("upgraded_run_compatible");

    const untouched = await getPersona(
      contextFor(world.ada, "member"),
      world.starterId,
    );
    expect(untouched?.version).toBe(1);
    expect(untouched?.models).toBeNull();

    const { specs } = await claim(world, world.starterTestVersion);
    const [spec] = specs;
    expect(spec, "no work order was claimed").toBeDefined();
    expect(specComplaints(spec ?? {})).toEqual([]);

    // The document it was always handed: version 1, no models block at all, and
    // the deployment's own settings deciding — which is what the compatibility
    // period is.
    expect(spec?.contract_version).toBe(1);
    expect(spec?.models).toBeUndefined();
    const platform = spec?.platform as {
      model: Record<string, string>;
      speech: Record<string, string>;
    };
    expect(platform.model.provider).toBe("openai");
    expect(platform.model.key).toBe(LEGACY.thinking);
    expect(platform.speech.tts_provider).toBe("cartesia");
    // And the deployment's own voice, because this persona's voice provider is
    // one the legacy speech path still carries and the selections never do.
    expect(platform.speech.tts_voice).toBe("a-deployment-wide-voice");
  });

  it("is named in an action that says what to choose, and where", async () => {
    api = await createApi("upgraded_run_action", { singleOrganization: true });
    await seedPlatformSettings(CONFIGURED_BEFORE_THE_CATALOG);
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    await upgradeModelSetup({ singleOrganization: true });

    const actions = await listModelUpgradeActions(contextFor(ada, "admin"));
    const hers = actions.find((one) => one.kind === "select_persona_models");

    expect(hers?.detail).toContain("elevenlabs");
    expect(hers?.detail).toContain("Persona models");
    // Never a substitute: the speaking providers this release does carry are
    // not offered in place of the one it does not.
    expect(hers?.detail).not.toContain("cartesia this release");
  });
});

describe("a simulator built before selections existed", () => {
  it("is offered the work it can conduct, and never a document it cannot read", async () => {
    await standUpProviders();
    const world = await anUpgradedInstallation("upgraded_run_mixed");

    // A worker declaring version 1 alone, which is what every simulator built
    // before the second version means by saying nothing.
    const migrated = await claim(world, world.ritaTestVersion, [1]);
    const legacy = await claim(world, world.starterTestVersion, [1]);

    // The migrated persona's work order is version 2 and this worker cannot
    // read one, so it is left where it is rather than handed over and failed.
    expect(migrated.specs).toEqual([]);
    // And the compatibility persona's is the document it always was.
    expect(legacy.specs).toHaveLength(1);
    expect(legacy.specs[0]?.contract_version).toBe(1);

    // The worker beside it that can read both takes the one that was left.
    const both = await api.app.inject({
      method: "POST",
      url: CLAIMS_PATH,
      headers: { authorization: `Bearer ${world.serviceToken}` },
      payload: {
        claimant: "sim-2",
        capacity: 5,
        wait_seconds: 0,
        contract_versions: [1, 2],
      },
    });
    const waiting = (both.json() as { specs: Record<string, unknown>[] }).specs;
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.contract_version).toBe(2);
  });
});

/**
 * The condition that is easiest to get wrong, and was.
 *
 * A run frozen before the upgrade pins grader versions with no selection of
 * their own, and its plan records the judge those graders will ask. On a
 * deployment judged by its **own** judge that plan names no credential at all —
 * the sentinel word goes in place of an id — so a marker that only read the
 * credential index would declare this installation finished with grading jobs
 * still queued behind exactly the configuration the next release removes.
 */
describe("grading work frozen before the upgrade", () => {
  it("holds the marker back even though its plan names no credential", async () => {
    await standUpProviders();
    api = await createApi("upgraded_run_platform_judge", {
      singleOrganization: true,
    });
    await seedPlatformSettings(CONFIGURED_BEFORE_THE_CATALOG);
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const registered = await ask(api.app, "POST", "/api/agents", key, {
      name: "Front desk",
      connection: LIVEKIT_VOICE,
    });
    await createPersona(contextFor(ada, "member"), { name: "Rita", traits: RITA });
    const pushed = await ask(api.app, "POST", "/api/tests", key, {
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning is booked for Thursday and has to move.",
      expected_behaviors: ["confirms the new time back before finishing"],
      personas: ["Rita"],
    });

    // Started and conducted *before* the upgrade, so the plan it froze pins
    // grader versions that carry no selection.
    const started = await ask(api.app, "POST", "/api/runs", key, {
      connection: (registered.body.connection as { id: string }).id,
      test_versions: [String(pushed.body.version_id)],
      idempotency_key: newId("run"),
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    const claimed = await api.app.inject({
      method: "POST",
      url: CLAIMS_PATH,
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
      payload: { claimant: "sim-1", capacity: 1, wait_seconds: 0 },
    });
    const [spec] = (claimed.json() as { specs: Record<string, unknown>[] }).specs;
    const simulationId = String(spec?.simulation_id);
    const admin = contextFor(ada, "admin");
    await startSimulation(admin, simulationId, "sim-1");
    await completeSimulation(admin, simulationId, "sim-1", {
      endingReason: "persona_concluded",
      turnCount: 4,
    });

    // The plan really does name no credential, which is the trap.
    const plan = await getGradingPlan(admin, String(started.body.id));
    expect(plan?.state).toBe("run_start");
    const { rows } = await api.database.sql<{ ids: unknown; status: string }>(
      `select p.judge_credential_ids as ids, j.status
         from grading_plan p
         join simulation s on s.run_id = p.run_id
         join grading_job j on j.simulation_id = s.id
        where p.run_id = $1`,
      [String(started.body.id)],
    );
    expect(rows[0]?.ids).toEqual([]);
    expect(rows[0]?.status).toBe("pending");

    await upgradeModelSetup({ singleOrganization: true });

    const standing = await readModelUpgradeCompletion();
    expect(standing.completed).toBe(false);
    // Two conditions standing, and `grading` is the one this case is about:
    // the job frozen against the old judge configuration, on a plan that names
    // no credential at all. (`personas` is the seeded starter persona, whose
    // own voice this release's catalog does not carry — see the case above.)
    expect(standing.outstanding).toEqual(["personas", "grading"]);
    expect((await recordModelUpgradeCompletion()).completed).toBe(false);
  });
});

describe("the completion marker", () => {
  it("stays unwritten while one persona is still on the old path", async () => {
    await standUpProviders();
    const world = await anUpgradedInstallation("upgraded_run_marker_personas");

    const standing = await readModelUpgradeCompletion();

    expect(standing.completed).toBe(false);
    expect(standing.outstanding).toContain("personas");
    expect(String(world.starterId)).toMatch(/^prs_/u);
  });

  /**
   * The drain the marker really guards, and the reason it is not enough to ask
   * whether every *persona* has selections: a simulation pinned to an old
   * version is a work order on the old contract, and removing that contract
   * while it is queued would strand it.
   */
  it("stays unwritten while a simulation on the old contract is still queued", async () => {
    await standUpProviders();
    const world = await anUpgradedInstallation("upgraded_run_marker_drain");

    const started = await ask(api.app, "POST", "/api/runs", world.key, {
      connection: world.connectionId,
      test_versions: [world.starterTestVersion],
      idempotency_key: newId("run"),
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

    // The persona is given selections, which settles the `personas` condition
    // and settles nothing about the work already queued behind it.
    const standing = await ask(
      api.app,
      "GET",
      `/api/personas/${world.starterId}`,
      world.key,
    );
    const chose = await ask(api.app, "PATCH", `/api/personas/${world.starterId}`, world.key, {
      expected_revision: standing.body.revision,
      expected_version_id: standing.body.version_id,
      models: {
        llm: { provider: "openai", model: "gpt-4o-mini" },
        stt: { provider: "deepgram", model: "nova-3-general" },
        tts: {
          provider: "cartesia",
          model: "sonic-3.5",
          voice_id: "a-voice-somebody-chose",
          speed: 1,
        },
      },
    });
    expect(chose.statusCode, JSON.stringify(chose.body)).toBe(200);

    const midDrain = await readModelUpgradeCompletion();
    expect(midDrain.outstanding).toEqual(["simulations"]);
    expect((await recordModelUpgradeCompletion()).completed).toBe(false);

    // Drained: the queued work lands terminal, and nothing on this installation
    // needs the legacy paths any more.
    const canceled = await ask(
      api.app,
      "POST",
      `/api/runs/${started.body.id as string}/cancel`,
      world.key,
    );
    expect(canceled.statusCode, JSON.stringify(canceled.body)).toBe(200);

    const finished = await recordModelUpgradeCompletion();
    expect(finished.outstanding).toEqual([]);
    expect(finished.completed).toBe(true);
    expect(finished.completedAt).toBeInstanceOf(Date);

    // And the answer a person or an operator reads is the same one.
    const answer = await ask(api.app, "GET", MODEL_UPGRADE_PATH, world.ada.secret);
    expect(answer.body.completed).toBe(true);
    expect(answer.body.outstanding).toEqual([]);
  });
});
