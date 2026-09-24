import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { hashInvitationToken } from "../src/auth/invitation.ts";
import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

/**
 * Invitation delivery, single use, addressing, expiry, and the refusals around
 * who may invite and who may accept.
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

async function signUp(email: string, organizationName: string): Promise<Person> {
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

/**
 * The same, on an instance whose transport delivers. Verification is required
 * there — read off the transport, with no second setting — so signing up leaves
 * no session and the click on the message is what completes it. Standing in for
 * that click is what these two extra statements are.
 */
async function signUpAndVerify(
  email: string,
  organizationName: string,
): Promise<Person> {
  const person = await signUp(email, organizationName);
  await api.database.sql(
    'update "user" set email_verified = true where id = $1',
    [person.userId],
  );

  const signedIn = await api.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { "content-type": "application/json", origin: api.config.baseUrl },
    payload: { email, password: "a-long-enough-password" },
  });
  expect(signedIn.statusCode, signedIn.body).toBe(200);

  return { ...person, cookie: cookiesFrom(signedIn.headers["set-cookie"]) };
}

type Invited = {
  readonly status: number;
  readonly body: Record<string, unknown>;
  /** The token out of the link, which is the whole thing being handed over. */
  readonly token: string;
};

async function invite(
  host: Person,
  email: string,
  role?: string,
): Promise<Invited> {
  const response = await api.app.inject({
    method: "POST",
    url: "/v1/invitations",
    headers: { cookie: host.cookie },
    payload: role === undefined ? { email } : { email, role },
  });

  const body = response.json() as Record<string, unknown>;
  const url = typeof body.acceptUrl === "string" ? body.acceptUrl : "";
  return {
    status: response.statusCode,
    body,
    token: url === "" ? "" : (new URL(url).searchParams.get("token") ?? ""),
  };
}

/** Following the link the whole way: read it, then sign up with it. */
async function follow(
  token: string,
  email: string,
): Promise<{ status: number; body: Record<string, unknown>; cookie: string }> {
  const response = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: {
      email,
      password: "a-long-enough-password",
      invitationToken: token,
    },
  });

  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
    cookie: cookiesFrom(response.headers["set-cookie"]),
  };
}

