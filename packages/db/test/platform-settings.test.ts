import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  NotPermittedError,
  platformFacts,
  PLATFORM_SETTINGS,
  readPlatformSettings,
  resolvePlatformSettings,
  seedPlatformSettings,
  writePlatformSettings,
  type AuthContext,
  type PlatformSettingValues,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The settings this deployment holds, in the platform's own store.
 *
 * **What this file is about.** Every one of these used to live in a file beside
 * the deployment that only the CLI read, so starting the platform any other way
 * lost all of them — silently, because each variable had an empty default. So
 * the claims here are about survival and about secrecy: what lands in the table
 * is sealed rather than plain, what comes back out is a hint rather than a key,
 * and what the environment seeds is written once and never over the top of a
 * value somebody chose.
 *
 * The judge is the model this follows, one scope up: sealed with the
 * deployment's own key, a hint kept for display, and a boot-time seed that
 * never replaces a choice. What is different is only who owns the row — these
 * belong to the deployment and to no customer, which is why no organization or
 * project appears anywhere below.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const bruno = newId("usr");

const THEIR_OWN_KEY = "sk-the-operator-typed-this-one-QRST";
const FROM_THE_ENVIRONMENT = "sk-a-deployment-script-supplied-this-WXYZ";

function owner(): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role: "admin",
    via: "session",
  };
}

function member(role: "member" | "viewer"): AuthContext {
  return {
    userId: bruno,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
    via: "session",
  };
}

/**
 * The context a claim mints, which is the only one the plaintext door opens
 * for. Written here rather than inside one describe because two of them need
 * it: what a simulator is really handed is the only honest way to assert that
 * a stranded setting is gone.
 */
function claimedBySimulator(): AuthContext {
  return {
    userId: "simulator",
    organizationId: acme.organization,
    projectId: acme.project,
    role: "member",
    via: "simulator",
  };
}

/**
 * A deployment that is one team, which is what every self-host is and what the
 * default flag says. It is the precondition on being here at all, so it is
 * written out at every call rather than hidden in a helper's default.
 */
const ONE_TEAM = { singleOrganization: true } as const;

/** And a platform serving several customers, where these settings are nobody's. */
const SEVERAL_CUSTOMERS = { singleOrganization: false } as const;

/** One setting as it stands, by name — the shape every read here asserts on. */
async function settingsByName(
  auth: AuthContext = owner(),
): Promise<Record<string, { hint: string | null; secret: boolean }>> {
  const held = await readPlatformSettings(auth, ONE_TEAM);
  return Object.fromEntries(
    held.map((setting) => [
      setting.name,
      { hint: setting.hint, secret: setting.secret },
    ]),
  );
}

beforeAll(async () => {
  database = await createConnectedDatabase("platform_settings");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, bruno, "bruno@acme.example");
});

afterAll(async () => {
  await database.drop();
});

describe("a platform that has been given no settings", () => {
  it("answers every setting it knows about, holding none of them", async () => {
    // Naming the settings it does not have is the whole readiness answer: a
    // platform that said only "setup required" would send whoever runs it to
    // read source to find out what is missing.
    //
    // Every name in the catalog, read off the catalog rather than listed
    // again: the list grows as settings move in, and a second copy of it here
    // would be a copy that goes stale rather than a claim that goes wrong.
    // What is asserted is the property — one answer per setting, and every
    // one of them absent.
    const held = await settingsByName();
    expect(Object.keys(held)).toEqual(
      PLATFORM_SETTINGS.map((setting) => setting.name),
    );
    for (const setting of PLATFORM_SETTINGS) {
      expect(held[setting.name]).toEqual({
        hint: null,
        secret: setting.secret,
      });
    }
  });

  it("knows the persona's model, its speech legs and its carrier", async () => {
    // The catalog written out once, because the loop above proves a shape and
    // this proves the contents — that the settings this effort moved really
    // are the ones the platform holds, and which of them may be shown back.
    expect(
      PLATFORM_SETTINGS.map((setting) => [setting.name, setting.secret]),
    ).toEqual([
      ["persona_model_provider", false],
      ["persona_model", false],
      ["persona_model_key", true],
      ["persona_model_reasoning_effort", false],
      ["speech_to_text_provider", false],
      ["speech_to_text_key", true],
      ["speech_to_text_model", false],
      ["text_to_speech_provider", false],
      ["text_to_speech_key", true],
      ["text_to_speech_model", false],
      ["text_to_speech_voice", false],
      ["voice_activity_provider", false],
      ["media_backend", false],
      ["carrier_trunk_address", false],
      ["carrier_trunk_number", false],
      ["carrier_trunk_username", false],
      ["carrier_trunk_password", true],
    ]);
  });

  it("holds nothing anybody could be shown", async () => {
    expect(await platformFacts()).toEqual({});
  });
});

