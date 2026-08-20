import {
  claimSimulations,
  PREDEFINED_GRADERS,
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
 * Which project a **browser** request works in.
 *
 * A browser names its project in the request, every request, because the
 * project a tab is looking at lives in that tab's address and nowhere else.
 * Two tabs on two projects are an ordinary thing for one person to have open,
 * and neither can be right if the server keeps one chosen project per session.
 *
 * So a session's project is a **default, not a scope**: every member of an
 * organization holds their organization role on every project in it, and
 * naming a sibling is what the selector does. An API key is the opposite — one
 * minted for a project is bounded by it — and the two are proved apart here.
 *
 * The refusal is quoted word for word. It is the sentence a page shows
 * somebody who followed a link into a project that is not theirs, so the
 * wording is the contract.
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
    url: `/api/agents?project=${project}`,
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
    project,
    connection: {
      type: "retell",
      modality: "chat",
      config: { retellAgentId: `agent_for_${name.replace(/\W/g, "")}` },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    },
  };
}

/** A voice connection that starts without carrier configuration in this API. */
const LIVEKIT_VOICE = {
  type: "livekit",
  modality: "voice",
  config: { url: "wss://acme.livekit.cloud" },
  credentials: {
    apiKey: "livekit-key-A1B2C3D4WXYZ",
    apiSecret: "livekit-secret-E5F6G7H8QRST",
  },
} as const;

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
      url: "/api/agents",
      headers: { authorization: `Bearer ${ada.secret}` },
      payload: registration("Front desk", ada.projectId),
    });
    await api.app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { authorization: `Bearer ${ada.secret}` },
      payload: registration("Outbound desk", outbound.id),
    });

    const first = await listAgentsAs({ cookie: ada.cookie }, ada.projectId);
    expect(first.status).toBe(200);
    expect((first.body.items as { name: string }[]).map((one) => one.name)).toEqual([
      "Front desk",
    ]);

    // The second tab. Nothing about the first request narrowed this one.
    const second = await listAgentsAs({ cookie: ada.cookie }, outbound.id);
    expect(second.status).toBe(200);
    expect(
      (second.body.items as { name: string }[]).map((one) => one.name),
    ).toEqual(["Outbound desk"]);

    // And the first tab still reads its own project afterwards.
    const again = await listAgentsAs({ cookie: ada.cookie }, ada.projectId);
    expect((again.body.items as { name: string }[]).map((one) => one.name)).toEqual([
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
 * The rest of the product, from a browser standing in a project that is not the
 * organization's first.
 *
 * **This is the case every other test in this repository misses, and the misses
 * are not accidents.** An API test authenticates with a key, and a key minted
 * for a project *is* that project — so the acting project and the named project
 * are the same value, and a door that reads neither still answers correctly. A
 * component test stubs `fetch` and never meets a door at all. Only a session
 * has an acting project that can differ from the one named, and only in a
 * second project does the difference have a value.
 *
 * A real browser found four of these at once: an agent registered in the second
 * project landed in the first, and a run in the second project could not be
 * read, followed or cancelled at all. Each was a route reading the project from
 * somewhere the browser was not saying it, or from nowhere. Each is held below,
 * at the seam where it costs milliseconds.
 */
describe("a browser working in a project that is not the first", () => {
  /** The two projects, and a key for building things in the second one. */
  async function twoProjects(label: string): Promise<{
    readonly ada: Customer;
    readonly outbound: string;
    readonly keyForOutbound: string;
  }> {
    api = await createApi(label);
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    // Made the way the New project page makes one, rather than by calling the
    // factory: what that page creates is the whole thing — the project, the
    // default persona a first test gets when it names none, and the seeded
    // grader copy. A project made through this door is ready for its first run.
    const made = await api.app.inject({
      method: "POST",
      url: "/api/projects",
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
      url: "/api/agents",
      headers: { cookie: ada.cookie },
      payload: { name: "Outbound desk", project: outbound },
    });
    expect(registered.statusCode, registered.body).toBe(201);

    // In the project it named — and, the half that matters, **not** in the
    // first. A door that ignored the project would have answered 201 all the
    // same, from the session's own project, and the browser would have been
    // sent to a detail page for an agent that is not in the project the address
    // names.
    const inOutbound = await listAgentsAs({ cookie: ada.cookie }, outbound);
    expect(
      (inOutbound.body.items as { name: string }[]).map((one) => one.name),
    ).toEqual(["Outbound desk"]);

    const inDefault = await listAgentsAs({ cookie: ada.cookie }, ada.projectId);
    expect(inDefault.body.items).toEqual([]);
  });

  /**
   * **The same door, with the project named in the query instead.**
   *
   * The case above proves the caller that exists today. This one proves the
   * *door*, and it is the half that was missing: the first fix moved the
   * register form to the body and left `POST /api/agents` reading nothing else,
   * so a request naming the project the way every other write in this group
   * names it — `?project=` — was still answered from the session's own project,
   * with a 201 and an agent in the wrong place. The next caller written to the
   * group's own pattern would have reproduced the fault exactly.
   *
   * Both spellings mean the same thing here, as they already do for a
   * simulation's regrade, and a caller using either is right.
   */
  it("registers an agent into the project its query named, too", async () => {
    const { ada, outbound } = await twoProjects("browser_registers_by_query");

    const registered = await api.app.inject({
      method: "POST",
      url: `/api/agents?project=${outbound}`,
      headers: { cookie: ada.cookie },
      payload: { name: "Outbound desk" },
    });
    expect(registered.statusCode, registered.body).toBe(201);

    const inOutbound = await listAgentsAs({ cookie: ada.cookie }, outbound);
    expect(
      (inOutbound.body.items as { name: string }[]).map((one) => one.name),
    ).toEqual(["Outbound desk"]);

    const inDefault = await listAgentsAs({ cookie: ada.cookie }, ada.projectId);
    expect(inDefault.body.items).toEqual([]);
  });

  /**
   * A run in the second project, read, followed and stopped from a browser.
   *
   * One test rather than three, because it is one arrangement and the three
   * doors are three views of it: the page reads the run, follows it while it
   * moves, and offers the one control that stops it. A browser that could open
   * a run it cannot follow would show a page frozen at the moment it loaded.
   */
  it("reads, follows and cancels a run that is in the project it named", async () => {
    const { ada, outbound, keyForOutbound } = await twoProjects(
      "browser_run_elsewhere",
    );

    const registered = await ask(api.app, "POST", "/api/agents", keyForOutbound, {
      name: "Outbound desk",
      connection: {
        type: "retell",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_outbound" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
    const connectionId = (registered.body.connection as { id: string }).id;

    const pushed = await ask(api.app, "POST", "/api/tests", keyForOutbound, {
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expected_behaviors: ["confirms the new time back before finishing"],
    });
    expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

    const started = await ask(api.app, "POST", "/api/runs", keyForOutbound, {
      connection: connectionId,
      test_versions: [String(pushed.body.version_id)],
      idempotency_key: newId("run"),
      label: "The first run in Outbound",
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    const runId = String(started.body.id);

    // The run's own page. Naming the project is the only thing that separates
    // this from the request that used to answer "no run of yours has that id"
    // about a run the list beside it had just shown.
    const read = await api.app.inject({
      method: "GET",
      url: `/api/runs/${runId}?project=${outbound}`,
      headers: { cookie: ada.cookie },
    });
    expect(read.statusCode, read.body).toBe(200);
    expect((read.json() as { label: string }).label).toBe(
      "The first run in Outbound",
    );

    // The feed the same page follows it with.
    const followed = await api.app.inject({
      method: "GET",
      url: `/api/runs/${runId}/events?after=0&project=${outbound}`,
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
      url: `/api/runs/${runId}/cancel?project=${outbound}`,
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
      url: `/api/runs/${runId}?project=${outbound}`,
      headers: { cookie: grace.cookie },
    });
    expect(foreign.statusCode).toBe(404);
  });

  /**
   * The audio on a conversation's evidence page.
   *
   * **The evidence page reads its project and the recording beside it did
   * not**, which is the hardest shape of this fault to notice: the page loads,
   * the transcript is there, the verdicts are there, and the player is simply
   * absent — which is exactly what an honest *this conversation recorded
   * nothing* looks like.
   *
   * No object store is needed to hold it. The store is consulted after the
   * conversation has been found, so the two answers are already different by
   * then: named, the route gets past the lookup and says this deployment has no
   * store; unnamed, it says there is no such conversation at all.
   */
  it("resolves a recording for a conversation in the project it named", async () => {
    const { ada, outbound, keyForOutbound } = await twoProjects(
      "browser_recording_elsewhere",
    );

    const registered = await ask(api.app, "POST", "/api/agents", keyForOutbound, {
      name: "Outbound desk",
      // Voice, because a chat has no audio and would be refused for that
      // reason instead — which is a different sentence and would not say
      // whether the conversation was found.
      connection: LIVEKIT_VOICE,
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);

    const pushed = await ask(api.app, "POST", "/api/tests", keyForOutbound, {
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expected_behaviors: ["confirms the new time back before finishing"],
    });
    const started = await ask(api.app, "POST", "/api/runs", keyForOutbound, {
      connection: (registered.body.connection as { id: string }).id,
      test_versions: [String(pushed.body.version_id)],
      idempotency_key: newId("run"),
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
      url: `/api/simulations/${conversation}/recording?project=${outbound}`,
      headers: { cookie: ada.cookie },
    });
    expect((asked.json() as { error: string }).error, asked.body).toBe(
      "no_object_store",
    );

    // And the contrast that makes the line above mean something: naming no
    // project is still the session's own, where this conversation is not.
    const unnamed = await api.app.inject({
      method: "GET",
      url: `/api/simulations/${conversation}/recording`,
      headers: { cookie: ada.cookie },
    });
    expect(unnamed.statusCode).toBe(404);
  });

  /**
   * **What an unnamed read still means, pinned rather than fixed.**
   *
   * `/runs/{runId}` is the address a terminal prints, it carries no project,
   * and it forwards by reading the run's own `project_id` — a read rather than
   * a guess, which is the right design. What the design needs and does not have
   * is a read that spans the organization: a request naming no project acts in
   * the session's own, which is the organization's first, and `getRun` narrows
   * by it. So a `results_url` for a run in any other project is answered as an
   * absence.
   *
   * It is pinned here rather than changed because widening it is a decision
   * about what an unnamed read means for **every** caller of that route. An API
   * key minted for one project must not gain a sibling by it — that asymmetry
   * is this file's own first promise — and separating a session from a key on
   * one route is a rule with reach. The developer's call; this test is here so
   * that it is made deliberately, and it fails the moment somebody makes it.
   */
  it("answers an unnamed read from the session's own project, not the organization", async () => {
    const { ada, outbound, keyForOutbound } = await twoProjects(
      "browser_unnamed_run_read",
    );

    const registered = await ask(api.app, "POST", "/api/agents", keyForOutbound, {
      name: "Outbound desk",
      connection: {
        type: "retell",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_unnamed" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
    const pushed = await ask(api.app, "POST", "/api/tests", keyForOutbound, {
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expected_behaviors: ["confirms the new time back before finishing"],
    });
    const started = await ask(api.app, "POST", "/api/runs", keyForOutbound, {
      connection: (registered.body.connection as { id: string }).id,
      test_versions: [String(pushed.body.version_id)],
      idempotency_key: newId("run"),
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    const runId = String(started.body.id);

    const unnamed = await api.app.inject({
      method: "GET",
      url: `/api/runs/${runId}`,
      headers: { cookie: ada.cookie },
    });
    expect(unnamed.statusCode).toBe(404);

    // Named, the same session reads the same run perfectly well. The project is
    // the whole of the difference.
    const named = await api.app.inject({
      method: "GET",
      url: `/api/runs/${runId}?project=${outbound}`,
      headers: { cookie: ada.cookie },
    });
    expect(named.statusCode, named.body).toBe(200);
  });

  /**
   * **Every other write a page makes, with the project named only in the
   * address.**
   *
   * The ticket wrote down that "every page in the product now names its project
   * the one way `writeJson` documents, in the address". It did not: six pages
   * were still sending it in the body through a second helper one keystroke
   * away, because six doors read only a body key. A page moved to the address
   * against one of those doors is not refused — it is **ignored**, and the
   * write lands in the session's own project, which is the organization's
   * first, with a confident 201.
   *
   * So the doors are proved here rather than the pages: one session standing in
   * the first project, authoring in the second, naming it **only** in the
   * address, every time. Each half is asserted twice — the thing is in Outbound
   * *and* the first project is still empty — because a door that ignored the
   * address would answer exactly the same status code.
   */
  it("authors a test, a grader and a run in the project its address names", async () => {
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
    const registered = await asBrowser("POST", `/api/agents?project=${outbound}`, {
      name: "Outbound desk",
      connection: {
        type: "retell",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_by_address" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const connectionId = (
      registered.json() as { connection: { id: string } }
    ).connection.id;

    /* POST /api/tests */
    const authored = await asBrowser("POST", `/api/tests?project=${outbound}`, {
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expected_behaviors: ["confirms the new time back before finishing"],
    });
    expect(authored.statusCode, authored.body).toBe(201);
    const testId = (authored.json() as { id: string }).id;

    /* PATCH /api/tests/{id} */
    const edited = await asBrowser(
      "PATCH",
      `/api/tests/${testId}?project=${outbound}`,
      { name: "Reschedules a booked appointment, politely" },
    );
    expect(edited.statusCode, edited.body).toBe(200);
    const versionId = (edited.json() as { version_id: string }).version_id;

    /* POST /api/graders */
    const used = await asBrowser("POST", `/api/graders?project=${outbound}`, {
      library_id: PREDEFINED_GRADERS.latency,
      params: { metric: "turn_response_latency", bound: 2000 },
      name: "Answers inside two seconds",
    });
    expect(used.statusCode, used.body).toBe(201);
    const graderId = (used.json() as { id: string }).id;

    /* PATCH /api/graders/{id} */
    const retuned = await asBrowser(
      "PATCH",
      `/api/graders/${graderId}?project=${outbound}`,
      { name: "Answers inside a second and a half" },
    );
    expect(retuned.statusCode, retuned.body).toBe(200);

    /* POST /api/runs */
    const started = await asBrowser("POST", `/api/runs?project=${outbound}`, {
      connection: connectionId,
      test_versions: [versionId],
      idempotency_key: newId("run"),
      label: "Started from the address",
    });
    expect(started.statusCode, started.body).toBe(201);
    expect((started.json() as { project_id: string }).project_id).toBe(outbound);

    /* Everything landed in Outbound... */
    const outboundTests = await asBrowser("GET", `/api/tests?project=${outbound}`);
    expect(
      (outboundTests.json() as { items: { name: string }[] }).items.map(
        (one) => one.name,
      ),
    ).toEqual(["Reschedules a booked appointment, politely"]);

    const outboundGraders = await asBrowser(
      "GET",
      `/api/graders?project=${outbound}`,
    );
    expect(
      (outboundGraders.json() as { items: { name: string }[] }).items.map(
        (one) => one.name,
      ),
    ).toContain("Answers inside a second and a half");

    const outboundRuns = await asBrowser("GET", `/api/runs?project=${outbound}`);
    expect(
      (outboundRuns.json() as { items: { label: string }[] }).items,
    ).toHaveLength(1);

    /* ...and nothing landed in the project the session is standing in. */
    const firstTests = await asBrowser("GET", `/api/tests?project=${ada.projectId}`);
    expect((firstTests.json() as { items: unknown[] }).items).toEqual([]);

    const firstRuns = await asBrowser("GET", `/api/runs?project=${ada.projectId}`);
    expect((firstRuns.json() as { items: unknown[] }).items).toEqual([]);

    // The seeded expected-behaviors copy and nothing else: the latency copy was
    // made in Outbound and the first project never heard about it.
    const firstGraders = await asBrowser(
      "GET",
      `/api/graders?project=${ada.projectId}`,
    );
    expect(
      (firstGraders.json() as { items: { name: string }[] }).items.map(
        (one) => one.name,
      ),
    ).toEqual(["expected_behaviors"]);

  });

  /**
   * Retry, from the same page and in the same project.
   *
   * Its own case because it is the one write on that page with a body of its
   * own — an idempotency key — so the project rides beside something rather
   * than alone, which is exactly the shape that got it typed into the query.
   */
  it("retries a run that is in the project it named", async () => {
    const { ada, outbound, keyForOutbound } = await twoProjects(
      "browser_retry_elsewhere",
    );

    const registered = await ask(api.app, "POST", "/api/agents", keyForOutbound, {
      name: "Outbound desk",
      connection: {
        type: "retell",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_retry" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);

    const pushed = await ask(api.app, "POST", "/api/tests", keyForOutbound, {
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expected_behaviors: ["confirms the new time back before finishing"],
    });
    const started = await ask(api.app, "POST", "/api/runs", keyForOutbound, {
      connection: (registered.body.connection as { id: string }).id,
      test_versions: [String(pushed.body.version_id)],
      idempotency_key: newId("run"),
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

    const again = await api.app.inject({
      method: "POST",
      url: `/api/runs/${String(started.body.id)}/retry`,
      headers: { cookie: ada.cookie },
      payload: { project: outbound, idempotency_key: newId("run") },
    });
    expect(again.statusCode, again.body).toBe(201);
    expect((again.json() as { retry_of_run_id: string }).retry_of_run_id).toBe(
      String(started.body.id),
    );

    // **And in the address, which is the other honest spelling.** A terminal
    // posts the project in the body beside everything else it is sending; a
    // page appends it to the address, the way every read in this group is
    // asked. Reading only one of the two is not strictness — it is a silent
    // fall back to the session's own project, which is the organization's
    // first, and the answer is a confident 201 about the wrong place.
    const byAddress = await api.app.inject({
      method: "POST",
      url: `/api/runs/${String(started.body.id)}/retry?project=${outbound}`,
      headers: { cookie: ada.cookie },
      payload: { idempotency_key: newId("run") },
    });
    expect(byAddress.statusCode, byAddress.body).toBe(201);
    expect((byAddress.json() as { project_id: string }).project_id).toBe(
      outbound,
    );
  });
});

/**
 * The other half of the same rule, and the half nothing in this repository
 * could see.
 *
 * A key minted for the **whole organization** names no project, and reading
 * across a whole customer is what such a key is for — the agents group says so
 * in as many words: *"Nothing, unless it named a project — reading across a
 * whole customer is the first-class case."* `inActingProject` is where that
 * lives: a context with no project narrows by nothing, and the organization
 * predicate still holds.
 *
 * **Every other API test in this repository signs up one organization holding
 * one project.** In such an organization a route that resolves an absent
 * project to "the organization's single project" answers exactly as a route
 * that narrows by nothing does, so the two are indistinguishable and the wrong
 * one is invisible. It takes a *second* project for them to differ — and then
 * the difference is not a narrowing at all. It is `NAME_THE_PROJECT`, an
 * outright 400, on four routes addressed by an id a terminal already holds.
 *
 * The four are here together because they are one journey a terminal makes:
 * read the run, follow it, stop it, and fetch the audio of a conversation in
 * it. None of them needs a project to answer — the id is unique in the
 * organization and the project is only a filter — which is exactly why the
 * credential's own reach is the right answer for all four.
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
    api = await createApi(label);
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    // Through the product's own door, so the second project is the whole thing
    // — default persona and seeded grader included — rather than a bare row.
    const made = await api.app.inject({
      method: "POST",
      url: "/api/projects",
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

    const registered = await ask(api.app, "POST", "/api/agents", keyForOutbound, {
      name: "Outbound desk",
      connection:
        modality === "voice"
          ? LIVEKIT_VOICE
          : {
              type: "retell",
              modality: "chat",
              config: { retellAgentId: `agent_in_retell_${label}` },
              credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
            },
    });
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);

    const pushed = await ask(api.app, "POST", "/api/tests", keyForOutbound, {
      name: "Reschedules a booked appointment",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expected_behaviors: ["confirms the new time back before finishing"],
    });
    expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

    const started = await ask(api.app, "POST", "/api/runs", keyForOutbound, {
      connection: (registered.body.connection as { id: string }).id,
      test_versions: [String(pushed.body.version_id)],
      idempotency_key: newId("run"),
      label: "The first run in Outbound",
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
   * but a refusal telling a terminal to name a project it has no reason to
   * know. `egma run` prints a `results_url` and nothing else.
   */
  it("reads, follows and cancels a run in the second project without naming one", async () => {
    const { ada, runId } = await aRunInTheSecondProject(
      "orgwide_key_run_elsewhere",
      "chat",
    );
    const asTheOrganization = { authorization: `Bearer ${ada.secret}` };

    const read = await api.app.inject({
      method: "GET",
      url: `/api/runs/${runId}`,
      headers: asTheOrganization,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect((read.json() as { label: string }).label).toBe(
      "The first run in Outbound",
    );

    const followed = await api.app.inject({
      method: "GET",
      url: `/api/runs/${runId}/events?after=0`,
      headers: asTheOrganization,
    });
    expect(followed.statusCode, followed.body).toBe(200);

    const stopped = await api.app.inject({
      method: "POST",
      url: `/api/runs/${runId}/cancel`,
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
      url: `/api/simulations/${conversation}/recording`,
      headers: { authorization: `Bearer ${ada.secret}` },
    });
    expect(asked.statusCode, asked.body).toBe(503);
    expect((asked.json() as { error: string }).error).toBe("no_object_store");

    /*
      The conversation itself, which is the other door the same page opens.

      This is the one the recording's own fix walked past: the evidence page
      asks for the transcript and the audio together, so a key that could fetch
      the audio and not the transcript made one page answer one question two
      ways. Asserted here rather than in a case of its own, because "the same
      page, both doors, one credential" is the claim — and two cases could drift
      until only one of them was moved, which is exactly what happened.
    */
    const conversationRead = await api.app.inject({
      method: "GET",
      url: `/api/simulations/${conversation}`,
      headers: { authorization: `Bearer ${ada.secret}` },
    });
    expect(conversationRead.statusCode, conversationRead.body).toBe(200);
    expect((conversationRead.json() as { id: string }).id).toBe(conversation);
  });
});
