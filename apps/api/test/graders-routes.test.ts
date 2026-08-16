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
 * judges with, the act that adds another — pressing **Use** on a library entry
 * — and the two that keep pressing Use from being a one-way door.
 *
 * **Four verbs, and what is still missing is the contract.** There is no create
 * taking a type and criteria, because a grader is always a copy *of* something:
 * the entry decides what kind of judgment it is and what the form asks for, and
 * the copy holds the answers. The custom-grader authoring surface the grading
 * effort designed stays shelved, and this file is where its absence is
 * checkable.
 *
 * The facts worth defending here are the ones the door cannot get right by
 * accident. **A project answers a grader before anybody has configured one** —
 * it was created holding a copy of `expected_behaviors`, which is what "a first
 * run is judged with zero setup" means at this altitude. **Values are checked
 * against what the entry actually asked for**, so a bound sent to an entry that
 * asks for none, or a measure egma does not compute, is refused here rather
 * than becoming a grader that is `skipped` forever — and refused in the same
 * words whether it arrives on a Use or on an edit, because there is one check
 * and not two. And **an edit is two acts wearing one verb**: values mint the
 * next version, live settings do not, and the answer says which happened.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

function request(
  method: "GET" | "POST" | "PATCH" | "DELETE",
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
  readonly description: string | null;
  readonly required: boolean;
  readonly scope: string;
  readonly version: number;
  readonly version_id: string;
  readonly config: { readonly assertions: readonly unknown[] };
};

/** A latency copy on the project, which is the one v0 entry that asks anything. */
async function aLatencyCopy(key: string): Promise<Listed> {
  const used = await request("POST", "/api/graders", key, {
    library_id: PREDEFINED_GRADERS.latency,
    params: { metric: "turn_response_latency", bound: 2000 },
    name: "Answers inside two seconds",
    description: "The number the support team argues about",
  });
  expect(used.statusCode, JSON.stringify(used.body)).toBe(201);
  return used.body as unknown as Listed;
}

/** An id shaped like a grader's that no project ever minted. */
const NOBODY_HAS_THIS = "grd_01M01MH8KAE8ZB19B0YJ7ZZZZZ";

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

