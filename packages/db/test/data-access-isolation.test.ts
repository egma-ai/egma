import { randomUUID } from "node:crypto";

import { newId } from "@egma/ids";
import {
  createApiKey,
  createProject,
  instanceIsClaimed,
  listApiKeys,
  listMembers,
  listProjects,
  membershipsOf,
  ProjectOutsideOrganizationError,
  projectsOf,
  provisionOrganization,
  readOrganization,
  readOrganizationSettings,
  readProject,
  revokeApiKey,
  updateOrganizationSettings,
  type AuthContext,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";

/**
 * Two organizations exist in every test in this file, because a test with one
 * organization cannot fail the way that matters: a query missing its tenancy
 * predicate returns exactly the right answer when there is only one customer's
 * data to return.
 *
 * These go through the data-access module, which is the seam the isolation
 * guarantee lives at. Raw SQL appears only to check what actually landed in a
 * table, never to set anything up that the module could have set up — asking
 * the module whether the module worked would prove nothing.
 *
 * One thing deliberately not asserted here: that a caller cannot hand in an
 * `AuthContext` naming somebody else's organization. Nothing at this seam could
 * stop that. The context is resolved from the credential rather than from the
 * request, and *that* is what the authentication path has to get right.
 */

let database: MigratedDatabase;

type Customer = {
  readonly auth: AuthContext;
  readonly organizationId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly slug: string;
};

let acme: Customer;
let globex: Customer;
let acmeOutboundProjectId: string;
let acmeApiKeyId: string;
let globexApiKeyId: string;

async function provision(slug: string, email: string): Promise<Customer> {
  const userId = newId("usr");
  await database.sql('insert into "user" (id, email) values ($1, $2)', [
    userId,
    email,
  ]);

  const provisioned = await provisionOrganization({
    ownerUserId: userId,
    organizationName: slug,
    organizationSlug: slug,
    projectName: "Default",
    projectSlug: "default",
  });

  return {
    userId,
    slug,
    organizationId: provisioned.organizationId,
    projectId: provisioned.projectId,
    auth: {
      userId,
      organizationId: provisioned.organizationId,
      projectId: provisioned.projectId,
      role: provisioned.membership.role,
      via: "session",
    },
  };
}

function secret(): { hash: string; prefix: string; displaySuffix: string } {
  return {
    hash: randomUUID(),
    prefix: "egma_sk_",
    displaySuffix: randomUUID().slice(0, 4),
  };
}

beforeAll(async () => {
  database = await createConnectedDatabase("access");

  acme = await provision("acme", "ada@acme.example");
  globex = await provision("globex", "grace@globex.example");

  const outbound = await createProject(acme.auth, {
    name: "Outbound",
    slug: "outbound",
  });
  acmeOutboundProjectId = outbound.id;

  acmeApiKeyId = (
    await createApiKey(acme.auth, { ...secret(), name: "acme terminal" })
  ).id;
  globexApiKeyId = (
    await createApiKey(globex.auth, { ...secret(), name: "globex terminal" })
  ).id;

  await updateOrganizationSettings(acme.auth, { retentionDays: 30 });
  await updateOrganizationSettings(globex.auth, { retentionDays: 90 });
});

afterAll(async () => {
  await database.drop();
});

describe("every exported read, called as one customer", () => {
  const reads: readonly [string, (auth: AuthContext) => Promise<unknown>][] = [
    ["readOrganization", readOrganization],
    ["readOrganizationSettings", readOrganizationSettings],
    ["readProject", readProject],
    ["listProjects", listProjects],
    ["listMembers", listMembers],
    ["listApiKeys", listApiKeys],
  ];

  it.each(reads)("returns none of the other customer's rows: %s", async (_name, read) => {
    const asAcme = JSON.stringify(await read(acme.auth));
    const asGlobex = JSON.stringify(await read(globex.auth));

    // Neither call may come back empty, or what follows passes for the wrong
    // reason.
    expect(asAcme).toContain(acme.organizationId);
    expect(asGlobex).toContain(globex.organizationId);

    expect(asAcme).not.toContain(globex.organizationId);
    expect(asAcme).not.toContain(globex.projectId);
    expect(asAcme).not.toContain(globex.userId);

    expect(asGlobex).not.toContain(acme.organizationId);
    expect(asGlobex).not.toContain(acme.projectId);
    expect(asGlobex).not.toContain(acme.userId);
  });
});

describe("the customer", () => {
  it("is read from the credential, and there is no id to pass", async () => {
    expect(await readOrganization(acme.auth)).toMatchObject({
      id: acme.organizationId,
      slug: "acme",
    });
    expect(await readOrganization(globex.auth)).toMatchObject({
      id: globex.organizationId,
      slug: "globex",
    });
  });

  it("has settings only it can see", async () => {
    expect(await readOrganizationSettings(acme.auth)).toMatchObject({
      organizationId: acme.organizationId,
      retentionDays: 30,
    });
    expect(await readOrganizationSettings(globex.auth)).toMatchObject({
      organizationId: globex.organizationId,
      retentionDays: 90,
    });
  });

  it("cannot write over the other customer's settings", async () => {
    await updateOrganizationSettings(acme.auth, {
      retentionDays: 7,
      dataResidency: "eu",
    });

    expect(await readOrganizationSettings(globex.auth)).toMatchObject({
      retentionDays: 90,
      dataResidency: null,
    });

    const { rows } = await database.sql<{
      organization_id: string;
      retention_days: number;
    }>("select organization_id, retention_days from organization_settings order by organization_id");
    expect(
      rows.find((row) => row.organization_id === globex.organizationId),
    ).toMatchObject({ retention_days: 90 });
  });
});

describe("projects", () => {
  it("are listed for the whole organization, because two of them are queryable together", async () => {
    const acmeProjects = await listProjects(acme.auth);
    expect(acmeProjects.map((row) => row.slug).sort()).toEqual([
      "default",
      "outbound",
    ]);
    for (const row of acmeProjects) {
      expect(row.organizationId).toBe(acme.organizationId);
    }

    expect((await listProjects(globex.auth)).map((row) => row.slug)).toEqual([
      "default",
    ]);
  });

  it("resolve to the one the caller is acting in, which also comes from the credential", async () => {
    expect(await readProject(acme.auth)).toMatchObject({
      id: acme.projectId,
      organizationId: acme.organizationId,
    });
    expect(await readProject(globex.auth)).toMatchObject({
      id: globex.projectId,
      organizationId: globex.organizationId,
    });
  });

  it("are not reachable by naming another customer's project", async () => {
    const acmeActingOnGlobexProject: AuthContext = {
      ...acme.auth,
      projectId: globex.projectId,
    };

    expect(await readProject(acmeActingOnGlobexProject)).toBeUndefined();
  });

  it("are created inside the caller's organization and nowhere else", async () => {
    const before = await listProjects(globex.auth);

    const created = await createProject(acme.auth, {
      name: "Support",
      slug: "support",
    });

    expect(created.organizationId).toBe(acme.organizationId);
    expect(created.createdBy).toBe(acme.userId);
    expect(await listProjects(globex.auth)).toEqual(before);
  });

  it("share a name across two customers without colliding", async () => {
    const created = await createProject(globex.auth, {
      name: "Support",
      slug: "support",
    });

    expect(created.organizationId).toBe(globex.organizationId);
    expect(created.slug).toBe("support");
  });
});

describe("who is in the organization", () => {
  it("is answered for the caller's organization only", async () => {
    expect(await listMembers(acme.auth)).toEqual([
      {
        organizationId: acme.organizationId,
        userId: acme.userId,
        email: "ada@acme.example",
        name: null,
        role: "admin",
        deactivatedAt: null,
        joinedAt: expect.any(Date),
      },
    ]);
    expect(await listMembers(globex.auth)).toEqual([
      {
        organizationId: globex.organizationId,
        userId: globex.userId,
        email: "grace@globex.example",
        name: null,
        role: "admin",
        deactivatedAt: null,
        joinedAt: expect.any(Date),
      },
    ]);
  });
});

describe("which projects an organization has", () => {
  it("is answered for that organization only, so a context can be built from it", async () => {
    expect((await projectsOf(globex.organizationId)).map((row) => row.slug)).toEqual(
      ["default", "support"],
    );

    for (const row of await projectsOf(acme.organizationId)) {
      expect(row.organizationId).toBe(acme.organizationId);
    }
  });

  it("puts the project provisioning made first, because identifiers sort by mint time", async () => {
    const [first] = await projectsOf(acme.organizationId);
    expect(first?.id).toBe(acme.projectId);
  });

  it("returns nothing for an organization that is not there", async () => {
    expect(await projectsOf(newId("org"))).toEqual([]);
  });
});

describe("whether anybody has signed up here yet", () => {
  it("is true once a customer exists, which is what closes open signup", async () => {
    expect(await instanceIsClaimed()).toBe(true);
  });
});

describe("which organization a person is in", () => {
  it("is answered by one resolver that takes the person and returns their memberships", async () => {
    expect(await membershipsOf(acme.userId)).toEqual([
      { organizationId: acme.organizationId, userId: acme.userId, role: "admin" },
    ]);
    expect(await membershipsOf(globex.userId)).toEqual([
      {
        organizationId: globex.organizationId,
        userId: globex.userId,
        role: "admin",
      },
    ]);
  });

  it("returns a list, so no caller can be written as though there is exactly one", async () => {
    const memberships = await membershipsOf(acme.userId);
    expect(Array.isArray(memberships)).toBe(true);
  });

  it("returns nothing at all for a person who is in none", async () => {
    const stranger = newId("usr");
    await database.sql('insert into "user" (id, email) values ($1, $2)', [
      stranger,
      "nobody@example.com",
    ]);

    expect(await membershipsOf(stranger)).toEqual([]);
  });
});

describe("api keys", () => {
  it("are listed for the caller's organization, including the ones naming no project", async () => {
    const keys = await listApiKeys(acme.auth);

    expect(keys.map((key) => key.id)).toContain(acmeApiKeyId);
    expect(keys.map((key) => key.id)).not.toContain(globexApiKeyId);
    for (const key of keys) {
      expect(key.organizationId).toBe(acme.organizationId);
    }
  });

  it("record their creator, because a key resolves that person's current role", async () => {
    const [key] = await listApiKeys(globex.auth);
    expect(key?.createdByUserId).toBe(globex.userId);
  });

  it("never hand back the hash they were stored under", async () => {
    const keys = await listApiKeys(acme.auth);
    for (const key of keys) {
      expect(Object.keys(key)).not.toContain("hash");
    }
  });

  it("may name a project of the caller's own organization", async () => {
    const key = await createApiKey(acme.auth, {
      ...secret(),
      projectId: acmeOutboundProjectId,
    });

    expect(key).toMatchObject({
      organizationId: acme.organizationId,
      projectId: acmeOutboundProjectId,
      scope: "project",
    });
  });

  it("are refused before reaching the database when they name another customer's project", async () => {
    const { rows: before } = await database.sql<{ count: string }>(
      "select count(*) as count from api_key",
    );

    await expect(
      createApiKey(acme.auth, { ...secret(), projectId: globex.projectId }),
    ).rejects.toBeInstanceOf(ProjectOutsideOrganizationError);

    const { rows: after } = await database.sql<{ count: string }>(
      "select count(*) as count from api_key",
    );
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it("cannot be revoked by the other customer", async () => {
    expect(await revokeApiKey(acme.auth, globexApiKeyId)).toBeUndefined();

    const { rows } = await database.sql<{ revoked_at: Date | null }>(
      "select revoked_at from api_key where id = $1",
      [globexApiKeyId],
    );
    expect(rows[0]?.revoked_at).toBeNull();
  });

  it("are revoked by their own customer, and stay revoked", async () => {
    const revoked = await revokeApiKey(acme.auth, acmeApiKeyId);
    expect(revoked?.revokedAt).toBeInstanceOf(Date);

    // Already revoked, so there is nothing left to update.
    expect(await revokeApiKey(acme.auth, acmeApiKeyId)).toBeUndefined();
  });
});

describe("creating a customer", () => {
  it("makes the organization, its first project and the owner's membership together", async () => {
    const userId = newId("usr");
    await database.sql('insert into "user" (id, email) values ($1, $2)', [
      userId,
      "hedy@initech.example",
    ]);

    const provisioned = await provisionOrganization({
      ownerUserId: userId,
      organizationName: "Initech",
      organizationSlug: "initech",
      projectName: "Default",
      projectSlug: "default",
    });

    expect(provisioned.membership).toEqual({
      organizationId: provisioned.organizationId,
      userId,
      role: "admin",
    });

    const context: AuthContext = {
      userId,
      organizationId: provisioned.organizationId,
      projectId: provisioned.projectId,
      role: provisioned.membership.role,
      via: "session",
    };
    expect(await readProject(context)).toMatchObject({ slug: "default" });
  });

  it("leaves neither when it cannot finish", async () => {
    // A person already belongs to an organization, so the membership at the end
    // of the transaction is refused and the organization and project written
    // before it must go with it.
    await expect(
      provisionOrganization({
        ownerUserId: acme.userId,
        organizationName: "Second",
        organizationSlug: "second",
        projectName: "Default",
        projectSlug: "default",
      }),
    ).rejects.toThrow();

    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from organization where slug = 'second'",
    );
    expect(rows[0]?.count).toBe("0");

    const { rows: projects } = await database.sql<{ count: string }>(
      `select count(*) as count from project
        where created_by = $1 and slug = 'default'`,
      [acme.userId],
    );
    expect(projects[0]?.count).toBe("1");
  });
});
