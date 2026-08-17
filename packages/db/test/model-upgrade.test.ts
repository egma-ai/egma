import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connect,
  createPersona,
  disconnect,
  editPersona,
  getPersona,
  getPersonaVersion,
  listCredentialCandidates,
  listModelUpgradeActions,
  readModelUpgradeCompletion,
  recordModelUpgradeCompletion,
  seedGraderLibrary,
  seedPlatformSettings,
  seedRunningGraders,
  setJudgeConfiguration,
  upgradeModelSetup,
  useLibraryEntry,
  editGrader,
  getGrader,
  listGraders,
  PREDEFINED_GRADERS,
  type AuthContext,
  type ModelUpgradeReport,
  type PersonaTraits,
} from "@egma/db";

import { readMigrations, runMigrations } from "../src/migrate.ts";
import {
  createEmptyDatabase,
  openSingleConnection,
  TEST_ENCRYPTION_KEY,
  type EmptyDatabase,
  type SingleConnection,
} from "./support/database.ts";

/**
 * A deployment standing at the release before model selections existed, taken
 * through the upgrade that gives its personas and graders explicit ones.
 *
 * **The database is really built at that release.** Every migration up to the
 * upgrade's own is written into a directory and applied; the rows are then
 * written through the doors that release shipped — a persona with no
 * selections, a grader judged by its project's judge, keys in the three places
 * that release kept them — and only then is the upgrade applied. Nothing here
 * starts from today's schema and pretends.
 *
 * **What it is proving is that the upgrade is additive.** Every old version is
 * still there, unedited, still readable, still saying what it said. What is new
 * is one successor version per persona and grader, and one sealed copy of each
 * key that was already stored. Where the answer was not unambiguous, nothing
 * was written at all except a sentence naming what somebody has to choose.
 *
 * The sentinels are recognisable strings rather than real envelopes because
 * **nothing in this upgrade opens one** — which is the property being asserted.
 * They are compared byte for byte for exactly that reason.
 */

let database: EmptyDatabase;
let asItWas: string;
let client: SingleConnection;

const acme = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");

function actingAsAcme(role: "admin" | "member" = "admin"): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
    via: "session",
  };
}

/** The deployment declares itself one team, which every real self-hoster is. */
const ONE_TEAM = { singleOrganization: true };

/**
 * The three keys the previous release kept, each in its own place and each
 * recognisable in a scan.
 */
const LEGACY_KEY = {
  thinking: "sk-sentinel-legacy-persona-model-key-A1B2",
  listening: "dg-sentinel-legacy-speech-to-text-key-C3D4",
  speaking: "ct-sentinel-legacy-text-to-speech-key-E5F6",
  judging: "sk-sentinel-legacy-judge-credential-key-G7H8",
} as const;

/** What the deployment was configured with, exactly as that release wrote it. */
const DEPLOYMENT_SETTINGS = {
  persona_model_provider: "openai",
  persona_model: "gpt-4o-mini",
  persona_model_key: LEGACY_KEY.thinking,
  // Retired by this release: no successor version may carry it.
  persona_model_reasoning_effort: "high",
  speech_to_text_provider: "deepgram",
  speech_to_text_model: "nova-2-phonecall",
  speech_to_text_key: LEGACY_KEY.listening,
  text_to_speech_provider: "cartesia",
  text_to_speech_model: "sonic-2",
  text_to_speech_voice: "a-deployment-wide-voice",
  text_to_speech_key: LEGACY_KEY.speaking,
  voice_activity_provider: "silero",
  media_backend: "livekit",
  // The carrier settings, which this upgrade must not touch at all.
  carrier_trunk_address: "sip:trunk.carrier.example",
  carrier_trunk_number: "+15550100",
  carrier_trunk_username: "acme-trunk",
} as const;

const RITA: PersonaTraits = {
  personality: "Books three cleans a month and knows the schedule better than the agent.",
  language: "en",
  // Speaks with the provider the deployment speaks with, so this one has an
  // unambiguous successor.
  voice: { provider: "cartesia", voiceId: "ritas-own-voice", speed: 1.15 },
  manner: "brisk",
};

