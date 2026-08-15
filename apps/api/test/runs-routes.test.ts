import {
  claimSimulations,
  completeSimulation,
  createPersona,
  createProject,
  createTest,
  archivePersona,
  editTest,
  failSimulation,
  markSimulationCanceled,
  startSimulation,
  type AuthContext,
  type SimulationClaim,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  contextFor,
  NEUTRAL_TRAITS,
  projectKeyFor,
  request as ask,
  signUp,
  type Answer,
  type Customer,
} from "./support/traces.ts";

/**
 * The run routes, over real HTTP against real Postgres.
 *
 * This is what a terminal starts a run through and then watches, so what is
 * asserted here is what a caller observes: the shapes, who may do what, every
 * refusal sentence word for word, and the two promises the whole surface rests
 * on — that a run executes exactly the versions it says it pinned, and that a
 * follower which crashes and comes back misses nothing and repeats nothing.
 *
 * The lifecycle underneath has its own tests and none of them are repeated
 * here. What it *is* used for is honest movement: no simulator exists in this
 * suite, so conversations are moved through the same exported functions a
 * simulator would call, and the feed is then read back over the wire. Anything
 * else would be a test of a fake feed.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

/** The shared helpers, with the app this file is driving already in hand. */
function request(
  method: "GET" | "POST",
  url: string,
  key: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  return ask(api.app, method, url, key, payload);
}

const RESCHEDULING = {
  name: "Reschedules a booked appointment",
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expected_behaviors: ["confirms the new time back before finishing"],
} as const;

/** A test, pushed the way a folder pushes one, and the version a run pins. */
async function pushTest(
  key: string,
  name: string,
  personas?: readonly string[],
): Promise<{ testId: string; versionId: string }> {
  const created = await request("POST", "/api/tests", key, {
    ...RESCHEDULING,
    name,
    ...(personas === undefined ? {} : { personas: [...personas] }),
  });
  expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
  return {
    testId: String(created.body.id),
    versionId: String(created.body.version_id),
  };
}

