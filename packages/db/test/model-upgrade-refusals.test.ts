import { newId } from "@egma/ids";
import {
  activateCredentialCandidate,
  createJudgeCredential,
  createPersona,
  getGrader,
  getPersona,
  holdManagedDeployment,
  listCredentialCandidates,
  listGraders,
  listModelUpgradeActions,
  PREDEFINED_GRADERS,
  readModelAccess,
  readModelUpgradeCompletion,
  resolveModelProviderKeys,
  storeModelProviderCredential,
  seedDefaultJudge,
  seedPlatformSettings,
  seedRunningGraders,
  setJudgeConfiguration,
  setProjectJudge,
  upgradeModelSetup,
  useLibraryEntry,
  writePlatformSettings,
  type AuthContext,
  type PersonaTraits,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Everything the upgrade refuses to decide, and what it writes instead.
 *
 * **These are the cases that matter most.** The happy path is one release's
 * settings becoming one persona's selections; these are the deployments where
 * that arithmetic has no single right answer — a provider this release does not
 * carry, a setting nobody ever filled in, a grader with no judge behind it at
 * all, and a deployment serving several teams whose one set of settings belongs
 * to none of them. In every one of them the same two things must be true:
 * nothing was guessed, and somebody was told.
 *
 * The rows are written through the doors the previous release shipped —
 * personas with no selections, graders judged by their project — against the
 * current schema. That the previous release's *schema* upgrades cleanly is
 * `model-upgrade.test.ts`'s subject and is not restated here.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");

function acting(
  tenant: { organization: string; project: string },
  role: "admin" | "member" = "admin",
): AuthContext {
  return {
    userId: ada,
    organizationId: tenant.organization,
    projectId: tenant.project,
    role,
    via: "session",
  };
}

const ONE_TEAM = { singleOrganization: true };

/** The one context a stored provider key may be opened for. */
function theSimulatorIn(tenant: {
  organization: string;
  project: string;
}): AuthContext {
  return {
    userId: "simulator",
    organizationId: tenant.organization,
    projectId: tenant.project,
    role: "viewer",
    via: "simulator",
  };
}
const SEVERAL_TEAMS = { singleOrganization: false };

const SELF_HOSTED = {
  hosted: false,
  gatewayAddress: undefined,
  internalGatewayKey: undefined,
} as const;

const HOSTED = {
  hosted: true,
  gatewayAddress: "https://gateway.egma.example",
  internalGatewayKey: "sentinel-internal-gateway-signing-key",
} as const;

const A_PERSONA = (provider: string): PersonaTraits => ({
  personality: "Rings about a delivery that has not arrived and wants a date.",
  language: "en",
  voice: { provider, voiceId: "a-voice", speed: 1 } as PersonaTraits["voice"],
});

beforeAll(async () => {
  database = await createConnectedDatabase("model_upgrade_refusals");
  holdManagedDeployment(SELF_HOSTED);
  await seedUser(database, ada, "ada@acme.example");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "main" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "main" },
  ]);
  await seedRunningGraders();
});

afterAll(async () => {
  holdManagedDeployment(SELF_HOSTED);
  await database?.drop();
});

