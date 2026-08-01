import {
  changeRole,
  createApiKey,
  deactivateUser,
  type AuthContext,
  type Role,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { hashApiKeySecret } from "../src/auth/api-key.ts";
import { fixedWindowRateLimit } from "../src/http/rate-limit.ts";
import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

/**
 * What a key is worth, and for how long.
 *
 * A key is the credential the whole programmatic surface is reached with, so
 * the promises about it are the ones a customer plans around: it never expires,
 * it stops working the moment it is revoked, it can never reach another
 * customer's data, and it is exactly as powerful as the person who minted it is
 * right now — not as powerful as they were when they minted it.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

type Person = {
  readonly userId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly cookie: string;
};

async function signUp(
  email: string,
  organizationName: string,
): Promise<Person> {
  const created = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: { email, password: "a-long-enough-password", organizationName },
  });
  expect(created.statusCode).toBe(201);

  const landed = created.json() as {
    userId: string;
    organization: { id: string };
    project: { id: string };
  };

  return {
    userId: landed.userId,
    organizationId: landed.organization.id,
    projectId: landed.project.id,
    cookie: cookiesFrom(created.headers["set-cookie"]),
  };
}

/**
 * A colleague inside somebody's organization, added the way the product adds
 * one: an admin invites them, and they follow the link.
 *
 * It went through the invitation path on 2026-08-01, having previously written
 * the two rows by hand with a note that an invitation would one day write them.
 * Everything in this file about roles, demotion and deactivation is therefore
 * now standing on the real thing rather than on a fixture that agreed with it.
 */
async function colleagueOf(
  host: Person,
  email: string,
  role: Role,
): Promise<Person> {
  const invited = await api.app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { cookie: host.cookie },
    payload: { email, role },
  });
  expect(invited.statusCode, invited.body).toBe(201);

  const link = (invited.json() as { accept_url: string }).accept_url;
  const joined = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: {
      email,
      password: "a-long-enough-password",
      invitationToken: new URL(link).searchParams.get("token"),
    },
  });
  expect(joined.statusCode, joined.body).toBe(201);
  const landed = joined.json() as { userId: string; role: Role };
  expect(landed.role).toBe(role);

  return {
    userId: landed.userId,
    organizationId: host.organizationId,
    projectId: host.projectId,
    cookie: cookiesFrom(joined.headers["set-cookie"]),
  };
}

function contextFor(person: Person, role: Role): AuthContext {
  return {
    userId: person.userId,
    organizationId: person.organizationId,
    projectId: person.projectId,
    role,
    via: "session",
  };
}

/** A key minted for somebody, and the secret only this test will ever see. */
async function keyFor(
  person: Person,
  role: Role,
  name: string,
): Promise<{ id: string; secret: string }> {
  const secret = `egma_sk_${newId("key")}`;
  const key = await createApiKey(contextFor(person, role), {
    hash: hashApiKeySecret(secret),
    prefix: "egma_sk_",
    displaySuffix: secret.slice(-4),
    name,
  });
  return { id: key.id, secret };
}

