import { newId } from "@egma/ids";
import { allowancePeriodAt, createPersona } from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  mintKey,
  NEUTRAL_PERSON,
  projectKeyFor,
  request as ask,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * What an organization has used of each allowance this period, over HTTP.
 *
 * **On every deployment.** Nothing here is configured and no adapter is
 * installed, which is the deployment every self-hoster runs: the three numbers
 * are counted and shown, and no limit exists to compare them against. That is
 * the point of the surface — measuring is the product, charging is not.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

/**
 * Acme was created on the 15th, so its month turns over on the 15th.
 *
 * The route reads the clock, as it must — nobody asks a settings page which
 * month to show — so the period a test seeds into is worked out from that same
 * clock through the one anchor rule, rather than written out as a date that
 * would stop being this month tomorrow.
 */
const ANCHOR = new Date("2026-01-15T08:00:00.000Z");

const PERIOD = allowancePeriodAt(ANCHOR, new Date());
/** An hour into the period, so it is inside it whenever this suite runs. */
const INSIDE = new Date(PERIOD.startedAt.getTime() + 3_600_000);
/** An hour before it began, which is last month's. */
const LAST_MONTH = new Date(PERIOD.startedAt.getTime() - 3_600_000);

type Span = {
  readonly lane: "retell_chat_api" | "retell_web_call" | "phone_number";
  readonly modality: "chat" | "voice";
  readonly startedAt: Date;
  readonly seconds: number;
};

/**
 * One conversation on this customer's own run, with the span the test is
 * about. Written directly, because what is under test is the surface and the
 * counting rather than the simulator.
 */