describe("a deployment serving several teams", () => {
  it("copies no deployment-wide key or selection into any of them", async () => {
    await seedPlatformSettings({
      persona_model_provider: "openai",
      persona_model: "gpt-4o-mini",
      persona_model_key: "sk-sentinel-several-teams-model-key-A1B2",
      speech_to_text_provider: "deepgram",
      speech_to_text_model: "nova-3-general",
      speech_to_text_key: "dg-sentinel-several-teams-listening-C3D4",
      text_to_speech_provider: "cartesia",
      text_to_speech_model: "sonic-3.5",
      text_to_speech_key: "ct-sentinel-several-teams-speaking-E5F6",
    });
    await createPersona(acting(acme), { name: "Rita", traits: A_PERSONA("cartesia") });
    await createPersona(acting(globex), { name: "Gene", traits: A_PERSONA("cartesia") });

    const report = await upgradeModelSetup(SEVERAL_TEAMS);

    expect(report.personas).toEqual([]);
    expect(report.graders).toEqual([]);
    expect(report.candidates).toEqual([]);
    expect(report.activated).toEqual([]);
    const { rows } = await database.sql(
      "select count(*) as count from model_provider_credential",
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("tells every organization that has work still on the old path", async () => {
    const acmes = await listModelUpgradeActions(acting(acme));
    const globexes = await listModelUpgradeActions(acting(globex));

    for (const actions of [acmes, globexes]) {
      const [only] = actions;
      expect(actions).toHaveLength(1);
      expect(only?.kind).toBe("set_up_model_access");
      expect(only?.detail).toContain("several organizations");
      expect(only?.detail).toContain("Managed by Egma");
    }
    // And each sees only its own, which is the tenancy rule this read is held
    // to like every other.
    expect(acmes[0]?.subject).toBe(acme.organization);
    expect(globexes[0]?.subject).toBe(globex.organization);
  });

  /**
   * The flag alone is not the gate, and this is why it is not: a deployment
   * left on the single-organization flag that has grown a second organization
   * must not copy one team's provider key into the other team's rows.
   */
  it("still copies nothing when the flag says one team and the database says two", async () => {
    const report = await upgradeModelSetup(ONE_TEAM);

    expect(report.candidates).toEqual([]);
    expect(report.personas).toEqual([]);
    const { rows } = await database.sql(
      "select count(*) as count from model_provider_credential",
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("leaves the marker standing, because nothing has selections yet", async () => {
    const standing = await readModelUpgradeCompletion();

    expect(standing.completed).toBe(false);
    expect(standing.outstanding).toEqual(["personas", "graders"]);
  });
});

describe("hosted Egma, whose organizations existed before it operated a gateway", () => {
  it("gives every one of them the access this deployment operates", async () => {
    holdManagedDeployment(HOSTED);
    expect((await readModelAccess(acting(acme))).mode).toBe("customer-owned");

    const report = await upgradeModelSetup(SEVERAL_TEAMS);

    expect([...report.managedAccess].sort()).toEqual(
      [acme.organization, globex.organization].sort(),
    );
    expect((await readModelAccess(acting(acme))).mode).toBe("managed");
    expect((await readModelAccess(acting(globex))).mode).toBe("managed");
  });

  it("copies no key and no selection while it does it", async () => {
    const { rows } = await database.sql(
      "select count(*) as count from model_provider_credential",
    );

    expect(Number(rows[0]?.count)).toBe(0);
    expect((await getPersona(acting(acme), (await firstPersona(acme)).id))?.models).toBeNull();
  });

  it("leaves an organization that has already chosen exactly as it chose", async () => {
    await database.sql(
      "update model_access set mode = 'customer-owned' where organization_id = $1",
      [globex.organization],
    );

    const report = await upgradeModelSetup(SEVERAL_TEAMS);

    expect(report.managedAccess).toEqual([]);
    expect((await readModelAccess(acting(globex))).mode).toBe("customer-owned");
  });
});

describe("a deployment whose settings do not answer the whole question", () => {
  let sole: MigratedDatabase;
  const solo = { organization: newId("org"), project: newId("prj") };

  beforeAll(async () => {
    // A database of its own, because "one organization" is a fact about the
    // whole deployment and the two above are in the same one.
    holdManagedDeployment(SELF_HOSTED);
    await database.drop();
    sole = await createConnectedDatabase("model_upgrade_incomplete");
    database = sole;
    await seedUser(sole, ada, "ada@acme.example");
    await seedOrganization(sole, solo.organization, [
      { id: solo.project, slug: "main" },
    ]);
    await seedRunningGraders();
  });

  it("refuses to invent the model nobody ever named", async () => {
    await seedPlatformSettings({
      persona_model_provider: "openai",
      persona_model: "gpt-4o-mini",
      persona_model_key: "sk-sentinel-incomplete-model-key-J9K0",
      speech_to_text_provider: "deepgram",
      // Optional in the previous release, and absent on plenty of real
      // deployments: the simulator had a default. A selection may not.
      speech_to_text_key: "dg-sentinel-incomplete-listening-L1M2",
      text_to_speech_provider: "cartesia",
      text_to_speech_model: "sonic-3.5",
      text_to_speech_key: "ct-sentinel-incomplete-speaking-N3P4",
    });
    const rita = await createPersona(acting(solo), {
      name: "Rita",
      traits: A_PERSONA("cartesia"),
    });

    const report = await upgradeModelSetup(ONE_TEAM);

    expect(report.personas).toEqual([]);
    expect((await getPersona(acting(solo), rita.id))?.models).toBeNull();
    const [action] = (await listModelUpgradeActions(acting(solo))).filter(
      (one) => one.subject === rita.id,
    );
    expect(action?.kind).toBe("select_persona_models");
    expect(action?.detail).toContain("a speech-to-text model");
    expect(action?.detail).toContain("Persona models");
  });

  it("still activates the keys it found, because a key is not a selection", async () => {
    const candidates = await listCredentialCandidates(acting(solo));

    expect(candidates.filter((one) => one.active).map((one) => one.provider)).toEqual(
      ["cartesia", "deepgram", "openai"],
    );
  });
});

describe("a deployment speaking through a provider this release does not carry", () => {
  const solo = { organization: newId("org"), project: newId("prj") };

  beforeAll(async () => {
    holdManagedDeployment(SELF_HOSTED);
    await database.drop();
    database = await createConnectedDatabase("model_upgrade_descoped");
    await seedUser(database, ada, "ada@acme.example");
    await seedOrganization(database, solo.organization, [
      { id: solo.project, slug: "main" },
    ]);
    await seedRunningGraders();
    await seedPlatformSettings({
      persona_model_provider: "openai",
      persona_model: "gpt-4o-mini",
      persona_model_key: "sk-sentinel-descoped-model-key-Q5R6",
      speech_to_text_provider: "deepgram",
      speech_to_text_model: "nova-3-general",
      speech_to_text_key: "dg-sentinel-descoped-listening-S7T8",
      // Left this effort's catalog by founder decision. Deferred, not
      // cancelled — and until it returns, nothing may be selected in its place.
      text_to_speech_provider: "elevenlabs",
      text_to_speech_model: "eleven_turbo_v2_5",
      text_to_speech_key: "el-sentinel-descoped-speaking-U9V0",
    });
  });

  it("chooses no substitute for it, and says why in the action", async () => {
    const nora = await createPersona(acting(solo), {
      name: "Nora",
      traits: A_PERSONA("elevenlabs"),
    });

    const report = await upgradeModelSetup(ONE_TEAM);

    expect(report.personas).toEqual([]);
    expect((await getPersona(acting(solo), nora.id))?.models).toBeNull();
    const [action] = (await listModelUpgradeActions(acting(solo))).filter(
      (one) => one.subject === nora.id,
    );
    // Named, so an organization with two blocked personas can tell them apart.
    expect(action?.subjectName).toBe("Nora");
    expect(action?.detail).toContain("elevenlabs");
    expect(action?.detail).toContain("not a provider in this release's model catalog");
    // Never a substitute. The other speaking providers this release does carry
    // are not mentioned, because suggesting one would be the guess.
    expect(action?.detail).not.toContain("cartesia");
  });

  /**
   * The key is kept, and — the half that was missing — it is *said out loud*.
   *
   * A stored key nothing can spend and nothing mentions is a deployment
   * speaking through a provider the product no longer offers, with the only
   * sign being the persona actions naming it. So the provider gets an action of
   * its own, and the screen shows the key as kept and unusable.
   */
  it("keeps its key, says so in an action, and refuses to spend it", async () => {
    const candidates = await listCredentialCandidates(acting(solo));
    const theirs = candidates.find((one) => one.provider === "elevenlabs");

    expect(theirs?.source).toBe("platform_setting");
    expect(theirs?.sourceName).toBe("text_to_speech_key");
    expect(theirs?.selectable).toBe(false);
    expect(theirs?.active).toBe(false);

    const [named] = (await listModelUpgradeActions(acting(solo))).filter(
      (one) => one.subject === "elevenlabs",
    );
    expect(named?.kind).toBe("select_model_provider_credential");
    expect(named?.subjectName).toBe("elevenlabs");
    expect(named?.detail).toContain("not a provider in this release's model catalog");
    await expect(
      activateCredentialCandidate(acting(solo), String(theirs?.id)),
    ).rejects.toThrow(/not a provider in this release's model catalog/);
    const { rows } = await database.sql<{ provider: string }>(
      "select provider from model_provider_credential order by provider",
    );
    expect(rows.map((row) => row.provider)).toEqual(["deepgram", "openai"]);
  });
});

describe("a grader with no judge behind it at all", () => {
  const solo = { organization: newId("org"), project: newId("prj") };

  beforeAll(async () => {
    holdManagedDeployment(SELF_HOSTED);
    await database.drop();
    database = await createConnectedDatabase("model_upgrade_no_judge");
    await seedUser(database, ada, "ada@acme.example");
    await seedOrganization(database, solo.organization, [
      { id: solo.project, slug: "main" },
    ]);
    await seedRunningGraders();
  });

  it("is left judged by nothing rather than judged by something invented", async () => {
    const [seeded] = (await listGraders(acting(solo))).items;
    if (seeded === undefined) throw new Error("the seeded grader is missing");

    const report = await upgradeModelSetup(ONE_TEAM);

    expect(report.graders).toEqual([]);
    expect((await getGrader(acting(solo), seeded.id))?.graderModel).toBeNull();
    const [action] = (await listModelUpgradeActions(acting(solo))).filter(
      (one) => one.subject === seeded.id,
    );
    expect(action?.kind).toBe("select_grader_model");
    expect(action?.detail).toContain("no judge configured");
    expect(action?.detail).toContain("Grader model");
  });

  /**
   * A code grader asks no model. It is not on a legacy path — it was never on a
   * model path — so it gains no selection and holds nothing up.
   */
  it("leaves a code grader alone, because it judges with nothing", async () => {
    const latency = await useLibraryEntry(acting(solo), {
      libraryId: PREDEFINED_GRADERS.latency,
      params: { metric: "turn_response_latency", bound: 2000 },
    });

    const report = await upgradeModelSetup(ONE_TEAM);
    const actions = await listModelUpgradeActions(acting(solo));

    expect(report.graders).not.toContain(latency.id);
    expect(actions.map((one) => one.subject)).not.toContain(latency.id);
    const { rows } = await database.sql<{ grader_model: unknown }>(
      `select gv.grader_model from grader g
         join grader_version gv on gv.id = g.current_version_id
        where g.id = $1`,
      [latency.id],
    );
    expect(rows[0]?.grader_model).toBeNull();
  });

  it("gains its explicit successor the moment the project has a judge", async () => {
    await setJudgeConfiguration(acting(solo), {
      provider: "openai",
      model: "gpt-4o",
      key: "sk-sentinel-late-judge-key-W1X2",
    });
    const seeded = (await listGraders(acting(solo))).items.find(
      (one) => one.libraryId === PREDEFINED_GRADERS.expectedBehaviors,
    );

    const report = await upgradeModelSetup(ONE_TEAM);

    expect(report.graders).toContain(String(seeded?.id));
    expect((await getGrader(acting(solo), String(seeded?.id)))?.graderModel).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
    expect(
      (await listModelUpgradeActions(acting(solo))).map((one) => one.subject),
    ).not.toContain(seeded?.id);
  });
});

async function firstPersona(tenant: {
  organization: string;
  project: string;
}): Promise<{ id: string }> {
  const { rows } = await database.sql<{ id: string }>(
    "select id from persona where organization_id = $1 order by id limit 1",
    [tenant.organization],
  );
  const [row] = rows;
  if (row === undefined) throw new Error("no persona was seeded");
  return row;
}

/**
 * A legacy key rotated after the upgrade has already run.
 *
 * **Both doors are still open during the compatibility period** — an owner
 * rotates a deployment key through `writePlatformSettings`, and an admin
 * rotates a judge key through `editJudgeCredential` — so an installation whose
 * key was revoked and replaced must not go on spending the revoked one. The
 * copy tracks its source, and the credential the upgrade wrote tracks the copy.
 */
describe("a legacy key rotated after the upgrade has run", () => {
  const solo = { organization: newId("org"), project: newId("prj") };

  beforeAll(async () => {
    holdManagedDeployment(SELF_HOSTED);
    await database.drop();
    database = await createConnectedDatabase("model_upgrade_rotation");
    await seedUser(database, ada, "ada@acme.example");
    await seedOrganization(database, solo.organization, [
      { id: solo.project, slug: "main" },
    ]);
    await seedPlatformSettings({
      persona_model_provider: "openai",
      persona_model: "gpt-4o-mini",
      persona_model_key: "sk-sentinel-rotation-model-key-OLD1",
      speech_to_text_provider: "deepgram",
      speech_to_text_model: "nova-3-general",
      speech_to_text_key: "dg-sentinel-rotation-listening-OLD2",
      text_to_speech_provider: "cartesia",
      text_to_speech_model: "sonic-3.5",
      text_to_speech_key: "ct-sentinel-rotation-speaking-OLD3",
    });
    await upgradeModelSetup(ONE_TEAM);
  });

  it("reaches the copy and the credential the upgrade wrote", async () => {
    expect(
      (await listCredentialCandidates(acting(solo))).find(
        (one) => one.provider === "deepgram",
      )?.hint,
    ).toBe("OLD2");

    // The door an operator really rotates a deployment key through.
    await writePlatformSettings(acting(solo), ONE_TEAM, {
      speech_to_text_key: "dg-sentinel-rotation-listening-NEW9",
    });
    const report = await upgradeModelSetup(ONE_TEAM);

    const candidate = (await listCredentialCandidates(acting(solo))).find(
      (one) => one.provider === "deepgram",
    );
    expect(candidate?.hint).toBe("NEW9");
    expect(candidate?.active).toBe(true);
    expect(report.activated).toEqual(["deepgram"]);

    // And what a claim would spend is the new key, opened through the one door
    // that opens one.
    const resolved = await resolveModelProviderKeys(theSimulatorIn(solo), [
      "deepgram",
    ]);
    expect(resolved.keys.get("deepgram")).toBe(
      "dg-sentinel-rotation-listening-NEW9",
    );
  });

  it("writes nothing at all when nothing rotated", async () => {
    const before = await database.sql(
      `select
         (select count(*) from model_credential_candidate) as candidates,
         (select max(updated_at) from model_provider_credential) as touched`,
    );

    const again = await upgradeModelSetup(ONE_TEAM);
    const after = await database.sql(
      `select
         (select count(*) from model_credential_candidate) as candidates,
         (select max(updated_at) from model_provider_credential) as touched`,
    );

    expect(again.activated).toEqual([]);
    expect(again.candidates).toEqual([]);
    // `updated_at` is what a person reads as "when the stored key last
    // changed", so a boot that rotated nothing must not move it.
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  /**
   * The rule that must never bend: an administrator's own key is theirs.
   *
   * They typed it through Model providers, which is a later and better answer
   * than any legacy row can offer — so a legacy rotation afterwards moves the
   * copy and leaves the credential exactly where they put it.
   */
  it("never overwrites a key an administrator typed", async () => {
    await storeModelProviderCredential(acting(solo), {
      provider: "deepgram",
      key: "dg-sentinel-rotation-typed-by-a-person-Z9",
    });

    await writePlatformSettings(acting(solo), ONE_TEAM, {
      speech_to_text_key: "dg-sentinel-rotation-listening-LATER",
    });
    const report = await upgradeModelSetup(ONE_TEAM);

    // The copy moved, because it tracks its source and always will.
    expect(
      (await listCredentialCandidates(acting(solo))).find(
        (one) => one.provider === "deepgram",
      )?.hint,
    ).toBe("ATER");
    // The credential did not, because it is no longer the upgrade's to move.
    expect(report.activated).toEqual([]);
    const resolved = await resolveModelProviderKeys(theSimulatorIn(solo), [
      "deepgram",
    ]);
    expect(resolved.keys.get("deepgram")).toBe(
      "dg-sentinel-rotation-typed-by-a-person-Z9",
    );
  });

  /**
   * A provider that has grown a second stored key **activates** nothing new,
   * and the credential it already has goes on following the key it named.
   *
   * The two questions are different and only one of them is ambiguous. *Which
   * account does this organization use* has two answers once there are two
   * candidates, so nothing may be activated from them. *Which stored key is
   * this credential following* has exactly one answer, written on the
   * credential itself — so a rotation of that source still reaches it, and the
   * revoked-key failure this whole fix is about does not come back the moment
   * somebody adds a judge credential.
   */
  it("activates nothing more, and still follows the key its credential names", async () => {
    // The first upgrade activated OpenAI from the one key there was; a judge
    // credential added afterwards makes two, and the choice reopens.
    await createJudgeCredential(acting(solo), {
      label: "Acme's own judge key",
      provider: "openai",
      key: "sk-sentinel-rotation-judge-OLD4",
    });
    await upgradeModelSetup(ONE_TEAM);
    // No action, and that is right rather than a gap: this organization already
    // has an OpenAI credential, so "which of these do you use" is answered by
    // the row that exists. The action is for a provider with two stored keys
    // and *nothing* chosen.
    expect(
      (await listModelUpgradeActions(acting(solo))).map((one) => one.subject),
    ).not.toContain("openai");

    await writePlatformSettings(acting(solo), ONE_TEAM, {
      persona_model_key: "sk-sentinel-rotation-model-key-NEW5",
    });
    const report = await upgradeModelSetup(ONE_TEAM);

    const openai = (await listCredentialCandidates(acting(solo))).filter(
      (one) => one.provider === "openai",
    );
    // The rotated copy is current, because a copy always tracks its source.
    expect(openai.map((one) => one.hint).sort()).toEqual(["NEW5", "OLD4"]);
    // Exactly one is active — the one the credential names — and no second
    // credential was created from the newcomer.
    expect(openai.filter((one) => one.active)).toHaveLength(1);
    const { rows } = await database.sql(
      "select count(*) as count from model_provider_credential where provider = 'openai'",
    );
    expect(Number((rows[0] as { count: string }).count)).toBe(1);
    // And the key a claim would spend is the rotated one, because the
    // credential says which stored key it follows and that one moved.
    const resolved = await resolveModelProviderKeys(theSimulatorIn(solo), [
      "openai",
    ]);
    expect(resolved.keys.get("openai")).toBe(
      "sk-sentinel-rotation-model-key-NEW5",
    );
    expect(report.activated).toEqual(["openai"]);
  });
});

/**
 * The boundary of the rotation fix, pinned so nobody has to rediscover it.
 *
 * **A rotated `EGMA_JUDGE_API_KEY` and a restart do not reach an existing
 * platform judge row at all**, and that is deliberate behaviour this effort did
 * not introduce: `seedDefaultJudge` reads only projects that have *no* judge
 * configuration and writes with `onConflictDoNothing`, which the schema states
 * as the whole promise that a project's chosen judge is never replaced. So the
 * copy this upgrade takes cannot go stale against its source — the source did
 * not move — and no refresh trigger of any kind could see a change that never
 * happened.
 *
 * The door that *does* re-seal such a row from the deployment's current key is
 * an administrator choosing the platform judge for a project, and it stamps the
 * row. That one the refresh follows, which is the half worth proving here: the
 * fix is not weaker than its source's own clock.
 */
describe("the deployment's own judge key", () => {
  const solo = { organization: newId("org"), project: newId("prj") };

  beforeAll(async () => {
    holdManagedDeployment(SELF_HOSTED);
    await database.drop();
    database = await createConnectedDatabase("model_upgrade_judge_env");
    await seedUser(database, ada, "ada@acme.example");
    await seedOrganization(database, solo.organization, [
      { id: solo.project, slug: "main" },
    ]);
  });

  it("does not reach an existing project when the environment rotates it", async () => {
    expect(
      await seedDefaultJudge({
        provider: "openai",
        model: "gpt-4o-mini",
        key: "sk-sentinel-judge-env-OLD1",
      }),
    ).toEqual([solo.project]);
    const before = await database.sql<{ hint: string; updated_at: Date }>(
      "select credentials_hint as hint, updated_at from judge_configuration where project_id = $1",
      [solo.project],
    );

    // The operator rotates the environment variable and restarts.
    const seeded = await seedDefaultJudge({
      provider: "openai",
      model: "gpt-4o-mini",
      key: "sk-sentinel-judge-env-NEW9",
    });

    const after = await database.sql<{ hint: string; updated_at: Date }>(
      "select credentials_hint as hint, updated_at from judge_configuration where project_id = $1",
      [solo.project],
    );

    // Nothing was written, so there is nothing for the upgrade to notice. The
    // grading engine goes on spending the key this project was seeded with —
    // which is the deployment's standing behaviour and not this upgrade's.
    expect(seeded).toEqual([]);
    expect(after.rows[0]?.hint).toBe("OLD1");
    expect(after.rows[0]?.updated_at).toEqual(before.rows[0]?.updated_at);
  });

  it("is followed by the refresh where a real door does re-seal the row", async () => {
    await upgradeModelSetup(ONE_TEAM);
    expect(
      (await listCredentialCandidates(acting(solo))).find(
        (one) => one.source === "judge_configuration",
      )?.hint,
    ).toBe("OLD1");

    // An administrator choosing the platform judge for this project re-seals
    // the row from the deployment's *current* key — the one this process was
    // started with, which is where the rotated value really lives — and stamps
    // the row on the way. That is the door the copy can follow.
    await setProjectJudge(acting(solo), {
      source: "platform",
      provider: "openai",
      model: "gpt-4o-mini",
      platformJudge: {
        provider: "openai",
        model: "gpt-4o-mini",
        key: "sk-sentinel-judge-env-NEW9",
      },
    });
    const report = await upgradeModelSetup(ONE_TEAM);

    const copied = (await listCredentialCandidates(acting(solo))).find(
      (one) => one.source === "judge_configuration",
    );
    expect(copied?.hint).toBe("NEW9");
    expect(report.activated).toContain("openai");
    const resolved = await resolveModelProviderKeys(theSimulatorIn(solo), [
      "openai",
    ]);
    expect(resolved.keys.get("openai")).toBe("sk-sentinel-judge-env-NEW9");
  });
});
