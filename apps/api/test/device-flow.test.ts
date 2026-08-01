import { afterEach, describe, expect, it } from "vitest";

import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

/**
 * `egma login`, end to end, from the side the terminal sees.
 *
 * Every branch of the flow is proved here rather than in a browser, because
 * every branch of the flow is an answer the API gives and a browser adds
 * nothing to reading it. The one path a browser is genuinely needed for — a
 * person looking at a page with a code already in it and clicking approve — has
 * exactly one test of its own.
 */

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

type Codes = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUriComplete: string;
  readonly intervalSeconds: number;
};

async function start(): Promise<Codes> {
  const response = await api.app.inject({
    method: "POST",
    url: "/api/device/code",
    payload: { client_id: "egma-cli" },
  });
  expect(response.statusCode).toBe(200);

  const body = response.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    interval: number;
    expires_in: number;
  };

  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUriComplete: body.verification_uri_complete,
    intervalSeconds: body.interval,
  };
}

/** What a terminal sends: form-encoded, exactly as RFC 8628 says. */
async function exchange(deviceCode: string) {
  return api.app.inject({
    method: "POST",
    url: "/api/device/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
      client_id: "egma-cli",
    }).toString(),
  });
}

async function signUp(
  email = "ada@acme.example",
  organizationName = "Acme",
): Promise<string> {
  const created = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: { email, password: "a-long-enough-password", organizationName },
  });
  expect(created.statusCode).toBe(201);
  return cookiesFrom(created.headers["set-cookie"]);
}

/**
 * A poll that is not being rate-limited by the provider. The interval is real
 * and honouring it is the client's job, so a test that wants the *next* answer
 * rather than `slow_down` waits it out the way a terminal would.
 */
async function pollPast(deviceCode: string, intervalSeconds: number) {
  await api.database.sql(
    "update device_code set last_polled_at = now() - ($1 || ' seconds')::interval where device_code = $2",
    [String(intervalSeconds + 1), deviceCode],
  );
  return exchange(deviceCode);
}