const NORA: PersonaTraits = {
  personality: "Calls once a year about a boiler service and has no idea what plan she is on.",
  language: "en",
  // Speaks with a provider the deployment does not, and which this release's
  // catalog does not carry either. Two reasons to refuse, and either is enough.
  voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 0.9 },
};

let rita: { id: string; versionId: string };
let nora: { id: string; versionId: string };
let ownJudge: string;
let projectsJudge: string;
let upgrade: ModelUpgradeReport;

beforeAll(async () => {
  database = await createEmptyDatabase("model_upgrade");
  asItWas = await mkdtemp(path.join(os.tmpdir(), "egma-model-upgrade-"));

  // The schema exactly as the release before the upgrade shipped it.
  const migrations = await readMigrations();
  const subject = migrations.findIndex((one) => one.name.startsWith("0037_"));
  if (subject === -1) throw new Error("0037 is missing");
  for (const migration of migrations.slice(0, subject)) {
    await writeFile(path.join(asItWas, migration.name), migration.sql);
  }
  const applied = await runMigrations(database.url, asItWas);
  expect(applied.applied).toEqual(
    migrations.slice(0, subject).map((one) => one.name),
  );

  connect({ databaseUrl: database.url, encryptionKey: TEST_ENCRYPTION_KEY });
  client = await openSingleConnection(database.url);
  await seedGraderLibrary();

  await client.sql("insert into organization (id, name, slug) values ($1, $2, $2)", [
    acme.organization,
    "acme",
  ]);
  await client.sql(
    "insert into project (id, organization_id, name, slug, revision) values ($1, $2, $3, $3, $4)",
    [acme.project, acme.organization, "main", newId("rev")],
  );
  await client.sql(
    `insert into "user" (id, email, name, email_verified) values ($1, $2, $3, true)`,
    [ada, "ada@acme.example", "Ada"],
  );

  await seedPlatformSettings(DEPLOYMENT_SETTINGS);

  // Two personas, both authored the way that release authored them: traits and
  // nothing else, because there was nothing else to say.
  const madeRita = await createPersona(actingAsAcme(), { name: "Rita", traits: RITA });
  const madeNora = await createPersona(actingAsAcme(), { name: "Nora", traits: NORA });
  rita = { id: madeRita.id, versionId: madeRita.versionId };
  nora = { id: madeNora.id, versionId: madeNora.versionId };

  // The project's judge, with the organization's own key behind it — the
  // arrangement the release before this one shipped.
  await setJudgeConfiguration(actingAsAcme(), {
    provider: "openai",
    model: "gpt-4o",
    key: LEGACY_KEY.judging,
  });

  // The mandatory grading copy every project has, written the way that release
  // wrote it: no model of its own, judged by the project's configuration.
  await seedRunningGraders();
  const [seeded] = (await listGraders(actingAsAcme())).items;
  if (seeded === undefined) throw new Error("the seeded grader is missing");
  projectsJudge = seeded.id;

  // And one grader that named its own judge model, which is the override that
  // has to win over the project's.
  const own = await useLibraryEntry(actingAsAcme(), {
    libraryId: PREDEFINED_GRADERS.expectedBehaviors,
    name: "Strictly judged behaviors",
    config: { assertions: [] },
  });
  ownJudge = own.id;
  await editGrader(actingAsAcme(), own.id, {
    judgeModel: { provider: "openai", model: "gpt-4o-mini" },
  });

  // Then the upgrade a self-hoster runs: the whole of what is pending, and the
  // boot act that finishes it.
  const upgraded = await runMigrations(database.url);
  expect(upgraded.applied).toEqual(
    migrations.slice(subject).map((one) => one.name),
  );
  upgrade = await upgradeModelSetup(ONE_TEAM);
});

afterAll(async () => {
  await client?.close();
  await disconnect();
  await database?.drop();
  await rm(asItWas, { recursive: true, force: true });
});

