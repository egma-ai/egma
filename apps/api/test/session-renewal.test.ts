import { afterEach, describe, expect, it } from "vitest";

import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

/**
 * Staying signed in while you are using egma.
 *
 * A browser session runs thirty days from its last use, and the provider moves
 * that deadline out once a day of use has passed. The row is only half of it:
 * the renewal reaches the person as a `set-cookie` line on the reply, and a
 * reply that drops it leaves the browser on the cookie it was handed at
 * sign-in — which then dies on the sign-in day however much they used it. So
 * the claim under test is the header, over HTTP, on every door a browser
 * reaches.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

/** Thirty days, in the seconds a `Max-Age` is written in. */
const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

/** Somebody signed up and signed in, and the cookie their browser now holds. */
async function signedIn(): Promise<string> {
  const created = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: {
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  return cookiesFrom(created.headers["set-cookie"]);
}

/** Every `set-cookie` line on a reply, however many there were. */
function setCookies(header: string | string[] | undefined): string[] {
  return header === undefined ? [] : [header].flat();
}

/** The line carrying the session cookie, or nothing when there is none. */
function sessionCookieIn(
  header: string | string[] | undefined,
): string | undefined {
  return setCookies(header).find((line) => line.includes("egma.session_token="));
}

/**
 * Put the session where a browser that has been signing in for a while sits.
 *
 * Renewal is due once the row's deadline is inside thirty days minus one, so
 * twenty days out is due and the thirty days a fresh sign-in gets is not.
 */
async function dueForRenewal(): Promise<void> {
  await api.database.sql(
    "update session set expires_at = now() + interval '20 days'",
  );
}

/** How far the stored deadline sits from thirty days out, in seconds. */
async function deadlineDriftSeconds(): Promise<number> {
  const { rows } = await api.database.sql<{ drift: string }>(
    `select extract(epoch from (expires_at - (now() + interval '30 days')))::text as drift
       from session`,
  );
  return Number(rows[0]?.drift ?? "NaN");
}

async function whoIsThis(cookie: string): Promise<number> {
  const asked = await api.app.inject({
    method: "GET",
    url: "/api/me",
    headers: { cookie },
  });
  return asked.statusCode;
}

describe("a browser session", () => {
  it("is left alone on a read that comes right after signing in", async () => {
    api = await createApi("session_renewal_not_due");
    const cookie = await signedIn();

    const read = await api.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });

    expect(read.statusCode).toBe(200);
    expect(setCookies(read.headers["set-cookie"])).toEqual([]);
  });

  it("is renewed on the first read after a day of use, in the cookie and in the row", async () => {
    api = await createApi("session_renewal_due");
    const cookie = await signedIn();
    await dueForRenewal();

    const read = await api.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);

    const renewed = sessionCookieIn(read.headers["set-cookie"]);
    expect(renewed).toBeTypeOf("string");
    expect(renewed).toContain(`Max-Age=${THIRTY_DAYS_SECONDS}`);

    // Both halves, so the browser and the database cannot disagree about when
    // this session is over.
    expect(Math.abs(await deadlineDriftSeconds())).toBeLessThan(120);
  });

  it("hands back a cookie that signs the next request in", async () => {
    api = await createApi("session_renewal_usable");
    const cookie = await signedIn();
    await dueForRenewal();

    const read = await api.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);

    const next = cookiesFrom(read.headers["set-cookie"]);
    expect(next).toContain("egma.session_token=");
    expect(await whoIsThis(next)).toBe(200);
  });

  /**
   * A person who leaves a page open is not reading `/api/me` all day; they are
   * reading product routes. Those go through the shared credentialed hook, and
   * the renewal has to come back from there as well or a whole working week
   * counts for nothing.
   */
  it("is renewed on a product route too, and not only on /api/me", async () => {
    api = await createApi("session_renewal_product_route");
    const cookie = await signedIn();
    await dueForRenewal();

    const listed = await api.app.inject({
      method: "GET",
      url: "/v1/members",
      headers: { cookie },
    });
    expect(listed.statusCode, listed.body).toBe(200);

    const renewed = sessionCookieIn(listed.headers["set-cookie"]);
    expect(renewed).toBeTypeOf("string");
    expect(renewed).toContain(`Max-Age=${THIRTY_DAYS_SECONDS}`);
    expect(Math.abs(await deadlineDriftSeconds())).toBeLessThan(120);
  });

  /**
   * The traces door spells the credentialed hook out by hand, so it is proved
   * on its own: a browser reaching it is renewed the same way, whatever the
   * door then makes of the body.
   */
  it("is renewed on the traces door too", async () => {
    api = await createApi("session_renewal_traces_door");
    const cookie = await signedIn();
    await dueForRenewal();

    const posted = await api.app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { cookie, "content-type": "application/json" },
      payload: { resourceSpans: [] },
    });
    expect(posted.statusCode, posted.body).not.toBe(401);

    const renewed = sessionCookieIn(posted.headers["set-cookie"]);
    expect(renewed).toBeTypeOf("string");
    expect(renewed).toContain(`Max-Age=${THIRTY_DAYS_SECONDS}`);
  });

  /** An API key has no cookie to renew, so a request under one sets none. */
  it("sets no cookie on a request made with an API key", async () => {
    api = await createApi("session_renewal_api_key");
    const cookie = await signedIn();

    const me = await api.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    const projectId = (me.json() as { projects: { id: string }[] }).projects[0]?.id;
    expect(projectId).toBeTypeOf("string");
    const minted = await api.app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "the terminal", projectId },
    });
    expect(minted.statusCode, minted.body).toBe(201);
    const secret = (minted.json() as { secret: string }).secret;
    await dueForRenewal();

    const listed = await api.app.inject({
      method: "GET",
      url: "/v1/agents",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(setCookies(listed.headers["set-cookie"])).toEqual([]);
  });

  /**
   * Renewal keeps a session alive; it does not make one hard to end. Signing
   * out still deletes the row, so the renewed cookie and the one it came from
   * are both worth nothing on the very next request.
   */
  it("still ends the moment somebody signs out", async () => {
    api = await createApi("session_renewal_sign_out");
    const cookie = await signedIn();
    await dueForRenewal();

    const read = await api.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    const renewed = cookiesFrom(read.headers["set-cookie"]);

    const out = await api.app.inject({
      method: "POST",
      url: "/api/sign-out",
      headers: { cookie: renewed },
    });
    expect(out.statusCode).toBe(200);

    expect(await whoIsThis(renewed)).toBe(401);
    expect(await whoIsThis(cookie)).toBe(401);
  });
});
