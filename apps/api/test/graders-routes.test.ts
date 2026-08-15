import { PREDEFINED_GRADERS } from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  projectKeyFor,
  request as ask,
  signUp,
  type Answer,
} from "./support/traces.ts";

/**
 * The running graders, over real HTTP against real Postgres: what a project
 * judges with, and the one act that adds another — pressing **Use** on a
 * library entry.
 *
 * **Two verbs, and the missing ones are the contract.** There is no create
 * taking a type and criteria, because a grader is always a copy *of* something:
 * the entry decides what kind of judgment it is and what the form asks for, and
 * the copy holds the answers. The custom-grader authoring surface the grading
 * effort designed is shelved with this change, and this file is where its
 * absence is checkable.
 *
 * The facts worth defending here are the two the door cannot get right by
 * accident. **A project answers a grader before anybody has configured one** —
 * it was created holding a copy of `expected_behaviors`, which is what "a first
 * run is judged with zero setup" means at this altitude. And **values are
 * checked against what the entry actually asked for**, so a bound sent to an
 * entry that asks for none, or a measure egma does not compute, is refused here
 * rather than becoming a grader that is `skipped` forever.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

function request(
  method: "GET" | "POST",
  url: string,
  key: string,
  body?: Record<string, unknown>,
): Promise<Answer> {
  return ask(api.app, method, url, key, body);
}

type Listed = {
  readonly id: string;
  readonly library_id: string;
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly scope: string;
  readonly config: { readonly assertions: readonly unknown[] };
};

function itemsOf(answer: Answer): readonly Listed[] {
  return answer.body.items as readonly Listed[];
}

describe("reading the running graders", () => {
  it("answers the copy every project is created with, before anybody sets one up", async () => {
    api = await createApi("graders_seeded");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const listed = await request("GET", "/api/graders", key);

    expect(listed.statusCode, JSON.stringify(listed.body)).toBe(200);
    expect(itemsOf(listed)).toHaveLength(1);
    expect(itemsOf(listed)[0]).toMatchObject({
      library_id: PREDEFINED_GRADERS.expectedBehaviors,
      name: "expected_behaviors",
      type: "llm_as_judge",
      required: true,
      scope: "simulations",
    });
    // Its assertions are the test's own sentences, so nothing is filled in —
    // and empty is what a correct copy of it holds, forever.
    expect(itemsOf(listed)[0]?.config).toEqual({ assertions: [] });
    expect(listed.body.next_cursor).toBeNull();
  });

  /**
   * The definition never crosses this door. The judge prompt is on the library
   * entry and is read from the shelf, which is the same row the engine reads at
   * judging time — so what a screen shows and what a model is sent are one
   * string, and a copy of it on this answer would be the second one.
   */
  it("hands over the pointer and the filled-in values, and no definition", async () => {
    api = await createApi("graders_no_definition");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const listed = await request("GET", "/api/graders", key);
    const [only] = itemsOf(listed);

    expect(only?.library_id).toBeDefined();
    expect(JSON.stringify(only)).not.toContain("cannot_determine");
    expect(only).not.toHaveProperty("prompt");
  });

  it("is a read every role holds, viewers included", async () => {
    api = await createApi("graders_roles");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await colleagueOf(api.app, ada, "grace@acme.example", "viewer");

    const listed = await request("GET", "/api/graders", grace.secret);

    // Somebody who may read a run's results and change nothing still has to be
    // able to see what those results were decided by.
    expect(listed.statusCode, JSON.stringify(listed.body)).toBe(200);
    expect(itemsOf(listed)).toHaveLength(1);
  });

  it("refuses a cursor it never issued, and says what to send instead", async () => {
    api = await createApi("graders_cursor");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const listed = await request("GET", "/api/graders?cursor=nonsense", key);

    expect(listed.statusCode).toBe(400);
    expect(String(listed.body.message)).toContain("next_cursor");
  });

  it("shows one customer nothing of another's", async () => {
    api = await createApi("graders_tenants");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const theirs = itemsOf(
      await request("GET", "/api/graders", await projectKeyFor(api.app, ada)),
    );
    const others = itemsOf(
      await request("GET", "/api/graders", await projectKeyFor(api.app, grace)),
    );

    // Each project has its own copy of egma's entry — the same definition, two
    // rows — so the ids never overlap even though the shelf behind them is one.
    expect(theirs.map((one) => one.id)).not.toEqual(others.map((one) => one.id));
    expect(theirs[0]?.library_id).toBe(others[0]?.library_id);
  });
});