async function lookUp(token: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await api.app.inject({
    method: "POST",
    url: "/api/invitations/lookup",
    payload: { token },
  });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

describe("with a transport that delivers", () => {
  it("sends the invitation, and keeps the link out of the answer", async () => {
    api = await createApi("invite_delivers", { emailDelivers: true });
    const ada = await signUpAndVerify("ada@acme.example", "Acme");

    const invited = await invite(ada, "bob@acme.example");

    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    expect(invited.body.delivered).toBe(true);
    // It reached the person it names, so the person it names is the one who
    // should be holding it.
    expect(invited.body.acceptUrl).toBeUndefined();

    // Ada's own verification message went through the same seam a moment ago,
    // which is the point of there being one seam.
    const sent = api.mail.filter((email) => email.to === "bob@acme.example");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain("Acme");
    expect(sent[0]?.body).toContain("/invite?token=");
  });
});

describe("the invitation row", () => {
  it("holds a hash and never the token itself", async () => {
    api = await createApi("invite_hashed");
    const ada = await signUp("ada@acme.example", "Acme");
    const invited = await invite(ada, "bob@acme.example");

    const { rows } = await api.database.sql<Record<string, unknown>>(
      "select * from invitation",
    );
    const row = rows[0] ?? {};

    expect(row.token_hash).toBe(hashInvitationToken(invited.token));
    expect(JSON.stringify(row)).not.toContain(invited.token);
    expect(
      Object.keys(row).filter((name) => /token|secret/.test(name)),
    ).toEqual(["token_hash"]);
  });
});

describe("who may invite", () => {
  it("is not a member, and not a viewer", async () => {
    api = await createApi("invite_others_may_not");
    const ada = await signUp("ada@acme.example", "Acme");

    for (const [role, email] of [
      ["member", "mia@acme.example"],
      ["viewer", "vic@acme.example"],
    ] as const) {
      const invited = await invite(ada, email, role);
      const joined = await follow(invited.token, email);
      expect(joined.status).toBe(201);
      expect(joined.body.role).toBe(role);

      const reaching = await api.app.inject({
        method: "POST",
        url: "/v1/invitations",
        headers: { cookie: joined.cookie },
        payload: { email: "somebody@acme.example" },
      });

      expect(reaching.statusCode, role).toBe(403);
      expect(reaching.json()).toMatchObject({ error: "not_permitted" });
    }

    // Nothing they tried to send exists.
    const { rows } = await api.database.sql<{ email: string }>(
      "select email from invitation order by email",
    );
    expect(rows.map((row) => row.email)).toEqual([
      "mia@acme.example",
      "vic@acme.example",
    ]);
  });
});

describe("following a link", () => {
  it("works exactly once", async () => {
    api = await createApi("invite_single_use");
    const ada = await signUp("ada@acme.example", "Acme");
    const invited = await invite(ada, "bob@acme.example");

    expect((await follow(invited.token, "bob@acme.example")).status).toBe(201);

    const again = await follow(invited.token, "carol@acme.example");
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "invitation_already_accepted" });

    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*) as count from membership",
    );
    expect(rows[0]?.count).toBe("2");
  });

  it("lets in the address it was sent to, and not another", async () => {
    api = await createApi("invite_addressed");
    const ada = await signUp("ada@acme.example", "Acme");
    const invited = await invite(ada, "bob@acme.example");

    const somebodyElse = await follow(invited.token, "mallory@acme.example");
    expect(somebodyElse.status).toBe(403);
    expect(somebodyElse.body).toMatchObject({
      error: "invitation_for_somebody_else",
    });

    // Nothing was created for them, so the link is still there for Bob.
    const { rows } = await api.database.sql<{ count: string }>(
      `select count(*) as count from "user" where email = 'mallory@acme.example'`,
    );
    expect(rows[0]?.count).toBe("0");
    expect((await follow(invited.token, "bob@acme.example")).status).toBe(201);
  });

  it("says expired and already-accepted are different things", async () => {
    api = await createApi("invite_expired_vs_accepted");
    const ada = await signUp("ada@acme.example", "Acme");

    const stale = await invite(ada, "bob@acme.example");
    await api.database.sql(
      "update invitation set expires_at = now() - interval '1 day' where token_hash = $1",
      [hashInvitationToken(stale.token)],
    );

    expect((await lookUp(stale.token)).body.state).toBe("expired");
    const refused = await follow(stale.token, "bob@acme.example");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "invitation_expired" });

    const used = await invite(ada, "carol@acme.example");
    expect((await follow(used.token, "carol@acme.example")).status).toBe(201);
    expect((await lookUp(used.token)).body.state).toBe("accepted");

    // The two refusals are told apart, because they mean opposite things: ask
    // for another one, versus you are already in.
    expect(refused.body.error).not.toBe(
      (await follow(used.token, "carol@acme.example")).body.error,
    );
  });
});

describe("somebody who already belongs to an organization", () => {
  it("cannot be invited into a second one, and is told why", async () => {
    api = await createApi("invite_already_elsewhere");
    const ada = await signUp("ada@acme.example", "Acme");
    await signUp("grace@globex.example", "Globex");

    const invited = await invite(ada, "grace@globex.example");

    expect(invited.status).toBe(409);
    expect(invited.body).toMatchObject({ error: "already_a_member" });
    // It says they belong somewhere, and never says where. Acme has no
    // business learning that Globex exists.
    expect(String(invited.body.message)).not.toContain("Globex");

    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*) as count from invitation",
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("cannot be invited twice into the one they are already in", async () => {
    api = await createApi("invite_already_here");
    const ada = await signUp("ada@acme.example", "Acme");
    const invited = await invite(ada, "bob@acme.example");
    await follow(invited.token, "bob@acme.example");

    const again = await invite(ada, "bob@acme.example");
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "already_a_member_here" });
  });

  /**
   * The check when the invitation was written cannot be the only one: an
   * account can appear between writing the link and following it, and the
   * database is what has to say so.
   */
  it("is refused at the moment the link is followed, not only when it was sent", async () => {
    api = await createApi("invite_raced");
    const ada = await signUp("ada@acme.example", "Acme");
    const invited = await invite(ada, "bob@acme.example");

    // Bob goes and sets egma up for himself instead, which nothing about the
    // invitation could have anticipated.
    const bob = await signUp("bob@acme.example", "Bob's own");

    // Following it as a signup is refused by the address already being taken.
    expect((await follow(invited.token, "bob@acme.example")).status).toBe(422);

    // And following it while signed in is refused by the one thing that can
    // actually say why: one person belongs to one organization.
    const accepted = await api.app.inject({
      method: "POST",
      url: "/api/invitations/accept",
      headers: { cookie: bob.cookie },
      payload: { token: invited.token },
    });

    expect(accepted.statusCode).toBe(409);
    expect(accepted.json()).toMatchObject({ error: "already_a_member" });

    // Bob is still in his own organization and in no second one.
    const { rows } = await api.database.sql<{ count: string }>(
      `select count(*) as count from membership m
         join "user" u on u.id = m.user_id
        where u.email = 'bob@acme.example'`,
    );
    expect(rows[0]?.count).toBe("1");
  });
});