describe("changing a running copy", () => {
  /**
   * **The live settings, and none of them re-interprets anything.** Where a
   * copy applies, whether it can fail a run, how much live traffic it judges
   * and what it is called change what the project lets a grader do from now on;
   * they change nothing about a judgment already made. So they are written in
   * place, the version number stands still, and every verdict already written
   * still points at the values that decided it.
   */
  it("changes where a copy applies and how loudly, without minting a version", async () => {
    api = await createApi("graders_edit_settings");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aLatencyCopy(key);

    const edited = await request("PATCH", `/api/graders/${copy.id}`, key, {
      name: "Watched while we tune it",
      required: false,
      scope: "both",
      production_sample_rate: 25,
    });

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({
      id: copy.id,
      name: "Watched while we tune it",
      required: false,
      scope: "both",
      production_sample_rate: 25,
      // Version 1 still: nothing a verdict was decided by moved.
      version: 1,
      version_id: copy.version_id,
      config: { assertions: [{ metric: "turn_response_latency", bound: 2000 }] },
    });

    const listed = itemsOf(await request("GET", "/api/graders", key));
    expect(listed.find((one) => one.id === copy.id)?.required).toBe(false);
  });

  /**
   * **A bound is what a verdict is made of, so changing one starts the next
   * version.** The version behind it is untouched, which is what makes last
   * week's verdict still mean what it meant — and the version number on this
   * answer is how a client finds out which of the two things it just did.
   */
  it("mints the next version when the filled-in values change", async () => {
    api = await createApi("graders_edit_values");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aLatencyCopy(key);

    const edited = await request("PATCH", `/api/graders/${copy.id}`, key, {
      params: { metric: "turn_response_latency", bound: 1200 },
    });

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({
      version: 2,
      config: { assertions: [{ metric: "turn_response_latency", bound: 1200 }] },
      // What the body left out, the copy kept.
      name: copy.name,
      required: true,
      scope: "simulations",
    });
    expect(edited.body.version_id).not.toBe(copy.version_id);
  });

  /**
   * **The same sentence, because there is one check and not two.** An edit's
   * values go through the code Use's values go through, against the entry this
   * copy points at, read live — so a bound the entry never asked for is refused
   * in the same words whichever door it arrived at. Two doors holding two
   * opinions about what a bound is would be the drift the whole two-level shape
   * exists to prevent.
   */
  it("refuses values the entry never asked for, in the words Use refuses them in", async () => {
    api = await createApi("graders_edit_same_refusal");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aLatencyCopy(key);

    const wrong = { metric: "turn_response_latency", bound: 2000, aggregation: "p90" };

    const used = await request("POST", "/api/graders", key, {
      library_id: PREDEFINED_GRADERS.latency,
      params: wrong,
    });
    const edited = await request("PATCH", `/api/graders/${copy.id}`, key, {
      params: wrong,
    });

    expect(used.statusCode).toBe(422);
    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(422);
    expect(String(edited.body.message)).toBe(String(used.body.message));
    expect(String(edited.body.message)).toContain("aggregation");

    // And nothing was written: the copy still judges by what it judged by.
    const after = await request("GET", "/api/graders", key);
    expect(itemsOf(after).find((one) => one.id === copy.id)?.config).toEqual({
      assertions: [{ metric: "turn_response_latency", bound: 2000 }],
    });
  });

  /**
   * **An empty set of answers is not "no answers".** It passes every rule about
   * keys — there is no key the entry never asked for, and no parameter left
   * unanswered — and would store an assertion holding nothing on a grader whose
   * assertions are the test's own sentences. Judging is unaffected, because the
   * engine reads the test rather than the config; the Running tab is not, and
   * would count "1 assertion" where the honest answer is that there is nothing
   * to fill in. The web form never sends it and this door is the only way in.
   */
  it("refuses an empty set of values on an entry that asks nothing", async () => {
    api = await createApi("graders_edit_empty_params");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const [seeded] = itemsOf(await request("GET", "/api/graders", key));
    if (seeded === undefined) throw new Error("the project has no graders");

    const edited = await request("PATCH", `/api/graders/${seeded.id}`, key, {
      params: {},
    });

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(422);
    expect(String(edited.body.message)).toContain("asks for nothing");

    // Still holding nothing, which is what a correct copy of it holds forever.
    const after = itemsOf(await request("GET", "/api/graders", key));
    expect(after.find((one) => one.id === seeded.id)?.config).toEqual({
      assertions: [],
    });
    expect(after.find((one) => one.id === seeded.id)?.version).toBe(1);
  });

  /** The measure rule is the same one door, said the same way, too. */
  it("refuses a measure egma does not compute, in the words Use refuses it in", async () => {
    api = await createApi("graders_edit_bad_measure");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aLatencyCopy(key);

    const used = await request("POST", "/api/graders", key, {
      library_id: PREDEFINED_GRADERS.latency,
      params: { metric: "turn_responze_latency", bound: 2000 },
    });
    const edited = await request("PATCH", `/api/graders/${copy.id}`, key, {
      params: { metric: "turn_responze_latency", bound: 2000 },
    });

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(422);
    expect(String(edited.body.message)).toBe(String(used.body.message));
  });

  /**
   * The pointer is the one thing about a copy that cannot move: every version
   * behind it holds values shaped by the type that pointer decided, so a copy
   * pointed somewhere else would be a different grader wearing the old one's
   * history. Refused by name, with the act that does want a second copy.
   */
  it("refuses to point a copy at another library entry, and says what to do instead", async () => {
    api = await createApi("graders_edit_repoint");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aLatencyCopy(key);

    const edited = await request("PATCH", `/api/graders/${copy.id}`, key, {
      library_id: PREDEFINED_GRADERS.expectedBehaviors,
    });

    expect(edited.statusCode).toBe(400);
    expect(String(edited.body.message)).toContain("Use");
  });

  it("refuses a key the body has no business carrying", async () => {
    api = await createApi("graders_edit_unknown_key");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aLatencyCopy(key);

    const edited = await request("PATCH", `/api/graders/${copy.id}`, key, {
      type: "llm_rubric",
    });

    expect(edited.statusCode).toBe(400);
    expect(String(edited.body.message)).toContain('"type"');
  });

  /**
   * A grader this credential cannot see reads exactly as one that is not there,
   * because to this caller those are the same thing — so the case needs both
   * halves in front of it: an id nobody ever minted, and a real one belonging
   * to somebody else. One refusal, one sentence, and nothing in either that
   * says which of the two it was.
   */
  it("answers another customer's grader exactly as one that never existed", async () => {
    api = await createApi("graders_edit_unknown");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const theirs = await projectKeyFor(api.app, ada);
    const others = await projectKeyFor(api.app, grace);

    const [only] = itemsOf(await request("GET", "/api/graders", theirs));
    if (only === undefined) throw new Error("the project has no graders");

    const madeUp = await request("PATCH", `/api/graders/${NOBODY_HAS_THIS}`, others, {
      required: false,
    });
    const somebodyElses = await request("PATCH", `/api/graders/${only.id}`, others, {
      required: false,
    });

    expect(madeUp.statusCode).toBe(404);
    expect(somebodyElses.statusCode).toBe(404);
    // The same sentence but for the id in it, so nothing about the answer says
    // whether the row exists somewhere else.
    expect(String(somebodyElses.body.message).replace(only.id, "")).toBe(
      String(madeUp.body.message).replace(NOBODY_HAS_THIS, ""),
    );

    // And Acme's copy is untouched, which is the half a status code cannot say.
    const untouched = itemsOf(await request("GET", "/api/graders", theirs));
    expect(untouched.find((one) => one.id === only.id)?.required).toBe(true);
  });

  it("is refused to a viewer, per the permission table", async () => {
    api = await createApi("graders_edit_roles");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aLatencyCopy(key);
    const grace = await colleagueOf(api.app, ada, "grace@acme.example", "viewer");

    const edited = await request("PATCH", `/api/graders/${copy.id}`, grace.secret, {
      required: false,
    });

    expect(edited.statusCode).toBe(403);
  });
});