describe("a persona the deployment's settings answer for", () => {
  it("gains one new version carrying what it thinks, listens and speaks with", async () => {
    const upgraded = await getPersona(actingAsAcme(), rita.id);

    expect(upgrade.personas).toEqual([rita.id]);
    expect(upgraded?.version).toBe(2);
    expect(upgraded?.versionId).not.toBe(rita.versionId);
    expect(upgraded?.models).toEqual({
      llm: { provider: "openai", model: "gpt-4o-mini" },
      stt: { provider: "deepgram", model: "nova-2-phonecall" },
      tts: {
        provider: "cartesia",
        model: "sonic-2",
        // The persona's own voice and its own pace, not the deployment's.
        voiceId: "ritas-own-voice",
        speed: 1.15,
      },
    });
  });

  it("keeps its first version exactly as it was, still readable and still empty", async () => {
    const original = await getPersonaVersion(actingAsAcme(), rita.versionId);

    expect(original?.version).toBe(1);
    expect(original?.models).toBeNull();
    expect(original?.traits).toEqual(RITA);
  });

  /**
   * The voice precedence, stated as the thing that would be wrong without it: a
   * migrated persona sounding like the deployment rather than like itself.
   */
  it("speaks with its own voice, never the deployment-wide one", async () => {
    const upgraded = await getPersona(actingAsAcme(), rita.id);

    expect(upgraded?.models?.tts.voiceId).toBe("ritas-own-voice");
    expect(upgraded?.models?.tts.voiceId).not.toBe(
      DEPLOYMENT_SETTINGS.text_to_speech_voice,
    );
    expect(upgraded?.models?.tts.speed).toBe(RITA.voice.speed);
  });

  /**
   * The retired setting, asserted over the whole stored document rather than
   * over a field name — a successor that carried it under any spelling would be
   * a new version writing down something this release does not have.
   */
  it("carries no reasoning effort, because that setting is not part of a selection", async () => {
    const { rows } = await client.sql<{ models: unknown }>(
      "select models from persona_version where persona_id = $1 and version = 2",
      [rita.id],
    );

    expect(JSON.stringify(rows[0]?.models)).not.toContain("reasoning");
    expect(JSON.stringify(rows[0]?.models)).not.toContain("high");
  });
});

describe("a persona whose own voice disagrees with the deployment's", () => {
  it("stays on the legacy path and receives no guessed version", async () => {
    const untouched = await getPersona(actingAsAcme(), nora.id);

    expect(upgrade.personas).not.toContain(nora.id);
    expect(untouched?.version).toBe(1);
    expect(untouched?.versionId).toBe(nora.versionId);
    expect(untouched?.models).toBeNull();
  });

  it("is named in an action that says what to choose and why", async () => {
    const actions = await listModelUpgradeActions(actingAsAcme());
    const hers = actions.find((one) => one.subject === nora.id);

    expect(hers?.kind).toBe("select_persona_models");
    expect(hers?.detail).toContain("elevenlabs");
    expect(hers?.detail).toContain("cartesia");
    // A sentence naming a screen, because the person reading it has to go
    // somewhere and do something.
    expect(hers?.detail).toContain("Persona models");
  });

  /**
   * The marker's whole purpose, seen from the one condition that is standing:
   * a single persona left on the legacy path is enough to hold the later
   * removal back, and the answer says which condition rather than only "no".
   */
  it("holds the completion marker back, and names the condition that is standing", async () => {
    const standing = await readModelUpgradeCompletion();

    expect(standing.completed).toBe(false);
    expect(standing.outstanding).toEqual(["personas"]);
  });

  it("clears its action the moment somebody makes the choice", async () => {
    await editPersona(actingAsAcme(), nora.id, {
      models: {
        llm: { provider: "openai", model: "gpt-4o-mini" },
        stt: { provider: "deepgram", model: "nova-3-general" },
        tts: {
          provider: "cartesia",
          model: "sonic-3.5",
          voiceId: "a-voice-somebody-chose",
          speed: 0.9,
        },
      },
    });

    const actions = await listModelUpgradeActions(actingAsAcme());
    expect(actions.map((one) => one.subject)).not.toContain(nora.id);
  });
});