describe("an invited person on a claimed self-hosted instance", () => {
  /**
   * Open signup closes the moment the first person claims the instance, and
   * without this there would be no way past it — which would make a self-hosted
   * egma a single-person product.
   */
  it("gets past the door that open signup closed behind the first person", async () => {
    api = await createApi("invite_claimed_instance", {
      singleOrganization: true,
    });
    const ada = await signUp("ada@acme.example", "Acme");

    // Confirmed shut, so what follows is not passing for the wrong reason.
    const uninvited = await api.app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        email: "bob@acme.example",
        password: "a-long-enough-password",
        organizationName: "Bob's own",
      },
    });
    expect(uninvited.statusCode).toBe(403);

    const invited = await invite(ada, "bob@acme.example");
    const joined = await follow(invited.token, "bob@acme.example");

    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    expect(joined.body).toMatchObject({
      organization: { id: ada.organizationId },
    });

    // One organization on the instance, two people in it.
    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*) as count from organization",
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("cannot be walked past by posting straight at the provider with a made-up token", async () => {
    api = await createApi("invite_claimed_direct", { singleOrganization: true });
    await signUp("ada@acme.example", "Acme");

    const direct = await api.app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        email: "mallory@acme.example",
        password: "a-long-enough-password",
        invitationToken: newId("inv"),
      },
    });

    expect(direct.statusCode).toBe(404);
    const { rows } = await api.database.sql<{ count: string }>(
      'select count(*) as count from "user"',
    );
    expect(rows[0]?.count).toBe("1");
  });
});

describe("somebody who already has an account and belongs nowhere", () => {
  /**
   * Reachable, and not a curiosity: this is exactly the person who was removed
   * from an organization and then asked back. Without this they would be told
   * their email address is taken by an account they cannot use.
   */
  it("accepts with the session they already have", async () => {
    api = await createApi("invite_existing_account");
    const ada = await signUp("ada@acme.example", "Acme");

    const first = await invite(ada, "bob@acme.example");
    const bob = await follow(first.token, "bob@acme.example");
    const bobUserId = (bob.body as { userId: string }).userId;

    await api.app.inject({
      method: "POST",
      url: `/v1/members/${bobUserId}/remove`,
      headers: { cookie: ada.cookie },
    });

    const second = await invite(ada, "bob@acme.example");
    const accepted = await api.app.inject({
      method: "POST",
      url: "/api/invitations/accept",
      headers: { cookie: bob.cookie },
      payload: { token: second.token },
    });

    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({
      organization: { id: ada.organizationId, name: "Acme" },
      role: "admin",
    });
  });

  it("is refused without a session, because a link alone names nobody", async () => {
    api = await createApi("invite_accept_anonymous");
    const ada = await signUp("ada@acme.example", "Acme");
    const invited = await invite(ada, "bob@acme.example");

    const anonymous = await api.app.inject({
      method: "POST",
      url: "/api/invitations/accept",
      payload: { token: invited.token },
    });

    expect(anonymous.statusCode).toBe(401);
  });
});

describe("the list of invitations", () => {
  it("shows an admin what is outstanding, and never the links", async () => {
    api = await createApi("invite_list");
    const ada = await signUp("ada@acme.example", "Acme");
    const bob = await invite(ada, "bob@acme.example");
    await invite(ada, "carol@acme.example", "viewer");
    await follow(bob.token, "bob@acme.example");

    const listed = await api.app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: { cookie: ada.cookie },
    });

    expect(listed.statusCode).toBe(200);
    const invitations = (
      listed.json() as { invitations: Record<string, unknown>[] }
    ).invitations;

    // Bob accepted his, so it is no longer outstanding.
    expect(invitations.map((one) => one.email)).toEqual([
      "carol@acme.example",
    ]);
    expect(JSON.stringify(invitations)).not.toContain("acceptUrl");
  });

  it("never shows one customer another customer's", async () => {
    api = await createApi("invite_list_tenancy");
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");
    await invite(ada, "bob@acme.example");
    await invite(grace, "hedy@globex.example");

    const listed = await api.app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: { cookie: grace.cookie },
    });

    const invitations = (
      listed.json() as { invitations: { email: string }[] }
    ).invitations;
    expect(invitations.map((one) => one.email)).toEqual([
      "hedy@globex.example",
    ]);
  });
});
