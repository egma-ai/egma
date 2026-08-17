import { createHash } from "node:crypto";

import { newId } from "@egma/ids";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  connectManagedAccess,
  createInferenceKey,
  holdManagedDeployment,
  disconnectManagedAccess,
  INTERNAL_GATEWAY_CREDENTIAL_PREFIX,
  listInferenceKeys,
  ManagedAccessBoundElsewhereError,
  ManagedAccessNotConnectedError,
  ManagedAccessUnavailableError,
  managedAccessAvailable,
  NotPermittedError,
  readManagedAccessConnection,
  readModelAccess,
  resolveInferenceKey,
  resolveManagedAccess,
  revokeInferenceKey,
  setModelAccess,
  UnprocessableInputError,
  type AuthContext,
  type ManagedDeployment,
  type Role,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Managed model access at the store: the inference keys hosted Egma mints, the
 * one a self-hosted deployment connects, and the credential Egma's own two
 * services present at the Egma model gateway.
 *
 * Everything is asserted through the access functions except the two reads that
 * go around them on purpose — the `hash` column and the sealed `credentials`
 * column. Those are the promises the product actually makes about this data:
 * that Egma Cloud keeps no readable copy of a key, and that a self-hosted
 * deployment keeps only a sealed one. A read the module could dress up would
 * not be able to say either.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const grace = newId("usr");

/** Sentinels, so a leak anywhere is a string a scan can find. */
const CLOUD_KEY = "egma_ik_sentinel-managed-access-A1B2";
const OTHER_CLOUD_KEY = "egma_ik_sentinel-second-install-C3D4";
const INTERNAL_KEY = "sentinel-internal-gateway-signing-E5F6";
const GATEWAY = "https://gateway.egma.example";

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

const SELF_HOSTED: ManagedDeployment = {
  hosted: false,
  gatewayAddress: GATEWAY,
  internalGatewayKey: undefined,
};

const HOSTED: ManagedDeployment = {
  hosted: true,
  gatewayAddress: GATEWAY,
  internalGatewayKey: INTERNAL_KEY,
};

/**
 * What kind of deployment this test is standing in, changed between cases.
 *
 * The two answers are two deployments in production and one module here, so the
 * seam is where they are told apart — which is exactly the seam worth testing.
 */
function standingIn(deployment: ManagedDeployment): void {
  holdManagedDeployment(deployment);
}

async function storedHash(inferenceKeyId: string): Promise<string | undefined> {
  const { rows } = await database.sql<{ hash: string }>(
    "select hash from inference_key where id = $1",
    [inferenceKeyId],
  );
  return rows[0]?.hash;
}

async function storedEnvelope(
  organizationId: string,
): Promise<string | undefined> {
  const { rows } = await database.sql<{ credentials: string }>(
    "select credentials from managed_access_key where organization_id = $1",
    [organizationId],
  );
  return rows[0]?.credentials;
}

/** The stamp, once the write that is deliberately not awaited has landed. */
async function eventuallyStamped(inferenceKeyId: string): Promise<Date> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await database.sql<{ last_used_at: Date | null }>(
      "select last_used_at from inference_key where id = $1",
      [inferenceKeyId],
    );
    const stamped = rows[0]?.last_used_at;
    if (stamped instanceof Date) return stamped;
    await new Promise((settle) => setTimeout(settle, 10));
  }
  throw new Error("the use stamp never landed");
}

/** The hash a route computes before it ever calls the store. */
function hashed(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

beforeAll(async () => {
  database = await createConnectedDatabase("managed-model-access");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, grace, "grace@globex.example");
  standingIn(SELF_HOSTED);
});

afterEach(() => {
  standingIn(SELF_HOSTED);
});

afterAll(async () => {
  await database.drop();
});

