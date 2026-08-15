import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { Identity } from "../src/auth/better-auth.ts";
import { sealResetLink } from "../src/auth/password-reset.ts";
import { passwordResetRoutes } from "../src/routes/password-reset.ts";
import { signupRoutes } from "../src/routes/signup.ts";
import { testConfig } from "./support/api.ts";

/**
 * What the auth provider refuses, as the two doors that relay to it say it.
 *
 * Signup and the completing half of a password reset both post at the
 * provider's own endpoints and both have to turn its answer into egma's. **The
 * claim here is that they say the same thing**: one refusal, one code, whichever
 * door met it. A code is what a client branches on and the only thing it may
 * branch on, so two doors spelling one refusal two ways would be two contracts
 * to keep — and the second one is always the one nobody remembers.
 *
 * The provider is a stub rather than the real one, and that is the point: the
 * refusals worth pinning down are the ones a real provider gives rarely and
 * only under settings a test suite does not run with. Its rate limit is on when
 * `NODE_ENV=production`, which is what the API's own container sets and what no
 * test does — so the answer a person clicking "Send the link" a fourth time
 * gets is unreachable here any other way. Everything in front of the stub is
 * egma's own code, driven over HTTP exactly as a browser drives it.
 */

/** Exactly what the provider's rate limiter writes, headers and all. */
function tooManyRequests(): Response {
  return new Response(
    JSON.stringify({ message: "Too many requests. Please try again later." }),
    { status: 429, headers: { "X-Retry-After": "42" } },
  );
}

/** And exactly what its endpoints write when they refuse the body. */
function refusesWith(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  const running = app;
  app = undefined;
  await running?.close();
});

/** Both doors, in front of one provider that always answers the same way. */
async function bothDoors(answer: () => Response): Promise<FastifyInstance> {
  const config = testConfig();
  const identity = {
    handler: async () => answer(),
    provider: undefined,
  } as unknown as Identity;

  app = Fastify({ logger: false });
  void app.register(passwordResetRoutes, {
    identity,
    authBasePath: "/api/auth",
    baseUrl: config.baseUrl,
    secret: config.authSecret,
  });
  void app.register(signupRoutes, {
    identity,
    authBasePath: "/api/auth",
    baseUrl: config.baseUrl,
    singleOrganization: false,
  });
  await app.ready();
  return app;
}

/**
 * A link this egma would have minted, so the refusal under test is the
 * provider's rather than the seal's.
 */
function aLiveLink(): string {
  return sealResetLink(
    {
      token: "a-token-the-provider-minted",
      expiresAt: new Date(Date.now() + 60_000),
    },
    testConfig().authSecret,
  );
}

describe("a provider that is refusing for rate", () => {
  /**
   * Clicking "Send the link" a fourth time inside a minute is ordinary human
   * impatience, and the provider's default budget for that endpoint is three.
   * A refusal is the honest answer; a 500 naming egma's own internals is not —
   * it tells the person nothing they can act on, and it writes an error to the
   * operator's log for somebody behaving normally.
   */
  it("is relayed as a refusal a person can act on, not as a fault", async () => {
    const door = await bothDoors(tooManyRequests);

    const asked = await door.inject({
      method: "POST",
      url: "/api/password-reset",
      payload: { email: "ada@acme.example" },
    });

    expect(asked.statusCode).toBe(429);
    const said = asked.json() as { error: string; message: string };
    expect(said.error).toBe("too_many_requests");
    // What happened, and what to do about it.
    expect(said.message).toMatch(/too many/i);
    expect(said.message).toMatch(/wait 42 seconds/i);
    // Never egma's own machinery, which is what a 500 would have named.
    expect(said.message).not.toMatch(/auth provider|500/i);
    expect(asked.headers["retry-after"]).toBe("42");
  });

  it("says the same at the door that finishes a reset", async () => {
    const door = await bothDoors(tooManyRequests);

    const finished = await door.inject({
      method: "POST",
      url: "/api/password-reset/complete",
      payload: { token: aLiveLink(), password: "a-long-enough-password" },
    });

    expect(finished.statusCode).toBe(429);
    expect((finished.json() as { error: string }).error).toBe("too_many_requests");
  });

  it("and at the door that signs somebody up", async () => {
    const door = await bothDoors(tooManyRequests);

    const signedUp = await door.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        email: "ada@acme.example",
        password: "a-long-enough-password",
        organizationName: "Acme",
      },
    });

    expect(signedUp.statusCode).toBe(429);
    expect((signedUp.json() as { error: string }).error).toBe("too_many_requests");
  });
});