/** An agent with one way of reaching it, registered the way a wizard does. */
async function registerAgentThrough(
  key: string,
  name: string,
  connection: Record<string, unknown>,
): Promise<{ agentId: string; connectionId: string }> {
  const registered = await request("POST", "/api/agents", key, {
    name,
    connection,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const agent = registered.body.agent as { id: string };
  const reached = registered.body.connection as { id: string };
  return { agentId: agent.id, connectionId: reached.id };
}

const RETELL = {
  type: "retell",
  modality: "chat",
  config: { retellAgentId: "agent_in_retell_1" },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
} as const;

/** A number egma dials: the shipped phone adapter's own connection shape. */
const PHONE = {
  type: "phone",
  modality: "voice",
  config: { phoneNumber: "+15551234567" },
} as const;

/**
 * A deployment `egma self-host setup` has finished with: a carrier
 * trunk, a number its calls come from, and a voice to speak with.
 *
 * Non-secret, all three of it — see `phone-readiness.ts`. What it stands for
 * here is the difference between an egma that can dial and one that has never
 * been given a carrier, which is the only thing the run door asks about.
 */
const PHONE_IS_SET_UP = {
  carrier_trunk_address: "egma-simulator-106e37f8.pstn.twilio.com",
  carrier_trunk_number: "+18885550123",
  text_to_speech_provider: "openai",
} as const;

/** Somebody with a key, an agent to check, and a test to check it against. */
async function aCustomerReadyToRun(
  label: string,
  options: { readonly phoneIsSetUp?: boolean } = {},
): Promise<{
  ada: Customer;
  key: string;
  agentId: string;
  connectionId: string;
  oneCaller: string;
  twoCallers: string;
}> {
  api = await createApi(
    label,
    options.phoneIsSetUp === true
      ? { platformSettings: PHONE_IS_SET_UP }
      : {},
  );
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const { agentId, connectionId } = await registerAgentThrough(
    key,
    "Front desk",
    RETELL,
  );

  // Two people to call about a test, authored the only way there is — no
  // route ships for a persona. One test then names both, which is what makes
  // "one simulation per test per person" something this file can observe.
  for (const name of ["Impatient Rita", "Deliberate Sam"]) {
    await createPersona(contextFor(ada, "member"), { name, traits: NEUTRAL_TRAITS });
  }

  const { versionId: oneCaller } = await pushTest(key, "Reschedules", [
    "Impatient Rita",
  ]);
  const { versionId: twoCallers } = await pushTest(key, "Cancels", [
    "Impatient Rita",
    "Deliberate Sam",
  ]);

  return { ada, key, agentId, connectionId, oneCaller, twoCallers };
}

/** Move the run's conversations the way a simulator would, at the db seam. */
const CLAIMANT = "simulator-blue-1";

async function claimOwn(
  runId: string,
): Promise<readonly SimulationClaim[]> {
  const claimed = await claimSimulations({
    claimant: CLAIMANT,
    capacity: 50,
  });
  return claimed.filter((claim) => claim.runId === runId);
}

describe("starting a run", () => {
  it("pins the versions it was given and answers them, with one conversation per test per person", async () => {
    const { key, agentId, connectionId, oneCaller, twoCallers } =
      await aCustomerReadyToRun("runs_create");

    const started = await request("POST", "/api/runs", key, {
      agent: agentId,
      connection: connectionId,
      test_versions: [oneCaller, twoCallers],
      label: "the whole folder",
    });

    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({
      status: "pending",
      agent_id: agentId,
      connection_id: connectionId,
      connection_type: "retell",
      modality: "chat",
      label: "the whole folder",
      test_versions: [oneCaller, twoCallers],
      // Two tests, three people between them: three conversations, counted
      // before anything was written and frozen from then on.
      expected_simulation_count: 3,
      // Null until the three of them land together at the finish.
      completed_count: null,
      failed_count: null,
      canceled_count: null,
      finished_at: null,
    });
    expect(String(started.body.id)).toMatch(/^run_/u);

    const simulations = started.body.simulations as Record<string, unknown>[];
    expect(simulations).toHaveLength(3);
    expect(simulations.map((one) => one.test_version_id)).toEqual([
      oneCaller,
      twoCallers,
      twoCallers,
    ]);
    expect(
      simulations.map((one) => `${String(one.test_name)}/${String(one.persona_name)}`),
    ).toEqual([
      "Reschedules/Impatient Rita",
      "Cancels/Impatient Rita",
      "Cancels/Deliberate Sam",
    ]);
    expect(simulations.map((one) => one.position)).toEqual([1, 2, 3]);
    for (const one of simulations) {
      expect(one.status).toBe("queued");
      expect(one.verdict).toBeNull();
      expect(one.reason).toBeNull();
      expect(String(one.persona_name)).not.toBe("");
      expect(String(one.test_name)).not.toBe("");
    }
  });

  it("answers a results address with no token in it, so it is safe to paste", async () => {
    const { key, connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_results_url",
    );

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller],
    });

    expect(started.body.results_url).toBe(
      `${api.config.baseUrl}/runs/${String(started.body.id)}`,
    );
    expect(String(started.body.results_url)).not.toContain("?");
    expect(String(started.body.results_url)).not.toContain(key);
  });

  it("takes the connection's own agent when the request names none", async () => {
    const { key, agentId, connectionId, oneCaller } =
      await aCustomerReadyToRun("runs_agent_implied");

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller],
    });

    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    expect(started.body.agent_id).toBe(agentId);
  });

  it("refuses one unknown or doubled version and writes nothing at all", async () => {
    const { key, connectionId, oneCaller, twoCallers } =
      await aCustomerReadyToRun("runs_create_refusals");

    const missing = newId("tstv");
    const unknown = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller, missing, twoCallers],
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.body).toEqual({
      error: "unprocessable",
      message:
        `there is no test version ${missing} on this egma. Push the test ` +
        `first, or read the test and pin the version_id it names now.`,
    });

    const doubled = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller, oneCaller],
    });
    expect(doubled.statusCode).toBe(422);
    expect(doubled.body).toEqual({
      error: "unprocessable",
      message:
        `test version ${oneCaller} is pinned twice on one run. Pin each ` +
        `version once; a run already conducts one simulation per test per ` +
        `persona.`,
    });

    // An entry that is not a version id takes the whole run with it: running
    // the rest would be a green result about a shortened selection.
    const unusable = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller, 7],
    });
    expect(unusable.statusCode).toBe(422);
    expect(unusable.body).toEqual({
      error: "unprocessable",
      message:
        "a run pins each test version as text — the version_id a push or a " +
        "read answered with — and one entry in test_versions is neither. " +
        "Send them all, or none of them runs.",
    });

    const none = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [],
    });
    expect(none.statusCode).toBe(422);
    expect(none.body).toEqual({
      error: "unprocessable",
      message:
        "a run needs at least one test version, because a run with no " +
        "simulations checks nothing. Pin the version_id of each test this " +
        "run should execute.",
    });

    // Nothing half-written: not the run that named a bad id, and not the
    // conversations the good ids beside it would have produced.
    const { rows } = await api.database.sql("select id from run");
    expect(rows).toEqual([]);
    const conversations = await api.database.sql("select id from simulation");
    expect(conversations.rows).toEqual([]);
  });

  it("refuses a connection nobody of theirs has, and one that is not on the agent they named", async () => {
    const { key, connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_connection_refusals",
    );
    const other = await registerAgentThrough(key, "Other desk", {
      ...RETELL,
      config: { retellAgentId: "agent_in_retell_2" },
    });

    const missing = newId("con");
    const nowhere = await request("POST", "/api/runs", key, {
      connection: missing,
      test_versions: [oneCaller],
    });
    expect(nowhere.statusCode).toBe(404);
    expect(nowhere.body).toEqual({
      error: "not_found",
      message:
        `there is no connection ${missing} in this project. Check the id, ` +
        `or read your agents to see how each one is reached.`,
    });

    const mismatched = await request("POST", "/api/runs", key, {
      agent: other.agentId,
      connection: connectionId,
      test_versions: [oneCaller],
    });
    expect(mismatched.statusCode).toBe(404);
    expect(mismatched.body).toEqual({
      error: "not_found",
      message:
        `connection ${connectionId} is not on agent ${other.agentId}. Name ` +
        `the agent that connection is on, or leave the agent out and egma ` +
        `takes the connection's own.`,
    });

    // A string that could not be an agent id at all is the same mistake one
    // step earlier, and it says which of the two ids it could not read.
    const misread = await request("POST", "/api/runs", key, {
      agent: connectionId,
      connection: connectionId,
      test_versions: [oneCaller],
    });
    expect(misread.statusCode).toBe(404);
    expect(misread.body).toEqual({
      error: "not_found",
      message:
        `"${connectionId}" is not an agent id, so no connection is on it. ` +
        `Name the agent that connection is on, or leave the agent out and ` +
        `egma takes the connection's own.`,
    });

    // And a connection id that could not be one either.
    const unreadable = await request("POST", "/api/runs", key, {
      connection: other.agentId,
      test_versions: [oneCaller],
    });
    expect(unreadable.statusCode).toBe(404);
    expect(unreadable.body).toEqual({
      error: "not_found",
      message:
        `"${other.agentId}" is not a connection id. Send the con_ id ` +
        `registering the agent answered with.`,
    });
  });

  it("refuses a request that named no connection, rather than one it never sent", async () => {
    const { key, oneCaller } = await aCustomerReadyToRun("runs_no_connection");

    // Absent and blank are the same mistake, and "no connection of yours has
    // that id" would be a sentence about an id the request never sent.
    for (const body of [
      { test_versions: [oneCaller] },
      { connection: "", test_versions: [oneCaller] },
      { connection: "   ", test_versions: [oneCaller] },
    ]) {
      const refused = await request("POST", "/api/runs", key, body);
      expect(refused.statusCode, JSON.stringify(body)).toBe(422);
      expect(refused.body).toEqual({
        error: "unprocessable",
        message:
          "a run is conducted over a connection, and this request named " +
          "none. Send connection with the con_ id of the way egma should " +
          "reach the agent — registering the agent answered with one.",
      });
    }
  });

  it("refuses a selection larger than a run may hold, naming what it asked for", async () => {
    const { ada, key, connectionId } = await aCustomerReadyToRun("runs_ceiling");
    const auth = contextFor(ada, "member");

    // Twenty people, and eleven frozen versions naming all of them: two
    // hundred and twenty conversations, over a run's two hundred.
    const personaIds: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      personaIds.push(
        (
          await createPersona(auth, {
            name: `Caller ${String(index)}`,
            traits: NEUTRAL_TRAITS,
          })
        ).id,
      );
    }

    const crowded = await createTest(auth, {
      name: "Asks about everything",
      scenario: "The first of many.",
      expectedBehaviors: ["answers"],
      personaIds,
    });
    const versions = [crowded.versionId];
    for (let index = 1; index < 11; index += 1) {
      const edited = await editTest(auth, crowded.id, {
        scenario: `Version ${String(index)} of many.`,
        expectedVersionId: versions.at(-1) as string,
      });
      versions.push(edited?.versionId ?? "");
    }

    const refused = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: versions,
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        "a run conducts at most 200 simulations, and these 11 versions ask " +
        "for 220. Split the selection across runs.",
    });

    const { rows } = await api.database.sql("select id from run");
    expect(rows).toEqual([]);
  });

  it("refuses a version whose persona has since been deleted, rather than conducting one fewer", async () => {
    const { ada, key, connectionId } = await aCustomerReadyToRun("runs_gone");
    const auth = contextFor(ada, "member");

    const leaving = await createPersona(auth, {
      name: "Departing Dara",
      traits: NEUTRAL_TRAITS,
    });
    const pinned = await createTest(auth, {
      name: "Asks twice",
      scenario: "They call back about the same booking.",
      expectedBehaviors: ["remembers the earlier conversation"],
      personaIds: [leaving.id],
    });

    // The test moves off them first: a live test naming somebody is what
    // refuses their delete, and the version they were on goes on naming them.
    await editTest(auth, pinned.id, {
      personaIds: [],
      expectedVersionId: pinned.versionId,
    });
    await archivePersona(auth, leaving.id);

    const refused = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [pinned.versionId],
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        `persona ${leaving.id} is deleted, and a run cannot conduct a ` +
        `simulation with a deleted persona. Edit the tests that name them, ` +
        `then pin the versions those edits mint.`,
    });
  });

  it("accepts a run over a phone connection, because the phone adapter has shipped and this platform can dial", async () => {
    const { key, oneCaller } = await aCustomerReadyToRun("runs_over_phone", {
      phoneIsSetUp: true,
    });
    const dialled = await registerAgentThrough(key, "Front desk line", PHONE);

    const started = await request("POST", "/api/runs", key, {
      connection: dialled.connectionId,
      test_versions: [oneCaller],
    });

    // This used to be the `no_adapter` refusal. The adapter is in the shipped
    // simulator now, so the door opens — and the run is a real one, queued
    // over the number the customer registered.
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({
      status: "pending",
      connection_id: dialled.connectionId,
      connection_type: "phone",
      modality: "voice",
    });

    const { rows } = await api.database.sql("select id from run");
    expect(rows).toEqual([{ id: String(started.body.id) }]);
  });

  /**
   * The money fence.
   *
   * A phone simulation is the one kind that spends somebody's money at a
   * carrier, and the platform that spends it is the deployment rather than the
   * repository. So a deployment nobody has given a trunk to must say so at the
   * door — not queue the conversation, hand it to a simulator, and let it die
   * at the dialling. What lands on the record then is a failed simulation
   * against an agent that was never called, which is exactly the confusion
   * between an operational failure and a verdict this product exists to
   * prevent.
   */
  it("refuses a phone run before writing anything when this platform has no carrier", async () => {
    const { key, oneCaller } = await aCustomerReadyToRun("runs_phone_unset");
    const dialled = await registerAgentThrough(key, "Front desk line", PHONE);

    const refused = await request("POST", "/api/runs", key, {
      connection: dialled.connectionId,
      test_versions: [oneCaller],
    });

    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body).toEqual({
      error: "phone_setup_required",
      message:
        "this egma has not been set up to place phone calls, so nothing was " +
        "dialled and nothing was charged. It is missing the carrier trunk " +
        "and the source number and the text-to-speech provider. Whoever runs " +
        "this platform makes it ready with one command in the platform " +
        "workspace: " +
        "egma self-host setup.",
    });

    // Nothing was written: no run, and so nothing for a simulator to claim.
    const { rows } = await api.database.sql("select id from run");
    expect(rows).toEqual([]);
    const { rows: simulations } = await api.database.sql(
      "select id from simulation",
    );
    expect(simulations).toEqual([]);
  });

  it("says which half of the phone configuration is missing, so a partly-configured platform is not told to start again", async () => {
    api = await createApi("runs_phone_half_set", {
      platformSettings: {
        carrier_trunk_address: PHONE_IS_SET_UP.carrier_trunk_address,
        text_to_speech_provider: PHONE_IS_SET_UP.text_to_speech_provider,
      },
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    await createPersona(contextFor(ada, "member"), {
      name: "Impatient Rita",
      traits: NEUTRAL_TRAITS,
    });
    const { versionId } = await pushTest(key, "Reschedules", ["Impatient Rita"]);
    const dialled = await registerAgentThrough(key, "Front desk line", PHONE);

    const refused = await request("POST", "/api/runs", key, {
      connection: dialled.connectionId,
      test_versions: [versionId],
    });

    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    expect(String(refused.body.message)).toContain(
      "It is missing the source number.",
    );
  });

  it("lets a run over a connection that does not use the platform's carrier through a platform with none", async () => {
    // The whole point of two readiness facts rather than one: an egma nobody
    // has given a carrier is a working egma for everything that is not a
    // phone call, and a gate that refused chat work would make the first-run
    // story impossible to tell.
    const { key, connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_unset_phone_lets_chat_through",
    );

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller],
    });

    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({ connection_type: "retell" });
  });

  it("answers a phone connection belonging to somebody else the way a missing one is answered, rather than refusing about it", async () => {
    // The gate reads a connection to decide, and a gate that answered about a
    // row the caller cannot see would confirm another customer's connection
    // exists — through a refusal, which is the quietest possible leak.
    const { key, oneCaller } = await aCustomerReadyToRun(
      "runs_phone_other_customer",
    );
    const bruno = await signUp(api.app, "bruno@other.example", "Other");
    const brunosKey = await projectKeyFor(api.app, bruno);
    const theirs = await registerAgentThrough(
      brunosKey,
      "Their front desk line",
      PHONE,
    );

    const refused = await request("POST", "/api/runs", key, {
      connection: theirs.connectionId,
      test_versions: [oneCaller],
    });

    expect(refused.statusCode).toBe(404);
    expect(refused.body).toMatchObject({ error: "not_found" });
    expect(String(refused.body.message)).toContain(
      `there is no connection ${theirs.connectionId} in this project`,
    );
  });

  it("is refused to a viewer, because a run spends money and creates data", async () => {
    const { ada, connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_viewer_create",
    );
    const quentin = await colleagueOf(api.app, ada, "quentin@acme.example", "viewer");

    const refused = await request("POST", "/api/runs", quentin.secret, {
      connection: connectionId,
      test_versions: [oneCaller],
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.body).toEqual({
      error: "not_permitted",
      message: "a viewer may not start_and_cancel_runs",
    });
  });

  it("is refused before anything is read when the key is not one of ours", async () => {
    const { connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_unknown_key",
    );

    const refused = await request("POST", "/api/runs", "egma_not_a_key", {
      connection: connectionId,
      test_versions: [oneCaller],
    });

    expect(refused.statusCode).toBe(401);
    expect(refused.body).toEqual({
      error: "not_authenticated",
      message:
        "this request carried no session and no usable API key. " +
        "Sign in, or send Authorization: Bearer with an egma key.",
    });
  });
});

