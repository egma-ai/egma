import { newId } from "@egma/ids";
import { createPersona, getRun, getSimulation } from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "@egma/retell";

import { settleOwedMockCleanups } from "../src/mocked-world.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  NEUTRAL_PERSON,
  projectKeyFor,
  request as ask,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * The sweep's two hard cases, both about a run that is `pending`.
 *
 * A mocked run's simulations are unclaimable until it names a temporary copy, so
 * a run whose build died leaves them queued forever — the sweep must find it
 * and cancel it (S2). But a run whose world is fully built and is merely
 * *waiting for a free simulator* is not stuck, and cancelling it for queue wait
 * would be a fate no other run in the product suffers (S3). One clock, two
 * answers, told apart by whether the draft exists.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RETELL_AGENT = "agent_b0e2e9cb267c47e7e7026cd8e8";
const KEY = "retell-secret-A1B2C3D4WXYZ";
const PINNED_NUMBER = "+15550100";

/**
 * A Retell that only ever has to answer the delete a teardown might send, and
 * the read that proves it.
 *
 * The listing is what says the deleted version is gone. A teardown records the
 * account as put back only when that read agrees, so this account answers with
 * the published version and nothing else — no temporary version stands on it.
 */
const RETELL: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200 });
  if (url.includes("/v2/list-agents")) {
    return json({
      items: [
        { agent_id: RETELL_AGENT, agent_name: "After hours", channel: "voice" },
      ],
      has_more: false,
    });
  }
  if (url.includes("/list-agent-versions/")) {
    return json({
      items: [{ version: 105, is_published: true }],
      has_more: false,
    });
  }
  // A delete that should never be called in these tests: a stuck run has no
  // draft, and a built-world run waiting for a simulator is left alone.
  if (method === "DELETE") return json({ deleted: true });
  throw new Error(`the sweep test's Retell was asked something unexpected: ${method} ${url}`);
}) as typeof fetch;

/**
 * The same account with one pinned number on it, and a count of every binding
 * it was asked to write.
 *
 * A restore is the one write a duplicated settle must not make twice: the
 * second one would be putting a `latest` binding back that somebody else has
 * already put back, over an account that may since have grown a newer run's
 * temporary version.
 */
function anAccountHoldingAPin(): {
  readonly fetchImpl: typeof fetch;
  readonly restores: { count: number };
} {
  const restores = { count: 0 };
  let bindings: readonly Record<string, unknown>[] = [
    { agent_id: RETELL_AGENT, agent_version: 105, weight: 2 },
  ];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200 });
    if (method === "GET" && path.startsWith("/get-phone-number/")) {
      return json({
        phone_number: PINNED_NUMBER,
        nickname: "Front desk",
        inbound_agents: bindings,
      });
    }
    if (method === "PATCH" && path.startsWith("/update-phone-number/")) {
      restores.count += 1;
      bindings = (init?.body === undefined
        ? []
        : (JSON.parse(String(init.body)) as Record<string, unknown>)[
            "inbound_agents"
          ]) as readonly Record<string, unknown>[];
      return json({ phone_number: PINNED_NUMBER });
    }
    return RETELL(input as string, init);
  }) as typeof fetch;
  return { fetchImpl, restores };
}

const SWEEP_LOG = { error: () => undefined };

type Ready = {
  readonly ada: Customer;
  readonly agentId: string;
  readonly connectionId: string;
  readonly suiteId: string;
  readonly testId: string;
  readonly testVersionId: string;
  readonly personaId: string;
  readonly personaVersionId: string;
};

