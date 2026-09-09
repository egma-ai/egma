import {
  claimSimulations,
  completeSimulation,
  createProject,
  startSimulation,
  type AuthContext,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  mintKey,
  request as ask,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * Sessions may select another accessible project per request; their default
 * project is not a restriction. Project API keys remain scoped to one project.
 * Check both access and the refusal messages clients display.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

async function listAgentsAs(
  cookieOrKey: Record<string, string>,
  project: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api.app.inject({
    method: "GET",
    url: `/v1/agents?projectId=${project}`,
    headers: cookieOrKey,
  });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

function registration(name: string, project: string): Record<string, unknown> {
  return {
    name,
    agentPlatform: "livekit",
    projectId: project,
    connection: {
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "chat",
      config: {
        url: "wss://fixture.livekit.cloud",
        agentName: `agent_for_${name.replace(/\W/g, "")}`,
      },
      credentials: { apiKey: "APIfixture12345678", apiSecret: "livekit-secret-fixture" },
    },
  };
}

/** A voice connection that starts without carrier configuration in this API. */
const LIVEKIT_VOICE = {
  agentPlatform: "livekit",
  connectionType: "livekit_room",
  accessVariant: "livekit_room.project_credentials",
  modality: "voice",
  config: { url: "wss://acme.livekit.cloud", agentName: "front-desk" },
  credentials: {
    apiKey: "livekit-key-A1B2C3D4WXYZ",
    apiSecret: "livekit-secret-E5F6G7H8QRST",
  },
} as const;

async function createSuite(key: string, name: string): Promise<string> {
  const suite = await ask(api.app, "POST", "/v1/test-suites", key, { name });
  expect(suite.statusCode, JSON.stringify(suite.body)).toBe(201);
  return String(suite.body.id);
}

describe("a browser naming a project", () => {
  it("reads any project of its own organization, not only the oldest", async () => {
    api = await createApi("browser_sibling_project");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });

    await api.app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { authorization: `Bearer ${ada.secret}` },
      payload: registration("Front desk", ada.projectId),
    });
    await api.app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { authorization: `Bearer ${ada.secret}` },
      payload: registration("Outbound desk", outbound.id),
    });

    const first = await listAgentsAs({ cookie: ada.cookie }, ada.projectId);
    expect(first.status).toBe(200);
    expect((first.body.agents as { name: string }[]).map((one) => one.name)).toEqual([
      "Front desk",
    ]);

    // The second tab. Nothing about the first request narrowed this one.
    const second = await listAgentsAs({ cookie: ada.cookie }, outbound.id);
    expect(second.status).toBe(200);
    expect(
      (second.body.agents as { name: string }[]).map((one) => one.name),
    ).toEqual(["Outbound desk"]);

    // And the first tab still reads its own project afterwards.
    const again = await listAgentsAs({ cookie: ada.cookie }, ada.projectId);
    expect((again.body.agents as { name: string }[]).map((one) => one.name)).toEqual([
      "Front desk",
    ]);
  });

  it("is refused a project of another organization, and told so as an absence", async () => {
    api = await createApi("browser_foreign_project");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const refused = await listAgentsAs({ cookie: ada.cookie }, grace.projectId);

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({
      error: "project_outside_organization",
      message:
        `There is no project ${grace.projectId} available to this ` +
        "organization. Choose a project from the selector and try again.",
    });
  });

  it("is refused a project that never existed, in the same words", async () => {
    api = await createApi("browser_unknown_project");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const invented = newId("prj");

    const refused = await listAgentsAs({ cookie: ada.cookie }, invented);

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({
      error: "project_outside_organization",
      message:
        `There is no project ${invented} available to this organization. ` +
        "Choose a project from the selector and try again.",
    });
  });

  /**
   * The asymmetry, stated as its own promise. A key minted for one project may
   * not use the browser's rule to reach a sibling — the selector's freedom
   * belongs to a person's membership, not to a credential's scope.
   */
  it("does not widen an API key minted for one project", async () => {
    api = await createApi("browser_does_not_widen_keys");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });
    const forDefault = await mintKey(
      api.app,
      ada.cookie,
      "default only",
      ada.projectId,
    );

    const refused = await listAgentsAs(
      { authorization: `Bearer ${forDefault}` },
      outbound.id,
    );

    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("not_permitted");
  });
});

/**
 * Use a session defaulting to the first project while operating in a second.
 * This exposes routes that ignore explicit project selection.
 */
