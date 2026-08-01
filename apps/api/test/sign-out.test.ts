import { afterEach, describe, expect, it } from "vitest";

import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

/**
 * Signing out, over HTTP, because that is where the guarantee lives: whatever
 * the route does internally, the thing being promised is that the cookie a
 * browser is holding stops being worth anything on the very next request.
 *
 * There is a browser test in this directory covering one end-to-end path, and
 * it is deliberately not grown here. What a browser would add is that a button
 * exists; what matters is what the button causes, and that is this.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

/** Somebody signed up and signed in, and the cookie their browser now holds. */
async function signedIn(email: string, organizationName: string): Promise<string> {
  const created = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: { email, password: "a-long-enough-password", organizationName },
  });
  expect(created.statusCode).toBe(201);
  return cookiesFrom(created.headers["set-cookie"]);
}

async function whoIsThis(cookie: string | null): Promise<number> {
  const asked = await api.app.inject({
    method: "GET",
    url: "/api/me",
    ...(cookie === null ? {} : { headers: { cookie } }),
  });
  return asked.statusCode;
}

async function sessionCount(): Promise<number> {
  const { rows } = await api.database.sql<{ held: string }>(
    "select count(*)::text as held from session",
  );
  return Number(rows[0]?.held ?? "-1");
}

describe("signing out", () => {
  it("succeeds for a signed-in browser, and that session then resolves to nobody", async () => {
    api = await createApi("sign_out_ends_it");
    const cookie = await signedIn("ada@acme.example", "Acme");

    expect(await whoIsThis(cookie)).toBe(200);

    const out = await api.app.inject({
      method: "POST",
      url: "/api/sign-out",
      headers: { cookie },
    });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ signed_out: true });

    // The same cookie, unchanged, on the very next request.
    expect(await whoIsThis(cookie)).toBe(401);
  });

  /**
   * Ending it where it is kept rather than only in the browser that clicked, so
   * a copy of the cookie taken somewhere else is over too.
   */
  it("takes the session out of the database rather than leaving a dead one behind", async () => {
    api = await createApi("sign_out_row");
    const cookie = await signedIn("ada@acme.example", "Acme");
    expect(await sessionCount()).toBe(1);

    const out = await api.app.inject({
      method: "POST",
      url: "/api/sign-out",
      headers: { cookie },
    });
    expect(out.statusCode).toBe(200);

    expect(await sessionCount()).toBe(0);
  });

  it("takes the cookie back out of the browser as well", async () => {
    api = await createApi("sign_out_cookie");
    const cookie = await signedIn("ada@acme.example", "Acme");

    const out = await api.app.inject({
      method: "POST",
      url: "/api/sign-out",
      headers: { cookie },
    });

    const cleared = [out.headers["set-cookie"] ?? []].flat();
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toContain("egma.session_token=;");
    expect(cleared[0]).toContain("Max-Age=0");
    expect(cleared[0]).toContain("HttpOnly");
  });

  /**
   * Nothing to do is not a refusal. A person whose session already went away —
   * in another tab, or by expiring — is not told they may not leave.
   */
  it("is not an error for somebody who was not signed in", async () => {
    api = await createApi("sign_out_nobody");
    const cookie = await signedIn("ada@acme.example", "Acme");

    const out = await api.app.inject({ method: "POST", url: "/api/sign-out" });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ signed_out: true });

    // And nobody else's was ended on the way past.
    expect(await sessionCount()).toBe(1);
    expect(await whoIsThis(cookie)).toBe(200);
  });

  it("ends the session it was sent with, and nobody else's", async () => {
    api = await createApi("sign_out_only_mine");
    const ada = await signedIn("ada@acme.example", "Acme");
    const grace = await signedIn("grace@globex.example", "Globex");

    const out = await api.app.inject({
      method: "POST",
      url: "/api/sign-out",
      headers: { cookie: ada },
    });
    expect(out.statusCode).toBe(200);

    expect(await whoIsThis(ada)).toBe(401);
    expect(await whoIsThis(grace)).toBe(200);
  });

  /**
   * A signed cookie that was never signed here names no session, so there is
   * nothing to end — and in particular no way to end somebody else's by
   * guessing at the token inside one.
   */
  it("ends nothing at all for a cookie that was never signed here", async () => {
    api = await createApi("sign_out_forged");
    const cookie = await signedIn("ada@acme.example", "Acme");

    const out = await api.app.inject({
      method: "POST",
      url: "/api/sign-out",
      headers: { cookie: "egma.session_token=not-a-real-token" },
    });
    expect(out.statusCode).toBe(200);

    expect(await sessionCount()).toBe(1);
    expect(await whoIsThis(cookie)).toBe(200);
  });
});
