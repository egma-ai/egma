import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMigratedDatabase,
  errorCodeOf,
  POSTGRES_ERROR,
  type MigratedDatabase,
} from "./support/database.ts";

/**
 * These tests write raw SQL on purpose. The constraints below exist to defend
 * the paths that never pass through the application — a migration script, a
 * bulk import, a manual fix at three in the morning — so a test that went
 * through the application could not reach them.
 *
 * Every test uses two organizations, because a test with one organization
 * cannot fail the way that matters.
 */

let database: MigratedDatabase;

const acme = { id: newId("org"), slug: "acme" };
const globex = { id: newId("org"), slug: "globex" };
const acmeProject = { id: newId("prj"), slug: "default" };
const globexProject = { id: newId("prj"), slug: "default" };
const ada = { id: newId("usr"), email: "ada@acme.example" };
const grace = { id: newId("usr"), email: "grace@globex.example" };

beforeAll(async () => {
  database = await createMigratedDatabase("tenancy");

  for (const organization of [acme, globex]) {
    await database.sql(
      "insert into organization (id, name, slug) values ($1, $2, $3)",
      [organization.id, organization.slug, organization.slug],
    );
  }
  for (const person of [ada, grace]) {
    await database.sql("insert into \"user\" (id, email) values ($1, $2)", [
      person.id,
      person.email,
    ]);
  }
  await database.sql(
    "insert into project (id, organization_id, name, slug, revision) values ($1, $2, $3, $4, $5)",
    [acmeProject.id, acme.id, "Default", acmeProject.slug, newId("rev")],
  );
  await database.sql(
    "insert into project (id, organization_id, name, slug, revision) values ($1, $2, $3, $4, $5)",
    [globexProject.id, globex.id, "Default", globexProject.slug, newId("rev")],
  );
});

afterAll(async () => {
  await database.drop();
});

async function insertApiKey(
  organizationId: string,
  projectId: string | null,
  createdBy: string,
): Promise<void> {
  await database.sql(
    `insert into api_key
       (id, organization_id, project_id, scope, hash, prefix, display_suffix, created_by_user_id)
     values ($1, $2, $3, $4, $5, 'egma_sk_', $6, $7)`,
    [
      newId("key"),
      organizationId,
      projectId,
      projectId === null ? "organization" : "project",
      newId("key"),
      "wxyz",
      createdBy,
    ],
  );
}

async function rawProjectKey(
  organizationId: string,
  projectId: string,
  createdBy: string,
): Promise<string> {
  const id = newId("key");
  await database.sql(
    `insert into api_key
       (id, organization_id, project_id, scope, hash, prefix, display_suffix, created_by_user_id)
     values ($1, $2, $3, 'project', $4, 'egma_sk_', 'wxyz', $5)`,
    [id, organizationId, projectId, newId("key"), createdBy],
  );
  return id;
}

async function rawAgent(
  organizationId: string,
  projectId: string,
  createdBy: string,
  platform: "livekit" | "retell",
): Promise<string> {
  const id = newId("agt");
  await database.sql(
    `insert into agent
       (id, organization_id, project_id, name, agent_platform, created_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, organizationId, projectId, id, platform, createdBy],
  );
  return id;
}

describe("pairing one customer with another customer's project", () => {
  it("is refused by Postgres, not by the application", async () => {
    await expect(
      insertApiKey(acme.id, globexProject.id, ada.id),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });

  it("still allows the pairing that is real", async () => {
    await expect(
      insertApiKey(acme.id, acmeProject.id, ada.id),
    ).resolves.toBeUndefined();
  });

  it("allows an organization-scoped row that names no project", async () => {
    await expect(insertApiKey(globex.id, null, grace.id)).resolves.toBeUndefined();
  });

  it("is refused even when the project id is real and only the pairing is not", async () => {
    // The single-column foreign key would be satisfied by this row: both the
    // organization and the project exist. Only the pair does not.
    const { rows } = await database.sql<{ exists: boolean }>(
      "select exists (select 1 from project where id = $1) as exists",
      [globexProject.id],
    );
    expect(rows[0]?.exists).toBe(true);

    await expect(
      insertApiKey(acme.id, globexProject.id, ada.id),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });
});

describe("an identifier carrying the wrong prefix for its table", () => {
  it("is refused by the project table", async () => {
    await expect(
      database.sql(
        "insert into project (id, organization_id, name, slug, revision) values ($1, $2, $3, $4, $5)",
        [newId("usr"), acme.id, "Wrong", "wrong-prefix", newId("rev")],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });

  it("is refused by the organization table", async () => {
    await expect(
      database.sql("insert into organization (id, name, slug) values ($1, $2, $3)", [
        newId("prj"),
        "Wrong",
        "wrong-prefix-org",
      ]),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });

  it("is refused when the body is the right shape but not Crockford base32", async () => {
    await expect(
      database.sql("insert into \"user\" (id, email) values ($1, $2)", [
        "usr_IIIIIIIIIIIIIIIIIIIIIIIIII",
        "excluded-letters@acme.example",
      ]),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });

  it("is refused when the body is the wrong length", async () => {
    await expect(
      database.sql("insert into \"user\" (id, email) values ($1, $2)", [
        "usr_0123456789",
        "too-short@acme.example",
      ]),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });
});

describe("a name is unique within its scope and nowhere wider", () => {
  it("accepts the same name in two different customers' accounts", async () => {
    const { rows } = await database.sql<{ slug: string }>(
      "select slug from project where id in ($1, $2)",
      [acmeProject.id, globexProject.id],
    );
    expect(rows.map((row) => row.slug)).toEqual(["default", "default"]);
  });

  it("refuses the same name twice inside one customer's account", async () => {
    await expect(
      database.sql(
        "insert into project (id, organization_id, name, slug, revision) values ($1, $2, $3, $4, $5)",
        [newId("prj"), acme.id, "Default again", acmeProject.slug, newId("rev")],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.uniqueViolation,
    );
  });

  it("treats two addresses differing only in case as the same person", async () => {
    await expect(
      database.sql("insert into \"user\" (id, email) values ($1, $2)", [
        newId("usr"),
        ada.email.toUpperCase(),
      ]),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.uniqueViolation,
    );
  });
});

describe("a second project in the same organization", () => {
  it("is accepted, because multi-project is a product change and not a migration", async () => {
    await expect(
      database.sql(
        "insert into project (id, organization_id, name, slug, revision) values ($1, $2, $3, $4, $5)",
        [newId("prj"), acme.id, "Outbound", "outbound", newId("rev")],
      ),
    ).resolves.toBeDefined();
  });

  it("is not blocked by any unique constraint on the organization column alone", async () => {
    const { rows } = await database.sql<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where tablename = 'project' and indexdef like '%UNIQUE%'`,
    );
    const uniqueOnOrganizationAlone = rows.filter((row) =>
      /\(organization_id\)/.test(row.indexdef),
    );
    expect(uniqueOnOrganizationAlone).toEqual([]);
  });
});

