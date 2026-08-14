import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  NotPermittedError,
  platformFacts,
  readPlatformSettings,
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

/** One setting as it stands, by name — the shape every read here asserts on. */
async function settingsByName(
  auth: AuthContext = owner(),
): Promise<Record<string, { hint: string | null; secret: boolean }>> {
  const held = await readPlatformSettings(auth);
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
    expect(await settingsByName()).toEqual({
      persona_model_provider: { hint: null, secret: false },
      persona_model: { hint: null, secret: false },
      persona_model_key: { hint: null, secret: true },
    });
  });

  it("holds nothing anybody could be shown", async () => {
    expect(await platformFacts()).toEqual({});
  });
});

describe("writing a platform setting", () => {
  it("seals the value rather than storing it", async () => {
    await writePlatformSettings(owner(), {
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

    expect(JSON.stringify(await readPlatformSettings(owner()))).not.toContain(
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
    await writePlatformSettings(owner(), { persona_model: "gpt-4.1-mini" });

    const held = await settingsByName();
    expect(held.persona_model?.hint).toBe("gpt-4.1-mini");
    expect(held.persona_model_key?.hint).toBe("QRST");
  });

  it("seals a replacement afresh, so two writes of one value are two rows apart", async () => {
    const before = await database.sql<{ value: string }>(
      "select value from platform_setting where name = $1",
      ["persona_model_key"],
    );
    await writePlatformSettings(owner(), { persona_model_key: THEIR_OWN_KEY });
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

  it("is one deployment's answer, whichever customer asked", async () => {
    // There is one platform and one set of settings on it. An owner in another
    // organization reads the same answer, because there is no other answer to
    // read — which is what "owned by the deployment" means when it is written
    // down as behaviour rather than as a column that is absent.
    const elsewhere = await readPlatformSettings({
      userId: newId("usr"),
      organizationId: globex.organization,
      projectId: globex.project,
      role: "admin",
      via: "session",
    });

    expect(
      elsewhere.find((setting) => setting.name === "persona_model")?.hint,
    ).toBe("gpt-4.1-mini");
  });
});

describe("who may read and change them", () => {
  it("refuses a member the read and the write alike", async () => {
    // These are the deployment's own provider credentials. Everybody in the
    // organization can start a run with them; being able to see whose account
    // is spent, or point it at another, is the organization-settings decision
    // rather than the authoring one.
    await expect(readPlatformSettings(member("member"))).rejects.toThrow(
      NotPermittedError,
    );
    await expect(
      writePlatformSettings(member("member"), { persona_model: "gpt-4o" }),
    ).rejects.toThrow(NotPermittedError);
  });

  it("refuses a viewer the same two", async () => {
    await expect(readPlatformSettings(member("viewer"))).rejects.toThrow(
      NotPermittedError,
    );
    await expect(
      writePlatformSettings(member("viewer"), { persona_model: "gpt-4o" }),
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
        // A name nobody reads is a row nothing ever uses, so it is refused
        // here rather than written and forgotten.
        { not_a_setting: "anything" } as unknown as PlatformSettingValues,
      ),
    ).rejects.toThrow(/not a platform setting egma knows/u);
  });

  it("refuses an empty value, because clearing a setting is not writing one", async () => {
    await expect(
      writePlatformSettings(owner(), { persona_model: "   " }),
    ).rejects.toThrow(/needs a value/u);
  });

  it("refuses a secret too short for any provider to have issued it", async () => {
    await expect(
      writePlatformSettings(owner(), { persona_model_key: "sk-abc" }),
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
    expect(await settingsByName()).toEqual({
      persona_model_provider: { hint: "openai", secret: false },
      persona_model: { hint: "gpt-4o-mini", secret: false },
      persona_model_key: { hint: "WXYZ", secret: true },
    });
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