describe("pressing Use on a library entry", () => {
  it("creates the copy, filled in with what the form asked for", async () => {
    api = await createApi("graders_use");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const used = await request("POST", "/api/graders", key, {
      library_id: PREDEFINED_GRADERS.latency,
      params: { metric: "turn_response_latency", bound: 2000 },
    });

    expect(used.statusCode, JSON.stringify(used.body)).toBe(201);
    expect(used.body).toMatchObject({
      library_id: PREDEFINED_GRADERS.latency,
      // Defaulted from the entry, so a copy nobody renamed says which grader
      // it is a copy of.
      name: "latency",
      // Copied down from the entry, never taken from the caller.
      type: "code",
      required: true,
      scope: "simulations",
      version: 1,
      config: { assertions: [{ metric: "turn_response_latency", bound: 2000 }] },
    });

    // And it is judging from now on, beside the one the project was born with.
    const listed = await request("GET", "/api/graders", key);
    expect(itemsOf(listed)).toHaveLength(2);
  });

  it("takes a name, a description and a diagnostic flag", async () => {
    api = await createApi("graders_use_settings");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const used = await request("POST", "/api/graders", key, {
      library_id: PREDEFINED_GRADERS.latency,
      params: { metric: "turn_response_latency", bound: 2000 },
      name: "Answers inside two seconds",
      description: "Watched, not enforced, while we tune it",
      required: false,
      scope: "both",
      production_sample_rate: 25,
    });

    expect(used.statusCode, JSON.stringify(used.body)).toBe(201);
    expect(used.body).toMatchObject({
      name: "Answers inside two seconds",
      description: "Watched, not enforced, while we tune it",
      // A diagnostic: judged, shown with its fraction, and unable to fail a
      // test. The only loudness switch v0 has.
      required: false,
      scope: "both",
      production_sample_rate: 25,
    });
  });

  it("refuses values the entry never asked for, naming what it does ask", async () => {
    api = await createApi("graders_use_unknown_param");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const used = await request("POST", "/api/graders", key, {
      library_id: PREDEFINED_GRADERS.latency,
      params: { metric: "turn_response_latency", bound: 2000, aggregation: "p90" },
    });

    expect(used.statusCode, JSON.stringify(used.body)).toBe(422);
    expect(String(used.body.message)).toContain("aggregation");
    expect(String(used.body.message)).toContain("bound");
  });

  /**
   * The one write-door rule that is about the world rather than about the
   * shape: a measure egma does not compute is a grader that reads nothing,
   * judges nothing and is `skipped` forever. Nothing downstream can tell that
   * from a conversation whose spans legitimately lack it, so only this moment
   * can.
   */
  it("refuses a measure egma does not compute, naming the ones it does", async () => {
    api = await createApi("graders_use_bad_measure");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const used = await request("POST", "/api/graders", key, {
      library_id: PREDEFINED_GRADERS.latency,
      params: { metric: "turn_responze_latency", bound: 2000 },
    });

    expect(used.statusCode, JSON.stringify(used.body)).toBe(422);
    expect(String(used.body.message)).toContain("is not a measure");
    expect(String(used.body.message)).toContain("turn_response_latency");
  });

  it("refuses anything at all on an entry that asks nothing", async () => {
    api = await createApi("graders_use_asks_nothing");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const used = await request("POST", "/api/graders", key, {
      library_id: PREDEFINED_GRADERS.expectedBehaviors,
      params: { bound: 2000 },
    });

    expect(used.statusCode, JSON.stringify(used.body)).toBe(422);
    expect(String(used.body.message)).toContain("asks for nothing");
  });

  /**
   * **Dropped silently, this is a bill.** A rate that arrived as text and was
   * ignored leaves the copy judging *all* of live traffic while the team that
   * sent `"10"` believes it judges a tenth — every real conversation asked of a
   * model, and paid for, on a setting somebody thinks they chose. The flag
   * beside it is refused the same way and for a smaller version of the same
   * reason.
   */
  it("refuses a sample rate that is not a number, rather than dropping it", async () => {
    api = await createApi("graders_use_bad_rate");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const used = await request("POST", "/api/graders", key, {
      library_id: PREDEFINED_GRADERS.latency,
      params: { metric: "turn_response_latency", bound: 2000 },
      scope: "both",
      production_sample_rate: "10",
    });

    expect(used.statusCode, JSON.stringify(used.body)).toBe(422);
    expect(String(used.body.message)).toContain("production_sample_rate");
    // And nothing was written, so nobody is judging anything they did not ask
    // to judge.
    expect(itemsOf(await request("GET", "/api/graders", key))).toHaveLength(1);
  });

  it("refuses a required flag that is not a flag, on the same terms", async () => {
    api = await createApi("graders_use_bad_required");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const used = await request("POST", "/api/graders", key, {
      library_id: PREDEFINED_GRADERS.expectedBehaviors,
      required: "false",
    });

    expect(used.statusCode, JSON.stringify(used.body)).toBe(422);
    expect(String(used.body.message)).toContain("required");
  });

  /**
   * The percentage itself is the factory's rule, and this door relays its
   * sentence rather than holding a second opinion about the number.
   */
  it("refuses a percentage outside the traffic there is", async () => {
    api = await createApi("graders_use_rate_range");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const used = await request("POST", "/api/graders", key, {
      library_id: PREDEFINED_GRADERS.latency,
      params: { metric: "turn_response_latency", bound: 2000 },
      production_sample_rate: 140,
    });

    expect(used.statusCode, JSON.stringify(used.body)).toBe(422);
    expect(String(used.body.message)).toContain("percentage");
  });

  it("refuses a body naming no entry, and says what to send", async () => {
    api = await createApi("graders_use_no_entry");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const used = await request("POST", "/api/graders", key, {
      params: { metric: "turn_response_latency", bound: 2000 },
    });

    expect(used.statusCode).toBe(400);
    expect(String(used.body.message)).toContain("library_id");
  });

  /**
   * An entry belonging to another customer and an entry that was never written
   * get one refusal, because telling them apart would answer a question about
   * somebody else's shelf.
   */
  it("refuses an entry that is not on this shelf", async () => {
    api = await createApi("graders_use_unknown_entry");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const used = await request("POST", "/api/graders", key, {
      library_id: "grl_01M01MH8KAE8ZB19B0YJ7ZZZZZ",
    });

    expect(used.statusCode, JSON.stringify(used.body)).toBe(422);
    expect(String(used.body.message)).toContain("not a grader on this shelf");
  });

  it("refuses a key the body has no business carrying", async () => {
    api = await createApi("graders_use_unknown_key");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const used = await request("POST", "/api/graders", key, {
      library_id: PREDEFINED_GRADERS.expectedBehaviors,
      // The retired authoring surface, tried on by somebody who read an older
      // document. Refused by name rather than ignored, so the answer is one a
      // coding agent can act on.
      type: "llm_rubric",
    });

    expect(used.statusCode).toBe(400);
    expect(String(used.body.message)).toContain('"type"');
  });

  it("is refused to a viewer, per the permission table", async () => {
    api = await createApi("graders_use_roles");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await colleagueOf(api.app, ada, "grace@acme.example", "viewer");

    const used = await request("POST", "/api/graders", grace.secret, {
      library_id: PREDEFINED_GRADERS.expectedBehaviors,
    });

    expect(used.statusCode).toBe(403);
  });
});