/** A ticked agent with a web-call connection and one test, all through the API. */
async function aTickedAgent(label: string): Promise<Ready> {
  api = await createApi(label, { retellFetch: RETELL });
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);

  const registered = await ask(api.app, "POST", "/v1/agents", key, {
    agentPlatform: "retell",
    name: "After hours",
    connection: {
      name: "Web call",
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      config: { retellAgentId: RETELL_AGENT },
      credentials: { apiKey: KEY },
      platformAgentId: RETELL_AGENT,
    },
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const agentId = (registered.body.agent as { id: string }).id;
  const connectionId = (registered.body.connection as { id: string }).id;

  const suite = await ask(api.app, "POST", "/v1/test-suites", key, {
    name: "Regression",
  });
  await createPersona(contextFor(ada, "member"), {
    name: "Impatient Rita",
    ...NEUTRAL_PERSON,
  });
  const pushed = await ask(api.app, "POST", "/v1/tests", key, {
    name: "Books an appointment",
    scenario: "Wants the first free afternoon slot next week.",
    expectedBehaviors: ["confirms the time back before finishing"],
    suiteId: String(suite.body.id),
    personas: ["Impatient Rita"],
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  const testRow = await api.database.sql<{ id: string; current_version_id: string }>(
    `select id, current_version_id from test where suite_id = $1 limit 1`,
    [String(suite.body.id)],
  );
  const personaRow = await api.database.sql<{ id: string; current_version_id: string }>(
    `select id, current_version_id from persona limit 1`,
  );

  return {
    ada,
    agentId,
    connectionId,
    suiteId: String(suite.body.id),
    testId: testRow.rows[0]!.id,
    testVersionId: testRow.rows[0]!.current_version_id,
    personaId: personaRow.rows[0]!.id,
    personaVersionId: personaRow.rows[0]!.current_version_id,
  };
}

/**
 * A run and one queued simulation, written straight into the store with a
 * chosen world, a chosen age, and — for a run whose teardown is the thing
 * under test — a finished status.
 */
async function seedRun(
  ready: Ready,
  copy: { readonly version: number | null } | null,
  minutesOld: number,
  status: "pending" | "completed" = "pending",
  /** The numbers this run's note says it pinned, if it pinned any. */
  numbers: readonly Record<string, unknown>[] = [],
  /** What this run's note says the serving version's tools looked like. */
  toolPrint?: string,
): Promise<{ runId: string; simulationId: string }> {
  const runId = newId("run");
  const simulationId = newId("sim");
  const { organizationId, projectId } = contextFor(ready.ada, "member");
  await api.database.sql(
    `insert into run
       (id, organization_id, project_id, suite_id, agent_id, connection_id,
        status, triggered_via, connection_snapshot, mock_tool_snapshot,
        temp_mock_agent_version, temp_mock_agent_version_cleanup,
        mock_metadata, expected_simulation_count, created_at, started_at,
        finished_at, completed_count, failed_count, canceled_count)
     values ($1,$2,$3,$4,$5,$6,$11,'manual',$7::jsonb,$8::jsonb,$9::integer,
        case when $12 = 'no' then null else false end,
        case when $12 = 'no' then null else $13::jsonb end,1,
        now() - ($10 || ' minutes')::interval,
        case when $11 = 'completed' then now() - ($10 || ' minutes')::interval end,
        case when $11 = 'completed' then now() - interval '1 minute' end,
        case when $11 = 'completed' then 1 end,
        case when $11 = 'completed' then 0 end,
        case when $11 = 'completed' then 0 end)`,
    [
      runId,
      organizationId,
      projectId,
      ready.suiteId,
      ready.agentId,
      ready.connectionId,
      JSON.stringify({
        agentPlatform: "retell",
        connectionType: "retell_web_call",
        accessVariant: "retell_web_call.api_key",
        modality: "voice",
        topology: "hosted-broker",
        environment: null,
        config: { retellAgentId: RETELL_AGENT },
        mockToolsEnabled: true,
      }),
      JSON.stringify({ defaults: [], overrides: {} }),
      copy?.version ?? null,
      String(minutesOld),
      status,
      copy === null ? "no" : "yes",
      JSON.stringify({
        engine: {
          type: "conversation-flow",
          engine_id: "flow_1",
          version: 105,
          ...(toolPrint === undefined ? {} : { tool_print: toolPrint }),
        },
        numbers,
      }),
    ],
  );
  await api.database.sql(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, test_id, test_version_id,
        position, modality, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'voice','queued')`,
    [
      simulationId,
      runId,
      organizationId,
      projectId,
      ready.agentId,
      ready.connectionId,
      ready.personaId,
      ready.personaVersionId,
      ready.testId,
      ready.testVersionId,
    ],
  );
  return { runId, simulationId };
}

/** The same account, refusing every delete — a teardown that cannot finish. */
const RETELL_DELETE_REFUSED: typeof fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  if ((init?.method ?? "GET") === "DELETE") {
    return new Response(JSON.stringify({ error: "not today" }), {
      status: 500,
    });
  }
  return RETELL(input as string, init);
}) as typeof fetch;

/** The claim's own marker: a cleanup owed, and no copy branched yet. */
const CLAIMED = { version: null };

/** A run that branched its copy: the cleanup is owed and names a version. */
const BRANCHED = { version: 106 };

describe("the sweep, over a run that is pending", () => {
  it("cancels a run whose build died before it named a draft", async () => {
    const ready = await aTickedAgent("sweep_cancels_stuck");
    // Its world is the building marker — the row a run wears while building,
    // with no draft — and it is twenty minutes old, well past the build window.
    const { runId, simulationId } = await seedRun(ready, CLAIMED, 20);
    const auth = contextFor(ready.ada, "member");

    await settleOwedMockCleanups(auth, ready.agentId, { baseUrl: "https://egma.test", retellFetch: RETELL }, SWEEP_LOG);

    // The stuck run is canceled, so its unclaimable simulations stop waiting.
    expect((await getRun(auth, runId))?.status).toBe("canceled");
    expect((await getSimulation(auth, simulationId))?.status).toBe("canceled");
  });

  it("leaves a run alone whose world is built and is waiting for a simulator", async () => {
    const ready = await aTickedAgent("sweep_spares_waiting");
    // A fully built world — its draft exists — and just as old. This run is not
    // stuck; it is queued, waiting for a free simulator, and its clock is queue
    // wait, not a dead build.
    const { runId, simulationId } = await seedRun(ready, BRANCHED, 20);
    const auth = contextFor(ready.ada, "member");

    await settleOwedMockCleanups(auth, ready.agentId, { baseUrl: "https://egma.test", retellFetch: RETELL }, SWEEP_LOG);

    // Untouched: still pending, its simulation still claimable, and its draft
    // never torn down. Cancelling it for queue wait would be a fate no other
    // run suffers.
    expect((await getRun(auth, runId))?.status).toBe("pending");
    expect((await getSimulation(auth, simulationId))?.status).toBe("queued");
    const after = await getRun(auth, runId);
    expect(after?.tempMockAgentVersion).toBe(106);
  });

  it("does not cancel a stuck run that is still inside the build window", async () => {
    const ready = await aTickedAgent("sweep_young_stuck");
    // Same marker, but two minutes old — a build in flight, not a dead one.
    const { runId } = await seedRun(ready, CLAIMED, 2);
    const auth = contextFor(ready.ada, "member");

    await settleOwedMockCleanups(auth, ready.agentId, { baseUrl: "https://egma.test", retellFetch: RETELL }, SWEEP_LOG);

    expect((await getRun(auth, runId))?.status).toBe("pending");
  });
});

/**
 * What the sweep answers, which one caller's safety hangs on: the build
 * refuses to branch over an `unsettled` agent, because an unsettled world's
 * restore retries later and must never find a draft to route `latest` onto.
 */
describe("what the sweep answers", () => {
  it("answers settled over an agent that owes nothing", async () => {
    const ready = await aTickedAgent("sweep_answers_clean");
    const auth = contextFor(ready.ada, "member");

    const swept = await settleOwedMockCleanups(auth, ready.agentId, { baseUrl: "https://egma.test", retellFetch: RETELL }, SWEEP_LOG);

    expect(swept).toEqual({ kind: "settled" });
  });

  it("answers settled once a finished run's world is given back", async () => {
    const ready = await aTickedAgent("sweep_answers_settled");
    // A finished run still holding its draft — ordinary litter, and the
    // account honours the delete.
    const { runId } = await seedRun(ready, BRANCHED, 20, "completed");
    const auth = contextFor(ready.ada, "member");

    const swept = await settleOwedMockCleanups(auth, ready.agentId, { baseUrl: "https://egma.test", retellFetch: RETELL }, SWEEP_LOG);

    expect(swept).toEqual({ kind: "settled" });
    // The copy is gone from Retell, and the flag says the account is back.
    // The version number stays: it is the record of what this run branched.
    expect((await getRun(auth, runId))?.tempMockAgentVersionCleanup).toBe(true);
  });

  it("answers unsettled while a finished run's draft cannot be deleted", async () => {
    const ready = await aTickedAgent("sweep_answers_unsettled");
    const { runId } = await seedRun(ready, BRANCHED, 20, "completed");
    const auth = contextFor(ready.ada, "member");

    const swept = await settleOwedMockCleanups(
      auth,
      ready.agentId,
      { baseUrl: "https://egma.test", retellFetch: RETELL_DELETE_REFUSED },
      SWEEP_LOG,
    );

    // Still owed, named by run — and the world still honestly holds its
    // draft, so the retry knows exactly what to give back.
    expect(swept.kind).toBe("unsettled");
    if (swept.kind === "unsettled") {
      expect(swept.reason).toContain(runId);
      expect(swept.reason).toContain("still owes");
    }
    expect((await getRun(auth, runId))?.tempMockAgentVersion).toBe(106);
    expect((await getRun(auth, runId))?.tempMockAgentVersionCleanup).toBe(false);
  });
});

/**
 * The promise a resumed teardown can still keep, because the note carries the
 * comparison value: the version this agent serves never moved.
 *
 * The run that built the world compared the engine it read back against a print
 * it held in memory. A run that crashed took that print with it — so without
 * one on the note, a teardown finished by anybody else could delete the copy
 * and call the account settled without ever looking at the version real callers
 * are served from.
 */
describe("a teardown resumed from the note alone", () => {
  const TOOLS = [
    {
      tool_id: "tool-get_availability",
      type: "custom",
      name: "get_availability",
      url: "https://backend.example.com/tools/get_availability",
    },
  ];

  /** The same account, answering for the engine the note names. */
  function anAccountServing(
    tools: readonly Record<string, unknown>[],
  ): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith("/get-conversation-flow/")) {
        return new Response(
          JSON.stringify({ conversation_flow_id: "flow_1", version: 105, tools }),
          { status: 200 },
        );
      }
      return RETELL(input as string, init);
    }) as typeof fetch;
  }

  it("settles when the serving version still declares what was captured", async () => {
    const ready = await aTickedAgent("sweep_print_unmoved");
    const { runId } = await seedRun(
      ready,
      BRANCHED,
      20,
      "completed",
      [],
      canonicalJson(TOOLS),
    );
    const auth = contextFor(ready.ada, "member");

    const swept = await settleOwedMockCleanups(
      auth,
      ready.agentId,
      { baseUrl: "https://egma.test", retellFetch: anAccountServing(TOOLS) },
      SWEEP_LOG,
    );

    expect(swept).toEqual({ kind: "settled" });
    expect((await getRun(auth, runId))?.tempMockAgentVersionCleanup).toBe(true);
  });

  it("stays unsettled, and says what stands there now, when it moved", async () => {
    const ready = await aTickedAgent("sweep_print_moved");
    const { runId } = await seedRun(
      ready,
      BRANCHED,
      20,
      "completed",
      [],
      canonicalJson(TOOLS),
    );
    const auth = contextFor(ready.ada, "member");

    // The serving version declares something else now — which is the one
    // failure this whole design exists to prevent, and which a settle that
    // could not compare would have reported as a clean account.
    const swept = await settleOwedMockCleanups(
      auth,
      ready.agentId,
      {
        baseUrl: "https://egma.test",
        retellFetch: anAccountServing([
          { tool_id: "tool-sms", type: "send_sms", name: "text_the_caller" },
        ]),
      },
      SWEEP_LOG,
    );

    expect(swept.kind).toBe("unsettled");
    if (swept.kind === "unsettled") {
      expect(swept.reason).toContain("conversation-flow flow_1 v105");
      expect(swept.reason).toContain("text_the_caller");
    }
    // Still owed, so the next mocked run of this agent is refused rather than
    // branching over a version Egma can no longer vouch for.
    expect((await getRun(auth, runId))?.tempMockAgentVersionCleanup).toBe(false);
  });
});

/**
 * Two settles of one agent, and the rule that makes the second one harmless.
 *
 * A terminal report lands the settle, and so does the next run's claim — so two
 * of them meeting is ordinary, not exotic. They take turns behind the agent's
 * mocked-world fence, and the one that arrives second re-reads the cleanup flag
 * inside it: a run somebody else has already put back is not in its list, so it
 * writes nothing. Without that re-read the second one would restore a `latest`
 * binding a moment after the first did — over an account that by then may hold
 * a newer run's temporary version, which is the hijack itself.
 */
describe("a settle that arrives after somebody else settled the run", () => {
  const PINNED = [{ number: PINNED_NUMBER, was: "latest", pinned_to: 105 }];

  it("restores nothing, and still answers settled", async () => {
    const ready = await aTickedAgent("sweep_settles_once");
    const account = anAccountHoldingAPin();
    const { runId } = await seedRun(ready, BRANCHED, 20, "completed", PINNED);
    const auth = contextFor(ready.ada, "member");
    const reach = { baseUrl: "https://egma.test", retellFetch: account.fetchImpl };

    const first = await settleOwedMockCleanups(auth, ready.agentId, reach, SWEEP_LOG);
    const second = await settleOwedMockCleanups(auth, ready.agentId, reach, SWEEP_LOG);

    expect(first).toEqual({ kind: "settled" });
    expect(second).toEqual({ kind: "settled" });
    // One restore, not two. The second settle found the flag already true.
    expect(account.restores.count).toBe(1);
    expect((await getRun(auth, runId))?.tempMockAgentVersionCleanup).toBe(true);
  });

  it("settles once when two of them run at the same time", async () => {
    const ready = await aTickedAgent("sweep_settles_once_racing");
    const account = anAccountHoldingAPin();
    const { runId } = await seedRun(ready, BRANCHED, 20, "completed", PINNED);
    const auth = contextFor(ready.ada, "member");
    const reach = { baseUrl: "https://egma.test", retellFetch: account.fetchImpl };

    // The real shape of it: a terminal report landing while the next run's
    // sweep is already inside the teardown. The fence makes them take turns,
    // and the loser's re-read is what makes its turn a no-op.
    const both = await Promise.all([
      settleOwedMockCleanups(auth, ready.agentId, reach, SWEEP_LOG),
      settleOwedMockCleanups(auth, ready.agentId, reach, SWEEP_LOG),
    ]);

    expect(both).toEqual([{ kind: "settled" }, { kind: "settled" }]);
    expect(account.restores.count).toBe(1);
    expect((await getRun(auth, runId))?.tempMockAgentVersionCleanup).toBe(true);
  });
});
