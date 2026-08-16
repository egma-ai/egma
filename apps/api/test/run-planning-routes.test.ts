import {
  createPersona,
  PREDEFINED_GRADERS,
  refreshConnectionCapabilities,
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
 * Planning a run, starting it safely, and taking a judge credential out of use
 * — over real HTTP against a real Postgres.
 *
 * What is asserted here is what a client observes: the shape of the plan, every
 * refusal sentence word for word, and the three promises the surface rests on.
 *
 * **The review and the start agree, because they are one resolution.** What
 * `GET /api/run-plan` says would be pinned and skipped is what `POST /api/runs`
 * writes, and this file checks the two against each other rather than checking
 * each against a hand-written expectation.
 *
 * **A start is idempotent under a key the client chose.** The same key and the
 * same body answers the run that already exists; the same key and a different
 * body is refused out loud, because telling somebody their new selection had
 * started when it had not is the one failure the key exists to prevent.
 *
 * **A credential nothing needs is archivable, and one something needs is not.**
 * The refusal names every blocking use, because the fix for each is somewhere
 * different.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

function request(
  method: "GET" | "POST",
  url: string,
  key: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  return ask(api.app, method, url, key, payload);
}

const RETELL = {
  type: "retell",
  modality: "chat",
  config: { retellAgentId: "agent_in_retell_1" },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
} as const;

/** Somebody with an agent to check and two tests to check it with. */
async function aCustomerReadyToPlan(
  label: string,
  options: { readonly defaultJudge?: null } = {},
): Promise<{
  readonly ada: Customer;
  readonly key: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly plain: string;
  readonly needsAudio: string;
}> {
  api = await createApi(
    label,
    options.defaultJudge === null ? { defaultJudge: null } : {},
  );
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const registered = await request("POST", "/api/agents", key, {
    name: "Front desk",
    connection: RETELL,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const agentId = String((registered.body.agent as { id: string }).id);
  const connectionId = String(
    (registered.body.connection as { id: string }).id,
  );

  await createPersona(contextFor(ada, "member"), {
    name: "Impatient Rita",
    traits: NEUTRAL_TRAITS,
  });

  const push = async (
    name: string,
    requiredCapabilities: readonly string[],
  ): Promise<string> => {
    const created = await request("POST", "/api/tests", key, {
      name,
      scenario:
        "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
      expected_behaviors: ["confirms the new time back before finishing"],
      personas: ["Impatient Rita"],
      required_capabilities: [...requiredCapabilities],
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    return String(created.body.version_id);
  };

  return {
    ada,
    key,
    agentId,
    connectionId,
    plain: await push("Reschedules", []),
    needsAudio: await push("Hears the hold music", ["raw_audio"]),
  };
}

function planQuery(
  agentId: string,
  connectionId: string,
  versions: readonly string[],
): string {
  const asked = new URLSearchParams();
  asked.set("agent", agentId);
  asked.set("connection", connectionId);
  asked.set("test_versions", versions.join(","));
  return `/api/run-plan?${asked.toString()}`;
}

describe("reading what a run would freeze", () => {
  it("names the versions, the personas and every grader, and carries no key", async () => {
    const { key, agentId, connectionId, plain } =
      await aCustomerReadyToPlan("run_plan_shape");

    const plan = await request(
      "GET",
      planQuery(agentId, connectionId, [plain]),
      key,
    );

    expect(plan.statusCode, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body).toMatchObject({
      agent_id: agentId,
      connection_id: connectionId,
      runnable_simulation_count: 1,
      skipped_simulation_count: 0,
    });

    const [test] = plan.body.tests as Record<string, unknown>[];
    expect(test?.test_version_id).toBe(plain);
    expect(
      (test?.personas as { name: string }[])[0]?.name,
    ).toBe("Impatient Rita");
    expect(test?.skip).toBeNull();

    // The seeded expected-behaviors copy is in every group, because applying
    // it is part of what running a test means. It is a running copy pointing at
    // a predefined library entry, so it is found by the entry it points at
    // rather than by a reserved key of its own.
    const graders = test?.graders as Record<string, unknown>[];
    const behaviors = graders.find(
      (one) => one.library_id === PREDEFINED_GRADERS.expectedBehaviors,
    );
    expect(behaviors?.kind).toBe("authored");
    expect(behaviors?.required).toBe(true);
    expect(behaviors?.judge).toMatchObject({ tag: "configured" });

    // A judge choice names a reference and never a secret, and the whole answer
    // is checked as bytes rather than field by field.
    expect(JSON.stringify(plan.body)).not.toContain("sk-");
  });

  it("says which conversations would be skipped, and why, without refusing", async () => {
    const { ada, key, agentId, connectionId, plain, needsAudio } =
      await aCustomerReadyToPlan("run_plan_skip");

    // Measured: a chat connection carries no audio, and the adapter says so.
    await refreshConnectionCapabilities(
      contextFor(ada, "member"),
      agentId,
      connectionId,
    );

    const plan = await request(
      "GET",
      planQuery(agentId, connectionId, [plain, needsAudio]),
      key,
    );

    expect(plan.statusCode, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body).toMatchObject({
      runnable_simulation_count: 1,
      skipped_simulation_count: 1,
    });
    const tests = plan.body.tests as Record<string, unknown>[];
    expect(tests[0]?.skip).toBeNull();
    expect(tests[1]?.skip).toEqual({
      reason: "required_capability_unsupported",
      capabilities: ["raw_audio"],
    });
  });

  it("tells an unmeasured connection from a measured one", async () => {
    const { key, agentId, connectionId, needsAudio } =
      await aCustomerReadyToPlan("run_plan_unmeasured");

    // No refresh: nobody has looked, which is a different answer from looking
    // and finding nothing, and has a different fix.
    const plan = await request(
      "GET",
      planQuery(agentId, connectionId, [needsAudio]),
      key,
    );

    expect(plan.statusCode).toBe(200);
    expect(plan.body.connection).toMatchObject({
      capabilities: { state: "unknown" },
    });
    expect((plan.body.tests as Record<string, unknown>[])[0]?.skip).toEqual({
      reason: "required_capability_unknown",
      capabilities: ["raw_audio"],
    });
  });

  it("says a project has no judge rather than refusing, so a page can draw it", async () => {
    const { key, agentId, connectionId, plain } = await aCustomerReadyToPlan(
      "run_plan_needs_setup",
      { defaultJudge: null },
    );

    const plan = await request(
      "GET",
      planQuery(agentId, connectionId, [plain]),
      key,
    );

    expect(plan.statusCode).toBe(200);
    expect(plan.body.judge).toEqual({ state: "needs_setup" });
  });

  it("refuses a test that does not apply to the agent, in the contract's own sentence", async () => {
    const { key, agentId, connectionId, plain } = await aCustomerReadyToPlan(
      "run_plan_not_applicable",
    );

    const second = await request("POST", "/api/agents", key, {
      name: "Night desk",
      connection: {
        ...RETELL,
        config: { retellAgentId: "agent_in_retell_2" },
      },
    });
    const otherAgent = (second.body.agent as { id: string }).id;
    const otherConnection = (second.body.connection as { id: string }).id;

    // Take the test off the second agent, so the pair is genuinely unlinked.
    const version = await request("GET", `/api/test-versions/${plain}`, key);
    await request(
      "POST",
      `/api/tests/${String(version.body.test_id)}/agents`,
      key,
      { agents: [agentId] },
    );

    const refused = await request(
      "GET",
      planQuery(otherAgent, otherConnection, [plain]),
      key,
    );

    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toBe("test_not_applicable");
    expect(String(refused.body.message)).toContain(
      `does not apply to agent ${otherAgent}`,
    );
    expect(connectionId).not.toBe(otherConnection);
  });
});

describe("starting a run safely", () => {
  it("refuses a start that named no idempotency key, in the contract's exact words", async () => {
    const { key, agentId, connectionId, plain } = await aCustomerReadyToPlan(
      "run_start_no_key",
    );

    const refused = await request("POST", "/api/runs", key, {
      agent: agentId,
      connection: connectionId,
      test_versions: [plain],
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        "Starting a run requires an idempotency key. Send one stable key " +
        "for this start action and try again.",
    });

    const { rows } = await api.database.sql("select id from run");
    expect(rows).toEqual([]);
  });

  it("answers the original run when the same key and body arrive again", async () => {
    const { key, agentId, connectionId, plain } = await aCustomerReadyToPlan(
      "run_start_same_key",
    );
    const body = {
      agent: agentId,
      connection: connectionId,
      test_versions: [plain],
      idempotency_key: "the-terminal-said-this-once",
    };

    const first = await request("POST", "/api/runs", key, body);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    const again = await request("POST", "/api/runs", key, body);

    expect(again.statusCode).toBe(201);
    expect(again.body.id).toBe(first.body.id);

    const { rows } = await api.database.sql("select id from run");
    expect(rows).toHaveLength(1);
  });

  it("refuses the same key over a different selection, in the contract's exact words", async () => {
    const { key, agentId, connectionId, plain, needsAudio } =
      await aCustomerReadyToPlan("run_start_key_conflict");
    const idempotencyKey = "the-terminal-said-this-once";

    const first = await request("POST", "/api/runs", key, {
      agent: agentId,
      connection: connectionId,
      test_versions: [plain],
      idempotency_key: idempotencyKey,
    });
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);

    const refused = await request("POST", "/api/runs", key, {
      agent: agentId,
      connection: connectionId,
      test_versions: [plain, needsAudio],
      idempotency_key: idempotencyKey,
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "idempotency_conflict",
      message:
        `Idempotency key ${idempotencyKey} already started a different run. ` +
        "Reuse the original request, or send a new key for this run.",
    });

    const { rows } = await api.database.sql("select id from run");
    expect(rows).toHaveLength(1);
  });

  it("refuses a project with no judge before anything is dialed, in the contract's exact words", async () => {
    const { ada, key, agentId, connectionId, plain } =
      await aCustomerReadyToPlan("run_start_no_judge", { defaultJudge: null });

    const refused = await request("POST", "/api/runs", key, {
      agent: agentId,
      connection: connectionId,
      test_versions: [plain],
      idempotency_key: newId("run"),
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "judge_not_configured",
      message:
        `This run needs an LLM judge, but project ${ada.projectId} has no ` +
        "judge configured. Open project Settings, configure the judge, and " +
        "start the run again.",
    });

    const { rows } = await api.database.sql("select id from run");
    expect(rows).toEqual([]);
  });

  it("writes exactly the skips the review promised, and completes an all-skipped run", async () => {
    const { ada, key, agentId, connectionId, needsAudio } =
      await aCustomerReadyToPlan("run_start_all_skipped");
    await refreshConnectionCapabilities(
      contextFor(ada, "member"),
      agentId,
      connectionId,
    );

    const plan = await request(
      "GET",
      planQuery(agentId, connectionId, [needsAudio]),
      key,
    );
    expect(plan.body).toMatchObject({
      runnable_simulation_count: 0,
      skipped_simulation_count: 1,
    });

    const started = await request("POST", "/api/runs", key, {
      agent: agentId,
      connection: connectionId,
      test_versions: [needsAudio],
      idempotency_key: newId("run"),
    });

    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({
      status: "completed",
      completed_count: 0,
      failed_count: 0,
      canceled_count: 0,
      skipped_count: 1,
      // A run that conducted nothing completes with no passing headline. The
      // word is `skipped`, which is precisely what happened.
      verdict: "skipped",
    });
    const [only] = started.body.simulations as Record<string, unknown>[];
    expect(only?.status).toBe("skipped");
    expect(only?.skip_reason).toBe("required_capability_unsupported");
    expect(only?.skipped_capabilities).toEqual(["raw_audio"]);
    /*
     * **No grader row is invented, and the verdict still says what happened.**
     * `counts` is null because nothing was judged, and the verdict is `skipped`
     * rather than null because nobody ever will: a null here would sit on a
     * finished run reading "awaiting grading" forever, waiting on work that was
     * deliberately never filed. What must never appear is `failed` — egma
     * declined to conduct this conversation, and nothing about the agent is
     * being said.
     */
    expect(only?.verdict).toBe("skipped");
    expect(only?.counts).toBeNull();
    // And no grading job was ever filed for it, so grading is not pending.
    expect(only?.grading).toBe("not_required");
  });

  it("lets a viewer read the plan and refuses their start", async () => {
    const { ada, key, agentId, connectionId, plain } =
      await aCustomerReadyToPlan("run_start_viewer");

    const viewer = await colleagueOf(
      api.app,
      ada,
      "quinn@acme.example",
      "viewer",
    );
    const viewerKey = await projectKeyFor(api.app, viewer);

    const plan = await request(
      "GET",
      planQuery(agentId, connectionId, [plain]),
      viewerKey,
    );
    expect(plan.statusCode, JSON.stringify(plan.body)).toBe(200);

    const refused = await request("POST", "/api/runs", viewerKey, {
      agent: agentId,
      connection: connectionId,
      test_versions: [plain],
      idempotency_key: newId("run"),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.body.error).toBe("not_permitted");

    // And nothing was written by the refused request, whatever the page showed.
    const started = await request("POST", "/api/runs", key, {
      agent: agentId,
      connection: connectionId,
      test_versions: [plain],
      idempotency_key: newId("run"),
    });
    expect(started.statusCode).toBe(201);
    const { rows } = await api.database.sql("select id from run");
    expect(rows).toHaveLength(1);
  });
});

describe("taking a judge credential out of use", () => {
  /** A credential, and the project pointed at it. */
  async function aCredential(
    ada: Customer,
    label: string,
    secret: string,
  ): Promise<string> {
    const created = await api.app.inject({
      method: "POST",
      url: "/api/judge-credentials",
      headers: { cookie: ada.cookie },
      payload: { label, provider: "openai", key: secret },
    });
    expect(created.statusCode, created.body).toBe(201);
    return String((created.json() as { id: string }).id);
  }

  it("refuses while a project points at it, and names the project", async () => {
    const { ada } = await aCustomerReadyToPlan("credential_in_use_project");
    const credentialId = await aCredential(
      ada,
      "The team's key",
      "sk-a-real-looking-openai-key-0001",
    );

    const pointed = await api.app.inject({
      method: "PUT",
      url: "/api/judge",
      headers: { cookie: ada.cookie },
      payload: {
        project: ada.projectId,
        provider: "openai",
        model: "gpt-4.1-mini",
        source: credentialId,
      },
    });
    expect(pointed.statusCode, pointed.body).toBe(200);

    const refused = await api.app.inject({
      method: "POST",
      url: `/api/judge-credentials/${credentialId}/archive`,
      headers: { cookie: ada.cookie },
      payload: {},
    });

    expect(refused.statusCode).toBe(409);
    const body = refused.json() as { error: string; message: string };
    expect(body.error).toBe("judge_credential_in_use");
    expect(body.message).toBe(
      `Judge credential ${credentialId} is used by project ${ada.projectId}. ` +
        "Point those projects at another credential and let pending grading " +
        "finish, then archive this credential.",
    );
  });

  it("succeeds once nothing needs it, and stops offering it", async () => {
    const { ada } = await aCustomerReadyToPlan("credential_archive");
    const credentialId = await aCredential(
      ada,
      "Nothing needs it",
      "sk-a-real-looking-openai-key-0002",
    );

    const archived = await api.app.inject({
      method: "POST",
      url: `/api/judge-credentials/${credentialId}/archive`,
      headers: { cookie: ada.cookie },
      payload: {},
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const listed = await api.app.inject({
      method: "GET",
      url: "/api/judge-credentials",
      headers: { cookie: ada.cookie },
    });
    const items = (listed.json() as { items: { id: string }[] }).items;
    expect(items.map((one) => one.id)).not.toContain(credentialId);
  });

  it("refuses anybody but an admin", async () => {
    const { ada } = await aCustomerReadyToPlan("credential_archive_role");
    const credentialId = await aCredential(
      ada,
      "Not a member's to remove",
      "sk-a-real-looking-openai-key-0003",
    );
    const member = await colleagueOf(
      api.app,
      ada,
      "quinn@acme.example",
      "member",
    );

    const refused = await api.app.inject({
      method: "POST",
      url: `/api/judge-credentials/${credentialId}/archive`,
      headers: { cookie: member.cookie },
      payload: {},
    });

    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { error: string }).error).toBe("not_permitted");
  });
});