async function conversation(
  seeded: Awaited<ReturnType<typeof aCustomerWhoRan>>,
  span: Span,
  position: number,
): Promise<void> {
  const connectionId = await connectionOf(seeded, span);
  await api.database.sql(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, test_id, test_version_id,
        position, modality, connection_type, status, ending_reason,
        started_at, ended_at, claimed_by, claimed_at, heartbeat_at, persona_parameter_values)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'completed',
             'persona_concluded',$14,$15,'the-simulator',$14,$14,
             (select persona_parameter_values from simulation where run_id = $2 limit 1))`,
    [
      newId("sim"),
      seeded.runId,
      seeded.customer.organizationId,
      seeded.customer.projectId,
      seeded.agentId,
      connectionId,
      seeded.personaId,
      seeded.personaVersionId,
      seeded.testId,
      seeded.testVersionId,
      position,
      span.modality,
      span.lane,
      span.startedAt,
      new Date(span.startedAt.getTime() + span.seconds * 1_000),
    ],
  );
}

const lanes = new Map<string, string>();

async function connectionOf(
  seeded: Awaited<ReturnType<typeof aCustomerWhoRan>>,
  span: Span,
): Promise<string> {
  const key = `${seeded.customer.organizationId}/${span.lane}`;
  const held = lanes.get(key);
  if (held !== undefined) return held;
  if (span.lane === "retell_chat_api") {
    lanes.set(key, seeded.connectionId);
    return seeded.connectionId;
  }
  const id = newId("con");
  await api.database.sql(
    `insert into connection
       (id, organization_id, project_id, agent_id, name, connection_type,
        access_variant, modality, topology, config)
     values ($1,$2,$3,$4,$5,$6,$7,'voice','hosted-broker','{}'::jsonb)`,
    [
      id,
      seeded.customer.organizationId,
      seeded.customer.projectId,
      seeded.agentId,
      `${span.lane}-1`,
      span.lane,
      span.lane === "phone_number"
        ? "phone_number.public_e164"
        : "retell_web_call.api_key",
    ],
  );
  lanes.set(key, id);
  return id;
}

const RETELL_CHAT_FETCH: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      items: [
        {
          agent_id: "agent_in_retell_1",
          agent_name: "Front desk",
          channel: "chat",
        },
      ],
      has_more: false,
    }),
    { status: 200 },
  );

async function aCustomerWhoRan(
  email: string,
  organizationName: string,
): Promise<{
  customer: Customer;
  key: string;
  organizationKey: string;
  runId: string;
  agentId: string;
  connectionId: string;
  personaId: string;
  personaVersionId: string;
  testId: string;
  testVersionId: string;
}> {
  const customer = await signUp(api.app, email, organizationName);
  const key = await projectKeyFor(api.app, customer);
  await createPersona(contextFor(customer, "member"), {
    name: "Impatient Rita",
    ...NEUTRAL_PERSON,
  });

  const registered = await ask(api.app, "POST", "/v1/agents", key, {
    agentPlatform: "retell",
    name: "Front desk",
    connection: {
      agentPlatform: "retell",
      connectionType: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    },
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const agentId = (registered.body.agent as { id: string }).id;
  const connectionId = (registered.body.connection as { id: string }).id;

  const suite = await ask(api.app, "POST", "/v1/test-suites", key, {
    name: "Appointment changes",
  });
  expect(suite.statusCode, JSON.stringify(suite.body)).toBe(201);
  const pushed = await ask(api.app, "POST", "/v1/tests", key, {
    name: "Reschedules a booked appointment",
    scenario: "Their cleaning has to move to any afternoon next week.",
    expectedBehaviors: ["confirms the new time back before finishing"],
    suiteId: String(suite.body.id),
    personas: ["Impatient Rita"],
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  const started = await ask(api.app, "POST", "/v1/runs", key, {
    suiteId: String(suite.body.id),
    agentId,
    connectionId,
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

  const { rows } = await api.database.sql<{
    persona_id: string;
    persona_version_id: string;
    test_id: string;
    test_version_id: string;
  }>(
    `select persona_id, persona_version_id, test_id, test_version_id
       from simulation where run_id = $1 limit 1`,
    [String(started.body.id)],
  );
  const pins = rows[0];
  if (pins === undefined) throw new Error("the run has no simulation");

  // The run's own queued conversation counts nothing: it never began.
  await api.database.sql(
    "update organization set created_at = $2 where id = $1",
    [customer.organizationId, ANCHOR],
  );

  return {
    customer,
    key,
    organizationKey: await mintKey(api.app, customer.cookie, "Usage settings"),
    runId: String(started.body.id),
    agentId,
    connectionId,
    personaId: pins.persona_id,
    personaVersionId: pins.persona_version_id,
    testId: pins.test_id,
    testVersionId: pins.test_version_id,
  };
}

type UsageAnswer = {
  periodStartedAt: string;
  resetsAt: string;
  allowances: { kind: string; unit: string; used: number }[];
};

describe("the organization's usage this period", () => {
  it("answers three allowances, their units and the period's two dates", async () => {
    api = await createApi("organization_usage", {
      retellFetch: RETELL_CHAT_FETCH,
      traceStore: true,
    });
    const acme = await aCustomerWhoRan("ada@acme.example", "Acme");

    await conversation(acme, {
      lane: "retell_chat_api",
      modality: "chat",
      startedAt: INSIDE,
      seconds: 45,
    }, 101);
    await conversation(acme, {
      lane: "retell_web_call",
      modality: "voice",
      startedAt: INSIDE,
      seconds: 90,
    }, 102);
    await conversation(acme, {
      lane: "phone_number",
      modality: "voice",
      startedAt: INSIDE,
      seconds: 30,
    }, 103);
    // Last month's conversation, which this period must not see.
    await conversation(acme, {
      lane: "phone_number",
      modality: "voice",
      startedAt: LAST_MONTH,
      seconds: 600,
    }, 104);

    const answer = await ask(
      api.app,
      "GET",
      "/api/organization/usage",
      acme.organizationKey,
    );
    expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200);
    const usage = answer.body as unknown as UsageAnswer;

    // The period the clock is in, counted from the organization's own date.
    expect(usage.periodStartedAt).toBe(PERIOD.startedAt.toISOString());
    expect(usage.resetsAt).toBe(PERIOD.resetsAt.toISOString());
    // A month, on the anchor's day and time, and never a calendar month.
    expect(PERIOD.startedAt.getUTCDate()).toBe(15);
    expect(PERIOD.resetsAt.getUTCDate()).toBe(15);
    expect(usage.allowances).toEqual([
      { kind: "chat_simulations", unit: "simulations", used: 1 },
      { kind: "web_call_minutes", unit: "minutes", used: 1.5 },
      { kind: "phone_minutes", unit: "minutes", used: 0.5 },
    ]);
  });

  it("answers zero for a customer who has run nothing", async () => {
    api = await createApi("organization_usage_empty", {
      retellFetch: RETELL_CHAT_FETCH,
      traceStore: true,
    });
    const acme = await aCustomerWhoRan("ada@acme.example", "Acme");
    const answer = await ask(
      api.app,
      "GET",
      "/api/organization/usage",
      acme.organizationKey,
    );
    expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200);
    const usage = answer.body as unknown as UsageAnswer;
    expect(usage.allowances.map((one) => one.used)).toEqual([0, 0, 0]);
  });

  it("counts nothing of another customer's", async () => {
    api = await createApi("organization_usage_tenancy", {
      retellFetch: RETELL_CHAT_FETCH,
      traceStore: true,
    });
    const acme = await aCustomerWhoRan("ada@acme.example", "Acme");
    const globex = await aCustomerWhoRan("bob@globex.example", "Globex");
    await conversation(globex, {
      lane: "phone_number",
      modality: "voice",
      startedAt: INSIDE,
      seconds: 120,
    }, 201);

    const theirs = await ask(
      api.app,
      "GET",
      "/api/organization/usage",
      globex.organizationKey,
    );
    const ours = await ask(
      api.app,
      "GET",
      "/api/organization/usage",
      acme.organizationKey,
    );
    expect((theirs.body as unknown as UsageAnswer).allowances[2]?.used).toBe(2);
    expect((ours.body as unknown as UsageAnswer).allowances[2]?.used).toBe(0);
  });

  it("is readable by a viewer, who can change none of it", async () => {
    api = await createApi("organization_usage_viewer", {
      retellFetch: RETELL_CHAT_FETCH,
      traceStore: true,
    });
    const acme = await aCustomerWhoRan("ada@acme.example", "Acme");
    await conversation(acme, {
      lane: "retell_chat_api",
      modality: "chat",
      startedAt: INSIDE,
      seconds: 45,
    }, 301);

    // A viewer can read the organization's usage without changing it.
    await api.database.sql(
      "update membership set role = 'viewer' where user_id = $1",
      [acme.customer.userId],
    );
    const asViewer = await mintKey(api.app, acme.customer.cookie, "Acme");
    const answer = await ask(
      api.app,
      "GET",
      "/api/organization/usage",
      asViewer,
    );
    expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200);
    expect(
      (answer.body as unknown as UsageAnswer).allowances[0]?.used,
    ).toBe(1);
  });

  it("refuses a request with no credential", async () => {
    api = await createApi("organization_usage_uncredentialed", {
      retellFetch: RETELL_CHAT_FETCH,
      traceStore: true,
    });
    const response = await api.app.inject({
      method: "GET",
      url: "/api/organization/usage",
    });
    expect(response.statusCode).toBe(401);
  });
});
