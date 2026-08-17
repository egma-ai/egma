import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_ACCESS,
  listModelProviderCredentials,
  ManagedAccessNotConnectedError,
  NotPermittedError,
  readModelAccess,
  removeModelProviderCredential,
  resolveModelProviderKeys,
  setModelAccess,
  storeModelProviderCredential,
  UnprocessableInputError,
  type AuthContext,
  type Role,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The organization's own provider keys, and the one binary choice that says
 * whether they are the ones Egma spends.
 *
 * Every assertion goes through the access functions — the seam — except the
 * reads of the raw `credentials` column, which bypass the module on purpose:
 * the claim under test is that what the module writes is ciphertext and that
 * nothing it answers with contains the key, and only a read the module cannot
 * dress up can say so. That is the judge credential's arrangement, verbatim,
 * because this is the same secret problem one table over.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const grace = newId("usr");

const OPENAI_KEY = "sk-model-sentinel-openai-QRST";
const DEEPGRAM_KEY = "dg-model-sentinel-listen-UVWX";
const REPLACEMENT_KEY = "sk-model-sentinel-rotated-YZ12";

function actingAsAcme(role: Role = "admin"): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
    via: "session",
  };
}

function actingAsGlobex(role: Role = "admin"): AuthContext {
  return {
    userId: grace,
    organizationId: globex.organization,
    projectId: globex.project,
    role,
    via: "session",
  };
}

/** What a simulation claim resolves to: no person, and `simulator` on its face. */
function theSimulatorInAcme(): AuthContext {
  return {
    userId: "simulator",
    organizationId: acme.organization,
    projectId: acme.project,
    role: "viewer",
    via: "simulator",
  };
}

/** The grading engine's own, which opens the same door for the same reason. */
function theEngineInAcme(): AuthContext {
  return {
    userId: "engine",
    organizationId: acme.organization,
    projectId: acme.project,
    role: "viewer",
    via: "engine",
  };
}

/** The sealed column, read around the module because that is the whole point. */
async function storedEnvelope(
  organizationId: string,
  provider: string,
): Promise<string | undefined> {
  const { rows } = await database.sql<{ credentials: string }>(
    "select credentials from model_provider_credential where organization_id = $1 and provider = $2",
    [organizationId, provider],
  );
  return rows[0]?.credentials;
}

beforeAll(async () => {
  database = await createConnectedDatabase("model-provider-credentials");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, grace, "grace@globex.example");
});

afterAll(async () => {
  await database.drop();
});

describe("storing one provider's key", () => {
  it("answers the provider, a safe hint and when it changed — never the key", async () => {
    const stored = await storeModelProviderCredential(actingAsAcme(), {
      provider: "openai",
      key: OPENAI_KEY,
    });

    expect(stored.provider).toBe("openai");
    expect(stored.hint).toBe("QRST");
    expect(stored.updatedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(stored)).not.toContain(OPENAI_KEY);
  });

  it("seals it, so the column holds ciphertext and not the key", async () => {
    const envelope = await storedEnvelope(acme.organization, "openai");

    expect(envelope).toBeDefined();
    expect(envelope).not.toContain(OPENAI_KEY);
    expect(envelope).toMatch(/^v1\./);
  });

  it("is listed by provider and hint, and by nothing else", async () => {
    await storeModelProviderCredential(actingAsAcme(), {
      provider: "deepgram",
      key: DEEPGRAM_KEY,
    });

    const held = await listModelProviderCredentials(actingAsAcme());

    expect(held.map((one) => one.provider)).toEqual(["deepgram", "openai"]);
    expect(held.map((one) => one.hint)).toEqual(["UVWX", "QRST"]);
    expect(JSON.stringify(held)).not.toContain(DEEPGRAM_KEY);
    expect(JSON.stringify(held)).not.toContain(OPENAI_KEY);
  });

  it("refuses a provider Egma ships no adapter for", async () => {
    await expect(
      storeModelProviderCredential(actingAsAcme(), {
        provider: "elevenlabs",
        key: OPENAI_KEY,
      }),
    ).rejects.toBeInstanceOf(UnprocessableInputError);
  });

  it("refuses something too short to be any provider's key", async () => {
    await expect(
      storeModelProviderCredential(actingAsAcme(), {
        provider: "openai",
        key: "sk-abc",
      }),
    ).rejects.toBeInstanceOf(UnprocessableInputError);
  });
});

describe("replacing one provider's key", () => {
  it("keeps one credential per provider and rotates what is stored", async () => {
    const before = await storedEnvelope(acme.organization, "openai");

    const rotated = await storeModelProviderCredential(actingAsAcme(), {
      provider: "openai",
      key: REPLACEMENT_KEY,
    });

    expect(rotated.hint).toBe("YZ12");

    const held = await listModelProviderCredentials(actingAsAcme());
    expect(held.filter((one) => one.provider === "openai")).toHaveLength(1);

    const after = await storedEnvelope(acme.organization, "openai");
    expect(after).not.toBe(before);
    expect(after).not.toContain(REPLACEMENT_KEY);
  });

  it("reaches the next resolution, which is what rotation has to mean", async () => {
    const resolved = await resolveModelProviderKeys(theSimulatorInAcme(), [
      "openai",
    ]);

    expect(resolved.keys.get("openai")).toBe(REPLACEMENT_KEY);
  });
});

