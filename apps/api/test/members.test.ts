import { afterEach, describe, expect, it } from "vitest";

import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

/**
 * Who is in an organization, and what an admin may do about it.
 *
 * The promise underneath all of it is one sentence: **removing somebody revokes
 * their keys and leaves everything they authored intact, with their name on
 * it.** Records of what somebody did are preserved; powers that act on their
 * behalf are revoked. An IT deprovisioning script must not be able to delete a
 * team's work.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

type Person = {
  readonly userId: string;
  readonly organizationId: string;
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
  expect(created.statusCode, created.body).toBe(201);
  const landed = created.json() as {
    userId: string;
    organization: { id: string };
  };
  return {
    userId: landed.userId,
    organizationId: landed.organization.id,
    cookie: cookiesFrom(created.headers["set-cookie"]),
  };
}

/** A colleague, added the way the product adds one. */
async function colleagueOf(
  host: Person,
  email: string,
  role: string,
): Promise<Person> {
  const invited = await api.app.inject({
    method: "POST",
    url: "/v1/invitations",
    headers: { cookie: host.cookie },
    payload: { email, role },
  });
  expect(invited.statusCode, invited.body).toBe(201);

  const link = (invited.json() as { acceptUrl: string }).acceptUrl;
  const token = new URL(link).searchParams.get("token") ?? "";

  const joined = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: {
      email,
      password: "a-long-enough-password",
      invitationToken: token,
    },
  });
  expect(joined.statusCode, joined.body).toBe(201);

  return {
    userId: (joined.json() as { userId: string }).userId,
    organizationId: host.organizationId,
    cookie: cookiesFrom(joined.headers["set-cookie"]),
  };
}

async function mintKey(person: Person, name: string): Promise<string> {
  const minted = await api.app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: { cookie: person.cookie },
    payload: { name },
  });
  expect(minted.statusCode).toBe(201);
  return (minted.json() as { secret: string }).secret;
}

async function act(
  person: Person,
  userId: string,
  what: string,
  body: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<TestApi["app"]["inject"]>>> {
  return api.app.inject({
    method: "POST",
    url: `/v1/members/${userId}/${what}`,
    headers: { cookie: person.cookie },
    payload: body,
  });
}

describe("the list of people", () => {
  it("is everybody in the caller's organization and nobody else's", async () => {
    api = await createApi("members_list");
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");
    await colleagueOf(ada, "mia@acme.example", "member");
    await colleagueOf(grace, "hedy@globex.example", "viewer");

    const listed = await api.app.inject({
      method: "GET",
      url: "/v1/members",
      headers: { cookie: ada.cookie },
    });

    const body = listed.json() as {
      members: { email: string; role: string }[];
      mayManageMembers: boolean;
    };
    expect(body.members.map((one) => one.email).sort()).toEqual([
      "ada@acme.example",
      "mia@acme.example",
    ]);
    expect(body.mayManageMembers).toBe(true);
  });

  it("is readable by everybody, because reading is not what roles are for", async () => {
    api = await createApi("members_list_viewer");
    const ada = await signUp("ada@acme.example", "Acme");
    const vic = await colleagueOf(ada, "vic@acme.example", "viewer");

    const listed = await api.app.inject({
      method: "GET",
      url: "/v1/members",
      headers: { cookie: vic.cookie },
    });

    expect(listed.statusCode).toBe(200);
    const body = listed.json() as {
      members: unknown[];
      mayManageMembers: boolean;
    };
    expect(body.members).toHaveLength(2);
    // They can see who is here and cannot act on any of them, and the answer
    // says so rather than leaving a page to find out by being refused.
    expect(body.mayManageMembers).toBe(false);
  });
});

describe("changing somebody's role", () => {
  it("is something an admin may do", async () => {
    api = await createApi("members_role_admin");
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "member");

    const changed = await act(ada, mia.userId, "role", { role: "viewer" });

    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ role: "viewer" });
  });

  it("is not something a member or a viewer may do", async () => {
    api = await createApi("members_role_refused");
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "member");
    const vic = await colleagueOf(ada, "vic@acme.example", "viewer");

    for (const person of [mia, vic]) {
      const reaching = await act(person, ada.userId, "role", { role: "viewer" });
      expect(reaching.statusCode).toBe(403);
      expect(reaching.json()).toMatchObject({ error: "not_permitted" });
    }

    const listed = await api.app.inject({
      method: "GET",
      url: "/v1/members",
      headers: { cookie: ada.cookie },
    });
    const roles = (listed.json() as { members: { role: string }[] }).members;
    expect(roles.map((one) => one.role).sort()).toEqual([
      "admin",
      "member",
      "viewer",
    ]);
  });

  it("reaches every key that person ever minted, on their next request", async () => {
    api = await createApi("members_role_reaches_keys");
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "admin");
    const theirs = await mintKey(mia, "mia's terminal");

    // An admin's key may revoke anybody's, so this one can reach Ada's.
    const adas = await mintKey(ada, "ada's terminal");
    const before = await api.app.inject({
      method: "GET",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${theirs}` },
    });
    expect((before.json() as { keys: unknown[] }).keys).toHaveLength(2);

    await act(ada, mia.userId, "role", { role: "viewer" });

    // No key row was touched, and there was nothing to go looking for.
    const after = await api.app.inject({
      method: "GET",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${theirs}` },
    });
    const keys = (after.json() as { keys: { name: string }[] }).keys;
    expect(keys.map((key) => key.name)).toEqual(["mia's terminal"]);
    expect(adas).not.toBe("");
  });

  it("cannot take away the last admin, because nobody could ever put one back", async () => {
    api = await createApi("members_role_last_admin");
    const ada = await signUp("ada@acme.example", "Acme");
    await colleagueOf(ada, "vic@acme.example", "viewer");

    const refused = await act(ada, ada.userId, "role", { role: "viewer" });

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "last_admin" });
  });

  it("lets the last admin step down once somebody else is one", async () => {
    api = await createApi("members_role_handover");
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "member");

    expect((await act(ada, mia.userId, "role", { role: "admin" })).statusCode).toBe(200);
    expect((await act(ada, ada.userId, "role", { role: "viewer" })).statusCode).toBe(200);
  });

  it("cannot reach into another customer's organization", async () => {
    api = await createApi("members_role_tenancy");
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");

    const reaching = await act(ada, grace.userId, "role", { role: "viewer" });

    expect(reaching.statusCode).toBe(404);
    const { rows } = await api.database.sql<{ role: string }>(
      "select role from membership where user_id = $1",
      [grace.userId],
    );
    expect(rows[0]?.role).toBe("admin");
  });
});