describe("the project a run lands in", () => {
  it("is asked for rather than guessed at once the organization holds two", async () => {
    const { ada, connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_project_ambiguous",
    );
    await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });

    const refused = await request("POST", "/api/runs", ada.secret, {
      connection: connectionId,
      test_versions: [oneCaller],
    });

    expect(refused.statusCode).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        "this organization holds more than one project and this credential " +
        "names none, so egma cannot tell which project this is about. Send " +
        "project with the one you mean, or use a key minted for that project.",
    });
  });

  it("is never another customer's, and the refusal confirms nothing about it", async () => {
    const { key, connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_project_across",
    );
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const refused = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller],
      project: grace.projectId,
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.body).toEqual({
      error: "not_permitted",
      message:
        `this credential may not act in project ${grace.projectId}. A ` +
        `credential authorized for one project acts in that one, and a key ` +
        `for the whole organization acts in any project of that organization. ` +
        `Leave project out to use the project this credential already acts in.`,
    });
  });

  it("is never a sibling project a project-scoped credential was not minted for", async () => {
    const { ada, key, connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_project_sibling",
    );
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });

    const refused = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller],
      project: outbound.id,
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.body).toEqual({
      error: "not_permitted",
      message:
        `this credential may not act in project ${outbound.id}. A credential ` +
        `authorized for one project acts in that one, and a key for the whole ` +
        `organization acts in any project of that organization. Leave project ` +
        `out to use the project this credential already acts in.`,
    });
  });
});