describe("a provider that is refusing what was typed", () => {
  /**
   * The provider spells its codes `PASSWORD_TOO_SHORT`; every code egma has
   * ever shipped is snake_case. Relaying the vendor's exact spelling would make
   * each of these codes a vendor's word to keep, and a provider swap a breaking
   * change for every client rather than a change behind the seam.
   */
  it("arrives in egma's spelling rather than the provider's", async () => {
    const door = await bothDoors(() =>
      refusesWith(400, "PASSWORD_TOO_SHORT", "Password is too short"),
    );

    const finished = await door.inject({
      method: "POST",
      url: "/api/password-reset/complete",
      payload: { token: aLiveLink(), password: "short" },
    });

    expect(finished.statusCode).toBe(400);
    const said = finished.json() as { error: string; message: string };
    expect(said.error).toBe("password_too_short");
    // The sentence is the provider's, because the provider holds the rule.
    expect(said.message).toBe("Password is too short");
  });

  it("arrives the same way at the door that signs somebody up", async () => {
    const door = await bothDoors(() =>
      refusesWith(400, "PASSWORD_TOO_SHORT", "Password is too short"),
    );

    const [finished, signedUp] = await Promise.all([
      door.inject({
        method: "POST",
        url: "/api/password-reset/complete",
        payload: { token: aLiveLink(), password: "short" },
      }),
      door.inject({
        method: "POST",
        url: "/api/signup",
        payload: {
          email: "ada@acme.example",
          password: "short",
          organizationName: "Acme",
        },
      }),
    ]);

    // One refusal, one code, whichever door met it.
    expect((signedUp.json() as { error: string }).error).toBe(
      (finished.json() as { error: string }).error,
    );
  });

  /**
   * Egma's own refusals travel this same channel — the signup hooks throw them
   * from inside the provider's call stack — already spelled egma's way. They
   * pass through untouched, which is what keeps `invitation_required` the word
   * the signup page reads.
   */
  it("leaves egma's own codes exactly as egma wrote them", async () => {
    const door = await bothDoors(() =>
      refusesWith(
        403,
        "invitation_required",
        "this egma has been claimed. Ask an admin for an invitation.",
      ),
    );

    const signedUp = await door.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        email: "ada@acme.example",
        password: "a-long-enough-password",
        organizationName: "Acme",
      },
    });

    expect(signedUp.statusCode).toBe(403);
    expect((signedUp.json() as { error: string }).error).toBe(
      "invitation_required",
    );
  });

  /**
   * **The one sentence the provider writes about itself rather than about the
   * caller**, and it reaches nobody.
   *
   * `[body.email] Invalid email address` names a field in the provider's own
   * body schema. ADR-0007 forbids a refusal generated from validation
   * internals, and is right to: a coding agent reading that learns the name of
   * somebody else's parser and nothing it can act on. So neither half of it
   * ships — not the code, which is the provider's word for its own schema, and
   * not the sentence. It is held here rather than at either door, because the
   * door that forgot would be the one nobody was looking at, which is exactly
   * how signup came to be relaying it while the reset door was not.
   */
  it("never relays what the provider generated from its own body schema", async () => {
    const door = await bothDoors(() =>
      refusesWith(400, "VALIDATION_ERROR", "[body.email] Invalid email address"),
    );

    const [signedUp, reset] = await Promise.all([
      door.inject({
        method: "POST",
        url: "/api/signup",
        payload: {
          email: "not-an-email",
          password: "a-long-enough-password",
          organizationName: "Acme",
        },
      }),
      door.inject({
        method: "POST",
        url: "/api/password-reset/complete",
        payload: { token: aLiveLink(), password: "a-long-enough-password" },
      }),
    ]);

    for (const refused of [signedUp, reset]) {
      const said = refused.json() as { error: string; message: string };
      expect(refused.statusCode).toBe(400);
      expect(said.error).not.toBe("validation_error");
      expect(said.message).not.toContain("body.email");
      // What is left is the door's own words, written for the person at it.
      expect(said.message.length).toBeGreaterThan(0);
    }

    expect((signedUp.json() as { error: string }).error).toBe("signup_failed");
  });

  /**
   * And an answer that named no code egma could relay — a proxy's own page, an
   * empty body, HTML. A client branching on `error` must never be handed a
   * sentence or an empty string wearing the shape of a promise.
   */
  it("falls back to the door's own code when the provider named none", async () => {
    const door = await bothDoors(
      () => new Response("<html>gateway</html>", { status: 400 }),
    );

    const signedUp = await door.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        email: "ada@acme.example",
        password: "a-long-enough-password",
        organizationName: "Acme",
      },
    });

    expect((signedUp.json() as { error: string }).error).toBe("signup_failed");
  });
});
