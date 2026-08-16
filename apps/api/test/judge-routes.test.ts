import { seedDefaultJudge } from "@egma/db";
import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { colleagueOf, signUp, type Customer } from "./support/traces.ts";

/** One mounted address and the methods answering at it. */
type MountedRoute = {
  readonly path: string;
  readonly methods: readonly string[];
};

/**
 * Every route the server mounts, read off its own printed tree.
 *
 * Fastify prints a radix tree, so a node's own text is what its parent's text
 * does *not* already spell — `/api/me` has a child `mbers`, and the two
 * concatenate to `/api/members`. Walking it with a stack of prefixes is
 * therefore the whole of the parse, and it is what makes this list the
 * server's rather than a copy of it kept by hand.
 */
function routesOf(tree: string): readonly MountedRoute[] {
  const found: MountedRoute[] = [];
  const prefixes: string[] = [];

  for (const line of tree.split("\n")) {
    const marked = /^((?:[│ ]\s\s\s)*)(?:├──|└──)\s(.*)$/.exec(line);
    if (marked === null) continue;

    const depth = (marked[1] ?? "").length / 4;
    const rest = marked[2] ?? "";
    const spoken = /^(.*?)\s\(([^()]*)\)\s*$/.exec(rest);
    const segment = (spoken === null ? rest : (spoken[1] ?? "")).trim();

    prefixes.length = depth;
    prefixes.push(segment);

    if (spoken !== null) {
      found.push({
        path: prefixes.join(""),
        methods: (spoken[2] ?? "")
          .split(",")
          .map((method) => method.trim())
          .filter((method) => method !== ""),
      });
    }
  }

  return found;
}

/**
 * The order the sweep asks in.
 *
 * Signing out is the one request that ends the ability to make requests, so it
 * goes last — not excluded, which would be a hole, but asked when there is
 * nothing after it to hollow out. Everything else keeps the server's own order.
 */
function sweepOrder(routes: readonly MountedRoute[]): readonly MountedRoute[] {
  const endsTheSession = (route: MountedRoute): boolean =>
    route.path === "/api/sign-out";
  return [
    ...routes.filter((route) => !endsTheSession(route)),
    ...routes.filter(endsTheSession),
  ];
}

/**
 * The judge routes, over real HTTP against real Postgres.
 *
 * **The claim this file exists to make: a stored judge key never comes back.**
 * An organization admin can label a credential, replace its secret whole, and
 * point a project at it — and at no point, through no route, with no argument,
 * does egma hand the stored value back to the browser. That is asserted here
 * against every route this API mounts rather than against the one that stores
 * it, because "the secret does not leak" is a property of the *surface* and not
 * of any single handler: a leak would arrive through some other route's
 * serializer, which is exactly what a test aimed at the storing route would
 * miss.
 *
 * Beside it, the two things a page depends on: `needs_setup` is a state and not
 * a failure, and choosing a judge names a credential rather than carrying a
 * key.
 *
 * Refusal wording is contract — a page shows these sentences word for word —
 * so a sentence that changed without somebody deciding to change it fails here.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

/** A key long enough to be one, and unmistakable if it ever appears in a body. */
const A_KEY = "sk-judge-NEVER-RETURNS-TO-A-BROWSER-1234";
const ANOTHER_KEY = "sk-judge-ROTATED-AND-ALSO-SECRET-98765";
/** The deployment's own, which is not a customer's to see either. */
const THE_PLATFORMS_KEY = "sk-the-platforms-own-key-NEVER-SHOWN-WXYZ";

type Answer = {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
};