describe("writing a platform setting", () => {
  it("seals the value rather than storing it", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, {
      persona_model_provider: "openai",
      persona_model: "gpt-4o",
      persona_model_key: THEIR_OWN_KEY,
    });

    // The one read in this file that goes around the module, on purpose: the
    // claim is that what is stored is ciphertext, and only a read the module
    // cannot dress up can say so.
    const stored = await database.sql<{ value: string; hint: string }>(
      "select value, hint from platform_setting where name = $1",
      ["persona_model_key"],
    );
    expect(stored.rows[0]?.value).not.toContain(THEIR_OWN_KEY);
    expect(stored.rows[0]?.value.startsWith("v1.")).toBe(true);
    expect(stored.rows[0]?.hint).not.toContain(THEIR_OWN_KEY);
  });

  it("answers the provider, the model and a hint, and never the key", async () => {
    const held = await settingsByName();

    expect(held.persona_model_provider).toEqual({
      hint: "openai",
      secret: false,
    });
    expect(held.persona_model).toEqual({ hint: "gpt-4o", secret: false });
    // Enough to tell two keys apart, and nothing anybody could spend with.
    expect(held.persona_model_key).toEqual({ hint: "QRST", secret: true });

    expect(JSON.stringify(await readPlatformSettings(owner(), ONE_TEAM))).not.toContain(
      THEIR_OWN_KEY,
    );
  });

  it("shows what is not a secret and withholds what is", async () => {
    // The public readiness answer reads this, so a secret must never have a
    // value here — not even a hint of one.
    expect(await platformFacts()).toEqual({
      persona_model_provider: "openai",
      persona_model: "gpt-4o",
      persona_model_key: null,
    });
  });

  it("changes one setting and leaves the rest alone", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, { persona_model: "gpt-4.1-mini" });

    const held = await settingsByName();
    expect(held.persona_model?.hint).toBe("gpt-4.1-mini");
    expect(held.persona_model_key?.hint).toBe("QRST");
  });

  it("seals a replacement afresh, so two writes of one value are two rows apart", async () => {
    const before = await database.sql<{ value: string }>(
      "select value from platform_setting where name = $1",
      ["persona_model_key"],
    );
    await writePlatformSettings(owner(), ONE_TEAM, { persona_model_key: THEIR_OWN_KEY });
    const after = await database.sql<{ value: string }>(
      "select value from platform_setting where name = $1",
      ["persona_model_key"],
    );

    // A fresh initialisation vector every time, exactly as a connection's
    // credentials are resealed: the column tells nobody that nothing changed.
    expect(after.rows[0]?.value).not.toBe(before.rows[0]?.value);
  });

  it("belongs to the deployment, so the row names no customer", async () => {
    const { rows } = await database.sql<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'platform_setting'`,
    );
    const columns = rows.map((row) => row.column_name).sort();

    expect(columns).toEqual([
      "created_at",
      "hint",
      "id",
      "name",
      "updated_at",
      "value",
    ]);
  });

});

describe("a deployment that serves more than one organization", () => {
  /** An owner, and of a second organization on the same platform. */
  function ownerAtGlobex(): AuthContext {
    return {
      userId: newId("usr"),
      organizationId: globex.organization,
      projectId: globex.project,
      role: "admin",
      via: "session",
    };
  }

  /**
   * **There is one platform and one set of settings on it, and that is exactly
   * why nobody may have them here.** These are the deployment's own provider
   * credentials: on a platform holding several customers, letting one
   * organization's owner read them would show them the hints of a key the
   * others depend on, and letting them write would point everybody else's
   * simulations at an account nobody else agreed to.
   *
   * Whose settings these are on such a deployment is a real question and it is
   * deliberately not answered yet. Until it is, egma refuses everybody rather
   * than picking one of them — the same guard the platform's own judge is
   * behind, which is only ever given away on a single-organization deployment.
   */
  it("refuses an owner of a second organization both the read and the write", async () => {
    await expect(
      readPlatformSettings(ownerAtGlobex(), SEVERAL_CUSTOMERS),
    ).rejects.toThrow(NotPermittedError);
    await expect(
      writePlatformSettings(ownerAtGlobex(), SEVERAL_CUSTOMERS, {
        persona_model: "gpt-4o",
      }),
    ).rejects.toThrow(NotPermittedError);
  });

  it("refuses the first organization's owner too, so it is the deployment and not the customer", async () => {
    await expect(
      readPlatformSettings(owner(), SEVERAL_CUSTOMERS),
    ).rejects.toThrow(NotPermittedError);
  });

  it("changed nothing: the settings are as the single-organization owner left them", async () => {
    expect((await settingsByName()).persona_model?.hint).toBe("gpt-4.1-mini");
  });
});

describe("who may read and change them", () => {
  it("lets an owner read them while this deployment is one team", async () => {
    // The passing side of the precondition above, kept beside it: the default
    // deployment, and the self-hoster who is both its operator and its only
    // organization's admin.
    const held = await readPlatformSettings(owner(), ONE_TEAM);

    expect(held.find((setting) => setting.name === "persona_model")?.hint).toBe(
      "gpt-4.1-mini",
    );
  });

  it("refuses a member the read and the write alike", async () => {
    // These are the deployment's own provider credentials. Everybody in the
    // organization can start a run with them; being able to see whose account
    // is spent, or point it at another, is the organization-settings decision
    // rather than the authoring one.
    await expect(readPlatformSettings(member("member"), ONE_TEAM)).rejects.toThrow(
      NotPermittedError,
    );
    await expect(
      writePlatformSettings(member("member"), ONE_TEAM, { persona_model: "gpt-4o" }),
    ).rejects.toThrow(NotPermittedError);
  });

  it("refuses a viewer the same two", async () => {
    await expect(readPlatformSettings(member("viewer"), ONE_TEAM)).rejects.toThrow(
      NotPermittedError,
    );
    await expect(
      writePlatformSettings(member("viewer"), ONE_TEAM, { persona_model: "gpt-4o" }),
    ).rejects.toThrow(NotPermittedError);
  });

  it("leaves the settings as they were", async () => {
    expect((await settingsByName()).persona_model?.hint).toBe("gpt-4.1-mini");
  });
});

describe("a write that cannot be acted on", () => {
  it("refuses a setting the platform does not know", async () => {
    await expect(
      writePlatformSettings(
        owner(),
        ONE_TEAM,
        // A name nobody reads is a row nothing ever uses, so it is refused
        // here rather than written and forgotten.
        { not_a_setting: "anything" } as unknown as PlatformSettingValues,
      ),
    ).rejects.toThrow(/not a platform setting Egma knows/u);
  });

  it("refuses an empty value, because clearing a setting is not writing one", async () => {
    await expect(
      writePlatformSettings(owner(), ONE_TEAM, { persona_model: "   " }),
    ).rejects.toThrow(/needs a value/u);
  });

  it("refuses a secret too short for any provider to have issued it", async () => {
    await expect(
      writePlatformSettings(owner(), ONE_TEAM, { persona_model_key: "sk-abc" }),
    ).rejects.toThrow(/shorter than any provider issues/u);
  });
});

describe("seeding from the environment", () => {
  it("never replaces a setting somebody has already chosen", async () => {
    // The property that makes seeding safe on every boot: a redeploy carrying
    // the old key in a script must not undo a key the operator changed.
    const written = await seedPlatformSettings({
      persona_model_provider: "openai",
      persona_model: "gpt-4o-mini",
      persona_model_key: FROM_THE_ENVIRONMENT,
    });

    expect(written).toEqual([]);
    const held = await settingsByName();
    expect(held.persona_model?.hint).toBe("gpt-4.1-mini");
    expect(held.persona_model_key?.hint).toBe("QRST");
  });
});

describe("seeding a platform that holds nothing", () => {
  beforeAll(async () => {
    // Back to a platform nobody has configured, which is what every deployment
    // is on the morning somebody first starts it.
    await database.sql("delete from platform_setting");
  });

  it("writes what the environment names", async () => {
    const written = await seedPlatformSettings({
      persona_model_provider: "openai",
      persona_model: "gpt-4o-mini",
      persona_model_key: FROM_THE_ENVIRONMENT,
    });

    expect([...written].sort()).toEqual([
      "persona_model",
      "persona_model_key",
      "persona_model_provider",
    ]);
    const held = await settingsByName();
    expect(held.persona_model_provider).toEqual({
      hint: "openai",
      secret: false,
    });
    expect(held.persona_model).toEqual({ hint: "gpt-4o-mini", secret: false });
    expect(held.persona_model_key).toEqual({ hint: "WXYZ", secret: true });
    // And nothing this environment did not name: a seed writes what it was
    // given and never fills a gap with a guess.
    expect(held.carrier_trunk_address).toEqual({ hint: null, secret: false });
  });

  it("seals what it wrote, exactly as a person's own write is sealed", async () => {
    const stored = await database.sql<{ value: string }>(
      "select value from platform_setting where name = $1",
      ["persona_model_key"],
    );
    expect(stored.rows[0]?.value).not.toContain(FROM_THE_ENVIRONMENT);
    expect(stored.rows[0]?.value.startsWith("v1.")).toBe(true);
  });

  it("writes nothing on the next boot, so every start is safe", async () => {
    expect(
      await seedPlatformSettings({
        persona_model_provider: "openai",
        persona_model: "gpt-4o-mini",
        persona_model_key: FROM_THE_ENVIRONMENT,
      }),
    ).toEqual([]);
  });

  it("fills only the gap when the environment names more than the platform holds", async () => {
    await database.sql("delete from platform_setting where name = $1", [
      "persona_model",
    ]);

    expect(
      await seedPlatformSettings({
        persona_model_provider: "openai",
        persona_model: "gpt-4o-mini",
        persona_model_key: FROM_THE_ENVIRONMENT,
      }),
    ).toEqual(["persona_model"]);
  });
});

describe("the one door to the plaintext", () => {
  /**
   * The context a simulation claim mints, and the only kind that may be here.
   *
   * A claim carries no user: the simulator stands behind every organization at
   * once and holds no credential, so the context arrives narrowed to the row it
   * was handed rather than resolved from anybody's key. `via` is what says
   * where it came from, and it is what this door reads.
   */
  function claimed(): AuthContext {
    return {
      // Not an identifier and deliberately not shaped like one: the claim
      // machinery writes the same word, because the conversations a simulator
      // conducts were asked for by whoever started the run rather than by it.
      userId: "simulator",
      organizationId: acme.organization,
      projectId: acme.project,
      role: "member",
      via: "simulator",
    };
  }

  it("answers a claim with the values in the clear, and nothing it does not hold", async () => {
    await database.sql("delete from platform_setting");
    await seedPlatformSettings({
      persona_model_provider: "openai",
      persona_model_key: THEIR_OWN_KEY,
      carrier_trunk_password: "the-carrier-issued-this-one",
    });

    // In the clear: this is the one caller that has to replay a key to a
    // provider, so a hint would be four characters of a credential and the
    // sealed envelope would be an envelope.
    expect(await resolvePlatformSettings(claimed())).toEqual({
      persona_model_provider: "openai",
      persona_model_key: THEIR_OWN_KEY,
      carrier_trunk_password: "the-carrier-issued-this-one",
    });
  });

  it("refuses every context a claim did not mint", async () => {
    // The guard is on the kind of context rather than on anything a caller
    // passes, so there is no argument by which a person's session, an API key
    // or the grading engine could reach a stored key. It is
    // `resolveSimulationConnection`'s guard word for word, over the settings
    // that ride the same work order.
    for (const auth of [
      owner(),
      member("member"),
      { ...claimed(), via: "api_key" } as AuthContext,
      { ...claimed(), via: "engine" } as AuthContext,
    ]) {
      await expect(resolvePlatformSettings(auth)).rejects.toThrow(
        /egma's own simulator/u,
      );
    }
  });

  it("answers nothing at all on a platform nobody has configured", async () => {
    await database.sql("delete from platform_setting");
    expect(await resolvePlatformSettings(claimed())).toEqual({});
  });

  it("refuses a row that will not unseal rather than conducting with it", async () => {
    await database.sql("delete from platform_setting");
    await seedPlatformSettings({ persona_model_provider: "openai" });
    // What a lost encryption key or a hand-edited row leaves behind. Handing
    // the simulator whatever came out would be a provider call with garbage
    // in the authorization header; the row is named instead, so whoever reads
    // the log knows which one needs repairing.
    await database.sql(
      "update platform_setting set value = 'not-an-envelope-at-all' where name = $1",
      ["persona_model_provider"],
    );

    await expect(resolvePlatformSettings(claimed())).rejects.toThrow();
  });
});

describe("a provider change, and what it strands", () => {
  // Its own slate, and at the end of the file, because everything here writes
  // providers and models that the ordered chain above reads. A block that
  // changed `persona_model` in the middle of that chain would be a test
  // failing somewhere it says nothing about.
  beforeAll(async () => {
    await database.sql("delete from platform_setting");
  });

  it("drops the old provider's model and voice when the provider changes", async () => {
    // A model name and a voice id belong to the provider that coined them, so
    // the moment the provider beside them changes they stop being
    // configuration and become a trap: the simulator would ask the newly
    // chosen provider for the old one's model and be refused at the first
    // word, which reads as a broken deployment rather than as a setting
    // nobody updated.
    await writePlatformSettings(owner(), ONE_TEAM, {
      text_to_speech_provider: "openai",
      text_to_speech_model: "gpt-4o-mini-tts",
      text_to_speech_voice: "alloy",
      speech_to_text_provider: "openai",
      speech_to_text_model: "gpt-4o-transcribe",
    });

    await writePlatformSettings(owner(), ONE_TEAM, {
      text_to_speech_provider: "cartesia",
      speech_to_text_provider: "openai_realtime",
    });

    const held = await resolvePlatformSettings(claimedBySimulator());
    expect(held.text_to_speech_provider).toBe("cartesia");
    expect(held.speech_to_text_provider).toBe("openai_realtime");
    // Gone, so each built leg answers with its own provider's default rather
    // than with a name the new provider has never heard of.
    expect(held.text_to_speech_model).toBeUndefined();
    expect(held.text_to_speech_voice).toBeUndefined();
    expect(held.speech_to_text_model).toBeUndefined();
  });

  it("keeps the new provider's own model when it is supplied in the same write", async () => {
    // Supplying the new provider's model in the same breath is the careful
    // thing to do, and it must not then be deleted for having arrived beside
    // the change that made it necessary.
    await writePlatformSettings(owner(), ONE_TEAM, {
      text_to_speech_provider: "openai",
      text_to_speech_model: "gpt-4o-mini-tts",
    });

    await writePlatformSettings(owner(), ONE_TEAM, {
      text_to_speech_provider: "cartesia",
      text_to_speech_model: "sonic-3.5",
    });

    const held = await resolvePlatformSettings(claimedBySimulator());
    expect(held.text_to_speech_model).toBe("sonic-3.5");
  });

  it("leaves the model and voice alone when the provider is rewritten unchanged", async () => {
    // A form that submits every field it holds rewrites the provider with the
    // value already stored. That is not a change, and it must not throw away
    // the model beside it.
    await writePlatformSettings(owner(), ONE_TEAM, {
      text_to_speech_provider: "cartesia",
      text_to_speech_model: "sonic-3.5",
      text_to_speech_voice: "a-cartesia-voice",
    });

    await writePlatformSettings(owner(), ONE_TEAM, {
      text_to_speech_provider: "cartesia",
    });

    const held = await resolvePlatformSettings(claimedBySimulator());
    expect(held.text_to_speech_model).toBe("sonic-3.5");
    expect(held.text_to_speech_voice).toBe("a-cartesia-voice");
  });

  it("drops a reasoning effort the newly chosen model may never have heard of", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, {
      persona_model: "a-model-that-reasons",
      persona_model_reasoning_effort: "high",
    });

    await writePlatformSettings(owner(), ONE_TEAM, {
      persona_model: "a-model-that-does-not",
    });

    const held = await resolvePlatformSettings(claimedBySimulator());
    expect(held.persona_model).toBe("a-model-that-does-not");
    expect(held.persona_model_reasoning_effort).toBeUndefined();
  });
});
