import {
  archiveAgent,
  archiveConnection,
  claimSimulations,
  completeSimulation,
  createPersona,
  failSimulation,
  markSimulationCanceled,
  PREDEFINED_GRADERS,
  startSimulation,
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
 * Reading a project's run history over real HTTP, and the two controls on one
 * run.
 *
 * **What is asserted here is what a page observes**, because a page is the
 * caller: the four facts arriving apart on every row and on the detail; the
 * filters narrowing on the server rather than in a browser; and Retry deriving
 * a new run from an old one or refusing by name, word for word.
 *
 * Conversations are moved through the same exported functions a simulator would
 * call, because no simulator exists in this suite. Anything else would be a test
 * of a fake feed.
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

const PHONE = {
  type: "phone",
  modality: "voice",
  config: { phoneNumber: "+15551234567" },
} as const;

const PHONE_IS_SET_UP = {
  carrier_trunk_address: "egma-simulator-106e37f8.pstn.twilio.com",
  carrier_trunk_number: "+18885550123",
} as const;

const CLAIMANT = "simulator-blue-1";

async function claimOwn(runId: string): Promise<readonly SimulationClaim[]> {
  const claimed = await claimSimulations({ claimant: CLAIMANT, capacity: 50 });
  return claimed.filter((claim) => claim.runId === runId);
}

type Ready = {
  readonly ada: Customer;
  readonly key: string;
  readonly agentId: string;
  readonly connectionId: string;
  /** A test and the frozen version a run pins, for each of two tests. */
  readonly reschedules: { testId: string; versionId: string };
  readonly cancels: { testId: string; versionId: string };
  /** A version whose requirement this connection has never been measured for. */
  readonly needsAudio: { testId: string; versionId: string };
};

async function aCustomerWithRuns(
  label: string,
  options: {
    readonly connection?: Record<string, unknown>;
    readonly phoneIsSetUp?: boolean;
  } = {},
): Promise<Ready> {
  api = await createApi(
    label,
    options.phoneIsSetUp === true
      ? { platformSettings: PHONE_IS_SET_UP }
      : {},
  );
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const registered = await request("POST", "/api/agents", key, {
    name: "Front desk",
    connection: options.connection ?? RETELL,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const agentId = String((registered.body.agent as { id: string }).id);
  const connectionId = String((registered.body.connection as { id: string }).id);

  for (const name of ["Impatient Rita", "Deliberate Sam"]) {
    await createPersona(contextFor(ada, "member"), {
      name,
      traits: NEUTRAL_TRAITS,
    });
  }

  const push = async (
    name: string,
    personas: readonly string[],
    extra: Record<string, unknown> = {},
  ): Promise<{ testId: string; versionId: string }> => {
    const created = await request("POST", "/api/tests", key, {
      name,
      scenario:
        "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
      expected_behaviors: ["confirms the new time back before finishing"],
      personas: [...personas],
      ...extra,
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    return {
      testId: String(created.body.id),
      versionId: String(created.body.version_id),
    };
  };

  return {
    ada,
    key,
    agentId,
    connectionId,
    reschedules: await push("Reschedules", ["Impatient Rita"]),
    cancels: await push("Cancels", ["Impatient Rita", "Deliberate Sam"]),
    needsAudio: await push("Reads a card number back", ["Impatient Rita"], {
      required_capabilities: ["raw_audio"],
    }),
  };
}

async function startRunOver(
  ready: Ready,
  versionIds: readonly string[],
  label?: string,
): Promise<string> {
  const started = await request("POST", "/api/runs", ready.key, {
    agent: ready.agentId,
    connection: ready.connectionId,
    test_versions: [...versionIds],
    idempotency_key: newId("run"),
    ...(label === undefined ? {} : { label }),
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  return String(started.body.id);
}

/* ------------------------------------------------------------------------ */

describe("the run history", () => {
  it("answers a project's runs newest first, and pages by the run id", async () => {
    const ready = await aCustomerWithRuns("run_history_paging");
    const first = await startRunOver(ready, [ready.reschedules.versionId]);
    const second = await startRunOver(ready, [ready.reschedules.versionId]);

    const page = await request("GET", "/api/runs?limit=1", ready.key);
    expect(page.statusCode, JSON.stringify(page.body)).toBe(200);
    const items = page.body.items as Record<string, unknown>[];
    expect(items.map((one) => one.id)).toEqual([second]);
    expect(page.body.next_cursor).toBe(second);

    const next = await request(
      "GET",
      `/api/runs?limit=1&cursor=${String(page.body.next_cursor)}`,
      ready.key,
    );
    expect((next.body.items as Record<string, unknown>[]).map((one) => one.id)).toEqual([
      first,
    ]);
  });

  /**
   * The heart of the ticket, over the wire.
   *
   * Four endings in one run, and every one of them read as itself. A page that
   * collapsed any pair of these would tell somebody their agent is broken when
   * egma is, or that something failed when nobody has looked.
   */
  it("keeps run status, conversation status, grading state and verdict apart", async () => {
    const ready = await aCustomerWithRuns("run_history_four_facts");
    const auth = contextFor(ready.ada, "member");
    const runId = await startRunOver(ready, [
      ready.reschedules.versionId,
      ready.needsAudio.versionId,
    ]);

    // Two conversations, and only one of them is claimable: the other requires
    // something nobody has measured this connection for, so it was written off
    // before it began and never enters the queue.
    const claims = await claimOwn(runId);
    expect(claims).toHaveLength(1);
    const [only] = claims;
    if (only === undefined) throw new Error("the run should hand out one");
    await failSimulation(auth, only.id, CLAIMANT, { reason: "not_answered" });

    const read = await request("GET", `/api/runs/${runId}`, ready.key);
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);

    // The machinery finished. Nothing about the agent was established.
    expect(read.body).toMatchObject({
      status: "completed",
      failed_count: 1,
      skipped_count: 1,
      completed_count: 0,
      canceled_count: 0,
    });
    expect(read.body.simulation_counts).toMatchObject({ failed: 1, skipped: 1 });

    const simulations = read.body.simulations as Record<string, unknown>[];
    const failed = simulations.find((one) => one.status === "failed");
    const skipped = simulations.find((one) => one.status === "skipped");

    // Egma tried and could not: `errored`, never `failed`.
    expect(failed?.verdict).toBe("errored");
    expect(failed?.reason).toBe("not_answered");
    // Egma declined to try: `skipped`, no grading work, and a named reason.
    expect(skipped?.verdict).toBe("skipped");
    expect(skipped?.grading).toBe("not_required");
    expect(skipped?.skip_reason).toBe("required_capability_unknown");
    expect(skipped?.skipped_capabilities).toEqual(["raw_audio"]);

    // And the run's own verdict is neither of those words and is not `failed`.
    expect(read.body.verdict).toBe("errored");

    // The row that opens this page says exactly the same.
    const list = await request("GET", "/api/runs", ready.key);
    const row = (list.body.items as Record<string, unknown>[]).find(
      (one) => one.id === runId,
    );
    expect(row).toMatchObject({
      status: "completed",
      verdict: "errored",
      simulation_counts: { failed: 1, skipped: 1 },
    });
  });

  it("says nothing at all about a run nobody has judged yet", async () => {
    const ready = await aCustomerWithRuns("run_history_pending");
    const runId = await startRunOver(ready, [ready.reschedules.versionId]);

    const list = await request("GET", "/api/runs", ready.key);
    const row = (list.body.items as Record<string, unknown>[]).find(
      (one) => one.id === runId,
    );
    // Pending grading is not a failure and is not a pass. It is nothing yet.
    expect(row?.verdict).toBeNull();
    expect(row?.graded_count).toBe(0);
    expect(row?.status).toBe("pending");
  });

  it("narrows on the server by agent, connection, test, status and date", async () => {
    const ready = await aCustomerWithRuns("run_history_filters");
    const onReschedules = await startRunOver(ready, [
      ready.reschedules.versionId,
    ]);
    const onCancels = await startRunOver(ready, [ready.cancels.versionId]);

    const ids = async (query: string): Promise<string[]> => {
      const page = await request("GET", `/api/runs?${query}`, ready.key);
      expect(page.statusCode, JSON.stringify(page.body)).toBe(200);
      return (page.body.items as Record<string, unknown>[]).map((one) =>
        String(one.id),
      );
    };

    expect(await ids(`agent=${ready.agentId}`)).toContain(onReschedules);
    expect(await ids(`connection=${ready.connectionId}`)).toContain(onCancels);
    expect(await ids(`test=${ready.cancels.testId}`)).toEqual([onCancels]);
    expect(await ids("status=pending")).toContain(onReschedules);
    expect(await ids("status=canceled")).toEqual([]);
    expect(await ids("since=2999-01-01T00:00:00.000Z")).toEqual([]);
  });

  /**
   * A filter that was silently dropped leaves somebody reading an answer as
   * though it had applied, so each one is refused by name with the list.
   */
  it("refuses a filter it cannot read rather than ignoring it", async () => {
    const ready = await aCustomerWithRuns("run_history_bad_filters");

    const bad = async (query: string): Promise<Answer> =>
      request("GET", `/api/runs?${query}`, ready.key);

    const agent = await bad("agent=tst_not_an_agent");
    expect(agent.statusCode).toBe(400);
    expect(String(agent.body.message)).toContain("is not a agent id");

    const status = await bad("status=finished");
    expect(status.statusCode).toBe(400);
    expect(String(status.body.message)).toContain("pending, running, completed, canceled");

    const verdict = await bad("verdict=green");
    expect(verdict.statusCode).toBe(400);
    expect(String(verdict.body.message)).toContain(
      "passed, failed, skipped, errored",
    );

    const since = await bad("since=last%20tuesday");
    expect(since.statusCode).toBe(400);
    expect(String(since.body.message)).toContain("RFC 3339");

    const cursor = await bad("cursor=not-a-run");
    expect(cursor.statusCode).toBe(422);
    expect(cursor.body.error).toBe("invalid_cursor");
  });

  it("shows a viewer everything and another customer nothing", async () => {
    const ready = await aCustomerWithRuns("run_history_roles");
    const runId = await startRunOver(ready, [ready.reschedules.versionId]);

    const quentin = await colleagueOf(
      api.app,
      ready.ada,
      "quentin@acme.example",
      "viewer",
    );
    const seen = await request("GET", "/api/runs", quentin.secret);
    expect(seen.statusCode).toBe(200);
    expect(
      (seen.body.items as Record<string, unknown>[]).map((one) => one.id),
    ).toContain(runId);

    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const theirs = await request("GET", "/api/runs", grace.secret);
    expect(theirs.statusCode).toBe(200);
    expect(theirs.body.items).toEqual([]);
  });
});

describe("one run, read whole", () => {
  it("names its pins, its plan, its snapshots and the identities it ran against", async () => {
    const ready = await aCustomerWithRuns("run_history_detail");
    const runId = await startRunOver(
      ready,
      [ready.reschedules.versionId],
      "Nightly smoke",
    );

    const read = await request("GET", `/api/runs/${runId}`, ready.key);
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);

    expect(read.body.test_versions).toEqual([ready.reschedules.versionId]);
    expect(read.body.connection_snapshot).toMatchObject({
      type: "retell",
      modality: "chat",
    });
    // Nothing a credential could ride in, and there never will be.
    expect(JSON.stringify(read.body.connection_snapshot)).not.toContain(
      "retell-secret",
    );
    expect(read.body.mock_tools).toMatchObject({ defaults: [], overrides: {} });
    expect(read.body.agent).toMatchObject({ name: "Front desk", archived: false });
    expect(read.body.connection).toMatchObject({ archived: false });
    expect(read.body.retry_of_run_id).toBeNull();

    const plan = read.body.grading_plan as Record<string, unknown>;
    expect(plan.state).toBe("run_start");
    expect(plan.captured_at).not.toBeNull();
    const groups = plan.groups as Record<string, unknown>[];
    expect(groups[0]).toMatchObject({
      tag: "version",
      test_version_id: ready.reschedules.versionId,
    });
    const items = groups[0]?.items as Record<string, unknown>[];
    // The expected-behaviors grader is a running copy of a predefined library
    // entry, seeded into every project — so it is in the plan as an ordinary
    // item with an id of its own, not as a rowless `built_in` sentinel.
    expect(items.some((one) => one.kind === "authored")).toBe(true);
    expect(
      items.some((one) => one.library_id === PREDEFINED_GRADERS.expectedBehaviors),
    ).toBe(true);
    // A plan names a credential reference and never a key.
    expect(JSON.stringify(plan)).not.toContain("sk-");
  });

  /**
   * Archiving stops new work. It must never make old evidence unreadable — a run
   * that cannot name what it went over is a run nobody can interpret.
   */
  it("stays readable after the agent and the connection are archived", async () => {
    const ready = await aCustomerWithRuns("run_history_archived");
    const auth = contextFor(ready.ada, "member");
    const runId = await startRunOver(ready, [ready.reschedules.versionId]);

    await archiveConnection(auth, ready.agentId, ready.connectionId);
    await archiveAgent(auth, ready.agentId);

    const read = await request("GET", `/api/runs/${runId}`, ready.key);
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
    expect(read.body.agent).toMatchObject({ name: "Front desk", archived: true });
    expect(read.body.connection).toMatchObject({ archived: true });
    expect(read.body.test_versions).toEqual([ready.reschedules.versionId]);
    // Archiving what a run went over cancels the run rather than deleting it.
    expect(read.body.status).toBe("canceled");
  });
});

describe("retrying a run", () => {
  it("derives the new run from the old one and links back to it", async () => {
    const ready = await aCustomerWithRuns("run_history_retry");
    const earlier = await startRunOver(
      ready,
      [ready.reschedules.versionId],
      "Nightly smoke",
    );

    const again = await request("POST", `/api/runs/${earlier}/retry`, ready.key, {
      idempotency_key: newId("run"),
    });
    expect(again.statusCode, JSON.stringify(again.body)).toBe(201);
    expect(again.body.id).not.toBe(earlier);
    expect(again.body.retry_of_run_id).toBe(earlier);
    expect(again.body.agent_id).toBe(ready.agentId);
    expect(again.body.connection_id).toBe(ready.connectionId);
    expect(again.body.test_versions).toEqual([ready.reschedules.versionId]);

    // The earlier run is not reopened and not changed.
    const before = await request("GET", `/api/runs/${earlier}`, ready.key);
    expect(before.body.status).toBe("pending");
    expect(before.body.retry_of_run_id).toBeNull();
  });

  /**
   * **The link is server-derived or it is worthless.** A create body that could
   * set it would let a client claim a run retries something it never executed,
   * and every comparison drawn from the link afterwards would be about two
   * unrelated runs.
   */
  it("cannot be set through the normal create body, whatever a client sends", async () => {
    const ready = await aCustomerWithRuns("run_history_retry_body");
    const earlier = await startRunOver(ready, [ready.reschedules.versionId]);

    const started = await request("POST", "/api/runs", ready.key, {
      agent: ready.agentId,
      connection: ready.connectionId,
      test_versions: [ready.reschedules.versionId],
      idempotency_key: newId("run"),
      retry_of_run_id: earlier,
      retry_of: earlier,
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    expect(started.body.retry_of_run_id).toBeNull();
  });

  it("refuses rather than substituting when the connection is no longer active", async () => {
    const ready = await aCustomerWithRuns("run_history_retry_refused");
    const auth = contextFor(ready.ada, "member");
    const earlier = await startRunOver(ready, [ready.reschedules.versionId]);

    await archiveConnection(auth, ready.agentId, ready.connectionId);

    const refused = await request(
      "POST",
      `/api/runs/${earlier}/retry`,
      ready.key,
      { idempotency_key: newId("run") },
    );
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toBe("retry_unavailable");
    expect(refused.body.message).toBe(
      `Run ${earlier} cannot be retried because connection ${ready.connectionId} ` +
        `is not active or no longer applies. Open the run builder and choose ` +
        `active resources; the original run was not changed.`,
    );

    // Nothing was started. The refusal is the whole of what happened.
    const list = await request("GET", "/api/runs", ready.key);
    const retries = (list.body.items as Record<string, unknown>[]).filter(
      (one) => one.retry_of_run_id !== null,
    );
    expect(retries).toEqual([]);
  });

  it("refuses rather than substituting when the test no longer applies to the agent", async () => {
    const ready = await aCustomerWithRuns("run_history_retry_link");
    const earlier = await startRunOver(ready, [ready.cancels.versionId]);

    // A second agent to hold the link, so the test keeps one and the only thing
    // that changed is the pairing this run used.
    const elsewhere = await request("POST", "/api/agents", ready.key, {
      name: "Somewhere else",
    });
    const other = String((elsewhere.body.agent as { id: string }).id);
    const relinked = await request(
      "POST",
      `/api/tests/${ready.cancels.testId}/agents`,
      ready.key,
      { agents: [other] },
    );
    expect(relinked.statusCode, JSON.stringify(relinked.body)).toBe(200);

    const refused = await request(
      "POST",
      `/api/runs/${earlier}/retry`,
      ready.key,
      { idempotency_key: newId("run") },
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toBe("retry_unavailable");
    expect(String(refused.body.message)).toContain(`test ${ready.cancels.testId}`);
    expect(String(refused.body.message)).toContain(
      "the original run was not changed",
    );
  });

  it("needs an idempotency key, on the same terms a start does", async () => {
    const ready = await aCustomerWithRuns("run_history_retry_key");
    const earlier = await startRunOver(ready, [ready.reschedules.versionId]);

    const without = await request(
      "POST",
      `/api/runs/${earlier}/retry`,
      ready.key,
      {},
    );
    expect(without.statusCode).toBe(422);
    // The same code and the same sentence the start door answers with, because
    // it is the same mistake and a client branches on the code.
    expect(without.body).toEqual({
      error: "unprocessable",
      message:
        "Starting a run requires an idempotency key. Send one stable key " +
        "for this start action and try again.",
    });

    // And the same key twice answers the same run rather than dialing again.
    const key = newId("run");
    const first = await request("POST", `/api/runs/${earlier}/retry`, ready.key, {
      idempotency_key: key,
    });
    const second = await request("POST", `/api/runs/${earlier}/retry`, ready.key, {
      idempotency_key: key,
    });
    expect(second.body.id).toBe(first.body.id);
  });

  it("is refused to a viewer, and answers nothing about a run that is not theirs", async () => {
    const ready = await aCustomerWithRuns("run_history_retry_roles");
    const earlier = await startRunOver(ready, [ready.reschedules.versionId]);

    const quentin = await colleagueOf(
      api.app,
      ready.ada,
      "quentin@acme.example",
      "viewer",
    );
    const refused = await request(
      "POST",
      `/api/runs/${earlier}/retry`,
      quentin.secret,
      { idempotency_key: newId("run") },
    );
    expect(refused.statusCode).toBe(403);

    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const stranger = await request(
      "POST",
      `/api/runs/${earlier}/retry`,
      grace.secret,
      { idempotency_key: newId("run") },
    );
    expect(stranger.statusCode).toBe(404);
  });
});

describe("running one simulation again", () => {
  it("creates one named run from the exact simulation in the address", async () => {
    const ready = await aCustomerWithRuns("simulation_rerun");
    const earlier = await startRunOver(ready, [ready.cancels.versionId]);
    const canceled = await request(
      "POST",
      `/api/runs/${earlier}/cancel`,
      ready.key,
      {},
    );
    expect(canceled.statusCode, JSON.stringify(canceled.body)).toBe(200);

    const sources = canceled.body.simulations as Record<string, unknown>[];
    const source = sources[1];
    if (source === undefined) throw new Error("the second simulation is needed");

    const again = await request(
      "POST",
      `/api/simulations/${String(source.id)}/rerun?project=${ready.ada.projectId}`,
      ready.key,
      {
        label: "Deliberate Sam again",
        idempotency_key: newId("run"),
      },
    );
    expect(again.statusCode, JSON.stringify(again.body)).toBe(201);
    expect(again.body).toMatchObject({
      label: "Deliberate Sam again",
      retry_of_run_id: earlier,
      expected_simulation_count: 1,
    });
    expect(again.body.simulations).toHaveLength(1);
    expect((again.body.simulations as Record<string, unknown>[])[0]).toMatchObject({
      test_version_id: ready.cancels.versionId,
      persona_id: source.persona_id,
      position: 1,
    });

    const original = await request("GET", `/api/runs/${earlier}`, ready.key);
    expect(original.body.status).toBe("canceled");
    expect(original.body.simulations).toHaveLength(2);
  });

  it("requires a run name and idempotency key, and waits for a terminal source", async () => {
    const ready = await aCustomerWithRuns("simulation_rerun_input");
    const earlier = await startRunOver(ready, [ready.reschedules.versionId]);
    const read = await request("GET", `/api/runs/${earlier}`, ready.key);
    const source = (read.body.simulations as Record<string, unknown>[])[0];
    if (source === undefined) throw new Error("the source simulation is needed");
    const path =
      `/api/simulations/${String(source.id)}/rerun?project=${ready.ada.projectId}`;

    const unnamed = await request("POST", path, ready.key, {
      idempotency_key: newId("run"),
    });
    expect(unnamed.statusCode).toBe(422);

    const unprotected = await request("POST", path, ready.key, {
      label: "No key",
    });
    expect(unprotected.statusCode).toBe(422);
    expect(unprotected.body.message).toBe(
      "Starting a run requires an idempotency key. Send one stable key for " +
        "this start action and try again.",
    );

    const active = await request("POST", path, ready.key, {
      label: "Too early",
      idempotency_key: newId("run"),
    });
    expect(active.statusCode).toBe(409);
    expect(active.body.error).toBe("simulation_rerun_unavailable");
    expect(String(active.body.message)).toContain("is still queued");
    expect(String(active.body.message)).not.toContain(String(source.id));
  });

  it("answers legacy simulation evidence as unprocessable rather than a conflict", async () => {
    const ready = await aCustomerWithRuns("simulation_rerun_legacy");
    const earlier = await startRunOver(ready, [ready.reschedules.versionId]);
    const read = await request("GET", `/api/runs/${earlier}`, ready.key);
    const source = (read.body.simulations as Record<string, unknown>[])[0];
    if (source === undefined) throw new Error("the source simulation is needed");
    await api.database.sql(
      "update simulation set test_id = null, test_version_id = null where id = $1",
      [String(source.id)],
    );
    await request("POST", `/api/runs/${earlier}/cancel`, ready.key, {});

    const refused = await request(
      "POST",
      `/api/simulations/${String(source.id)}/rerun?project=${ready.ada.projectId}`,
      ready.key,
      { label: "Legacy source", idempotency_key: newId("run") },
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.body.error).toBe("unprocessable");
    expect(String(refused.body.message)).toContain(
      "does not record the test version it ran",
    );
    expect(String(refused.body.message)).not.toContain(String(source.id));
  });

  it("is idempotent for one source and conflicts when the key names another", async () => {
    const ready = await aCustomerWithRuns("simulation_rerun_key");
    const earlier = await startRunOver(ready, [ready.cancels.versionId]);
    const canceled = await request(
      "POST",
      `/api/runs/${earlier}/cancel`,
      ready.key,
      {},
    );
    const [firstSource, secondSource] = canceled.body.simulations as Record<
      string,
      unknown
    >[];
    if (firstSource === undefined || secondSource === undefined) {
      throw new Error("two source simulations are needed");
    }

    const key = newId("run");
    const rerun = async (source: Record<string, unknown>, label: string) =>
      request(
        "POST",
        `/api/simulations/${String(source.id)}/rerun?project=${ready.ada.projectId}`,
        ready.key,
        { label, idempotency_key: key },
      );
    const first = await rerun(firstSource, "First source");
    const repeated = await rerun(firstSource, "First source");
    expect(repeated.body.id).toBe(first.body.id);

    const conflict = await rerun(secondSource, "Second source");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.error).toBe("idempotency_conflict");
  });

  it("recalls a successful phone rerun before carrier readiness changes can refuse it", async () => {
    const ready = await aCustomerWithRuns("simulation_rerun_phone_recall", {
      connection: PHONE,
      phoneIsSetUp: true,
    });
    const earlier = await startRunOver(ready, [ready.reschedules.versionId]);
    const canceled = await request(
      "POST",
      `/api/runs/${earlier}/cancel`,
      ready.key,
      {},
    );
    const source = (canceled.body.simulations as Record<string, unknown>[])[0];
    if (source === undefined) throw new Error("the source simulation is needed");

    const path =
      `/api/simulations/${String(source.id)}/rerun?project=${ready.ada.projectId}`;
    const idempotencyKey = newId("run");
    const first = await request("POST", path, ready.key, {
      label: "Phone source again",
      idempotency_key: idempotencyKey,
    });
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);

    // Deployment readiness is mutable and may change after a request lands.
    // The same request has already spent the carrier, so its key must answer
    // with that run rather than re-evaluate whether a new call may start.
    await api.database.sql("delete from platform_setting");

    const repeated = await request("POST", path, ready.key, {
      label: "Phone source again",
      idempotency_key: idempotencyKey,
    });
    expect(repeated.statusCode, JSON.stringify(repeated.body)).toBe(201);
    expect(repeated.body.id).toBe(first.body.id);

    // A different key is a first attempt. It still cannot write anything while
    // the carrier is unavailable.
    const newAttempt = await request("POST", path, ready.key, {
      label: "A genuinely new phone run",
      idempotency_key: newId("run"),
    });
    expect(newAttempt.statusCode).toBe(422);
    expect(newAttempt.body.error).toBe("phone_setup_required");
    const { rows } = await api.database.sql("select id from run order by id");
    expect(rows).toHaveLength(2);
  });

  it("is unavailable to a viewer and reveals no other customer's simulation", async () => {
    const ready = await aCustomerWithRuns("simulation_rerun_roles");
    const earlier = await startRunOver(ready, [ready.reschedules.versionId]);
    await request("POST", `/api/runs/${earlier}/cancel`, ready.key, {});
    const read = await request("GET", `/api/runs/${earlier}`, ready.key);
    const source = (read.body.simulations as Record<string, unknown>[])[0];
    if (source === undefined) throw new Error("the source simulation is needed");
    const path =
      `/api/simulations/${String(source.id)}/rerun?project=${ready.ada.projectId}`;

    const quentin = await colleagueOf(
      api.app,
      ready.ada,
      "sim-viewer@acme.example",
      "viewer",
    );
    const viewer = await request("POST", path, quentin.secret, {
      label: "Viewer cannot run it",
      idempotency_key: newId("run"),
    });
    expect(viewer.statusCode).toBe(403);

    const grace = await signUp(api.app, "sim@globex.example", "Globex");
    const stranger = await request(
      "POST",
      `/api/simulations/${String(source.id)}/rerun?project=${grace.projectId}`,
      grace.secret,
      { label: "Not visible", idempotency_key: newId("run") },
    );
    expect(stranger.statusCode).toBe(404);
  });
});

describe("stopping a run", () => {
  /**
   * A conversation that finished a moment before the cancel reached its
   * simulator reports afterwards. It must not turn a stop into a green result.
   */
  it("stays canceled when a later report lands, and never becomes completed", async () => {
    const ready = await aCustomerWithRuns("run_history_cancel_race");
    const auth = contextFor(ready.ada, "member");
    const runId = await startRunOver(ready, [ready.cancels.versionId]);

    const claims = await claimOwn(runId);
    const [held, other] = claims;
    if (held === undefined || other === undefined) {
      throw new Error("the run should hand out two conversations");
    }
    await startSimulation(auth, held.id, CLAIMANT);

    const canceled = await request(
      "POST",
      `/api/runs/${runId}/cancel`,
      ready.key,
    );
    expect(canceled.statusCode, JSON.stringify(canceled.body)).toBe(200);
    expect(canceled.body.status).toBe("canceled");

    /*
     * **The race, exactly as it happens.** The simulator had already finished
     * this conversation when the cancel reached it, so the report lands and the
     * conversation really is `completed`. What must not happen is the run header
     * following it: a run somebody stopped that then reads `completed` is a
     * suite reported green on work nobody let finish.
     */
    const landed = await completeSimulation(auth, held.id, CLAIMANT, {
      endingReason: "persona_concluded",
    });
    expect(landed?.status).toBe("completed");

    // The other conversation honors the cancellation at its next heartbeat,
    // which is what settles the run's counts.
    await markSimulationCanceled(auth, other.id, CLAIMANT);

    const read = await request("GET", `/api/runs/${runId}`, ready.key);
    expect(read.body.status).toBe("canceled");
    // Its conversations are counted honestly — one finished, one stopped — and
    // the header still says the run was canceled.
    expect(read.body.simulation_counts).toMatchObject({
      completed: 1,
      canceled: 1,
    });
    // A canceled conversation reads `skipped`, never `failed`.
    const stopped = (read.body.simulations as Record<string, unknown>[]).find(
      (one) => one.status === "canceled",
    );
    expect(stopped?.verdict).toBe("skipped");
    expect(stopped?.grading).toBe("not_required");
  });
});
