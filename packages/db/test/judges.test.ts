import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getJudgeConfiguration,
  NotPermittedError,
  resolveJudgeKey,
  setJudgeConfiguration,
  type AuthContext,
  type Role,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The project's default judge, and the secret behind it.
 *
 * Every assertion goes through the access functions — the seam — except the
 * reads of the raw `credentials` column, which bypass the module on purpose:
 * the claim under test is that what the module writes is ciphertext and what it
 * answers never includes the key, and only a read the module cannot dress up
 * can say so. That is the connection factory's arrangement, verbatim, because
 * this is the same secret problem one table over.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const grace = newId("usr");

const A_KEY = "sk-judge-secret-A1B2C3D4WXYZ";

function actingAsAcme(role: Role = "admin"): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
    via: "session",
  };
}

/** What a grading claim resolves to: no person, and `engine` on its face. */
function theEngineInAcme(projectId = acme.project): AuthContext {
  return {
    userId: "engine",
    organizationId: acme.organization,
    projectId,
    role: "viewer",
    via: "engine",
  };
}

beforeAll(async () => {
  database = await createConnectedDatabase("judges");
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

describe("setting a project's judge", () => {
  it("answers the provider, the model, a reference and a hint — never the key", async () => {
    const set = await setJudgeConfiguration(actingAsAcme(), {
      provider: "openai",
      model: "gpt-4.1-mini",
      key: A_KEY,
    });

    expect(set).toMatchObject({
      projectId: acme.project,
      provider: "openai",
      model: "gpt-4.1-mini",
      keyReference: acme.project,
      keyHint: "WXYZ",
    });
    expect(JSON.stringify(set)).not.toContain("sk-judge-secret");
  });

  it("lands on the organization's credential as a v1. envelope, not as the key", async () => {
    await setJudgeConfiguration(actingAsAcme(), {
      provider: "openai",
      model: "gpt-4.1-mini",
      key: A_KEY,
    });

    const { rows } = await database.sql<{
      credentials: string;
      credentials_hint: string;
    }>(
      `select c.credentials, c.credentials_hint
         from judge_configuration jc
         join judge_credential c on c.id = jc.credential_id
        where jc.project_id = $1`,
      [acme.project],
    );

    expect(rows[0]?.credentials).toMatch(
      /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
    expect(rows[0]?.credentials).not.toContain("sk-judge-secret");
    expect(rows[0]?.credentials_hint).toBe("WXYZ");
  });

  it("replaces rather than accumulates: one judge per project", async () => {
    await setJudgeConfiguration(actingAsAcme(), {
      provider: "openai",
      model: "gpt-4.1-mini",
      key: A_KEY,
    });
    const rewritten = await setJudgeConfiguration(actingAsAcme(), {
      provider: "openai",
      model: "gpt-4.1",
      key: "sk-judge-rotated-99998888",
    });

    expect(rewritten.model).toBe("gpt-4.1");
    expect(rewritten.keyHint).toBe("8888");

    const { rows } = await database.sql<{ count: string }>(
      "select count(*)::text as count from judge_configuration where project_id = $1",
      [acme.project],
    );
    expect(rows[0]?.count).toBe("1");
    expect(await resolveJudgeKey(theEngineInAcme(), acme.project)).toBe(
      "sk-judge-rotated-99998888",
    );
  });

  it("refuses a provider egma cannot ask, naming the ones it can", async () => {
    await expect(
      setJudgeConfiguration(actingAsAcme(), {
        provider: "anthropic",
        model: "claude",
        key: A_KEY,
      }),
    ).rejects.toThrow(/not a judge provider Egma knows/);
  });

  it("refuses a key too short to be one any provider issued", async () => {
    await expect(
      setJudgeConfiguration(actingAsAcme(), {
        provider: "openai",
        model: "gpt-4.1-mini",
        key: "sk-1",
      }),
    ).rejects.toThrow(/at least 8 characters/);
  });

  it("is an admin's act, on the row that already names provider credentials", async () => {
    await expect(
      setJudgeConfiguration(actingAsAcme("member"), {
        provider: "openai",
        model: "gpt-4.1-mini",
        key: A_KEY,
      }),
    ).rejects.toThrow(NotPermittedError);
  });
});

describe("reading a project's judge", () => {
  it("is nothing at all for a project that configured none", async () => {
    const grace_ = {
      userId: grace,
      organizationId: globex.organization,
      projectId: globex.project,
      role: "admin",
      via: "session",
    } as const;

    expect(await getJudgeConfiguration(grace_)).toBeUndefined();
  });

  it("never carries the key, whatever the caller's role", async () => {
    await setJudgeConfiguration(actingAsAcme(), {
      provider: "openai",
      model: "gpt-4.1-mini",
      key: A_KEY,
    });

    for (const role of ["viewer", "member", "admin"] as const) {
      const read = await getJudgeConfiguration(actingAsAcme(role));
      expect(read).toBeDefined();
      expect(read).not.toHaveProperty("key");
      expect(JSON.stringify(read)).not.toContain("sk-judge-secret");
      expect(read?.keyHint).toBe("WXYZ");
    }
  });
});

describe("resolving the key", () => {
  beforeAll(async () => {
    await setJudgeConfiguration(actingAsAcme(), {
      provider: "openai",
      model: "gpt-4.1-mini",
      key: A_KEY,
    });
  });

  it("round-trips through the one door egma's engine knocks on", async () => {
    expect(await resolveJudgeKey(theEngineInAcme(), acme.project)).toBe(A_KEY);
  });

  /**
   * The narrow gate, and the reason it is not a role: judging is the only thing
   * egma does with a judge key, and the only thing that judges is the grading
   * service. A person's session is refused at every role, so no product surface
   * can grow into one that hands a customer their own key back.
   */
  it("is refused to every context that did not come from a grading claim", async () => {
    for (const role of ["viewer", "member", "admin"] as const) {
      await expect(
        resolveJudgeKey(actingAsAcme(role), acme.project),
      ).rejects.toThrow(/grading engine/);
    }
  });

  it("is refused a reference naming a project the claim is not for", async () => {
    await expect(
      resolveJudgeKey(theEngineInAcme(), globex.project),
    ).rejects.toThrow(/names another/);
  });

  it("is nothing at all when the project configured no judge", async () => {
    const engineInGlobex: AuthContext = {
      userId: "engine",
      organizationId: globex.organization,
      projectId: globex.project,
      role: "viewer",
      via: "engine",
    };
    expect(await resolveJudgeKey(engineInGlobex, globex.project)).toBeUndefined();
  });
});