describe("a browser working in a project that is not the first", () => {
  /** The two projects, and a key for building things in the second one. */
  async function twoProjects(
    label: string,
    options: { readonly traceStore?: boolean } = {},
  ): Promise<{
    readonly ada: Customer;
    readonly outbound: string;
    readonly keyForOutbound: string;
  }> {
    api = await createApi(label, {
      traceStore: options.traceStore ?? false,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    // Create through the API to include the protected Expected behaviors project
    // grader. The project can also use shared Egma-provided personas.
    const made = await api.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: ada.cookie },
      payload: { name: "Outbound" },
    });
    expect(made.statusCode, made.body).toBe(201);
    const outbound = (made.json() as { id: string }).id;

    return {
      ada,
      outbound,
      keyForOutbound: await mintKey(
        api.app,
        ada.cookie,
        "outbound only",
        outbound,
      ),
    };
  }

  it("registers an agent into the project it named, not the one its session sits in", async () => {
    const { ada, outbound } = await twoProjects("browser_registers_elsewhere");

    // Exactly the request the register form sends: a session cookie, and the
    // project in the body, which is where this door reads one.
    const registered = await api.app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { cookie: ada.cookie },
      payload: {
        name: "Outbound desk",
        agentPlatform: "livekit",
        projectId: outbound,
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);

    // In the project it named — and, the half that matters, **not** in the
    // first. A door that ignored the project would have answered 201 all the
    // same, from the session's own project, and the browser would have been
    // sent to a detail page for an agent that is not in the project the address
    // names.
    const inOutbound = await listAgentsAs({ cookie: ada.cookie }, outbound);
    expect(
      (inOutbound.body.agents as { name: string }[]).map((one) => one.name),
    ).toEqual(["Outbound desk"]);

    const inDefault = await listAgentsAs({ cookie: ada.cookie }, ada.projectId);
    expect(inDefault.body.agents).toEqual([]);
  });

  /**
   * Agent registration accepts projectId in either the query or body.
   * Check the query form independently so it cannot fall back to the session default.
   */
  it("registers an agent into the project its query named, too", async () => {
    const { ada, outbound } = await twoProjects("browser_registers_by_query");

    const registered = await api.app.inject({
      method: "POST",
      url: `/v1/agents?projectId=${outbound}`,
      headers: { cookie: ada.cookie },
      payload: { name: "Outbound desk", agentPlatform: "livekit" },
    });
    expect(registered.statusCode, registered.body).toBe(201);

    const inOutbound = await listAgentsAs({ cookie: ada.cookie }, outbound);
    expect(
      (inOutbound.body.agents as { name: string }[]).map((one) => one.name),
    ).toEqual(["Outbound desk"]);

    const inDefault = await listAgentsAs({ cookie: ada.cookie }, ada.projectId);
    expect(inDefault.body.agents).toEqual([]);
  });

  /**
   * A run in the second project, read, followed and stopped from a browser.
   *
   * One test rather than three, because it is one arrangement and the three
   * doors are three views of it: the page reads the run, follows it while it
   * moves, and offers the one control that stops it. A browser that could open
   * a run it cannot follow would show a page frozen at the moment it loaded.
   */
  it("reads a run and its simulations, follows it and cancels it in the project it named", async () => {
    const { ada, outbound, keyForOutbound } = await twoProjects(
      "browser_run_elsewhere",
    );

    const registered = await ask(api.app, "POST", "/v1/agents", keyForOutbound, {
      agentPlatform: "livekit",
      name: "Outbound desk",
      connection: {
        agentPlatform: "livekit",
        connectionType: "livekit_room",
        accessVariant: "livekit_room.project_credentials",
        modality: "chat",
        config: { url: "wss://fixture.livekit.cloud", agentName: "agent_in_retell_outbound" },
        credentials: { apiKey: "APIfixture12345678", apiSecret: "livekit-secret-fixture" },
      },
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const agentId = (registered.body.agent as { id: string }).id;
    const connectionId = (registered.body.connection as { id: string }).id;

    const suiteId = await createSuite(keyForOutbound, "Appointment changes");
    const pushed = await ask(api.app, "POST", "/v1/tests", keyForOutbound, {
      suiteId,
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personas: ["Everyday caller"],
    });
    expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

    const started = await ask(api.app, "POST", "/v1/runs", keyForOutbound, {
      suiteId,
      agentId,
      connectionId,
      name: "The first run in Outbound",
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    const runId = String(started.body.id);

    // The run's own page. Naming the project is the only thing that separates
    // this from the request that used to answer "no run of yours has that id"
    // about a run the list beside it had just shown.
    const read = await api.app.inject({
      method: "GET",
      url: `/v1/runs/${runId}?projectId=${outbound}`,
      headers: { cookie: ada.cookie },
    });
    expect(read.statusCode, read.body).toBe(200);
    expect((read.json() as { name: string }).name).toBe(
      "The first run in Outbound",
    );

    // The simulations are a separate bounded page, under the same project
    // rule as the run header.
    const simulations = await api.app.inject({
      method: "GET",
      url:
        `/v1/runs/${runId}/simulations?pageSize=1&` +
        `projectId=${outbound}`,
      headers: { cookie: ada.cookie },
    });
    expect(simulations.statusCode, simulations.body).toBe(200);
    const simulationPage = simulations.json() as {
      simulations: unknown[];
      nextPageToken: string | null;
    };
    expect(simulationPage.simulations).toHaveLength(1);
    expect(simulationPage.nextPageToken).toBeNull();

    // The feed the same page follows it with.
    const followed = await api.app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/events?after=0&projectId=${outbound}`,
      headers: { cookie: ada.cookie },
    });
    expect(followed.statusCode, followed.body).toBe(200);

    // And the one control on that page that changes anything, **named the way
    // the page names it**: in the address. This door read only a body key
    // until now, so the address was not refused — it was ignored, and the
    // write narrowed to the session's own project, which is the organization's
    // first.
    const stopped = await api.app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/cancel?projectId=${outbound}`,
      headers: { cookie: ada.cookie },
      payload: {},
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect((stopped.json() as { status: string }).status).toBe("canceled");

    // A run of somebody else's organization is still an absence, and naming a
    // project cannot reach one: the rule that widened is the browser's own
    // membership, and it stops at the organization exactly as it always did.
    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const foreign = await api.app.inject({
      method: "GET",
      url: `/v1/runs/${runId}?projectId=${outbound}`,
      headers: { cookie: grace.cookie },
    });
    expect(foreign.statusCode).toBe(404);
  });

  /**
   * Check recording lookup in a non-default project before storage signing.
   * No configured store should yield the storage refusal, not a missing simulation.
   */
  it("resolves a recording for a conversation in the project it named", async () => {
    const { ada, outbound, keyForOutbound } = await twoProjects(
      "browser_recording_elsewhere",
      { traceStore: true },
    );

    const registered = await ask(api.app, "POST", "/v1/agents", keyForOutbound, {
      agentPlatform: "livekit",
      name: "Outbound desk",
      // Voice, because a chat has no audio and would be refused for that
      // reason instead — which is a different sentence and would not say
      // whether the conversation was found.
      connection: LIVEKIT_VOICE,
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);

    const agentId = (registered.body.agent as { id: string }).id;
    const suiteId = await createSuite(
      keyForOutbound,
      "Recorded appointment changes",
    );
    const pushed = await ask(api.app, "POST", "/v1/tests", keyForOutbound, {
      suiteId,
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personas: ["Everyday caller"],
    });
    expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);
    const started = await ask(api.app, "POST", "/v1/runs", keyForOutbound, {
      suiteId,
      agentId,
      connectionId: (registered.body.connection as { id: string }).id,
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    const runId = String(started.body.id);

    // Moved the way a simulator moves it, because no simulator runs here.
    const inOutbound: AuthContext = {
      userId: ada.userId,
      organizationId: ada.organizationId,
      projectId: outbound,
      role: "admin",
      via: "session",
    };
    const claimed = (
      await claimSimulations({ claimant: "simulator-blue-1", capacity: 50 })
    ).filter((claim) => claim.runId === runId);
    const conversation = claimed[0]?.id ?? "";
    expect(conversation, "the run wrote a conversation").not.toBe("");

    await startSimulation(inOutbound, conversation, "simulator-blue-1");
    await completeSimulation(inOutbound, conversation, "simulator-blue-1", {
      endingReason: "agent_ended",
      turnCount: 6,
      recordingReference: `${conversation}/dual-channel.wav`,
    });

    const asked = await api.app.inject({
      method: "GET",
      url: `/v1/simulations/${conversation}/recording?projectId=${outbound}`,
      headers: { cookie: ada.cookie },
    });
    expect((asked.json() as { error: string }).error, asked.body).toBe(
      "no_object_store",
    );

    // And the contrast that makes the line above mean something: naming no
    // project is still the session's own, where this conversation is not.
    const unnamed = await api.app.inject({
      method: "GET",
      url: `/v1/simulations/${conversation}/recording`,
      headers: { cookie: ada.cookie },
    });
    expect(unnamed.statusCode).toBe(404);
  });

  /**
   * A session read without projectId uses its default project and cannot find a
   * run in a sibling project. Browser run URLs supply their project explicitly.
   */
  it("answers an unnamed read from the session's own project, not the organization", async () => {
    const { ada, outbound, keyForOutbound } = await twoProjects(
      "browser_unnamed_run_read",
    );

    const registered = await ask(api.app, "POST", "/v1/agents", keyForOutbound, {
      agentPlatform: "livekit",
      name: "Outbound desk",
      connection: {
        agentPlatform: "livekit",
        connectionType: "livekit_room",
        accessVariant: "livekit_room.project_credentials",
        modality: "chat",
        config: { url: "wss://fixture.livekit.cloud", agentName: "agent_in_retell_unnamed" },
        credentials: { apiKey: "APIfixture12345678", apiSecret: "livekit-secret-fixture" },
      },
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const agentId = (registered.body.agent as { id: string }).id;
    const suiteId = await createSuite(keyForOutbound, "Unnamed run reads");
    const pushed = await ask(api.app, "POST", "/v1/tests", keyForOutbound, {
      suiteId,
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personas: ["Everyday caller"],
    });
    expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);
    const started = await ask(api.app, "POST", "/v1/runs", keyForOutbound, {
      suiteId,
      agentId,
      connectionId: (registered.body.connection as { id: string }).id,
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    const runId = String(started.body.id);

    const unnamed = await api.app.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
      headers: { cookie: ada.cookie },
    });
    expect(unnamed.statusCode).toBe(404);

    // Named, the same session reads the same run perfectly well. The project is
    // the whole of the difference.
    const named = await api.app.inject({
      method: "GET",
      url: `/v1/runs/${runId}?projectId=${outbound}`,
      headers: { cookie: ada.cookie },
    });
    expect(named.statusCode, named.body).toBe(200);
  });

  /**
   * Send writes with projectId only in the query, using a session whose default
   * is another project. Check the selected project receives the record and the
   * default project stays empty.
   */
  it("authors a suite and test, updates a project grader, and starts a run in the project its address names", async () => {
    const { ada, outbound } = await twoProjects("browser_writes_by_address");
    const inOutbound = { cookie: ada.cookie };

    const asBrowser = (
      method: "POST" | "PATCH" | "GET",
      url: string,
      payload?: Record<string, unknown>,
    ) =>
      api.app.inject({
        method,
        url,
        headers: inOutbound,
        ...(payload === undefined ? {} : { payload }),
      });

    /* An agent and a connection to run against, in Outbound. */
    const registered = await asBrowser("POST", `/v1/agents?projectId=${outbound}`, {
      name: "Outbound desk",
      agentPlatform: "livekit",
      connection: {
        agentPlatform: "livekit",
        connectionType: "livekit_room",
        accessVariant: "livekit_room.project_credentials",
        modality: "chat",
        config: { url: "wss://fixture.livekit.cloud", agentName: "agent_in_retell_by_address" },
        credentials: { apiKey: "APIfixture12345678", apiSecret: "livekit-secret-fixture" },
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const agentId = (
      registered.json() as { agent: { id: string } }
    ).agent.id;
    const connectionId = (
      registered.json() as { connection: { id: string } }
    ).connection.id;

    const suite = await asBrowser(
      "POST",
      `/v1/test-suites?projectId=${outbound}`,
      { name: "Appointment changes" },
    );
    expect(suite.statusCode, suite.body).toBe(201);
    const suiteId = (suite.json() as { id: string }).id;

    const firstSuite = await asBrowser(
      "POST",
      `/v1/test-suites?projectId=${ada.projectId}`,
      { name: "No tests here" },
    );
    expect(firstSuite.statusCode, firstSuite.body).toBe(201);
    const firstSuiteId = (firstSuite.json() as { id: string }).id;

    /* POST /v1/tests */
    const authored = await asBrowser("POST", `/v1/tests?projectId=${outbound}`, {
      suiteId,
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personas: ["Everyday caller"],
    });
    expect(authored.statusCode, authored.body).toBe(201);
    const testId = (authored.json() as { id: string }).id;

    /* PATCH /v1/tests/{id} */
    const edited = await asBrowser(
      "PATCH",
      `/v1/tests/${testId}?projectId=${outbound}`,
      { name: "Reschedules a booked appointment, politely" },
    );
    expect(edited.statusCode, edited.body).toBe(200);

    /* GET /v1/graders */
    const projectGraders = await asBrowser(
      "GET",
      `/v1/graders?projectId=${outbound}`,
    );
    expect(projectGraders.statusCode, projectGraders.body).toBe(200);
    const [expectedBehaviors] = (
      projectGraders.json() as { graders: { id: string }[] }
    ).graders;
    if (expectedBehaviors === undefined) {
      throw new Error("the project has no Expected behaviors grader");
    }

    /* PATCH /v1/graders/{id} */
    const retuned = await asBrowser(
      "PATCH",
      `/v1/graders/${expectedBehaviors.id}?projectId=${outbound}`,
      { passThreshold: 0.8 },
    );
    expect(retuned.statusCode, retuned.body).toBe(200);

    /* POST /v1/runs */
    const started = await asBrowser("POST", `/v1/runs?projectId=${outbound}`, {
      suiteId,
      agentId,
      connectionId,
      name: "Started from the address",
    });
    expect(started.statusCode, started.body).toBe(201);
    expect((started.json() as { projectId: string }).projectId).toBe(outbound);

    /* Everything landed in Outbound... */
    const outboundTests = await asBrowser(
      "GET",
      `/v1/tests?projectId=${outbound}&suiteId=${suiteId}`,
    );
    expect(
      (outboundTests.json() as { tests: { name: string }[] }).tests.map(
        (one) => one.name,
      ),
    ).toEqual(["Reschedules a booked appointment, politely"]);

    const outboundGraders = await asBrowser(
      "GET",
      `/v1/graders?projectId=${outbound}`,
    );
    expect(
      (
        outboundGraders.json() as {
          graders: { name: string; passThreshold: number }[];
        }
      ).graders.map(({ name, passThreshold }) => ({ name, passThreshold })),
    ).toEqual([{ name: "expected_behaviors", passThreshold: 0.8 }]);

    const outboundRuns = await asBrowser("GET", `/v1/runs?projectId=${outbound}`);
    expect(
      (outboundRuns.json() as { runs: { name: string }[] }).runs,
    ).toHaveLength(1);

    /* ...and nothing landed in the project the session is standing in. */
    const firstTests = await asBrowser(
      "GET",
      `/v1/tests?projectId=${ada.projectId}&suiteId=${firstSuiteId}`,
    );
    expect((firstTests.json() as { tests: unknown[] }).tests).toEqual([]);

    const firstRuns = await asBrowser("GET", `/v1/runs?projectId=${ada.projectId}`);
    expect((firstRuns.json() as { runs: unknown[] }).runs).toEqual([]);

    // The first project's protected grader kept its own threshold. The edit in
    // Outbound did not cross the project boundary.
    const firstGraders = await asBrowser(
      "GET",
      `/v1/graders?projectId=${ada.projectId}`,
    );
    expect(
      (
        firstGraders.json() as {
          graders: { name: string; passThreshold: number }[];
        }
      ).graders.map(({ name, passThreshold }) => ({ name, passThreshold })),
    ).toEqual([{ name: "expected_behaviors", passThreshold: 1 }]);
  });

});

/**
 * Use an organization API key with no project filter to read, follow, cancel,
 * and resolve recordings across two projects. Organization predicates still
 * apply; routes must not require a project merely because multiple projects exist.
 */
describe("a key for the whole organization, where the organization holds two projects", () => {
  /** A run in the organization's *second* project, and a key for the whole customer. */
  async function aRunInTheSecondProject(
    label: string,
    modality: "chat" | "voice",
  ): Promise<{
    readonly ada: Customer;
    readonly outbound: string;
    readonly runId: string;
  }> {
    api = await createApi(label, { traceStore: modality === "voice" });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    // Create the second project through the API, including its protected grader
    // and access to shared Egma-provided personas.
    const made = await api.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: ada.cookie },
      payload: { name: "Outbound" },
    });
    expect(made.statusCode, made.body).toBe(201);
    const outbound = (made.json() as { id: string }).id;

    // Built with a key minted for the second project, because building it is
    // not what is under test here — reading it back without naming it is.
    const keyForOutbound = await mintKey(
      api.app,
      ada.cookie,
      "outbound only",
      outbound,
    );

    const registered = await ask(api.app, "POST", "/v1/agents", keyForOutbound, {
      agentPlatform: "livekit",
      name: "Outbound desk",
      connection:
        modality === "voice"
          ? LIVEKIT_VOICE
          : {
              agentPlatform: "livekit",
              connectionType: "livekit_room",
              accessVariant: "livekit_room.project_credentials",
              modality: "chat",
              config: {
                url: "wss://fixture.livekit.cloud",
                agentName: `agent_in_livekit_${label}`,
              },
              credentials: { apiKey: "APIfixture12345678", apiSecret: "livekit-secret-fixture" },
            },
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);

    const agentId = (registered.body.agent as { id: string }).id;
    const suiteId = await createSuite(
      keyForOutbound,
      `Appointment changes ${label}`,
    );
    const pushed = await ask(api.app, "POST", "/v1/tests", keyForOutbound, {
      suiteId,
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personas: ["Everyday caller"],
    });
    expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

    const started = await ask(api.app, "POST", "/v1/runs", keyForOutbound, {
      suiteId,
      agentId,
      connectionId: (registered.body.connection as { id: string }).id,
      name: "The first run in Outbound",
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

    return { ada, outbound, runId: String(started.body.id) };
  }

  /**
   * Read it, follow it, stop it — with a credential that names no project, in
   * an organization that holds two.
   *
   * The status codes are asserted rather than only the bodies, because the
   * regression this holds is a **400**: not a narrower answer, not an absence,
   * but a refusal telling a CLI or API client to name a project it has no reason
   * to know after the run has already been identified by id.
   */
  it("reads, follows and cancels a run in the second project without naming one", async () => {
    const { ada, runId } = await aRunInTheSecondProject(
      "orgwide_key_run_elsewhere",
      "chat",
    );
    const asTheOrganization = { authorization: `Bearer ${ada.secret}` };

    const read = await api.app.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
      headers: asTheOrganization,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect((read.json() as { name: string }).name).toBe(
      "The first run in Outbound",
    );

    const followed = await api.app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/events?after=0`,
      headers: asTheOrganization,
    });
    expect(followed.statusCode, followed.body).toBe(200);

    const stopped = await api.app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/cancel`,
      headers: asTheOrganization,
      payload: {},
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect((stopped.json() as { status: string }).status).toBe("canceled");
  });

  /**
   * The fourth route, on a conversation inside that same run.
   *
   * `no_object_store` is the marker that the lookup got **past** the
   * conversation: this instance has no bucket configured, so a route that found
   * the conversation says so, and a route that could not find it says there is
   * no such conversation. Either of those is a different answer from *name a
   * project*, which is what the refusal branch gives.
   */
  it("resolves a recording in the second project without naming one", async () => {
    const { ada, outbound, runId } = await aRunInTheSecondProject(
      "orgwide_key_recording_elsewhere",
      "voice",
    );

    // Moved the way a simulator moves it, because no simulator runs here.
    const inOutbound: AuthContext = {
      userId: ada.userId,
      organizationId: ada.organizationId,
      projectId: outbound,
      role: "admin",
      via: "session",
    };
    const claimed = (
      await claimSimulations({ claimant: "simulator-blue-1", capacity: 50 })
    ).filter((claim) => claim.runId === runId);
    const conversation = claimed[0]?.id ?? "";
    expect(conversation, "the run wrote a conversation").not.toBe("");

    await startSimulation(inOutbound, conversation, "simulator-blue-1");
    await completeSimulation(inOutbound, conversation, "simulator-blue-1", {
      endingReason: "agent_ended",
      turnCount: 6,
      recordingReference: `${conversation}/dual-channel.wav`,
    });

    const asked = await api.app.inject({
      method: "GET",
      url: `/v1/simulations/${conversation}/recording`,
      headers: { authorization: `Bearer ${ada.secret}` },
    });
    expect(asked.statusCode, asked.body).toBe(503);
    expect((asked.json() as { error: string }).error).toBe("no_object_store");

    /*
     * Use the same organization key for simulation evidence and its recording,
     * so the two requests made by one page have consistent access.
     */
    const conversationRead = await api.app.inject({
      method: "GET",
      url: `/v1/simulations/${conversation}`,
      headers: { authorization: `Bearer ${ada.secret}` },
    });
    expect(conversationRead.statusCode, conversationRead.body).toBe(200);
    expect((conversationRead.json() as { id: string }).id).toBe(conversation);
  });
});