describe("the graders", () => {
  it("gives the one judged by its project the project's own model, explicitly", async () => {
    const upgraded = await getGrader(actingAsAcme(), projectsJudge);

    expect(upgrade.graders).toContain(projectsJudge);
    expect(upgraded?.version).toBe(2);
    expect(upgraded?.graderModel).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  /**
   * The precedence that has to hold, said as the failure it prevents: a grader
   * that deliberately named a cheaper judge silently moved onto the project's
   * stronger one, with verdicts to show for it.
   */
  it("lets a grader's own judge model beat the project's configuration", async () => {
    const upgraded = await getGrader(actingAsAcme(), ownJudge);

    expect(upgraded?.graderModel).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(upgraded?.graderModel?.model).not.toBe("gpt-4o");
  });

  it("leaves every earlier grader version exactly as it was", async () => {
    const { rows } = await client.sql<{
      version: number;
      judge_model: unknown;
      grader_model: unknown;
    }>(
      "select version, judge_model, grader_model from grader_version where grader_id = $1 order by version",
      [ownJudge],
    );

    expect(rows.map((row) => row.version)).toEqual([1, 2, 3]);
    // The override as it was authored, on the version that was authored with it.
    expect(rows[1]?.judge_model).toEqual({ provider: "openai", model: "gpt-4o-mini" });
    expect(rows[1]?.grader_model).toBeNull();
    // And the successor says one thing: a complete selection, and no override
    // for anything to consult beside it.
    expect(rows[2]?.judge_model).toBeNull();
  });
});

describe("the keys the deployment already held", () => {
  it("copies every one of them in, sealed, with where it was found", async () => {
    const candidates = await listCredentialCandidates(actingAsAcme());

    expect(
      candidates.map((one) => [one.provider, one.source, one.sourceName]),
    ).toEqual([
      ["cartesia", "platform_setting", "text_to_speech_key"],
      ["deepgram", "platform_setting", "speech_to_text_key"],
      ["openai", "platform_setting", "persona_model_key"],
      ["openai", "judge_credential", "main judge key"],
    ]);
    expect(upgrade.candidates).toHaveLength(4);
  });

  it("hands out four characters and never a key", async () => {
    const candidates = await listCredentialCandidates(actingAsAcme());

    for (const one of candidates) {
      expect(one.hint).toHaveLength(4);
      for (const key of Object.values(LEGACY_KEY)) {
        expect(JSON.stringify(one)).not.toContain(key);
      }
    }
  });

  /**
   * The envelope moved byte for byte, which is what says nothing was opened.
   * A re-sealed copy would differ — the initialisation vector is fresh on every
   * write — so this equality is the assertion that the master key was never
   * used.
   */
  it("copies the sealed envelope verbatim, so nothing was ever unsealed", async () => {
    const { rows } = await client.sql<{ stored: string; copied: string }>(
      `select s.value as stored, c.credentials as copied
         from platform_setting s
         join model_credential_candidate c on c.source_name = s.name
        where s.name = 'speech_to_text_key'`,
    );

    expect(rows[0]?.copied).toBe(rows[0]?.stored);
    expect(rows[0]?.copied).toMatch(/^v1\./);
  });

  it("activates the sole candidate for each provider that has exactly one", async () => {
    const candidates = await listCredentialCandidates(actingAsAcme());
    const active = candidates.filter((one) => one.active);

    expect(upgrade.activated).toEqual(["cartesia", "deepgram"]);
    expect(active.map((one) => one.provider)).toEqual(["cartesia", "deepgram"]);
  });

  /**
   * Two OpenAI keys: the deployment's own model key and the organization's
   * judge key. Egma cannot tell whether they are one account, because telling
   * would mean reading a secret — so it activates neither and asks.
   */
  it("activates neither of two keys for one provider, and asks instead", async () => {
    const candidates = await listCredentialCandidates(actingAsAcme());
    const openai = candidates.filter((one) => one.provider === "openai");
    const { rows } = await client.sql<{ provider: string }>(
      "select provider from model_provider_credential where organization_id = $1 order by provider",
      [acme.organization],
    );

    expect(openai).toHaveLength(2);
    expect(openai.every((one) => !one.active)).toBe(true);
    expect(rows.map((row) => row.provider)).toEqual(["cartesia", "deepgram"]);

    const actions = await listModelUpgradeActions(actingAsAcme());
    const asking = actions.find((one) => one.subject === "openai");
    expect(asking?.kind).toBe("select_model_provider_credential");
    expect(asking?.detail).toContain("2 stored openai keys");
    expect(asking?.detail).toContain("Model providers");
  });

  it("leaves the rows it copied from exactly where they were", async () => {
    const { rows: settings } = await client.sql<{ count: string }>(
      "select count(*) as count from platform_setting",
    );
    const { rows: judges } = await client.sql<{ source: string; credential_id: string | null }>(
      "select source, credential_id from judge_configuration where project_id = $1",
      [acme.project],
    );

    expect(Number(settings[0]?.count)).toBe(
      Object.keys(DEPLOYMENT_SETTINGS).length,
    );
    // The project's judge still points at the credential it always pointed at,
    // so an old grading plan can still resolve it.
    expect(judges[0]?.source).toBe("credential");
    expect(judges[0]?.credential_id).not.toBeNull();
  });
});

describe("what the upgrade must not touch", () => {
  it("leaves the carrier settings byte for byte as they were", async () => {
    const { rows } = await client.sql<{ name: string; hint: string }>(
      `select name, hint from platform_setting
        where name like 'carrier_%' or name = 'media_backend'
        order by name`,
    );

    expect(rows).toEqual([
      { name: "carrier_trunk_address", hint: "sip:trunk.carrier.example" },
      { name: "carrier_trunk_number", hint: "+15550100" },
      { name: "carrier_trunk_username", hint: "acme-trunk" },
      { name: "media_backend", hint: "livekit" },
    ]);
  });

  it("writes no model access on a self-hosted deployment", async () => {
    const { rows } = await client.sql<{ count: string }>(
      "select count(*) as count from model_access",
    );

    expect(upgrade.managedAccess).toEqual([]);
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

describe("running the upgrade again", () => {
  it("writes nothing at all the second time", async () => {
    const before = await client.sql<{ personas: string; graders: string; candidates: string; credentials: string }>(
      `select
         (select count(*) from persona_version) as personas,
         (select count(*) from grader_version) as graders,
         (select count(*) from model_credential_candidate) as candidates,
         (select count(*) from model_provider_credential) as credentials`,
    );

    const again = await upgradeModelSetup(ONE_TEAM);
    const after = await client.sql<{ personas: string; graders: string; candidates: string; credentials: string }>(
      `select
         (select count(*) from persona_version) as personas,
         (select count(*) from grader_version) as graders,
         (select count(*) from model_credential_candidate) as candidates,
         (select count(*) from model_provider_credential) as credentials`,
    );

    expect(again.personas).toEqual([]);
    expect(again.graders).toEqual([]);
    expect(again.candidates).toEqual([]);
    expect(again.activated).toEqual([]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("does not duplicate the action it already wrote", async () => {
    const { rows } = await client.sql<{ count: string }>(
      "select count(*) as count from model_upgrade_action where kind = 'select_model_provider_credential'",
    );

    expect(Number(rows[0]?.count)).toBe(1);
  });
});

describe("the completion marker", () => {
  /**
   * The marker is about *work*, not about every outstanding decision. This
   * organization still has two OpenAI keys and has chosen neither, and that
   * genuinely does not stop the legacy paths being removed: nothing queued
   * needs the old contract, and no grading plan is waiting on a credential
   * reference. So the conditions are clear while the action is still open, and
   * the marker waits only to be recorded.
   */
  it("has nothing outstanding once the work is done, even with a key still to choose", async () => {
    const standing = await readModelUpgradeCompletion();
    const asking = await listModelUpgradeActions(actingAsAcme());

    expect(standing.outstanding).toEqual([]);
    expect(standing.completed).toBe(false);
    expect(asking.map((one) => one.kind)).toEqual([
      "select_model_provider_credential",
    ]);
  });

  it("is written once every persona and grader carries selections", async () => {
    const recorded = await recordModelUpgradeCompletion();

    expect(recorded.completed).toBe(true);
    expect(recorded.completedAt).toBeInstanceOf(Date);
    expect(recorded.outstanding).toEqual([]);
  });

  it("stays written, and a second recording does not move it", async () => {
    const first = await readModelUpgradeCompletion();
    const again = await recordModelUpgradeCompletion();

    expect(again.completedAt?.getTime()).toBe(first.completedAt?.getTime());
    const { rows } = await client.sql<{ count: string }>(
      "select count(*) as count from platform_instance where model_upgrade_completed_at is not null",
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });
});