describe("reading one run", () => {
  it("answers the run and every conversation in it, to any role", async () => {
    const { ada, key, connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_read",
    );
    const quentin = await colleagueOf(api.app, ada, "quentin@acme.example", "viewer");

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller],
    });
    const runId = String(started.body.id);

    // A read-only auditor reads everything, which is what read-only means.
    const read = await request("GET", `/api/runs/${runId}`, quentin.secret);
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toEqual(started.body);
  });

  it("shows another customer nothing, in the words nothing uses", async () => {
    const { key, connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_read_across",
    );
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller],
    });

    const theirs = await request(
      "GET",
      `/api/runs/${String(started.body.id)}`,
      grace.secret,
    );
    const invented = await request("GET", `/api/runs/${newId("run")}`, key);

    for (const answer of [theirs, invented]) {
      expect(answer.statusCode).toBe(404);
      expect(answer.body).toEqual({
        error: "not_found",
        message:
          "no run of yours has that id. Check the id, or start a run with " +
          "POST /api/runs.",
      });
    }
  });
});

describe("following a run", () => {
  it("hands a crashed follower everything it missed and nothing it already applied", async () => {
    const { ada, key, connectionId, oneCaller, twoCallers } =
      await aCustomerReadyToRun("runs_follow");
    const auth = contextFor(ada, "member");

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller, twoCallers],
    });
    const runId = String(started.body.id);

    type Feed = {
      readonly events: { seq: number; kind: string; status: string }[];
      readonly next: number;
      readonly done: boolean;
    };

    /**
     * A follower written the way the contract says one is: it remembers the
     * last number it applied and asks for everything after it, and it applies
     * each number at most once. The server's half is to be stateless; this is
     * the other half, and the two together are what crash-resume is.
     */
    const applied: number[] = [];
    const seen = new Set<number>();
    let cursor = 0;
    const follow = async (): Promise<Feed> => {
      const page = await request(
        "GET",
        `/api/runs/${runId}/events?after=${String(cursor)}`,
        key,
      );
      expect(page.statusCode, JSON.stringify(page.body)).toBe(200);
      const feed = page.body as unknown as Feed;
      for (const event of feed.events) {
        if (seen.has(event.seq)) continue;
        seen.add(event.seq);
        applied.push(event.seq);
      }
      cursor = feed.next;
      return feed;
    };

    expect((await follow()).events).toEqual([]);

    const [first, second, third] = await claimOwn(runId);
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("the claim missed the run under test");
    }
    await follow();

    // The crash: the same page asked for twice. The server keeps no record of
    // who has read what, so it answers the same thing — and applying it again
    // is the follower's own no-op rather than something the server prevented.
    const askedFrom = cursor;
    const once = await follow();
    const soFar = applied.length;
    cursor = askedFrom;
    const twice = await follow();
    expect(twice.events.map((event) => event.seq)).toEqual(
      once.events.map((event) => event.seq),
    );
    expect(applied.length).toBe(soFar);

    await startSimulation(auth, first.id, CLAIMANT);
    await completeSimulation(auth, first.id, CLAIMANT, {
      endingReason: "agent_ended",
    });
    await failSimulation(auth, second.id, CLAIMANT, {
      reason: "agent_never_joined",
    });
    await startSimulation(auth, third.id, CLAIMANT);
    await completeSimulation(auth, third.id, CLAIMANT, {
      endingReason: "persona_concluded",
    });

    const last = await follow();

    // Every number exactly once, in order, with no hole in the middle — which
    // is what "missed nothing and repeated nothing" means.
    expect(applied).toEqual(
      Array.from({ length: applied.length }, (_, index) => index + 1),
    );
    expect(new Set(applied).size).toBe(applied.length);
    expect(last.done).toBe(true);
  });

  it("keeps a conversation that never ran apart from one that ran and was judged", async () => {
    const { ada, key, connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_follow_shapes",
    );
    const auth = contextFor(ada, "member");

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller],
    });
    const runId = String(started.body.id);

    const [only] = await claimOwn(runId);
    if (only === undefined) throw new Error("the claim missed the run");
    await failSimulation(auth, only.id, CLAIMANT, { reason: "not_answered" });

    const page = await request("GET", `/api/runs/${runId}/events`, key);
    const events = page.body.events as Record<string, unknown>[];

    // The status says how far it got; the verdict says what the graders made
    // of it, and nothing has judged anything here. A line that folded the two
    // would report a test that never ran as a test that failed.
    const landed = events.find(
      (event) => event.kind === "simulation" && event.status === "failed",
    );
    expect(landed).toMatchObject({
      simulation_id: only.id,
      status: "failed",
      reason: "not_answered",
      verdict: null,
    });
    expect(landed).toHaveProperty("test_name");
    expect(landed).toHaveProperty("persona_name");

    // A run event is about the header, and says nothing about a conversation.
    const header = events.find((event) => event.kind === "run");
    expect(Object.keys(header ?? {}).sort()).toEqual([
      "at",
      "kind",
      "seq",
      "status",
    ]);

    // And the counts keep the three apart, because a conversation that never
    // ran is not one that passed and not one that was stopped.
    const read = await request("GET", `/api/runs/${runId}`, key);
    expect(read.body).toMatchObject({
      status: "completed",
      completed_count: 0,
      failed_count: 1,
      canceled_count: 0,
    });
  });

  it("is readable by a viewer, and by nobody outside the customer", async () => {
    const { ada, key, connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_follow_roles",
    );
    const quentin = await colleagueOf(api.app, ada, "quentin@acme.example", "viewer");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller],
    });
    const runId = String(started.body.id);

    const audited = await request(
      "GET",
      `/api/runs/${runId}/events`,
      quentin.secret,
    );
    expect(audited.statusCode).toBe(200);
    expect(audited.body).toEqual({ events: [], next: 0, done: false });

    const theirs = await request(
      "GET",
      `/api/runs/${runId}/events`,
      grace.secret,
    );
    expect(theirs.statusCode).toBe(404);
    expect(theirs.body).toEqual({
      error: "not_found",
      message:
        "no run of yours has that id. Check the id, or start a run with " +
        "POST /api/runs.",
    });
  });

  it("refuses a number this feed never issued rather than starting again from the beginning", async () => {
    const { key, connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_follow_cursor",
    );

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller],
    });
    const runId = String(started.body.id);

    // `Number` would take every one of these and answer about a page nobody
    // asked for — 0x10 is sixteen, 1e3 is a thousand, " 7 " is seven — while
    // the sentence says a sequence number is what it takes. The last three
    // are digits and still refused: past the sequence column's integer range
    // they would surface as the database's own error, and past what a number
    // here can hold exactly they would quietly round.
    for (const after of [
      "the-last-one",
      "-1",
      "1.5",
      "0x10",
      "1e3",
      "5.0",
      " 7 ",
      "+3",
      "2147483648",
      "9007199254740993",
      "99999999999999999999",
    ]) {
      const refused = await request(
        "GET",
        `/api/runs/${runId}/events?after=${encodeURIComponent(after)}`,
        key,
      );
      expect(refused.statusCode, after).toBe(400);
      expect(refused.body).toEqual({
        error: "invalid_request",
        message:
          `"${after}" is not a sequence number this feed issued. Send back ` +
          `the next an earlier page answered with, or leave after out to ` +
          `start at the first change.`,
      });
    }

    // A parameter that arrived empty is a parameter nobody set — the rule
    // every query in this API shares — so `?after=` starts at the beginning
    // rather than being refused for a value it does not have.
    const blank = await request("GET", `/api/runs/${runId}/events?after=`, key);
    expect(blank.statusCode).toBe(200);
    expect(blank.body).toEqual({ events: [], next: 0, done: false });
  });
});

