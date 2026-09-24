import { afterEach, describe, expect, it } from "vitest";

import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

/** Check that the identity provider refuses a forged session and honours a revoked one. */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

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
  expect(created.statusCode).toBe(201);
  return cookiesFrom(created.headers["set-cookie"]);
}

function requestWith(cookie: string | null): Request {
  return new Request("http://localhost:3101/api/me", {
    headers: cookie === null ? {} : { cookie },
  });
}

describe("resolving an identity", () => {
  it("answers nobody for a cookie that was never signed here", async () => {
    api = await createApi("seam_resolve_forged");
    await signedIn();

    expect(
      await api.identity.provider.resolveIdentity(
        requestWith("egma.session_token=not-a-real-token"),
      ),
    ).toBeNull();
  });
});

describe("revoking a session", () => {
  it("takes effect on the very next request", async () => {
    api = await createApi("seam_revoke");
    const cookie = await signedIn();

    const before = await api.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);

    const { rows } = await api.database.sql<{ token: string }>(
      "select token from session",
    );
    const token = rows[0]?.token;
    expect(token).toBeTypeOf("string");

    await api.identity.provider.revokeSession(token as string);

    const after = await api.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});