describe("removing somebody", () => {
  it("revokes their keys and leaves everything they authored, with their name on it", async () => {
    api = await createApi("members_remove");
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "member");
    const theirs = await mintKey(mia, "mia's terminal");

    expect(
      (
        await api.app.inject({
          method: "GET",
          url: "/v1/keys",
          headers: { authorization: `Bearer ${theirs}` },
        })
      ).statusCode,
    ).toBe(200);

    const removed = await act(ada, mia.userId, "remove");
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ keysRevoked: 1 });

    // No cache to wait out. The next request is already the one that fails.
    expect(
      (
        await api.app.inject({
          method: "GET",
          url: "/v1/keys",
          headers: { authorization: `Bearer ${theirs}` },
        })
      ).statusCode,
    ).toBe(401);

    // The row says revoked rather than gone, so what happened is still legible.
    const { rows } = await api.database.sql<{
      name: string;
      revoked_at: Date | null;
      created_by_user_id: string;
    }>(
      "select name, revoked_at, created_by_user_id from api_key where created_by_user_id = $1",
      [mia.userId],
    );
    expect(rows).toEqual([
      {
        name: "mia's terminal",
        revoked_at: expect.any(Date),
        created_by_user_id: mia.userId,
      },
    ]);

    // They authored the invitation record of themselves joining, and they are
    // still the person on it.
    const { rows: users } = await api.database.sql<{ email: string }>(
      'select email from "user" where id = $1',
      [mia.userId],
    );
    expect(users).toEqual([{ email: "mia@acme.example" }]);
  });

  it("takes them out of the organization, so nothing of theirs resolves", async () => {
    api = await createApi("members_remove_membership");
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "member");

    await act(ada, mia.userId, "remove");

    const listed = await api.app.inject({
      method: "GET",
      url: "/v1/members",
      headers: { cookie: ada.cookie },
    });
    const emails = (listed.json() as { members: { email: string }[] }).members;
    expect(emails.map((one) => one.email)).toEqual(["ada@acme.example"]);

    // Their session still resolves to a person and to nowhere, which is what
    // the pages already say rather than pretending they are somewhere.
    const me = await api.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: mia.cookie },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { organizations: unknown[] }).organizations).toEqual([]);
  });

  it("is not something a member may do to anybody", async () => {
    api = await createApi("members_remove_refused");
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "member");
    const vic = await colleagueOf(ada, "vic@acme.example", "viewer");

    expect((await act(mia, vic.userId, "remove")).statusCode).toBe(403);
    expect((await act(vic, mia.userId, "remove")).statusCode).toBe(403);

    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*) as count from membership",
    );
    expect(rows[0]?.count).toBe("3");
  });

  it("cannot take away the last admin", async () => {
    api = await createApi("members_remove_last_admin");
    const ada = await signUp("ada@acme.example", "Acme");
    await colleagueOf(ada, "mia@acme.example", "member");

    const refused = await act(ada, ada.userId, "remove");
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "last_admin" });
  });

  it("leaves the other customer's people alone", async () => {
    api = await createApi("members_remove_tenancy");
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");

    expect((await act(ada, grace.userId, "remove")).statusCode).toBe(404);

    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*) as count from membership where user_id = $1",
      [grace.userId],
    );
    expect(rows[0]?.count).toBe("1");
  });
});