describe("stopping a run", () => {
  it("settles the three counts together, and the feed ends done", async () => {
    const { key, connectionId, oneCaller, twoCallers } =
      await aCustomerReadyToRun("runs_cancel");

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller, twoCallers],
    });
    const runId = String(started.body.id);

    const canceled = await request("POST", `/api/runs/${runId}/cancel`, key);

    expect(canceled.statusCode, JSON.stringify(canceled.body)).toBe(200);
    // Nothing ran, so nothing passed. Two conversations were stopped, and the
    // counts say exactly that rather than an empty green.
    expect(canceled.body).toMatchObject({
      status: "canceled",
      completed_count: 0,
      failed_count: 0,
      canceled_count: 3,
    });
    expect(canceled.body.finished_at).toBeTypeOf("string");
    expect(
      (canceled.body.simulations as { status: string }[]).map(
        (one) => one.status,
      ),
    ).toEqual(["canceled", "canceled", "canceled"]);

    const feed = await request("GET", `/api/runs/${runId}/events`, key);
    expect(feed.body.done).toBe(true);
    expect(
      (feed.body.events as { kind: string; status: string }[]).map(
        (event) => `${event.kind} ${event.status}`,
      ),
    ).toEqual([
      "simulation canceled",
      "simulation canceled",
      "simulation canceled",
      "run canceled",
    ]);
  });

  it("leaves the counts unwritten while a conversation is still out, so the feed is not done yet", async () => {
    const { ada, key, connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_cancel_in_flight",
    );
    const auth = contextFor(ada, "member");

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller],
    });
    const runId = String(started.body.id);
    const [only] = await claimOwn(runId);
    if (only === undefined) throw new Error("the claim missed the run");

    const canceled = await request("POST", `/api/runs/${runId}/cancel`, key);
    expect(canceled.body).toMatchObject({
      status: "canceled",
      completed_count: null,
      failed_count: null,
      canceled_count: null,
      finished_at: null,
    });
    expect((await request("GET", `/api/runs/${runId}/events`, key)).body.done).toBe(
      false,
    );

    // The straggler lands, and only then are the counts honest.
    await markSimulationCanceled(auth, only.id, CLAIMANT);
    const settled = await request("GET", `/api/runs/${runId}`, key);
    expect(settled.body).toMatchObject({
      status: "canceled",
      completed_count: 0,
      failed_count: 0,
      canceled_count: 1,
    });
    expect((await request("GET", `/api/runs/${runId}/events`, key)).body.done).toBe(
      true,
    );
  });

  it("is nothing to do twice, and is refused once the run has finished", async () => {
    const { ada, key, connectionId, oneCaller, twoCallers } =
      await aCustomerReadyToRun("runs_cancel_twice");
    const auth = contextFor(ada, "member");

    const stopped = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller],
    });
    const stoppedId = String(stopped.body.id);
    await request("POST", `/api/runs/${stoppedId}/cancel`, key);
    const again = await request("POST", `/api/runs/${stoppedId}/cancel`, key);
    expect(again.statusCode).toBe(200);
    expect(again.body).toMatchObject({ status: "canceled", canceled_count: 1 });

    // One that finished by itself has nothing left to stop, and the caller
    // hears so rather than being told the cancel worked.
    const ran = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [twoCallers],
    });
    const ranId = String(ran.body.id);
    for (const one of await claimOwn(ranId)) {
      await startSimulation(auth, one.id, CLAIMANT);
      await completeSimulation(auth, one.id, CLAIMANT, {
        endingReason: "agent_ended",
      });
    }

    const missed = await request("POST", `/api/runs/${ranId}/cancel`, key);
    expect(missed.statusCode).toBe(409);
    expect(missed.body).toEqual({
      error: "conflict",
      message:
        `run ${ranId} is completed, and a completed run has nothing left to ` +
        `cancel. Its counts are final; start a fresh run to conduct those ` +
        `tests again.`,
    });
  });

  it("is refused to a viewer, and answers nothing about a run that is not theirs", async () => {
    const { ada, key, connectionId, oneCaller } = await aCustomerReadyToRun(
      "runs_cancel_roles",
    );
    const quentin = await colleagueOf(api.app, ada, "quentin@acme.example", "viewer");

    const started = await request("POST", "/api/runs", key, {
      connection: connectionId,
      test_versions: [oneCaller],
    });
    const runId = String(started.body.id);

    const refused = await request(
      "POST",
      `/api/runs/${runId}/cancel`,
      quentin.secret,
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toEqual({
      error: "not_permitted",
      message: "a viewer may not start_and_cancel_runs",
    });

    const invented = await request("POST", `/api/runs/${newId("run")}/cancel`, key);
    expect(invented.statusCode).toBe(404);
    expect(invented.body).toEqual({
      error: "not_found",
      message:
        "no run of yours has that id. Check the id, or start a run with " +
        "POST /api/runs.",
    });
  });
});
