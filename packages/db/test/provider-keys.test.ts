import { newId } from "@egma/ids";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createProviderFundingReceipt,
  readProviderFundingReceipt,
  readProviderKeys,
  putProviderKey,
  deleteProviderKey,
  resolveProviderKeysForWork,
  listCustomerFundedProviders,
  type AuthContext,
} from "@egma/db";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization } from "./support/tenancy.ts";
let database: MigratedDatabase;
const organizationId = newId("org");
const otherId = newId("org");
const auth: AuthContext = {
  organizationId,
  projectId: undefined,
  userId: newId("usr"),
  role: "admin",
  via: "session",
};
beforeAll(async () => {
  database = await createConnectedDatabase("provider_keys");
  await seedOrganization(database, organizationId, []);
  await seedOrganization(database, otherId, []);
});
afterAll(async () => {
  await database.close();
  await database.drop();
});
it("keeps organization keys sealed and unreadable to people while resolving them for scoped work", async () => {
  expect(
    (await readProviderKeys(auth)).providers.every(
      (p) => p.credential === null,
    ),
  ).toBe(true);
  const written = await putProviderKey(
    auth,
    "openai",
    "test-customer-openai-secret-ABCD",
    null,
  );
  expect(written.credential?.hint).toBe("••••ABCD");
  expect(JSON.stringify(await readProviderKeys(auth))).not.toContain(
    "test-customer",
  );
  const stored = await database.sql<{ credentials: string }>(
    "select credentials from provider_key",
  );
  expect(stored.rows[0]?.credentials).not.toContain("test-customer");
  expect(await listCustomerFundedProviders(organizationId)).toEqual(["openai"]);
  expect(
    await resolveProviderKeysForWork({ ...auth, via: "engine" }, ["openai"]),
  ).toMatchObject({
    openai: {
      key: "test-customer-openai-secret-ABCD",
      credentialRef: written.credential?.revision,
    },
  });
  expect(
    await resolveProviderKeysForWork(
      { ...auth, organizationId: otherId, via: "engine" },
      ["openai"],
    ),
  ).toEqual({});
  await expect(resolveProviderKeysForWork(auth, ["openai"])).rejects.toThrow();
  await expect(
    putProviderKey(
      { ...auth, role: "member" },
      "openai",
      "test-other-secret",
      written.credential!.revision,
    ),
  ).rejects.toThrow();
  await expect(
    putProviderKey(auth, "openai", "test-other-secret", null),
  ).rejects.toThrow();
  const rotated = await putProviderKey(
    auth,
    "openai",
    "test-customer-openai-new-WXYZ",
    written.credential!.revision,
  );
  await expect(
    deleteProviderKey(auth, "openai", written.credential!.revision),
  ).rejects.toThrow();
  expect(
    (await deleteProviderKey(auth, "openai", rotated.credential!.revision))
      .credential,
  ).toBeNull();
  expect(await listCustomerFundedProviders(organizationId)).toEqual([]);
});

it("keeps the actual payer after rotation and rejects a receipt from another organization, provider or claim", () => {
  const work = { ...auth, via: "simulator" as const };
  const claim = {
    simulationId: newId("sim"),
    claimedAt: new Date("2026-09-08T10:00:00Z"),
    provider: "openai" as const,
  };
  const receipt = createProviderFundingReceipt(work, {
    ...claim,
    credentialRef: newId("rev"),
  });
  expect(readProviderFundingReceipt(work, claim, receipt).paymentSource).toBe(
    "customer",
  );
  expect(() =>
    readProviderFundingReceipt(
      { ...work, organizationId: otherId },
      claim,
      receipt,
    ),
  ).toThrow();
  expect(() =>
    readProviderFundingReceipt(
      work,
      { ...claim, provider: "deepgram" },
      receipt,
    ),
  ).toThrow();
  expect(() =>
    readProviderFundingReceipt(
      work,
      { ...claim, claimedAt: new Date("2026-09-08T10:01:00Z") },
      receipt,
    ),
  ).toThrow();
  expect(() =>
    readProviderFundingReceipt(work, claim, receipt.slice(0, -5) + "WRONG"),
  ).toThrow();
});