describe("belonging to an organization", () => {
  it("happens once per person, and a second row is refused by the database", async () => {
    await database.sql(
      "insert into membership (id, organization_id, user_id, role) values ($1, $2, $3, $4)",
      [newId("mbr"), acme.id, ada.id, "admin"],
    );

    await expect(
      database.sql(
        "insert into membership (id, organization_id, user_id, role) values ($1, $2, $3, $4)",
        [newId("mbr"), globex.id, ada.id, "admin"],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.uniqueViolation,
    );
  });

  it("carries one of the three roles and nothing else", async () => {
    await expect(
      database.sql(
        "insert into membership (id, organization_id, user_id, role) values ($1, $2, $3, $4)",
        [newId("mbr"), globex.id, grace.id, "superuser"],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });
});

describe("binding a LiveKit monitoring export key", () => {
  it("refuses a key from another project and customer", async () => {
    const acmeAgent = await rawAgent(
      acme.id,
      acmeProject.id,
      ada.id,
      "livekit",
    );
    const globexKey = await rawProjectKey(
      globex.id,
      globexProject.id,
      grace.id,
    );

    await expect(
      database.sql(
        "update agent set monitoring_export_api_key_id = $1 where id = $2",
        [globexKey, acmeAgent],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });

  it("allows LiveKit and refuses the same pointer on Retell", async () => {
    const acmeKey = await rawProjectKey(acme.id, acmeProject.id, ada.id);
    const retellAgent = await rawAgent(
      acme.id,
      acmeProject.id,
      ada.id,
      "retell",
    );
    const globexKey = await rawProjectKey(
      globex.id,
      globexProject.id,
      grace.id,
    );
    const globexAgent = await rawAgent(
      globex.id,
      globexProject.id,
      grace.id,
      "livekit",
    );

    await expect(
      database.sql(
        "update agent set monitoring_export_api_key_id = $1 where id = $2",
        [globexKey, globexAgent],
      ),
    ).resolves.toBeDefined();
    await expect(
      database.sql(
        "update agent set monitoring_export_api_key_id = $1 where id = $2",
        [acmeKey, retellAgent],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });

  it("allows one key on one agent and refuses it on a second", async () => {
    const acmeKey = await rawProjectKey(acme.id, acmeProject.id, ada.id);
    const first = await rawAgent(acme.id, acmeProject.id, ada.id, "livekit");
    const second = await rawAgent(acme.id, acmeProject.id, ada.id, "livekit");
    const globexKey = await rawProjectKey(
      globex.id,
      globexProject.id,
      grace.id,
    );
    const globexAgent = await rawAgent(
      globex.id,
      globexProject.id,
      grace.id,
      "livekit",
    );

    await database.sql(
      "update agent set monitoring_export_api_key_id = $1 where id = $2",
      [acmeKey, first],
    );
    await database.sql(
      "update agent set monitoring_export_api_key_id = $1 where id = $2",
      [globexKey, globexAgent],
    );
    await expect(
      database.sql(
        "update agent set monitoring_export_api_key_id = $1 where id = $2",
        [acmeKey, second],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.uniqueViolation,
    );
  });
});