describe("removing one provider's key", () => {
  it("takes it out of the list and out of every later resolution", async () => {
    await storeModelProviderCredential(actingAsAcme(), {
      provider: "cartesia",
      key: "ct-model-sentinel-speak-3456",
    });

    const removed = await removeModelProviderCredential(
      actingAsAcme(),
      "cartesia",
    );
    expect(removed?.provider).toBe("cartesia");

    const held = await listModelProviderCredentials(actingAsAcme());
    expect(held.map((one) => one.provider)).not.toContain("cartesia");

    const resolved = await resolveModelProviderKeys(theSimulatorInAcme(), [
      "cartesia",
    ]);
    expect(resolved.keys.size).toBe(0);
    expect(resolved.missing).toEqual(["cartesia"]);
  });

  it("answers nothing where the organization held none, rather than pretending", async () => {
    expect(
      await removeModelProviderCredential(actingAsAcme(), "cartesia"),
    ).toBeUndefined();
  });
});

describe("who may manage a credential", () => {
  it("is an admin, and a member is refused", async () => {
    await expect(
      storeModelProviderCredential(actingAsAcme("member"), {
        provider: "openai",
        key: OPENAI_KEY,
      }),
    ).rejects.toBeInstanceOf(NotPermittedError);

    await expect(
      removeModelProviderCredential(actingAsAcme("member"), "openai"),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });

  it("still lets a viewer see which providers are configured, by hint alone", async () => {
    const held = await listModelProviderCredentials(actingAsAcme("viewer"));

    expect(held.map((one) => one.provider)).toContain("openai");
    expect(JSON.stringify(held)).not.toContain(REPLACEMENT_KEY);
  });
});

describe("another organization", () => {
  it("sees none of them and cannot remove one", async () => {
    expect(await listModelProviderCredentials(actingAsGlobex())).toEqual([]);
    expect(
      await removeModelProviderCredential(actingAsGlobex(), "openai"),
    ).toBeUndefined();

    // And Acme still holds what Globex was just told nothing about.
    const held = await listModelProviderCredentials(actingAsAcme());
    expect(held.map((one) => one.provider)).toContain("openai");
  });

  it("resolves none of them either, however its own claim is narrowed", async () => {
    const resolved = await resolveModelProviderKeys(
      {
        userId: "simulator",
        organizationId: globex.organization,
        projectId: globex.project,
        role: "viewer",
        via: "simulator",
      },
      ["openai"],
    );

    expect(resolved.keys.size).toBe(0);
    expect(resolved.missing).toEqual(["openai"]);
  });
});

describe("opening a stored key", () => {
  it("is refused for a person's session, however senior", async () => {
    await expect(
      resolveModelProviderKeys(actingAsAcme("admin"), ["openai"]),
    ).rejects.toThrow(/simulator or its grading engine/);
  });

  it("answers the grading engine, which judges with the same accounts", async () => {
    const resolved = await resolveModelProviderKeys(theEngineInAcme(), [
      "openai",
    ]);

    expect(resolved.keys.get("openai")).toBe(REPLACEMENT_KEY);
  });

  it("answers only the providers asked for, so unrelated secrets never travel", async () => {
    const resolved = await resolveModelProviderKeys(theSimulatorInAcme(), [
      "deepgram",
    ]);

    expect([...resolved.keys.keys()]).toEqual(["deepgram"]);
    expect(resolved.keys.get("deepgram")).toBe(DEEPGRAM_KEY);
  });
});

describe("the organization's model access", () => {
  it("is customer-owned before anybody chooses, and says nobody has", async () => {
    const access = await readModelAccess(actingAsAcme());

    expect(access.mode).toBe(DEFAULT_MODEL_ACCESS);
    expect(access.mode).toBe("customer-owned");
    expect(access.updatedAt).toBeNull();
  });

  it("is chosen by an admin and refused to a member", async () => {
    await expect(
      setModelAccess(actingAsAcme("member"), "customer-owned"),
    ).rejects.toBeInstanceOf(NotPermittedError);

    const chosen = await setModelAccess(actingAsAcme(), "customer-owned");
    expect(chosen.mode).toBe("customer-owned");
    expect(chosen.updatedAt).toBeInstanceOf(Date);
  });

  it("refuses managed while no inference key is connected, and names what is missing", async () => {
    await expect(
      setModelAccess(actingAsAcme(), "managed"),
    ).rejects.toBeInstanceOf(ManagedAccessNotConnectedError);

    // And the refusal changed nothing: the organization is where it was.
    expect((await readModelAccess(actingAsAcme())).mode).toBe("customer-owned");
  });

  it("refuses a word that is not one of the two", async () => {
    await expect(setModelAccess(actingAsAcme(), "mixed")).rejects.toBeInstanceOf(
      UnprocessableInputError,
    );
  });

  it("is one organization's own, and says nothing about another's", async () => {
    expect((await readModelAccess(actingAsGlobex())).updatedAt).toBeNull();
  });

  it("changing it scans no credential and refuses nothing for being incomplete", async () => {
    // Globex holds no credential at all, which under customer-owned access is
    // an organization that cannot conduct a simulation yet. The setting still
    // lands: readiness is reported per claim, where it can name the simulation
    // it stopped, and never as a checklist standing in front of a switch.
    expect(await listModelProviderCredentials(actingAsGlobex())).toEqual([]);

    const chosen = await setModelAccess(actingAsGlobex(), "customer-owned");

    expect(chosen.mode).toBe("customer-owned");
  });
});