describe("starting a device authorization", () => {
  it("hands the terminal a code and an address on this instance", async () => {
    api = await createApi("device_start");
    const response = await api.app.inject({
      method: "POST",
      url: "/api/device/code",
      payload: { client_id: "egma-cli" },
    });

    const body = response.json() as Record<string, unknown>;

    expect(body.user_code).toMatch(/^[A-Z0-9]{8}$/);
    expect(body.device_code).toBeTypeOf("string");
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.interval).toBeGreaterThan(0);

    // The self-hoster's own origin, never a domain egma runs, and the code is
    // already in it so that nobody retypes characters between two windows.
    expect(body.verification_uri).toBe(`${api.config.baseUrl}/device`);
    expect(body.verification_uri_complete).toBe(
      `${api.config.baseUrl}/device?user_code=${String(body.user_code)}`,
    );
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

describe("polling while nobody has answered", () => {
  it("says the authorization is pending", async () => {
    api = await createApi("device_pending");
    const codes = await start();

    const polled = await exchange(codes.deviceCode);

    expect(polled.statusCode).toBe(400);
    expect(polled.json()).toMatchObject({ error: "authorization_pending" });
  });

  it("says slow down when a client polls faster than the interval it was given", async () => {
    api = await createApi("device_slow_down");
    const codes = await start();

    expect((await exchange(codes.deviceCode)).json()).toMatchObject({
      error: "authorization_pending",
    });
    const again = await exchange(codes.deviceCode);

    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: "slow_down" });

    // And the answer goes back to pending once the interval has passed, so a
    // client that backs off is not punished for having been told to.
    const later = await pollPast(codes.deviceCode, codes.intervalSeconds);
    expect(later.json()).toMatchObject({ error: "authorization_pending" });
  });
});

describe("the approval page's view of a code", () => {
  it("refuses to say anything at all to somebody who is not signed in", async () => {
    api = await createApi("device_view_signed_out");
    const codes = await start();

    const looked = await api.app.inject({
      method: "GET",
      url: `/api/device/authorization?user_code=${codes.userCode}`,
    });

    expect(looked.statusCode).toBe(401);
    expect(looked.json()).toMatchObject({ status: "signed_out" });
  });

  it("names the organization and the projects the terminal would be let into", async () => {
    api = await createApi("device_view");
    const codes = await start();
    const cookie = await signUp();

    const looked = await api.app.inject({
      method: "GET",
      url: `/api/device/authorization?user_code=${codes.userCode}`,
      headers: { cookie },
    });

    expect(looked.statusCode).toBe(200);
    expect(looked.json()).toMatchObject({
      status: "pending",
      user_code: codes.userCode,
      organization: { name: "Acme" },
      projects: [{ name: "Default" }],
    });
  });

  it("takes a code typed back with a hyphen and lower case, because people do that", async () => {
    api = await createApi("device_view_typed");
    const codes = await start();
    const cookie = await signUp();

    const typed = `${codes.userCode.slice(0, 4)}-${codes.userCode.slice(4)}`.toLowerCase();
    const looked = await api.app.inject({
      method: "GET",
      url: `/api/device/authorization?user_code=${encodeURIComponent(typed)}`,
      headers: { cookie },
    });

    expect(looked.json()).toMatchObject({ status: "pending" });
  });

  it("says a code it does not recognise is unknown, not expired", async () => {
    api = await createApi("device_view_mistyped");
    await start();
    const cookie = await signUp();

    const looked = await api.app.inject({
      method: "GET",
      url: "/api/device/authorization?user_code=AAAAAAAA",
      headers: { cookie },
    });

    expect(looked.json()).toEqual({ status: "unknown" });
  });

  it("says a code that sat too long is expired, and says which of the two it was", async () => {
    api = await createApi("device_view_expired");
    const codes = await start();
    const cookie = await signUp();

    await api.database.sql(
      "update device_code set expires_at = now() - interval '1 minute' where user_code = $1",
      [codes.userCode],
    );

    const looked = await api.app.inject({
      method: "GET",
      url: `/api/device/authorization?user_code=${codes.userCode}`,
      headers: { cookie },
    });

    expect(looked.json()).toEqual({ status: "expired" });
  });
});

describe("approving", () => {
  it("mints a key at the end of it, shown exactly once, that works on real requests", async () => {
    api = await createApi("device_approve");
    const codes = await start();
    const cookie = await signUp();

    const looked = await api.app.inject({
      method: "GET",
      url: `/api/device/authorization?user_code=${codes.userCode}`,
      headers: { cookie },
    });
    const projectId = (looked.json() as { projects: { id: string }[] })
      .projects[0]?.id;

    const approved = await api.app.inject({
      method: "POST",
      url: "/api/device/approve",
      headers: { cookie },
      payload: { user_code: codes.userCode, project_id: projectId },
    });
    expect(approved.json()).toEqual({ status: "approved" });

    const collected = await pollPast(codes.deviceCode, codes.intervalSeconds);
    expect(collected.statusCode).toBe(200);

    const grant = collected.json() as Record<string, unknown>;
    expect(grant.token_type).toBe("Bearer");
    expect(grant.project_id).toBe(projectId);
    expect(grant.scope).toBe("project");
    // Keys never expire, so the protocol says nothing about when this one does.
    expect(grant).not.toHaveProperty("expires_in");
    expect(collected.headers["cache-control"]).toBe("no-store");

    const secret = String(grant.access_token);
    expect(secret).toMatch(/^egma_sk_[A-Za-z0-9_-]{43}$/);

    // Shown exactly once: the table holds a hash and a few characters, and no
    // second request will ever produce this string again.
    const { rows } = await api.database.sql<{
      hash: string;
      prefix: string;
      display_suffix: string;
    }>("select hash, prefix, display_suffix from api_key");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hash).not.toContain(secret);
    expect(rows[0]?.prefix).toBe("egma_sk_");
    expect(rows[0]?.display_suffix).toBe(secret.slice(-4));

    // And the terminal now holds something that works.
    const used = await api.app.inject({
      method: "GET",
      url: "/api/keys",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(used.statusCode).toBe(200);
    expect((used.json() as { keys: unknown[] }).keys).toHaveLength(1);

    // The code is spent. A second terminal cannot collect the same grant.
    const again = await pollPast(codes.deviceCode, codes.intervalSeconds);
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: "expired_token" });
  });

  it("is refused when the project belongs to another customer", async () => {
    api = await createApi("device_approve_foreign_project");
    const codes = await start();
    const cookie = await signUp();

    // Globex's project, named by Acme's browser.
    const { rows } = await api.database.sql<{ id: string }>(
      `with o as (
         insert into organization (id, name, slug)
         values ('org_00000000000000000000000001', 'Globex', 'globex') returning id)
       insert into project (id, organization_id, name, slug)
       select 'prj_00000000000000000000000001', o.id, 'Theirs', 'theirs' from o
       returning id`,
    );

    const approved = await api.app.inject({
      method: "POST",
      url: "/api/device/approve",
      headers: { cookie },
      payload: { user_code: codes.userCode, project_id: rows[0]?.id },
    });

    expect(approved.statusCode).toBe(403);
    expect(approved.json()).toMatchObject({
      error: "project_outside_organization",
    });
  });

  it("cannot be done by somebody who is not signed in", async () => {
    api = await createApi("device_approve_signed_out");
    const codes = await start();

    const approved = await api.app.inject({
      method: "POST",
      url: "/api/device/approve",
      payload: { user_code: codes.userCode },
    });

    expect(approved.statusCode).toBe(401);
  });
});