describe("the authoring surface that is not here", () => {
  /**
   * v0 ships a small shelf of graders egma maintains rather than a form asking
   * a team to design judgment logic on their first day. The route that would
   * have edited a grader is not registered, and this is where that decision is
   * checkable rather than merely written down.
   *
   * **Delete used to be held here beside it, and that was the error.** What
   * ADR-0009 shelved is *defining* graders; it made switching one off the
   * plainest act in the area — dormant is no copy at all, and there is no
   * enable switch — so a door that refused both refused the only loudness
   * control the product has. The delete is registered now and proved below.
   */
  it("answers nothing for an edit of a grader", async () => {
    api = await createApi("graders_no_authoring");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const [only] = itemsOf(await request("GET", "/api/graders", key));
    if (only === undefined) throw new Error("the project has no graders");

    const answered = await ask(api.app, "PATCH", `/api/graders/${only.id}`, key);
    expect(answered.statusCode).toBe(404);
  });
});

/**
 * Deleting a running copy: the whole of the off switch.
 *
 * **A copy that exists judges.** There is no enabled flag to clear and no
 * `none` scope to choose, so this is how a project stops being judged by
 * something — the seeded expected-behaviors copy included. The start-up
 * backfill is built around exactly that: it asks whether a project has *ever*
 * held a copy, deleted rows included, so a container restarting cannot write
 * the grader back and overrule the person who deleted it.
 */
