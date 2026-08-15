import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

/**
 * Signing up, over HTTP, against a real Postgres.
 *
 * This is the seam the flow actually has: nothing here passes through the
 * data-access module's own exported calls the way a tenancy test does, because
 * what is under test is the path from a form to a provisioned organization —
 * the provider's endpoint, the hook it fires, and the transaction underneath.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

async function signUp(
  body: Record<string, unknown>,
): Promise<ReturnType<TestApi["app"]["inject"]>> {
  return api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: body,
  });
}

describe("somebody with no account", () => {
  it("lands in an organization and a project that were created together", async () => {
    api = await createApi("signup_lands");

    const response = await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
      projectName: "Default",
    });

    expect(response.statusCode).toBe(201);
    const landed = response.json();
    expect(landed.organization.name).toBe("Acme");
    expect(landed.project.name).toBe("Default");
    expect(landed.organization.id).toMatch(/^org_/);
    expect(landed.project.id).toMatch(/^prj_/);
    expect(landed.userId).toMatch(/^usr_/);

    const { rows } = await api.database.sql<{
      organization_id: string;
      name: string;
    }>(
      `select p.organization_id, p.name
         from project p join organization o on o.id = p.organization_id
        where o.slug = 'acme'`,
    );
    expect(rows).toEqual([
      { organization_id: landed.organization.id, name: "Default" },
    ]);
  });

  it("becomes the admin of the organization they created", async () => {
    api = await createApi("signup_admin");

    const response = await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });
    expect(response.json().role).toBe("admin");

    const { rows } = await api.database.sql<{ role: string }>(
      "select role from membership",
    );
    expect(rows).toEqual([{ role: "admin" }]);
  });

  it("is signed in when they are done, with no verification step in the way", async () => {
    api = await createApi("signup_signed_in");

    const created = await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });

    // The cookie a person can see says egma. Which library set it is not
    // something a provider swap should make visible.
    expect(cookiesFrom(created.headers["set-cookie"])).toContain(
      "egma.session_token=",
    );

    const me = await api.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: cookiesFrom(created.headers["set-cookie"]) },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("ada@acme.example");
  });

  it("gets the project called Default when they name none", async () => {
    api = await createApi("signup_default_project");

    const response = await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });

    expect(response.json().project.name).toBe("Default");
  });

  it("is refused with no name for their organization, rather than given a blank one", async () => {
    api = await createApi("signup_needs_a_name");

    const response = await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "   ",
    });

    expect(response.statusCode).toBe(400);
    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*) as count from organization",
    );
    expect(rows[0]?.count).toBe("0");
  });

  /**
   * And an address that is not one is refused **in words about the address**.
   *
   * The auth provider's own sentence for this is `[body.email] Invalid email
   * address`, which names a field in its body schema — code rather than the
   * situation a person is in, and exactly what ADR-0007 says a refusal must not
   * be generated from. None of it reaches a caller: the sentence is egma's, and
   * it says what to look at.
   */
  it("is refused for an address that is not one, in egma's own words", async () => {
    api = await createApi("signup_bad_address");

    const response = await signUp({
      email: "not-an-email",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });

    expect(response.statusCode).toBe(400);
    const said = response.json() as { error: string; message: string };
    expect(said.error).toBe("signup_failed");
    expect(said.message).not.toContain("body.email");
    expect(said.message).toMatch(/email address/i);
  });
});

describe("the organization and its first project", () => {
  it("are one transaction, so a failure part-way leaves neither", async () => {
    api = await createApi("signup_atomic");

    // A forced failure, and it has to be forced: the organization is written
    // first and the project second, so nothing a person can type makes the
    // second one fail on its own. This makes the project refuse one name,
    // which puts the failure exactly where it has to be — after the
    // organization exists and before the transaction commits.
    await api.database.sql(
      "alter table project add constraint project_refuses_poison check (name <> 'Poison')",
    );

    const response = await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
      projectName: "Poison",
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    for (const table of ["organization", "project", "membership"]) {
      const { rows } = await api.database.sql<{ count: string }>(
        `select count(*) as count from ${table}`,
      );
      expect(rows[0]?.count, `${table} should be empty`).toBe("0");
    }

    // Signup fully succeeded or fully failed, so the email address is not
    // quietly taken by an account that never worked.
    const { rows: users } = await api.database.sql<{ count: string }>(
      'select count(*) as count from "user"',
    );
    expect(users[0]?.count).toBe("0");

    await api.database.sql(
      "alter table project drop constraint project_refuses_poison",
    );

    // And the person can try again, because nothing of theirs is in the way.
    const second = await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });
    expect(second.statusCode).toBe(201);
  });

  it("do not collide when two customers pick the same name", async () => {
    api = await createApi("signup_same_name");

    const first = await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });
    const second = await signUp({
      email: "grace@acme.co",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    const { rows } = await api.database.sql<{ slug: string }>(
      "select slug from organization order by slug",
    );
    expect(rows).toEqual([{ slug: "acme" }, { slug: "acme-2" }]);
  });

  it("refuse out loud rather than hang when every name derived from one is taken", async () => {
    api = await createApi("signup_name_exhausted");

    for (const slug of ["acme", "acme-2", "acme-3", "acme-4", "acme-5"]) {
      await api.database.sql(
        "insert into organization (id, name, slug) values ($1, $2, $2)",
        [newId("org"), slug],
      );
    }

    const response = await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("organization_name_unavailable");
  });
});