/**
 * The three fields that arrive as words, and what happens when they arrive as
 * something else.
 *
 * **Refused, because the alternative is a project configured differently from
 * what somebody wrote down.** These used to be read through a helper that turns
 * anything but a string into the empty string, which the door then read as
 * silence — so `{"scope": 123}` answered 200 with the copy still judging
 * simulations, and `{"description": 123}` answered 200 having *erased* a note a
 * person had typed. It is `production_sample_rate: "10"` one field along, and
 * the group's own unknown-key gate exists to refuse exactly this shape of
 * mistake.
 *
 * **Absent stays absent.** An edit is partial, and every case in this block
 * that leaves a key out has to keep meaning "keep what is there" — which the
 * settings and values cases above rely on and would fail loudly without.
 */
describe("the fields a body sends as words", () => {
  /** A copy with something in every field this block is about. */
  async function aNamedCopy(key: string): Promise<Listed> {
    const copy = await aLatencyCopy(key);
    expect(copy.description).toBe("The number the support team argues about");
    return copy;
  }

  /** What the copy looks like now, read back through the list. */
  async function nowReading(key: string, id: string): Promise<Listed> {
    const found = itemsOf(await request("GET", "/api/graders", key)).find(
      (one) => one.id === id,
    );
    if (found === undefined) throw new Error(`${id} is no longer running`);
    return found;
  }

  it("refuses a name that is not text, and renames nothing", async () => {
    api = await createApi("graders_edit_name_shape");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aNamedCopy(key);

    const edited = await request("PATCH", `/api/graders/${copy.id}`, key, {
      name: 123,
    });

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(422);
    expect(String(edited.body.message)).toContain("name");
    expect(String(edited.body.message)).toContain("number");
    expect((await nowReading(key, copy.id)).name).toBe(copy.name);
  });

  /**
   * **A copy has to be called something**, so an empty name is a refusal rather
   * than a rename this door quietly drops. It is the factory's rule and the
   * factory's sentence: this door checks that a word arrived, not what it says.
   */
  it("refuses an empty name rather than ignoring it", async () => {
    api = await createApi("graders_edit_name_empty");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aNamedCopy(key);

    const edited = await request("PATCH", `/api/graders/${copy.id}`, key, {
      name: "   ",
    });

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(422);
    expect(String(edited.body.message)).toContain("name");
    expect((await nowReading(key, copy.id)).name).toBe(copy.name);
  });

  it("refuses a scope that is not text, and moves nothing", async () => {
    api = await createApi("graders_edit_scope_shape");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aNamedCopy(key);

    const edited = await request("PATCH", `/api/graders/${copy.id}`, key, {
      scope: 123,
    });

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(422);
    expect(String(edited.body.message)).toContain("scope");
    // Still judging what it was judging, which is the half a status code
    // cannot say: a developer who believed they pointed this at live traffic
    // would otherwise find out when nothing was ever judged there.
    expect((await nowReading(key, copy.id)).scope).toBe("simulations");
  });

  /**
   * **The scope's vocabulary is the factory's gate, not this door's.** The route
   * casts the word it read into the scope union, which is safe precisely
   * because `validScope` refuses a word egma has never heard of and names the
   * three it knows. This is that claim checked rather than asserted.
   */
  it("refuses a scope egma has never heard of, naming the ones it knows", async () => {
    api = await createApi("graders_edit_scope_word");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aNamedCopy(key);

    const edited = await request("PATCH", `/api/graders/${copy.id}`, key, {
      scope: "banana",
    });

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(422);
    expect(String(edited.body.message)).toContain("simulations");
    expect((await nowReading(key, copy.id)).scope).toBe("simulations");
  });

  /**
   * **The worst of the three, because it destroyed something.** A number here
   * used to be read as the empty string, then as "clear it", so a request that
   * answered 200 erased a note a person had typed and said nothing about it.
   */
  it("refuses a description that is not text, and leaves the note where it was", async () => {
    api = await createApi("graders_edit_note_shape");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aNamedCopy(key);

    const edited = await request("PATCH", `/api/graders/${copy.id}`, key, {
      description: 123,
    });

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(422);
    expect(String(edited.body.message)).toContain("description");
    expect((await nowReading(key, copy.id)).description).toBe(copy.description);
  });

  /**
   * And the intent that has to keep working: there is no note. Both ways of
   * saying it mean it — a form submitting a blank box, and a client sending
   * JSON's own word for nothing.
   */
  it("clears the note for an empty string and for null alike", async () => {
    api = await createApi("graders_edit_note_cleared");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    for (const emptied of ["", null]) {
      const copy = await aNamedCopy(key);
      const edited = await request("PATCH", `/api/graders/${copy.id}`, key, {
        description: emptied,
      });

      expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body.description).toBeNull();
      expect((await nowReading(key, copy.id)).description).toBeNull();
    }
  });

  /** Leaving it out is not clearing it, which is what makes an edit partial. */
  it("keeps the note, the name and the scope when the body leaves them out", async () => {
    api = await createApi("graders_edit_partial");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aNamedCopy(key);

    const edited = await request("PATCH", `/api/graders/${copy.id}`, key, {
      required: false,
    });

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({
      name: copy.name,
      description: copy.description,
      scope: copy.scope,
      required: false,
    });
  });

  /**
   * The project a write names is read the same way, and for a worse version of
   * the same reason: a number quietly ignored is a write that lands in whatever
   * project the credential happens to act in rather than the one the request
   * named.
   */
  it("refuses a project that is not text, on either verb", async () => {
    api = await createApi("graders_project_shape");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aNamedCopy(key);

    const used = await request("POST", "/api/graders", key, {
      library_id: PREDEFINED_GRADERS.expectedBehaviors,
      project: 123,
    });
    const edited = await request("PATCH", `/api/graders/${copy.id}`, key, {
      project: 123,
      required: false,
    });

    expect(used.statusCode, JSON.stringify(used.body)).toBe(422);
    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(422);
    expect(String(edited.body.message)).toContain("project");
    expect((await nowReading(key, copy.id)).required).toBe(true);
  });

  /**
   * The same three on the way in. A Use cannot erase anything — there is
   * nothing there yet — but a `scope` that does not arrive as text would
   * quietly become `simulations`, which is the same trap one step earlier:
   * somebody switches a grader on for live traffic and it never judges any.
   */
  it("refuses each of them on the way in, and writes nothing", async () => {
    api = await createApi("graders_use_word_shapes");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    for (const wrong of [
      { name: 123 },
      { scope: 123 },
      { description: 123 },
    ]) {
      const used = await request("POST", "/api/graders", key, {
        library_id: PREDEFINED_GRADERS.latency,
        params: { metric: "turn_response_latency", bound: 2000 },
        ...wrong,
      });

      expect(used.statusCode, JSON.stringify(used.body)).toBe(422);
      expect(String(used.body.message)).toContain(Object.keys(wrong)[0] ?? "");
    }

    // Nothing was switched on: the project still holds only the copy it was
    // created with.
    expect(itemsOf(await request("GET", "/api/graders", key))).toHaveLength(1);
  });
});