describe("an inference key, as Egma Cloud files it", () => {
  it("answers a name, a safe hint and its lifecycle — and holds no key to answer with", async () => {
    const created = await createInferenceKey(actingAsAcme(), {
      name: "Lakeside self-hosted",
      hash: hashed(CLOUD_KEY),
      prefix: "egma_ik_",
      displaySuffix: CLOUD_KEY.slice(-4),
    });

    expect(created.name).toBe("Lakeside self-hosted");
    expect(created.looksLike).toBe(`egma_ik_…${CLOUD_KEY.slice(-4)}`);
    expect(created.revokedAt).toBeNull();
    expect(created.lastUsedAt).toBeNull();
    expect(JSON.stringify(created)).not.toContain(CLOUD_KEY);
  });

  it("stores a hash of it and nowhere a readable copy", async () => {
    const created = await createInferenceKey(actingAsAcme(), {
      name: "Second install",
      hash: hashed(OTHER_CLOUD_KEY),
      prefix: "egma_ik_",
      displaySuffix: OTHER_CLOUD_KEY.slice(-4),
    });

    expect(await storedHash(created.id)).toBe(hashed(OTHER_CLOUD_KEY));

    const { rows } = await database.sql<Record<string, unknown>>(
      "select * from inference_key where id = $1",
      [created.id],
    );
    expect(JSON.stringify(rows)).not.toContain(OTHER_CLOUD_KEY);
  });

  it("needs a name, because a list of four unnamed keys is four nobody dares revoke", async () => {
    await expect(
      createInferenceKey(actingAsAcme(), {
        name: "   ",
        hash: hashed("egma_ik_sentinel-unnamed-G7H8"),
        prefix: "egma_ik_",
        displaySuffix: "G7H8",
      }),
    ).rejects.toBeInstanceOf(UnprocessableInputError);
  });

  it("is an administrator's to create, list and revoke, and nobody else's", async () => {
    for (const role of ["member", "viewer"] as const) {
      await expect(listInferenceKeys(actingAsAcme(role))).rejects.toBeInstanceOf(
        NotPermittedError,
      );
      await expect(
        createInferenceKey(actingAsAcme(role), {
          name: "no",
          hash: hashed("egma_ik_sentinel-no-J9K0"),
          prefix: "egma_ik_",
          displaySuffix: "J9K0",
        }),
      ).rejects.toBeInstanceOf(NotPermittedError);
    }
  });

  it("belongs to its own organization, and another customer's list is empty of it", async () => {
    const mine = await listInferenceKeys(actingAsAcme());
    expect(mine.length).toBeGreaterThan(0);
    expect(await listInferenceKeys(actingAsGlobex())).toEqual([]);
  });
});