describe("the external-identity columns", () => {
  it("sit empty, because the provider writes into egma's own user table", async () => {
    api = await createApi("signup_external_identity");

    await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });

    const { rows: users } = await api.database.sql<{
      external_identity_provider: string | null;
      external_identity_id: string | null;
    }>(
      'select external_identity_provider, external_identity_id from "user"',
    );
    expect(users).toEqual([
      { external_identity_provider: null, external_identity_id: null },
    ]);

    const { rows: organizations } = await api.database.sql<{
      external_identity_provider: string | null;
      external_identity_id: string | null;
    }>(
      "select external_identity_provider, external_identity_id from organization",
    );
    expect(organizations).toEqual([
      { external_identity_provider: null, external_identity_id: null },
    ]);
  });
});

describe("with no mail transport configured", () => {
  it("completes signup, and asks for no verification", async () => {
    api = await createApi("signup_no_email");

    const response = await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });

    expect(response.statusCode).toBe(201);
    expect(api.mail).toEqual([]);

    const me = await api.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: cookiesFrom(response.headers["set-cookie"]) },
    });
    expect(me.statusCode).toBe(200);
  });
});

describe("with a transport that delivers", () => {
  it("sends the verification message through the one email seam", async () => {
    api = await createApi("signup_with_email", { emailDelivers: true });

    const response = await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });

    expect(response.statusCode).toBe(201);
    expect(api.mail.map((email) => email.to)).toEqual(["ada@acme.example"]);
  });
});

describe("a self-hosted instance", () => {
  it("is claimed by the first person, and open signup closes behind them", async () => {
    api = await createApi("signup_claims", { singleOrganization: true });

    expect((await api.app.inject({ url: "/api/signup/availability" })).json()).toEqual({
      open: true,
    });

    const first = await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().role).toBe("admin");

    const availability = await api.app.inject({
      url: "/api/signup/availability",
    });
    expect(availability.json()).toMatchObject({
      open: false,
      reason: "invitation_required",
    });

    const second = await signUp({
      email: "grace@globex.example",
      password: "a-long-enough-password",
      organizationName: "Globex",
    });
    expect(second.statusCode).toBe(403);
    expect(second.body).toContain("invitation");

    const { rows } = await api.database.sql<{ count: string }>(
      'select count(*) as count from "user"',
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("refuses a second person who posts straight at the provider, not only one who uses the page", async () => {
    api = await createApi("signup_claims_direct", { singleOrganization: true });

    await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });

    const direct = await api.app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: {
        "content-type": "application/json",
        origin: api.config.baseUrl,
      },
      payload: JSON.stringify({
        email: "grace@globex.example",
        password: "a-long-enough-password",
        name: "grace",
      }),
    });

    expect(direct.statusCode).toBe(403);
    const { rows } = await api.database.sql<{ count: string }>(
      'select count(*) as count from "user"',
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("lets a second person sign up when the deployment holds many customers", async () => {
    api = await createApi("signup_multi_tenant", { singleOrganization: false });

    await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });
    const second = await signUp({
      email: "grace@globex.example",
      password: "a-long-enough-password",
      organizationName: "Globex",
    });

    expect(second.statusCode).toBe(201);
    expect((await api.app.inject({ url: "/api/signup/availability" })).json()).toEqual(
      { open: true },
    );
  });
});

describe("the caller behind a relayed signup", () => {
  it("is known to the provider by their own address, not as one shared nobody", async () => {
    api = await createApi("signup_caller_address");

    const response = await api.app.inject({
      method: "POST",
      url: "/api/signup",
      remoteAddress: "203.0.113.9",
      payload: {
        email: "ada@acme.example",
        password: "a-long-enough-password",
        organizationName: "Acme",
      },
    });
    expect(response.statusCode).toBe(201);

    // The address on the session the provider issued is the caller's own.
    // The same resolution feeds the provider's per-caller signup budget, so
    // an address lost in the relay would mean every signup on the instance
    // shares one budget — a handful per ten seconds, total.
    const { rows } = await api.database.sql<{ ip_address: string | null }>(
      "select ip_address from session",
    );
    expect(rows).toEqual([{ ip_address: "203.0.113.9" }]);
  });
});

describe("a person with one organization and one project", () => {
  it("is offered nothing to pick between", async () => {
    api = await createApi("signup_cardinality");

    const created = await signUp({
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    });

    const me = await api.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: cookiesFrom(created.headers["set-cookie"]) },
    });

    const body = me.json();
    expect(body.organizations).toHaveLength(1);
    expect(body.projects).toHaveLength(1);
    expect(body.organizations[0]).toMatchObject({
      name: "Acme",
      slug: "acme",
      role: "admin",
    });
  });

  it("is nobody at all without a session", async () => {
    api = await createApi("signup_no_session");

    const me = await api.app.inject({ method: "GET", url: "/api/me" });
    expect(me.statusCode).toBe(401);
  });
});