function withKey(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

async function mint(
  person: Person,
  body: Record<string, unknown> = {},
): Promise<{ id: string; secret: string; status: number; body: never }> {
  const response = await api.app.inject({
    method: "POST",
    url: "/api/keys",
    headers: { cookie: person.cookie },
    payload: body,
  });
  const json = response.json() as { id: string; secret: string };
  return {
    id: json.id,
    secret: json.secret,
    status: response.statusCode,
    body: json as never,
  };
}

describe("minting a key", () => {
  it("shows the secret exactly once and stores something that is not it", async () => {
    api = await createApi("keys_mint");
    const ada = await signUp("ada@acme.example", "Acme");

    const minted = await mint(ada, { name: "laptop" });
    expect(minted.status).toBe(201);
    expect(minted.secret).toMatch(/^egma_sk_[A-Za-z0-9_-]{43}$/);

    const listed = await api.app.inject({
      method: "GET",
      url: "/api/keys",
      headers: { cookie: ada.cookie },
    });
    const keys = (listed.json() as { keys: Record<string, unknown>[] }).keys;

    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty("secret");
    expect(keys[0]?.looks_like).toBe(`egma_sk_…${minted.secret.slice(-4)}`);
    expect(keys[0]?.name).toBe("laptop");
  });

  it("is a single SHA-256 over the secret, and there is no second hash to keep", async () => {
    api = await createApi("keys_hash");
    const ada = await signUp("ada@acme.example", "Acme");
    const minted = await mint(ada);

    const { rows } = await api.database.sql<Record<string, unknown>>(
      "select * from api_key",
    );
    const row = rows[0] ?? {};

    expect(row.hash).toBe(hashApiKeySecret(minted.secret));
    expect(
      Object.keys(row).filter((name) => /hash|secret|token/.test(name)),
    ).toEqual(["hash"]);
  });

  it("never expires, so there is no timer nobody remembers setting", async () => {
    api = await createApi("keys_no_expiry");
    await signUp("ada@acme.example", "Acme");

    const { rows } = await api.database.sql<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'api_key'`,
    );

    expect(
      rows.map((row) => row.column_name).filter((name) => /expir/.test(name)),
    ).toEqual([]);
  });

  it("is something every role may do, including a viewer", async () => {
    api = await createApi("keys_viewer_mints");
    const ada = await signUp("ada@acme.example", "Acme");
    const vic = await colleagueOf(ada, "vic@acme.example", "viewer");

    const theirs = await keyFor(vic, "viewer", "vic's terminal");

    // A viewer's own key reaches the product, which is the whole reason login
    // is allowed to mint one for them.
    const used = await api.app.inject({
      method: "GET",
      url: "/api/keys",
      headers: withKey(theirs.secret),
    });
    expect(used.statusCode).toBe(200);

    // And they can mint another with it, because login does exactly that.
    const another = await api.app.inject({
      method: "POST",
      url: "/api/keys",
      headers: withKey(theirs.secret),
      payload: { name: "second machine" },
    });
    expect(another.statusCode).toBe(201);
  });
});

describe("a request carrying a key", () => {
  it("runs no auth-provider code at all", async () => {
    api = await createApi("keys_no_provider");
    const ada = await signUp("ada@acme.example", "Acme");
    const minted = await mint(ada);

    // If any provider code were on this path, this would be how it announced
    // itself. Resolving a session is the provider; resolving a key is not.
    const provider = api.identity.provider as unknown as Record<
      string,
      unknown
    >;
    provider.resolveIdentity = () => {
      throw new Error("the auth provider was asked about an API-key request");
    };

    const used = await api.app.inject({
      method: "GET",
      url: "/api/keys",
      headers: withKey(minted.secret),
    });

    expect(used.statusCode).toBe(200);
  });

  it("acts in the organization the key row names, whatever the request says", async () => {
    api = await createApi("keys_organization_from_row");
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");
    const minted = await mint(ada);

    const named = await api.app.inject({
      method: "POST",
      url: "/api/keys",
      headers: withKey(minted.secret),
      payload: { name: "reaching", organization_id: grace.organizationId },
    });

    expect(named.statusCode).toBe(201);
    expect((named.json() as { organization_id: string }).organization_id).toBe(
      ada.organizationId,
    );
  });

  it("is refused when it names a project outside the key's organization", async () => {
    api = await createApi("keys_foreign_project");
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");
    const minted = await mint(ada);

    const reaching = await api.app.inject({
      method: "POST",
      url: "/api/keys",
      headers: withKey(minted.secret),
      payload: { project_id: grace.projectId },
    });

    expect(reaching.statusCode).toBe(403);
    expect(reaching.json()).toMatchObject({
      error: "project_outside_organization",
    });
  });

  it("records when it was last used, so an abandoned key is visible as one", async () => {
    api = await createApi("keys_last_used");
    const ada = await signUp("ada@acme.example", "Acme");
    const minted = await mint(ada);

    const before = await api.database.sql<{ last_used_at: Date | null }>(
      "select last_used_at from api_key where id = $1",
      [minted.id],
    );
    expect(before.rows[0]?.last_used_at).toBeNull();

    await api.app.inject({
      method: "GET",
      url: "/api/keys",
      headers: withKey(minted.secret),
    });

    const after = await api.database.sql<{ last_used_at: Date | null }>(
      "select last_used_at from api_key where id = $1",
      [minted.id],
    );
    expect(after.rows[0]?.last_used_at).toBeInstanceOf(Date);
  });

  it("is nobody once the key is revoked, on the very next request", async () => {
    api = await createApi("keys_revoked");
    const ada = await signUp("ada@acme.example", "Acme");
    const minted = await mint(ada);

    expect(
      (
        await api.app.inject({
          method: "GET",
          url: "/api/keys",
          headers: withKey(minted.secret),
        })
      ).statusCode,
    ).toBe(200);

    const revoked = await api.app.inject({
      method: "POST",
      url: `/api/keys/${minted.id}/revoke`,
      headers: { cookie: ada.cookie },
    });
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as { revoked_at: string }).revoked_at).toBeTypeOf(
      "string",
    );

    // No cache to wait out. The next request is already the one that fails.
    expect(
      (
        await api.app.inject({
          method: "GET",
          url: "/api/keys",
          headers: withKey(minted.secret),
        })
      ).statusCode,
    ).toBe(401);
  });

  it("is nobody once its creator is deactivated, and everything they authored stays", async () => {
    api = await createApi("keys_deactivated");
    const ada = await signUp("ada@acme.example", "Acme");
    const minted = await mint(ada);
    // An organization keeps at least one admin, so somebody has to be able to
    // do the deactivating. This is also the shape a real deprovisioning has.
    const noor = await colleagueOf(ada, "noor@acme.example", "admin");

    await deactivateUser(contextFor(noor, "admin"), ada.userId);

    expect(
      (
        await api.app.inject({
          method: "GET",
          url: "/api/keys",
          headers: withKey(minted.secret),
        })
      ).statusCode,
    ).toBe(401);

    // Records of what somebody did are preserved; powers that act on their
    // behalf are revoked. An IT deprovisioning script must not be able to
    // delete a team's work.
    const { rows } = await api.database.sql<{
      name: string;
      created_by: string;
    }>("select name, created_by from project where organization_id = $1", [
      ada.organizationId,
    ]);
    expect(rows).toEqual([{ name: "Default", created_by: ada.userId }]);
  });

  it("acts at its creator's role now, not the role they held when they minted it", async () => {
    api = await createApi("keys_follow_role");
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "member");
    const theirs = await keyFor(mia, "member", "mia's terminal");

    const before = await api.database.sql<Record<string, unknown>>(
      "select * from api_key where id = $1",
      [theirs.id],
    );

    // The demotion, and nothing else. No key row is touched, and nobody goes
    // looking for one.
    await changeRole(contextFor(ada, "admin"), mia.userId, "viewer");

    const listed = await api.app.inject({
      method: "GET",
      url: "/api/keys",
      headers: withKey(theirs.secret),
    });
    expect(listed.statusCode).toBe(200);

    // A viewer still sees and still mints, which is the whole product staying
    // usable for them...
    expect(
      (
        await api.app.inject({
          method: "POST",
          url: "/api/keys",
          headers: withKey(theirs.secret),
          payload: { name: "still allowed" },
        })
      ).statusCode,
    ).toBe(201);

    // ...and the key row is byte for byte what it was, apart from the fact that
    // it was used.
    const after = await api.database.sql<Record<string, unknown>>(
      "select * from api_key where id = $1",
      [theirs.id],
    );
    expect({ ...after.rows[0], last_used_at: null }).toEqual({
      ...before.rows[0],
      last_used_at: null,
    });
  });
});

describe("the list of keys", () => {
  it("shows an admin every key in the organization", async () => {
    api = await createApi("keys_list_admin");
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "member");
    await keyFor(mia, "member", "mia's terminal");
    await mint(ada, { name: "ada's terminal" });

    const listed = await api.app.inject({
      method: "GET",
      url: "/api/keys",
      headers: { cookie: ada.cookie },
    });

    const keys = (listed.json() as { keys: { name: string }[] }).keys;
    expect(keys.map((key) => key.name).sort()).toEqual([
      "ada's terminal",
      "mia's terminal",
    ]);
  });

  /**
   * Filtered, and not refused. A `viewer` who could not list their own key
   * could never rotate it, and login mints one for every role — so gating this
   * would manufacture credentials nobody can retire.
   */
  it("shows everybody else only the keys they minted, rather than refusing them", async () => {
    api = await createApi("keys_list_filtered");
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "member");
    const theirs = await keyFor(mia, "member", "mia's terminal");
    await mint(ada, { name: "ada's terminal" });

    const listed = await api.app.inject({
      method: "GET",
      url: "/api/keys",
      headers: withKey(theirs.secret),
    });

    expect(listed.statusCode).toBe(200);
    const keys = (listed.json() as { keys: { name: string }[] }).keys;
    expect(keys.map((key) => key.name)).toEqual(["mia's terminal"]);
  });

  it("never shows one customer another customer's keys", async () => {
    api = await createApi("keys_list_tenancy");
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");
    await mint(ada, { name: "ada's terminal" });
    const theirs = await mint(grace, { name: "grace's terminal" });

    const listed = await api.app.inject({
      method: "GET",
      url: "/api/keys",
      headers: withKey(theirs.secret),
    });

    const keys = (listed.json() as { keys: { name: string }[] }).keys;
    expect(keys.map((key) => key.name)).toEqual(["grace's terminal"]);
  });
});

describe("revoking", () => {
  it("is something an admin may do to anybody's key", async () => {
    api = await createApi("keys_revoke_anyones");
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "member");
    const theirs = await keyFor(mia, "member", "mia's terminal");

    const revoked = await api.app.inject({
      method: "POST",
      url: `/api/keys/${theirs.id}/revoke`,
      headers: { cookie: ada.cookie },
    });

    expect(revoked.statusCode).toBe(200);
  });

  it("is not something one member may do to another's", async () => {
    api = await createApi("keys_revoke_someone_elses");
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "member");
    const mine = await keyFor(mia, "member", "mia's terminal");
    const adas = await mint(ada, { name: "ada's terminal" });

    const reaching = await api.app.inject({
      method: "POST",
      url: `/api/keys/${adas.id}/revoke`,
      headers: withKey(mine.secret),
    });

    expect(reaching.statusCode).toBe(404);

    const { rows } = await api.database.sql<{ revoked_at: Date | null }>(
      "select revoked_at from api_key where id = $1",
      [adas.id],
    );
    expect(rows[0]?.revoked_at).toBeNull();
  });

  it("leaves a key in another customer's account alone", async () => {
    api = await createApi("keys_revoke_across");
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");
    const theirs = await mint(grace, { name: "grace's terminal" });

    const reaching = await api.app.inject({
      method: "POST",
      url: `/api/keys/${theirs.id}/revoke`,
      headers: { cookie: ada.cookie },
    });

    expect(reaching.statusCode).toBe(404);
  });
});

describe("the request budget", () => {
  /**
   * Keyed on the organization, which is the unit being served. Rotation is
   * mint, deploy, revoke — a customer doing it correctly must not discover that
   * their budget went with the old key, and a customer doing it repeatedly must
   * not discover that it resets one.
   */
  it("belongs to the organization, so a new key does not reset it", async () => {
    api = await createApi("keys_budget", {
      rateLimit: fixedWindowRateLimit({ limit: 3, windowMilliseconds: 60_000 }),
    });
    const ada = await signUp("ada@acme.example", "Acme");

    const first = await mint(ada, { name: "first" });
    const second = await mint(ada, { name: "second" });
    expect(second.status).toBe(201);

    const third = await api.app.inject({
      method: "GET",
      url: "/api/keys",
      headers: withKey(first.secret),
    });
    expect(third.statusCode).toBe(200);

    const fourth = await api.app.inject({
      method: "GET",
      url: "/api/keys",
      headers: withKey(second.secret),
    });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.headers["retry-after"]).toBeDefined();
  });

  it("is one customer's own, and is not spent by another's traffic", async () => {
    api = await createApi("keys_budget_tenancy", {
      rateLimit: fixedWindowRateLimit({ limit: 1, windowMilliseconds: 60_000 }),
    });
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");
    // Minted without spending Globex's own allowance, so what is being measured
    // below is Acme's traffic and nothing else.
    const theirs = await keyFor(grace, "admin", "grace's terminal");

    // Acme spends its single request.
    await mint(ada, { name: "ada's terminal" });
    expect(
      (
        await api.app.inject({
          method: "GET",
          url: "/api/keys",
          headers: { cookie: ada.cookie },
        })
      ).statusCode,
    ).toBe(429);

    // Globex still has theirs.
    expect(
      (
        await api.app.inject({
          method: "GET",
          url: "/api/keys",
          headers: withKey(theirs.secret),
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe("a request with no credential at all", () => {
  it("is refused rather than served as nobody", async () => {
    api = await createApi("keys_anonymous");
    await signUp("ada@acme.example", "Acme");

    expect(
      (await api.app.inject({ method: "GET", url: "/api/keys" })).statusCode,
    ).toBe(401);

    expect(
      (
        await api.app.inject({
          method: "GET",
          url: "/api/keys",
          headers: withKey("egma_sk_this-was-never-a-key-anybody-was-given"),
        })
      ).statusCode,
    ).toBe(401);
  });
});