describe("one inference key resolved by its hash", () => {
  it("answers the organization it authorizes, and no context at all", async () => {
    const created = await createInferenceKey(actingAsAcme(), {
      name: "Resolvable",
      hash: hashed("egma_ik_sentinel-resolvable-L1M2"),
      prefix: "egma_ik_",
      displaySuffix: "L1M2",
    });

    const resolved = await resolveInferenceKey(
      hashed("egma_ik_sentinel-resolvable-L1M2"),
    );

    expect(resolved).toEqual({
      inferenceKeyId: created.id,
      organizationId: acme.organization,
    });
  });

  it("does not make a connection wait on writing down that it was used", async () => {
    const secret = "egma_ik_sentinel-hot-path-Zz1Xx2";
    const created = await createInferenceKey(actingAsAcme(), {
      name: "Hot path",
      hash: hashed(secret),
      prefix: "egma_ik_",
      displaySuffix: "Xx2",
    });

    // The answer a connection is waiting for is in hand before the stamp is
    // written: the read is what the caller awaits, and the write is not
    // awaited at all.
    const resolved = await resolveInferenceKey(hashed(secret));
    expect(resolved?.inferenceKeyId).toBe(created.id);

    // A second open a moment later writes nothing, because the stamp is
    // fresh — which is what stops every connection on one key queueing behind
    // one row lock. Observed as the stamp not moving.
    const first = await database.sql<{ last_used_at: Date | null }>(
      "select last_used_at from inference_key where id = $1",
      [created.id],
    );
    // The first write may still be in flight; wait for it to land at all.
    const landed = await eventuallyStamped(created.id);
    expect(landed).toBeInstanceOf(Date);

    await resolveInferenceKey(hashed(secret));
    await new Promise((settle) => setTimeout(settle, 50));
    const again = await database.sql<{ last_used_at: Date | null }>(
      "select last_used_at from inference_key where id = $1",
      [created.id],
    );
    expect(again.rows[0]?.last_used_at?.getTime()).toBe(landed.getTime());
    expect(first.rows.length).toBe(1);
  });

  it("marks it used, so a key nobody needs is visible as one", async () => {
    const secret = "egma_ik_sentinel-used-N3P4";
    const created = await createInferenceKey(actingAsAcme(), {
      name: "Used",
      hash: hashed(secret),
      prefix: "egma_ik_",
      displaySuffix: "N3P4",
    });
    await resolveInferenceKey(hashed(secret));
    // The write is deliberately not awaited by the caller, so the read that
    // observes it waits for it here instead.
    await eventuallyStamped(created.id);

    const listed = (await listInferenceKeys(actingAsAcme())).find(
      (key) => key.id === created.id,
    );
    expect(listed?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("answers nothing once it is revoked, read from the row rather than a cache", async () => {
    const secret = "egma_ik_sentinel-revoked-Q5R6";
    const created = await createInferenceKey(actingAsAcme(), {
      name: "Retired",
      hash: hashed(secret),
      prefix: "egma_ik_",
      displaySuffix: "Q5R6",
    });

    expect(await resolveInferenceKey(hashed(secret))).toBeDefined();

    const revoked = await revokeInferenceKey(actingAsAcme(), created.id);
    expect(revoked?.revokedAt).toBeInstanceOf(Date);

    expect(await resolveInferenceKey(hashed(secret))).toBeUndefined();
  });

  it("leaves the other keys of the same organization working, which is what makes rotation overlap", async () => {
    const older = "egma_ik_sentinel-rotate-old-S7T8";
    const newer = "egma_ik_sentinel-rotate-new-V9W0";
    const first = await createInferenceKey(actingAsAcme(), {
      name: "Before rotation",
      hash: hashed(older),
      prefix: "egma_ik_",
      displaySuffix: "S7T8",
    });
    await createInferenceKey(actingAsAcme(), {
      name: "After rotation",
      hash: hashed(newer),
      prefix: "egma_ik_",
      displaySuffix: "V9W0",
    });

    expect(await resolveInferenceKey(hashed(newer))).toBeDefined();
    await revokeInferenceKey(actingAsAcme(), first.id);

    expect(await resolveInferenceKey(hashed(older))).toBeUndefined();
    expect(await resolveInferenceKey(hashed(newer))).toBeDefined();
  });

  it("cannot be revoked from another customer's account", async () => {
    const secret = "egma_ik_sentinel-not-yours-X1Y2";
    const created = await createInferenceKey(actingAsAcme(), {
      name: "Acme's",
      hash: hashed(secret),
      prefix: "egma_ik_",
      displaySuffix: "X1Y2",
    });

    expect(await revokeInferenceKey(actingAsGlobex(), created.id)).toBeUndefined();
    expect(await resolveInferenceKey(hashed(secret))).toBeDefined();
  });
});

describe("a self-hosted organization connecting one", () => {
  it("reads back Connected and a safe hint, and never the key", async () => {
    await connectManagedAccess(actingAsAcme(), {
      key: CLOUD_KEY,
      cloudOrganizationId: globex.organization,
    });

    const read = await readManagedAccessConnection(actingAsAcme());
    expect(read.connected).toBe(true);
    expect(read.hint).toBe(CLOUD_KEY.slice(-4));
    expect(read.cloudOrganizationId).toBe(globex.organization);
    expect(JSON.stringify(read)).not.toContain(CLOUD_KEY);
  });

  it("seals it, so the column holds ciphertext and not the key", async () => {
    const envelope = await storedEnvelope(acme.organization);

    expect(envelope).toBeDefined();
    expect(envelope).not.toContain(CLOUD_KEY);
    expect(envelope).toMatch(/^v1\./);
  });

  it("refuses a key owned by another Egma Cloud organization while the binding stands", async () => {
    await expect(
      connectManagedAccess(actingAsAcme(), {
        key: OTHER_CLOUD_KEY,
        cloudOrganizationId: acme.organization,
      }),
    ).rejects.toBeInstanceOf(ManagedAccessBoundElsewhereError);

    const read = await readManagedAccessConnection(actingAsAcme());
    expect(read.hint).toBe(CLOUD_KEY.slice(-4));
  });

  it("replaces a key from the same Egma Cloud organization, which is ordinary rotation", async () => {
    await connectManagedAccess(actingAsAcme(), {
      key: OTHER_CLOUD_KEY,
      cloudOrganizationId: globex.organization,
    });

    expect((await readManagedAccessConnection(actingAsAcme())).hint).toBe(
      OTHER_CLOUD_KEY.slice(-4),
    );
  });

  it("is an administrator's to connect and disconnect, and nobody else's", async () => {
    for (const role of ["member", "viewer"] as const) {
      await expect(
        connectManagedAccess(actingAsAcme(role), {
          key: CLOUD_KEY,
          cloudOrganizationId: globex.organization,
        }),
      ).rejects.toBeInstanceOf(NotPermittedError);
      await expect(
        disconnectManagedAccess(actingAsAcme(role)),
      ).rejects.toBeInstanceOf(NotPermittedError);
    }
  });

  it("is another customer's business and not readable across the boundary", async () => {
    expect(await readManagedAccessConnection(actingAsGlobex())).toEqual({
      connected: false,
      hint: null,
      cloudOrganizationId: null,
      updatedAt: null,
    });
  });
});

describe("the credential one claim is prepared with", () => {
  it("is opened for the simulator and for the grading engine", async () => {
    for (const asking of [theSimulatorInAcme(), theEngineInAcme()]) {
      const resolved = await resolveManagedAccess(asking);
      expect(resolved.gatewayAddress).toBe(GATEWAY);
      expect(resolved.credential).toBe(OTHER_CLOUD_KEY);
    }
  });

  it("is refused to a person, at every role including admin", async () => {
    for (const role of ["admin", "member", "viewer"] as const) {
      await expect(resolveManagedAccess(actingAsAcme(role))).rejects.toThrow(
        /simulator or its grading engine/,
      );
    }
  });

  it("is hosted Egma's own signed credential where nothing was pasted", async () => {
    standingIn(HOSTED);

    const resolved = await resolveManagedAccess(theSimulatorInAcme());

    expect(resolved.gatewayAddress).toBe(GATEWAY);
    expect(resolved.credential.startsWith(INTERNAL_GATEWAY_CREDENTIAL_PREFIX)).toBe(
      true,
    );
    // The organization travels inside the signature rather than beside it, and
    // the signing key is never any part of what goes out.
    expect(resolved.credential).not.toContain(INTERNAL_KEY);
    expect(resolved.credential).not.toContain(OTHER_CLOUD_KEY);
  });

  it("says which organization it is for, so hosted work is not one deployment-wide credential", async () => {
    standingIn(HOSTED);

    const forAcme = await resolveManagedAccess(theSimulatorInAcme());
    const forGlobex = await resolveManagedAccess({
      userId: "simulator",
      organizationId: globex.organization,
      projectId: globex.project,
      role: "viewer",
      via: "simulator",
    });

    expect(forAcme.credential).not.toBe(forGlobex.credential);
  });

  it("says an administrator has one thing to connect, when nothing is connected", async () => {
    await expect(resolveManagedAccess(theSimulatorInGlobex())).rejects.toBeInstanceOf(
      ManagedAccessNotConnectedError,
    );
  });

  it("says the deployment is misconfigured, when nobody told it where the gateway is", async () => {
    standingIn({ hosted: false, gatewayAddress: undefined, internalGatewayKey: undefined });

    await expect(resolveManagedAccess(theSimulatorInAcme())).rejects.toBeInstanceOf(
      ManagedAccessUnavailableError,
    );
  });
});

function theSimulatorInGlobex(): AuthContext {
  return {
    userId: "simulator",
    organizationId: globex.organization,
    projectId: globex.project,
    role: "viewer",
    via: "simulator",
  };
}

describe("choosing managed access", () => {
  it("is refused on a self-hosted deployment with nothing connected", async () => {
    expect(await managedAccessAvailable(actingAsGlobex())).toBe(false);
    await expect(
      setModelAccess(actingAsGlobex(), "managed"),
    ).rejects.toBeInstanceOf(ManagedAccessNotConnectedError);
  });

  it("lands on a self-hosted deployment once a key is connected", async () => {
    expect(await managedAccessAvailable(actingAsAcme())).toBe(true);

    const chosen = await setModelAccess(actingAsAcme(), "managed");
    expect(chosen.mode).toBe("managed");
    expect((await readModelAccess(actingAsAcme())).mode).toBe("managed");
  });

  it("is always available on hosted Egma, where there is nothing to connect", async () => {
    standingIn(HOSTED);

    expect(await managedAccessAvailable(actingAsGlobex())).toBe(true);
    expect((await setModelAccess(actingAsGlobex(), "managed")).mode).toBe(
      "managed",
    );
  });
});

describe("disconnecting", () => {
  it("takes the key away and leaves the access mode exactly as it was", async () => {
    expect((await readModelAccess(actingAsAcme())).mode).toBe("managed");

    expect(await disconnectManagedAccess(actingAsAcme())).toBe(true);

    expect((await readManagedAccessConnection(actingAsAcme())).connected).toBe(
      false,
    );
    // Deliberately unchanged: the next claim lands as a visible infrastructure
    // error naming what to reconnect, rather than this quietly deciding
    // somebody's access mode for them.
    expect((await readModelAccess(actingAsAcme())).mode).toBe("managed");
  });

  it("frees the binding, so another Egma Cloud organization's key can be connected", async () => {
    await connectManagedAccess(actingAsAcme(), {
      key: OTHER_CLOUD_KEY,
      cloudOrganizationId: acme.organization,
    });

    expect((await readManagedAccessConnection(actingAsAcme())).cloudOrganizationId).toBe(
      acme.organization,
    );
  });

  it("answers false where there was nothing to disconnect", async () => {
    await disconnectManagedAccess(actingAsAcme());
    expect(await disconnectManagedAccess(actingAsAcme())).toBe(false);
  });
});