describe("switching a running copy off", () => {
  /**
   * **Deleting is the switching off, and it is the only one there is.** No
   * enable flag, no `none` scope: from the moment this returns, nothing the
   * project runs is judged by the copy — and the answer says when, so a reader
   * can tell which runs were before it.
   */
  it("takes the copy out of the list, and says when it stopped", async () => {
    api = await createApi("graders_delete");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aLatencyCopy(key);

    expect(itemsOf(await request("GET", "/api/graders", key))).toHaveLength(2);

    const removed = await request("DELETE", `/api/graders/${copy.id}`, key);

    expect(removed.statusCode, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ id: copy.id, name: copy.name });
    expect(String(removed.body.deleted_at)).not.toBe("");

    const left = itemsOf(await request("GET", "/api/graders", key));
    expect(left.map((one) => one.id)).not.toContain(copy.id);
    // The one every project is created with is still judging, because only the
    // copy that was named was switched off.
    expect(left).toHaveLength(1);
  });

  /**
   * Including that one. Deleting the seeded copy is exactly how a project stops
   * being judged against its own written-down expectations — there is no other
   * switch, and the screen says so when the list comes back empty.
   */
  it("switches off the copy every project is created with, like any other", async () => {
    api = await createApi("graders_delete_seeded");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const [seeded] = itemsOf(await request("GET", "/api/graders", key));
    if (seeded === undefined) throw new Error("the project has no graders");

    const removed = await request("DELETE", `/api/graders/${seeded.id}`, key);

    expect(removed.statusCode, JSON.stringify(removed.body)).toBe(200);
    expect(itemsOf(await request("GET", "/api/graders", key))).toHaveLength(0);
  });

  /**
   * **Pressing Use again is the way back, and it makes a new copy rather than
   * reviving the old one** — a new identity, because the old id is what a
   * verdict already written still names.
   *
   * It is also where the start-up backfill would show if it were wrong. That
   * backfill asks whether a project has *ever* held a copy, deleted rows
   * included, precisely so a restarting container cannot write the seeded
   * grader back and overrule the person who switched it off. A project sitting
   * at zero has to be able to stay at zero, and to come back only when somebody
   * asks it to.
   */
  it("leaves Use as the way back, with a new copy", async () => {
    api = await createApi("graders_delete_then_use");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const [seeded] = itemsOf(await request("GET", "/api/graders", key));
    if (seeded === undefined) throw new Error("the project has no graders");
    await request("DELETE", `/api/graders/${seeded.id}`, key);

    const used = await request("POST", "/api/graders", key, {
      library_id: PREDEFINED_GRADERS.expectedBehaviors,
    });

    expect(used.statusCode, JSON.stringify(used.body)).toBe(201);
    expect(used.body.id).not.toBe(seeded.id);
    expect(itemsOf(await request("GET", "/api/graders", key))).toHaveLength(1);
  });

  it("answers a second delete as a grader that is not there", async () => {
    api = await createApi("graders_delete_twice");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aLatencyCopy(key);

    expect((await request("DELETE", `/api/graders/${copy.id}`, key)).statusCode).toBe(
      200,
    );

    const again = await request("DELETE", `/api/graders/${copy.id}`, key);
    expect(again.statusCode).toBe(404);
    expect(String(again.body.message)).toContain("switched off");
  });

  it("is refused to a viewer, per the permission table", async () => {
    api = await createApi("graders_delete_roles");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const copy = await aLatencyCopy(key);
    const grace = await colleagueOf(api.app, ada, "grace@acme.example", "viewer");

    const removed = await request(
      "DELETE",
      `/api/graders/${copy.id}`,
      grace.secret,
    );

    expect(removed.statusCode).toBe(403);
    expect(itemsOf(await request("GET", "/api/graders", key))).toHaveLength(2);
  });

  it("shows one customer nothing of another's, and switches nothing off there", async () => {
    api = await createApi("graders_delete_tenants");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const theirs = await projectKeyFor(api.app, ada);
    const others = await projectKeyFor(api.app, grace);

    const [only] = itemsOf(await request("GET", "/api/graders", theirs));
    if (only === undefined) throw new Error("the project has no graders");

    const removed = await request("DELETE", `/api/graders/${only.id}`, others);

    expect(removed.statusCode).toBe(404);
    expect(itemsOf(await request("GET", "/api/graders", theirs))).toHaveLength(1);
  });
});