describe("denying", () => {
  it("tells the terminal it was denied rather than leaving it waiting", async () => {
    api = await createApi("device_deny");
    const codes = await start();
    const cookie = await signUp();

    const denied = await api.app.inject({
      method: "POST",
      url: "/api/device/deny",
      headers: { cookie },
      payload: { user_code: codes.userCode },
    });
    expect(denied.json()).toEqual({ status: "denied" });

    const collected = await pollPast(codes.deviceCode, codes.intervalSeconds);
    expect(collected.statusCode).toBe(400);
    expect(collected.json()).toMatchObject({ error: "access_denied" });

    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*) as count from api_key",
    );
    expect(rows[0]?.count).toBe("0");
  });
});

describe("a code that sat too long", () => {
  it("tells the terminal it expired, which is not the same as being denied", async () => {
    api = await createApi("device_expired");
    const codes = await start();

    await api.database.sql(
      "update device_code set expires_at = now() - interval '1 minute' where device_code = $1",
      [codes.deviceCode],
    );

    const collected = await exchange(codes.deviceCode);
    expect(collected.statusCode).toBe(400);
    expect(collected.json()).toMatchObject({ error: "expired_token" });
  });
});

describe("the token endpoint", () => {
  it("understands the device grant and nothing else", async () => {
    api = await createApi("device_grant_type");
    const codes = await start();

    const wrong = await api.app.inject({
      method: "POST",
      url: "/api/device/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "password",
        device_code: codes.deviceCode,
        client_id: "egma-cli",
      }).toString(),
    });

    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("refuses a device code it has never issued", async () => {
    api = await createApi("device_unknown_code");

    const collected = await exchange("not-a-device-code-anybody-was-given");

    expect(collected.statusCode).toBe(400);
    expect(collected.json()).toMatchObject({ error: "expired_token" });
  });

  it("refuses to mint for an approval that never named a project", async () => {
    api = await createApi("device_unaimed");
    const codes = await start();
    const cookie = await signUp();

    // Somebody posting straight at the provider's own approve endpoint,
    // around the page where the organization and the project are chosen.
    await api.app.inject({
      method: "GET",
      url: `/api/auth/device?user_code=${codes.userCode}`,
      headers: { cookie },
    });
    const approved = await api.app.inject({
      method: "POST",
      url: "/api/auth/device/approve",
      headers: { cookie, "content-type": "application/json" },
      payload: { userCode: codes.userCode },
    });
    expect(approved.statusCode).toBe(200);

    const collected = await pollPast(codes.deviceCode, codes.intervalSeconds);
    expect(collected.statusCode).toBe(400);
    expect(collected.json()).toMatchObject({ error: "invalid_grant" });

    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*) as count from api_key",
    );
    expect(rows[0]?.count).toBe("0");
  });
});