describe("deactivating an account", () => {
  it("stops every key that person minted, and touches no key row", async () => {
    api = await createApi("members_deactivate");
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "member");
    const theirs = await mintKey(mia, "mia's terminal");

    const before = await api.database.sql<Record<string, unknown>>(
      "select * from api_key where created_by_user_id = $1",
      [mia.userId],
    );

    const deactivated = await act(ada, mia.userId, "deactivate");
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json()).toMatchObject({ role: "member" });

    expect(
      (
        await api.app.inject({
          method: "GET",
          url: "/v1/keys",
          headers: { authorization: `Bearer ${theirs}` },
        })
      ).statusCode,
    ).toBe(401);

    const after = await api.database.sql<Record<string, unknown>>(
      "select * from api_key where created_by_user_id = $1",
      [mia.userId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  /**
   * The other half of the same sentence, and the half a browser is on.
   *
   * A live session is a power exactly as a live key is, so switching an account
   * off has to take both. This is the deprovisioning case the design is for: an
   * IT script disables somebody, and the tab they left open must not still be
   * administering the organization.
   */
  it("stops the browser session that person left open, and leaves what they authored", async () => {
    api = await createApi("members_deactivate_session");
    const ada = await signUp("ada@acme.example", "Acme");
    const noor = await colleagueOf(ada, "noor@acme.example", "admin");

    const asAda = { cookie: ada.cookie };
    expect(
      (await api.app.inject({ method: "GET", url: "/api/me", headers: asAda }))
        .statusCode,
    ).toBe(200);

    // An organization keeps at least one admin, so somebody else does the
    // switching off. This is the shape a real deprovisioning has.
    expect((await act(noor, ada.userId, "deactivate")).statusCode).toBe(200);

    // The same cookie, on the very next request, at every surface it reached.
    for (const url of ["/api/me", "/v1/members", "/v1/keys"]) {
      const after = await api.app.inject({ method: "GET", url, headers: asAda });
      expect(after.statusCode, url).toBe(401);
    }

    // Including the admin action they held a moment ago.
    expect((await act(ada, noor.userId, "deactivate")).statusCode).toBe(401);

    // Records of what somebody did are preserved. Their membership, their role
    // and their name on what they authored are all exactly where they were.
    const { rows } = await api.database.sql<{
      name: string;
      created_by: string;
    }>("select name, created_by from project where organization_id = $1", [
      ada.organizationId,
    ]);
    expect(rows).toEqual([{ name: "Default", created_by: ada.userId }]);

    const listed = await api.app.inject({
      method: "GET",
      url: "/v1/members",
      headers: { cookie: noor.cookie },
    });
    expect(
      (listed.json() as { members: Record<string, unknown>[] }).members,
    ).toContainEqual(
      expect.objectContaining({
        userId: ada.userId,
        role: "admin",
        deactivatedAt: expect.any(String),
      }),
    );
  });

  it("is not something a viewer may do", async () => {
    api = await createApi("members_deactivate_refused");
    const ada = await signUp("ada@acme.example", "Acme");
    const vic = await colleagueOf(ada, "vic@acme.example", "viewer");

    expect((await act(vic, ada.userId, "deactivate")).statusCode).toBe(403);
  });

  it("cannot take away the last admin", async () => {
    api = await createApi("members_deactivate_last_admin");
    const ada = await signUp("ada@acme.example", "Acme");
    await colleagueOf(ada, "vic@acme.example", "viewer");

    expect((await act(ada, ada.userId, "deactivate")).statusCode).toBe(409);
  });
});