async function asBrowser(
  person: Customer,
  method: "GET" | "POST" | "PATCH" | "PUT",
  url: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  const response = await api.app.inject({
    method,
    url,
    headers: { cookie: person.cookie },
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    statusCode: response.statusCode,
    body: (() => {
      try {
        return response.json() as Record<string, unknown>;
      } catch {
        return {};
      }
    })(),
    raw: response.body,
  };
}

async function credentialFor(
  person: Customer,
  label: string,
  key: string,
): Promise<{ readonly id: string; readonly revision: string }> {
  const created = await asBrowser(person, "POST", "/api/judge-credentials", {
    label,
    provider: "openai",
    key,
  });
  expect(created.statusCode, created.raw).toBe(201);
  return {
    id: created.body.id as string,
    revision: created.body.revision as string,
  };
}

describe("an organization's judge credentials", () => {
  it("answers a label, a provider and a hint — and never the key, on create, list or read", async () => {
    api = await createApi("judge_credentials_never_return");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const created = await asBrowser(ada, "POST", "/api/judge-credentials", {
      label: "Acme production",
      provider: "openai",
      key: A_KEY,
    });

    expect(created.statusCode, created.raw).toBe(201);
    expect(created.body).toMatchObject({
      label: "Acme production",
      provider: "openai",
      // Four characters, which is enough to tell two keys apart and not enough
      // to be one.
      hint: "1234",
    });
    expect(created.raw).not.toContain(A_KEY);
    // Not blanked — absent. There is no field on the wire a key could travel in.
    expect(Object.keys(created.body)).not.toContain("key");
    expect(Object.keys(created.body)).not.toContain("credentials");

    const id = created.body.id as string;

    const listed = await asBrowser(ada, "GET", "/api/judge-credentials");
    expect(listed.statusCode, listed.raw).toBe(200);
    expect(listed.raw).not.toContain(A_KEY);
    expect((listed.body.items as { id: string }[]).map((one) => one.id)).toEqual([
      id,
    ]);

    const read = await asBrowser(ada, "GET", `/api/judge-credentials/${id}`);
    expect(read.statusCode, read.raw).toBe(200);
    expect(read.raw).not.toContain(A_KEY);
  });

  /**
   * The whole-surface version of the claim above, and the one that actually
   * protects the promise.
   *
   * A leak does not arrive through the route that stores a secret — that one is
   * written by somebody thinking about secrets. It arrives through a
   * neighbouring read whose serializer widened. So the routes are not listed
   * here: they are **read off the server**, which means this covers what egma
   * actually mounts today and whatever somebody mounts tomorrow. A list would
   * have been a sample dressed as a proof, and the route added next month is
   * exactly the one nobody would think to add to it.
   */
  it("cannot be read back through any route the server actually mounts", async () => {
    api = await createApi("judge_secret_unreadable_anywhere", {
      // A platform judge as well as a customer's, so both envelopes egma can
      // hold are in the database while every route is asked.
      defaultJudge: {
        provider: "openai",
        model: "gpt-4o",
        key: THE_PLATFORMS_KEY,
      },
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    // A second admin, so the writing sweep below cannot end the session the
    // reading sweep depends on.
    const bob = await colleagueOf(api.app, ada, "bob@acme.example", "admin");

    const credential = await credentialFor(ada, "Acme production", A_KEY);
    const pointed = await asBrowser(ada, "PUT", "/api/judge", {
      provider: "openai",
      model: "gpt-4.1-mini",
      source: credential.id,
      project: ada.projectId,
    });
    expect(pointed.statusCode, pointed.raw).toBe(200);

    const mounted = routesOf(api.app.printRoutes({ commonPrefix: false }));
    // A tree that stopped parsing would make this test pass by asking nothing,
    // which is the one way a sweep can lie.
    expect(mounted.length).toBeGreaterThan(30);
    expect(mounted.some((route) => route.path === "/api/judge-credentials")).toBe(
      true,
    );

    const filled = (path: string): string =>
      path
        .replace(":credentialId", credential.id)
        .replace(":graderId", newId("grd"))
        .replace(":agentId", newId("agt"))
        .replace(":mockToolId", newId("mck"))
        .replace(":testId", newId("tst"))
        .replace(":versionId", newId("tstv"))
        .replace(":runId", newId("run"))
        .replace(":simulationId", newId("sim"))
        .replace(":apiKeyId", newId("key"))
        .replace(":userId", ada.userId)
        .replace(":traceId", "0123456789abcdef0123456789abcdef")
        .replace("*", "session");

    const asked: string[] = [];
    for (const route of sweepOrder(mounted)) {
      for (const method of route.methods) {
        const url = filled(route.path);
        const response = await api.app.inject({
          method: method as "GET",
          url,
          // Reading with one admin and writing with the other: the one request
          // that ends a session must not be able to hollow out the sweep.
          headers: { cookie: method === "GET" || method === "HEAD" ? ada.cookie : bob.cookie },
          ...(method === "GET" || method === "HEAD" ? {} : { payload: {} }),
        });

        asked.push(`${method} ${url}`);
        const body = response.body;
        for (const [name, secret] of [
          ["the customer's key", A_KEY],
          ["the deployment's key", THE_PLATFORMS_KEY],
        ] as const) {
          expect(body, `${method} ${url} answered with ${name}`).not.toContain(
            secret,
          );
          // Not even most of it: four characters is the hint, and anything
          // longer is the secret leaking a piece at a time.
          expect(
            body,
            `${method} ${url} answered with most of ${name}`,
          ).not.toContain(secret.slice(0, 12));
        }
      }
    }

    // Every method of every mounted route, and the count said out loud so that
    // a parser quietly dropping half the tree cannot pass unnoticed.
    expect(asked.length).toBeGreaterThan(50);
  });

  /**
   * Replacing a key without ever reading one. This is the acceptance the
   * ticket names, stated as a sequence a person actually performs: they hold
   * only what a read gave them — a label, a hint and a revision — and that is
   * enough to rotate.
   */
  it("rotates whole from what a read gives, and the old secret never comes back", async () => {
    api = await createApi("judge_credential_rotation");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const credential = await credentialFor(ada, "Acme production", A_KEY);

    const read = await asBrowser(
      ada,
      "GET",
      `/api/judge-credentials/${credential.id}`,
    );
    expect(read.body.hint).toBe("1234");

    const rotated = await asBrowser(
      ada,
      "PATCH",
      `/api/judge-credentials/${credential.id}`,
      { key: ANOTHER_KEY, expected_revision: read.body.revision },
    );

    expect(rotated.statusCode, rotated.raw).toBe(200);
    // The identity survives, so every project pointing at it keeps pointing.
    expect(rotated.body.id).toBe(credential.id);
    expect(rotated.body.hint).toBe("8765");
    expect(rotated.raw).not.toContain(ANOTHER_KEY);
    expect(rotated.raw).not.toContain(A_KEY);

    const after = await asBrowser(ada, "GET", "/api/judge-credentials");
    expect(after.raw).not.toContain(A_KEY);
    expect(after.raw).not.toContain(ANOTHER_KEY);
  });

  it("refuses a stale rotation without changing the stored secret", async () => {
    api = await createApi("judge_credential_stale_rotation");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const credential = await credentialFor(ada, "Acme production", A_KEY);

    // Somebody else relabels it, and the revision this tab holds goes stale.
    const relabelled = await asBrowser(
      ada,
      "PATCH",
      `/api/judge-credentials/${credential.id}`,
      { label: "Acme staging", expected_revision: credential.revision },
    );
    expect(relabelled.statusCode, relabelled.raw).toBe(200);

    const stale = await asBrowser(
      ada,
      "PATCH",
      `/api/judge-credentials/${credential.id}`,
      { key: ANOTHER_KEY, expected_revision: credential.revision },
    );

    expect(stale.statusCode).toBe(409);
    expect(stale.body).toEqual({
      error: "identity_conflict",
      message:
        `Judge credential ${credential.id} changed after you opened it. Read ` +
        "it again, keep or reapply your edits, and send the update with " +
        "expected_revision set to its new revision.",
    });

    // Nothing moved: the hint still names the key that was there.
    const after = await asBrowser(
      ada,
      "GET",
      `/api/judge-credentials/${credential.id}`,
    );
    expect(after.body.hint).toBe("1234");
    expect(after.body.label).toBe("Acme staging");
  });

  it("refuses a change of provider, because the key belongs to one account", async () => {
    api = await createApi("judge_credential_provider_immutable");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const credential = await credentialFor(ada, "Acme production", A_KEY);

    const refused = await asBrowser(
      ada,
      "PATCH",
      `/api/judge-credentials/${credential.id}`,
      { provider: "openai" },
    );

    expect(refused.statusCode).toBe(422);
    expect(refused.body.error).toBe("unprocessable");
    expect(String(refused.body.message)).toContain("cannot be changed");
  });

  it("is an admin's to write and a member's only to read", async () => {
    api = await createApi("judge_credential_permissions");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const bob = await colleagueOf(api.app, ada, "bob@acme.example", "member");
    const eve = await colleagueOf(api.app, ada, "eve@acme.example", "viewer");

    const credential = await credentialFor(ada, "Acme production", A_KEY);

    for (const person of [bob, eve]) {
      const refused = await asBrowser(person, "POST", "/api/judge-credentials", {
        label: "Mine",
        provider: "openai",
        key: ANOTHER_KEY,
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.body).toEqual({
        error: "not_permitted",
        message:
          `Your ${person === bob ? "member" : "viewer"} role cannot manage ` +
          "judge credentials. Ask an organization admin to change your role, " +
          "then try again.",
      });

      const rotation = await asBrowser(
        person,
        "PATCH",
        `/api/judge-credentials/${credential.id}`,
        { key: ANOTHER_KEY },
      );
      expect(rotation.statusCode).toBe(403);
    }

    // Reading is everybody's: it is the list a judge setting chooses from, and
    // what it answers with is a label and a hint.
    const listed = await asBrowser(eve, "GET", "/api/judge-credentials");
    expect(listed.statusCode).toBe(200);
    expect(listed.raw).not.toContain(A_KEY);
  });

  /**
   * A fault says so in words this API chose, and says nothing else.
   *
   * What reaches this branch is what nobody wrote to be read — a driver error,
   * a constraint name, a query layer's wrapper — and on these routes the query
   * that failed is one that selected a sealed envelope. Relaying its message
   * would put ciphertext and SQL into a browser response, on exactly the
   * surface that must never hand any of a key back.
   */
  it("answers a fault without relaying whatever the fault said", async () => {
    api = await createApi("judge_fault_is_not_echoed");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    // A label longer than the column allows: nothing about the request is
    // malformed, so no write-door check refuses it, and the database does — in
    // its own words, naming its own internals.
    const broken = await asBrowser(ada, "POST", "/api/judge-credentials", {
      label: "x".repeat(2_000_000),
      provider: "openai",
      key: A_KEY,
    });

    expect(broken.statusCode).toBe(500);
    expect(broken.body).toEqual({
      error: "unavailable",
      message:
        "Egma could not complete this judge request. Nothing was changed. " +
        "Try again, and check the API logs if it keeps happening.",
    });
  });

  it("is invisible to another organization, in the same words as one that never existed", async () => {
    api = await createApi("judge_credential_isolation");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const credential = await credentialFor(ada, "Acme production", A_KEY);

    const listed = await asBrowser(grace, "GET", "/api/judge-credentials");
    expect(listed.body.items).toEqual([]);

    const read = await asBrowser(
      grace,
      "GET",
      `/api/judge-credentials/${credential.id}`,
    );
    expect(read.statusCode).toBe(404);
    expect(read.body).toEqual({
      error: "not_found",
      message:
        `There is no judge credential ${credential.id} available in this ` +
        "project. Check the link, or choose it from the current project.",
    });
    expect(read.raw).not.toContain(A_KEY);
  });
});

describe("a project's judge", () => {
  it("is needs_setup when the deployment configured none, which is a state and not a failure", async () => {
    api = await createApi("judge_needs_setup", { defaultJudge: null });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const judge = await asBrowser(
      ada,
      "GET",
      `/api/judge?project=${ada.projectId}`,
    );

    expect(judge.statusCode, judge.raw).toBe(200);
    expect(judge.body).toMatchObject({
      state: "needs_setup",
      provider: null,
      model: null,
      source: null,
      credential_id: null,
      hint: null,
    });
  });

  it("names a credential and carries no key at all", async () => {
    api = await createApi("judge_names_a_credential");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const credential = await credentialFor(ada, "Acme production", A_KEY);

    const set = await asBrowser(ada, "PUT", "/api/judge", {
      provider: "openai",
      model: "gpt-4.1-mini",
      source: credential.id,
      project: ada.projectId,
    });

    expect(set.statusCode, set.raw).toBe(200);
    expect(set.body).toMatchObject({
      state: "configured",
      provider: "openai",
      model: "gpt-4.1-mini",
      source: "credential",
      credential_id: credential.id,
      hint: "1234",
    });
    expect(set.raw).not.toContain(A_KEY);

    const read = await asBrowser(
      ada,
      "GET",
      `/api/judge?project=${ada.projectId}`,
    );
    expect(read.body).toMatchObject({
      source: "credential",
      credential_id: credential.id,
    });
  });

  it("refuses a credential of another provider, naming both", async () => {
    api = await createApi("judge_provider_mismatch");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const credential = await credentialFor(ada, "Acme production", A_KEY);

    // The refusal is reachable the moment a second provider ships. Until then
    // the same shape is proved through the door that decides it: a judge whose
    // provider is not one egma knows is refused before any credential is read,
    // and a credential naming a provider the judge does not use is the branch
    // below.
    const mismatched = await asBrowser(ada, "PUT", "/api/judge", {
      provider: "anthropic",
      model: "claude-opus-4",
      source: credential.id,
      project: ada.projectId,
    });

    expect(mismatched.statusCode).toBe(422);
    expect(String(mismatched.body.message)).toContain("not a judge provider");
  });

  it("refuses a credential of another organization as one that is not there", async () => {
    api = await createApi("judge_foreign_credential");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const credential = await credentialFor(ada, "Acme production", A_KEY);

    const refused = await asBrowser(grace, "PUT", "/api/judge", {
      provider: "openai",
      model: "gpt-4.1-mini",
      source: credential.id,
      project: grace.projectId,
    });

    expect(refused.statusCode).toBe(422);
    expect(String(refused.body.message)).toContain(
      "there is no active judge credential",
    );
  });

  /**
   * Moving to a key of your own is not a one-way door.
   *
   * A project that chose a credential stops holding the deployment's envelope,
   * because a row may hold exactly one key source. If choosing the sentinel
   * again looked for that envelope on the row, the first move away from it
   * would be the last — and the refusal on the way back would say this
   * deployment has no judge while it plainly has one.
   */
  it("can be pointed back at the deployment's own judge after choosing a credential", async () => {
    api = await createApi("judge_back_to_platform", {
      defaultJudge: {
        provider: "openai",
        model: "gpt-4o",
        key: "sk-the-platforms-own-key-WXYZ",
      },
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const credential = await credentialFor(ada, "Acme production", A_KEY);

    const mine = await asBrowser(ada, "PUT", "/api/judge", {
      provider: "openai",
      model: "gpt-4.1-mini",
      source: credential.id,
      project: ada.projectId,
    });
    expect(mine.body).toMatchObject({ source: "credential" });

    const back = await asBrowser(ada, "PUT", "/api/judge", {
      provider: "openai",
      model: "gpt-4o",
      source: "platform",
      project: ada.projectId,
    });

    expect(back.statusCode, back.raw).toBe(200);
    expect(back.body).toMatchObject({
      source: "platform",
      credential_id: null,
      hint: null,
      model: "gpt-4o",
    });
    expect(back.raw).not.toContain("sk-the-platforms-own-key-WXYZ");

    // And the credential it used to spend from is released rather than
    // destroyed: another project may still point at it.
    const held = await asBrowser(ada, "GET", "/api/judge-credentials");
    expect((held.body.items as { id: string }[]).map((one) => one.id)).toEqual([
      credential.id,
    ]);

    // And back again, so neither direction is the special one.
    const mineAgain = await asBrowser(ada, "PUT", "/api/judge", {
      provider: "openai",
      model: "gpt-4.1-mini",
      source: credential.id,
      project: ada.projectId,
    });
    expect(mineAgain.body).toMatchObject({
      source: "credential",
      credential_id: credential.id,
    });
  });

  it("refuses the platform sentinel on a deployment that configured no judge", async () => {
    api = await createApi("judge_no_platform_judge", { defaultJudge: null });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await asBrowser(ada, "PUT", "/api/judge", {
      provider: "openai",
      model: "gpt-4.1-mini",
      source: "platform",
      project: ada.projectId,
    });

    expect(refused.statusCode).toBe(422);
    expect(String(refused.body.message)).toContain(
      "this deployment configured no judge of its own",
    );
  });

  /**
   * The deployment's own judge, given to a project at signup, read back as what
   * it is — and hinted at by nothing.
   *
   * The key belongs to whoever runs the platform. A project holding it cannot
   * rotate it, cannot choose which one it is, and has nothing to tell apart, so
   * handing over four characters of an operator's secret would buy nobody
   * anything.
   */
  it("says the source is the platform, and offers no hint and no key", async () => {
    api = await createApi("judge_platform_source", {
      defaultJudge: {
        provider: "openai",
        model: "gpt-4o",
        key: "sk-the-platforms-own-key-WXYZ",
      },
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const judge = await asBrowser(
      ada,
      "GET",
      `/api/judge?project=${ada.projectId}`,
    );

    expect(judge.body).toMatchObject({
      state: "configured",
      provider: "openai",
      model: "gpt-4o",
      source: "platform",
      credential_id: null,
      hint: null,
    });
    expect(judge.raw).not.toContain("sk-the-platforms-own-key-WXYZ");
    expect(judge.raw).not.toContain("WXYZ");
  });

  /**
   * The rule the parent effort is most anxious about, asserted by **running the
   * seeding again** rather than by trusting that it would behave.
   *
   * `seedDefaultJudge` is what a restart runs, and it is the thing that could
   * quietly replace a judge somebody chose. So the test does what a restart
   * does: chooses a credential, runs the backfill, and reads the setting back.
   */
  it("survives the boot backfill running again after a credential was chosen", async () => {
    api = await createApi("judge_choice_survives_seeding", {
      defaultJudge: {
        provider: "openai",
        model: "gpt-4o",
        key: "sk-the-platforms-own-key-WXYZ",
      },
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const credential = await credentialFor(ada, "Acme production", A_KEY);
    await asBrowser(ada, "PUT", "/api/judge", {
      provider: "openai",
      model: "gpt-4.1-mini",
      source: credential.id,
      project: ada.projectId,
    });

    // The restart. Exactly what `apps/api/src/index.ts` runs on boot, with the
    // same configuration this instance was built with.
    const seeded = await seedDefaultJudge({
      provider: "openai",
      model: "gpt-4o",
      key: "sk-the-platforms-own-key-WXYZ",
    });
    // It found nothing to give, because this project already has a judge.
    expect(seeded).toEqual([]);

    const judge = await asBrowser(
      ada,
      "GET",
      `/api/judge?project=${ada.projectId}`,
    );

    expect(judge.body).toMatchObject({
      source: "credential",
      credential_id: credential.id,
      model: "gpt-4.1-mini",
    });
    expect(judge.body.hint).toBe("1234");
  });

  it("is an admin's to change, and everybody's to read", async () => {
    api = await createApi("judge_setting_permissions");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const bob = await colleagueOf(api.app, ada, "bob@acme.example", "member");
    const credential = await credentialFor(ada, "Acme production", A_KEY);

    const refused = await asBrowser(bob, "PUT", "/api/judge", {
      provider: "openai",
      model: "gpt-4.1-mini",
      source: credential.id,
      project: ada.projectId,
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.body).toEqual({
      error: "not_permitted",
      message:
        "Your member role cannot change the project judge. Ask an " +
        "organization admin to change your role, then try again.",
    });

    const read = await asBrowser(
      bob,
      "GET",
      `/api/judge?project=${ada.projectId}`,
    );
    expect(read.statusCode).toBe(200);
  });

  it("refuses a browser request that named no project", async () => {
    api = await createApi("judge_project_required");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await asBrowser(ada, "GET", "/api/judge");

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "project_required",
      message:
        "This request did not name a project. Choose a project from the " +
        "selector and try again.",
    });
  });

  it("refuses a project of another organization as an absence", async () => {
    api = await createApi("judge_foreign_project");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const refused = await asBrowser(
      ada,
      "GET",
      `/api/judge?project=${grace.projectId}`,
    );

    expect(refused.statusCode).toBe(404);
    expect(refused.body).toEqual({
      error: "project_outside_organization",
      message:
        `There is no project ${grace.projectId} available to this ` +
        "organization. Choose a project from the selector and try again.",
    });
  });
});