describe("deleting a running grader", () => {
  it("stops the project being judged by it, and says what went", async () => {
    api = await createApi("graders_delete");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const [only] = itemsOf(await request("GET", "/api/graders", key));
    if (only === undefined) throw new Error("the project has no graders");

    const deleted = await ask(
      api.app,
      "DELETE",
      `/api/graders/${only.id}`,
      key,
    );

    expect(deleted.statusCode, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.id).toBe(only.id);
    expect(deleted.body.deleted_at).toEqual(expect.any(String));

    // And the project is judged by nothing at all, which is a state it is
    // allowed to be in: a run started here conducts every simulation and comes
    // back with no verdicts, rather than being refused.
    expect(itemsOf(await request("GET", "/api/graders", key))).toHaveLength(0);
  });

  /**
   * Pressing Use again is how it comes back — a new copy of the same entry,
   * with a new identity, because the old one is what a verdict already written
   * still names.
   */
  it("leaves Use as the way back, with a new copy", async () => {
    api = await createApi("graders_delete_then_use");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const [only] = itemsOf(await request("GET", "/api/graders", key));
    if (only === undefined) throw new Error("the project has no graders");
    await ask(api.app, "DELETE", `/api/graders/${only.id}`, key);

    const used = await request("POST", "/api/graders", key, {
      library_id: PREDEFINED_GRADERS.expectedBehaviors,
    });

    expect(used.statusCode, JSON.stringify(used.body)).toBe(201);
    expect(used.body.id).not.toBe(only.id);
    expect(itemsOf(await request("GET", "/api/graders", key))).toHaveLength(1);
  });

  it("is refused to a viewer, per the permission table", async () => {
    api = await createApi("graders_delete_viewer");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await colleagueOf(
      api.app,
      ada,
      "grace@acme.example",
      "viewer",
    );

    const [only] = itemsOf(await request("GET", "/api/graders", grace.secret));
    if (only === undefined) throw new Error("the project has no graders");

    const refused = await ask(
      api.app,
      "DELETE",
      `/api/graders/${only.id}`,
      grace.secret,
    );

    expect(refused.statusCode).toBe(403);
    // And nothing went: reading it back is the only proof of that worth having.
    expect(itemsOf(await request("GET", "/api/graders", grace.secret))).toHaveLength(
      1,
    );
  });

  /**
   * Another customer's copy reads exactly as one that never existed. Confirming
   * that somebody else's row is there is itself a leak, so both are 404 and
   * both get the same sentence.
   */
  it("shows one customer nothing of another's, including its absence", async () => {
    api = await createApi("graders_delete_tenants");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const [theirs] = itemsOf(
      await request("GET", "/api/graders", await projectKeyFor(api.app, grace)),
    );
    if (theirs === undefined) throw new Error("the project has no graders");

    const refused = await ask(
      api.app,
      "DELETE",
      `/api/graders/${theirs.id}`,
      await projectKeyFor(api.app, ada),
    );

    expect(refused.statusCode).toBe(404);
    expect(String(refused.body.message)).toContain("available in this project");
  });
});
