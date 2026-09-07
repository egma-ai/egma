import { newId } from "@egma/ids";
import { allowancePeriodAt, createPersona } from "@egma/db";
import {
  billingRoutes,
  cloudBillingPlugIn,
  seedCloudPlans,
} from "@egma/ee";
import { afterEach, describe, expect, it } from "vitest";

import { CLAIMS_PATH } from "../../apps/api/src/routes/claims.ts";
import { createApi, type TestApi } from "../../apps/api/test/support/api.ts";
import {
  contextFor,
  mintKey,
  NEUTRAL_PERSON,
  projectKeyFor,
  request as ask,
  signUp,
  type Customer,
} from "../../apps/api/test/support/traces.ts";

/**
 * Egma Cloud's billing, over the API's own HTTP surface.
 *
 * **The adapter is selected by constructing it, never through the
 * environment.** A test that set a Stripe secret would be a test about
 * `process.env`; what matters here is what the deployment does once the cloud
 * plug-in is in place, so the plug-in is built and installed and its routes are
 * mounted, which is exactly what the entry point does when the secret is set.
 *
 * **No Stripe is called and none is faked.** A Pro subscription enters this
 * file as the two columns Egma keeps from one; a purchased credit enters it as
 * the ledger row the webhook would have written. What is under test is what
 * Egma does with those facts.
 *
 * **Two organizations throughout**, because the first question any of this has
 * to answer correctly is whose plan, whose allowance and whose money.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

/** Acme was created on the 15th, so its month turns over on the 15th. */
const ANCHOR = new Date("2026-01-15T08:00:00.000Z");
const PERIOD = allowancePeriodAt(ANCHOR, new Date());
/** An hour into the period, so it is inside it whenever this suite runs. */
const INSIDE = new Date(PERIOD.startedAt.getTime() + 3_600_000);

/** $5.00 in micro-dollars, as the shipped plan file states it. */
const WELCOME_CREDIT_MICROS = 5_000_000;

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

/** An instance standing in for a deployment that named a Stripe secret. */
async function aBillingDeployment(label: string): Promise<void> {
  api = await createApi(label, {
    retellFetch: RETELL_CHAT_FETCH,
    billing: cloudBillingPlugIn(),
    installBilling: true,
    billingRoutes,
  });
  // The plan rows the entry point writes on boot, from the file in `ee/`.
  await seedCloudPlans();
}

type Seeded = {
  readonly customer: Customer;
  readonly key: string;
  readonly runId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly personaId: string;
  readonly personaVersionId: string;
  readonly testId: string;
  readonly testVersionId: string;
  readonly suiteId: string;
};

async function aCustomerWithARun(
  email: string,
  organizationName: string,
): Promise<Seeded> {
  const customer = await signUp(api.app, email, organizationName);
  // Before anything asks a money question: the account is opened at the first
  // one and freezes this instant as the customer's reset day, exactly as it
  // does for a real organization whose creation date never moves again.
  await api.database.sql(
    "update organization set created_at = $2 where id = $1",
    [customer.organizationId, ANCHOR],
  );
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

  return {
    customer,
    key,
    runId: String(started.body.id),
    agentId,
    connectionId,
    personaId: pins.persona_id,
    personaVersionId: pins.persona_version_id,
    testId: pins.test_id,
    testVersionId: pins.test_version_id,
    suiteId: String(suite.body.id),
  };
}

let position = 1_000;

/** Chat conversations this customer has already run this period. */
async function chatConversations(
  seeded: Seeded,
  count: number,
): Promise<void> {
  const from = position + 1;
  position += count;
  await api.database.sql(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, persona_parameter_values, test_id, test_version_id,
        position, modality, connection_type, status, ending_reason,
        started_at, ended_at)
     select
       'sim_' || upper(substr(md5(random()::text || n::text || clock_timestamp()::text), 1, 26)),
       $1, $2, $3, $4, $5, $6, $7,
       (select persona_parameter_values from simulation where run_id = $1 order by position limit 1),
       $8, $9, n, 'chat', 'retell_chat_api', 'completed', 'persona_concluded',
       $10::timestamptz, $10::timestamptz + interval '30 seconds'
     from generate_series($11::int, $11::int + $12::int - 1) as n`,
    [
      seeded.runId,
      seeded.customer.organizationId,
      seeded.customer.projectId,
      seeded.agentId,
      seeded.connectionId,
      seeded.personaId,
      seeded.personaVersionId,
      seeded.testId,
      seeded.testVersionId,
      INSIDE,
      from,
      count,
    ],
  );
}

type BillingAnswer = {
  plan: {
    code: string;
    name: string;
    feeMicros: number;
    allowances: { kind: string; unit: string; allowed: number | null }[];
  };
  balanceMicros: number;
  periodStartedAt: string;
  resetsAt: string;
  mayManageBilling: boolean;
  charges: {
    provider: string;
    model: string;
    requests: number;
    amountMicros: number;
  }[];
};

describe("what the Billing section reads", () => {
  it("gives an admin the plan, its allowances and the balance", async () => {
    await aBillingDeployment("cloud_billing_admin");
    const acme = await aCustomerWithARun("ada@acme.example", "Acme");

    const answer = await ask(
      api.app,
      "GET",
      "/api/organization/billing",
      acme.key,
    );
    expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200);
    const read = answer.body as unknown as BillingAnswer;

    // Every organization starts on Hobby with its welcome credit, and nobody
    // was asked for a card.
    expect(read.plan.code).toBe("hobby");
    expect(read.plan.name).toBe("Hobby");
    expect(read.plan.feeMicros).toBe(0);
    expect(read.balanceMicros).toBe(WELCOME_CREDIT_MICROS);
    expect(read.mayManageBilling).toBe(true);
    expect(read.plan.allowances).toEqual([
      { kind: "chat_simulations", unit: "simulations", allowed: 500 },
      { kind: "web_call_minutes", unit: "minutes", allowed: 500 },
      { kind: "phone_minutes", unit: "minutes", allowed: 500 },
    ]);
    // The month is the organization's own, counted from the day it was made.
    expect(read.periodStartedAt).toBe(PERIOD.startedAt.toISOString());
    expect(read.resetsAt).toBe(PERIOD.resetsAt.toISOString());
  });

  it("reads the account the credential names, and no other", async () => {
    await aBillingDeployment("cloud_billing_two_customers");
    const acme = await aCustomerWithARun("ada@acme.example", "Acme");
    const globex = await aCustomerWithARun("gil@globex.example", "Globex");

    // The row a Stripe subscription would have written, seeded directly.
    await api.database.sql(
      `update cloud_billing_account
         set plan_code = 'pro', stripe_customer_id = 'cus_seeded',
             stripe_subscription_id = 'sub_seeded',
             stripe_subscription_status = 'active'
       where organization_id = $1`,
      [globex.customer.organizationId],
    );

    const theirs = await ask(
      api.app,
      "GET",
      "/api/organization/billing",
      acme.key,
    );
    const ours = await ask(
      api.app,
      "GET",
      "/api/organization/billing",
      globex.key,
    );
    expect((theirs.body as unknown as BillingAnswer).plan.code).toBe("hobby");
    expect((ours.body as unknown as BillingAnswer).plan.code).toBe("pro");
    // Pro's chat is unlimited, which the answer says as an absence rather than
    // as a zero.
    expect(
      (ours.body as unknown as BillingAnswer).plan.allowances[0]?.allowed,
    ).toBeNull();
  });

  it("gives a member the plan and the balance, and no breakdown", async () => {
    await aBillingDeployment("cloud_billing_member");
    const acme = await aCustomerWithARun("ada@acme.example", "Acme");

    await api.database.sql(
      "update membership set role = 'member' where user_id = $1",
      [acme.customer.userId],
    );
    const asMember = await mintKey(api.app, acme.customer.cookie, "Acme");
    const answer = await ask(
      api.app,
      "GET",
      "/api/organization/billing",
      asMember,
    );
    expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200);
    const read = answer.body as unknown as BillingAnswer;
    expect(read.balanceMicros).toBe(WELCOME_CREDIT_MICROS);
    expect(read.mayManageBilling).toBe(false);
    expect(read.charges).toEqual([]);
  });

  it("refuses a request with no credential", async () => {
    await aBillingDeployment("cloud_billing_uncredentialed");
    const response = await api.app.inject({
      method: "GET",
      url: "/api/organization/billing",
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("starting a run an organization cannot pay for", () => {
  it("is refused, naming the spent allowance and its reset date", async () => {
    await aBillingDeployment("cloud_billing_run_start");
    const acme = await aCustomerWithARun("ada@acme.example", "Acme");
    const globex = await aCustomerWithARun("gil@globex.example", "Globex");

    // Five hundred is the number the Hobby row publishes, so five hundred is
    // what this spends.
    await chatConversations(acme, 500);

    const refused = await ask(api.app, "POST", "/v1/runs", acme.key, {
      suiteId: acme.suiteId,
      agentId: acme.agentId,
      connectionId: acme.connectionId,
    });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    const message = String(
      (refused.body as { message?: unknown }).message ?? "",
    );
    expect(message).toContain("500");
    expect(message).toContain("Hobby");
    expect(message).toContain("Settings");

    // And the other customer's month is its own.
    const admitted = await ask(api.app, "POST", "/v1/runs", globex.key, {
      suiteId: globex.suiteId,
      agentId: globex.agentId,
      connectionId: globex.connectionId,
    });
    expect(admitted.statusCode, JSON.stringify(admitted.body)).toBe(201);
  });

  it("is refused when Egma's key cannot pay for the providers it needs", async () => {
    await aBillingDeployment("cloud_billing_run_start_funding");
    const acme = await aCustomerWithARun("ada@acme.example", "Acme");

    // The balance spent, as a correction an operator would write.
    await spendTheBalance(acme);

    const refused = await ask(api.app, "POST", "/v1/runs", acme.key, {
      suiteId: acme.suiteId,
      agentId: acme.agentId,
      connectionId: acme.connectionId,
    });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(422);
    const message = String(
      (refused.body as { message?: unknown }).message ?? "",
    );
    // A chat conversation needs its persona's LLM and nothing else.
    expect(message).toContain("openai");
    expect(message).toContain("$0.00");
    expect(message).toContain("Settings");

    // Nothing was written: one run in this project, the one the fixture made.
    const { rows } = await api.database.sql<{ started: string }>(
      "select count(*)::text as started from run where project_id = $1",
      [acme.customer.projectId],
    );
    expect(rows[0]?.started).toBe("1");
  });
});

/** This customer's welcome credit spent, as an operator's correction. */
async function spendTheBalance(seeded: Seeded): Promise<void> {
  await api.database.sql(
    `insert into cloud_ledger_entry
       (id, organization_id, kind, amount_micros, reference_kind,
        reference_id, idempotency_key, occurred_at)
     values ($1, $2, 'correction', $3, 'operator', 'this-test',
             'this-test-spends-' || $2, now())`,
    [newId("cle"), seeded.customer.organizationId, -WELCOME_CREDIT_MICROS],
  );
  await api.database.sql(
    "update cloud_billing_account set balance_micros = 0 where organization_id = $1",
    [seeded.customer.organizationId],
  );
}

type HoldAnswer = {
  runId: string;
  holds: {
    held: string;
    allowance?: string;
    resetsAt?: string;
    providers?: string[];
    message: string;
  }[];
};

describe("why a run's queued work is waiting", () => {
  it("names the spent allowance while the month is spent", async () => {
    await aBillingDeployment("cloud_billing_run_hold");
    const acme = await aCustomerWithARun("ada@acme.example", "Acme");
    await chatConversations(acme, 500);

    const answer = await ask(
      api.app,
      "GET",
      `/api/runs/${acme.runId}/billing-hold`,
      acme.key,
    );
    expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200);
    const read = answer.body as unknown as HoldAnswer;
    expect(read.runId).toBe(acme.runId);
    const allowance = read.holds.find((hold) => hold.held === "allowance");
    expect(allowance?.allowance).toBe("chat_simulations");
    expect(allowance?.resetsAt).toBe(PERIOD.resetsAt.toISOString());
    expect(allowance?.message).toContain("Hobby");
  });

  it("names the unfunded providers when the balance is spent", async () => {
    await aBillingDeployment("cloud_billing_run_hold_funding");
    const acme = await aCustomerWithARun("ada@acme.example", "Acme");

    await spendTheBalance(acme);

    const answer = await ask(
      api.app,
      "GET",
      `/api/runs/${acme.runId}/billing-hold`,
      acme.key,
    );
    expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200);
    const read = answer.body as unknown as HoldAnswer;
    const funding = read.holds.find((hold) => hold.held === "funding");
    // A chat simulation needs its persona's LLM and nothing else.
    expect(funding?.providers).toEqual(["openai"]);
    expect(funding?.message).toContain("$0.00");
  });

  it("says nothing about a run with nothing waiting", async () => {
    await aBillingDeployment("cloud_billing_run_hold_quiet");
    const acme = await aCustomerWithARun("ada@acme.example", "Acme");
    await chatConversations(acme, 500);
    // Nothing of this run is still waiting.
    await api.database.sql(
      "delete from simulation where run_id = $1 and status = 'queued'",
      [acme.runId],
    );

    const answer = await ask(
      api.app,
      "GET",
      `/api/runs/${acme.runId}/billing-hold`,
      acme.key,
    );
    expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200);
    expect((answer.body as unknown as HoldAnswer).holds).toEqual([]);
  });

  it("answers nothing at all on a deployment that does not bill", async () => {
    // No plug-in, no routes: every allowance unlimited and every provider
    // funded, which is the deployment every self-hoster runs.
    api = await createApi("cloud_billing_absent", {
      retellFetch: RETELL_CHAT_FETCH,
    });
    const acme = await aCustomerWithARun("ada@acme.example", "Acme");
    await chatConversations(acme, 500);

    const hold = await ask(
      api.app,
      "GET",
      `/api/runs/${acme.runId}/billing-hold`,
      acme.key,
    );
    expect(hold.statusCode, JSON.stringify(hold.body)).toBe(200);
    expect((hold.body as unknown as HoldAnswer).holds).toEqual([]);

    // The Billing section is not mounted, so its address is not there.
    const billing = await ask(
      api.app,
      "GET",
      "/api/organization/billing",
      acme.key,
    );
    expect(billing.statusCode).toBe(404);

    // And a run past five hundred chat simulations still starts.
    const started = await ask(api.app, "POST", "/v1/runs", acme.key, {
      suiteId: acme.suiteId,
      agentId: acme.agentId,
      connectionId: acme.connectionId,
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

    // No cloud row was written for anybody.
    const { rows } = await api.database.sql(
      "select 1 from cloud_billing_account",
    );
    expect(rows).toHaveLength(0);
  });
});

describe("what the claim door does when a customer's month is spent", () => {
  it("leaves the conversation queued and never stops one already running", async () => {
    await aBillingDeployment("cloud_billing_claim");
    const acme = await aCustomerWithARun("ada@acme.example", "Acme");
    await chatConversations(acme, 500);

    // One conversation of this run is already being conducted. Billing must
    // never reach it: a claimed simulation finishes.
    const running = newId("sim");
    await api.database.sql(
      `insert into simulation
         (id, run_id, organization_id, project_id, agent_id, connection_id,
          persona_id, persona_version_id, persona_parameter_values, test_id, test_version_id,
          position, modality, connection_type, status,
          claimed_by, claimed_at, heartbeat_at, started_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8,
               (select persona_parameter_values from simulation where run_id = $2 order by position limit 1),
               $9, $10, 9001, 'chat',
               'retell_chat_api', 'running', 'the-simulator', now(), now(),
               now())`,
      [
        running,
        acme.runId,
        acme.customer.organizationId,
        acme.customer.projectId,
        acme.agentId,
        acme.connectionId,
        acme.personaId,
        acme.personaVersionId,
        acme.testId,
        acme.testVersionId,
      ],
    );

    const claimed = await api.app.inject({
      method: "POST",
      url: CLAIMS_PATH,
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
      payload: {
        contract_versions: [5],
        claimant: "sim-1",
        capacity: 10,
        wait_seconds: 0,
      },
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    const handed = (claimed.json() as { specs: unknown[] }).specs;
    expect(handed).toEqual([]);

    // Back on the queue, not failed: nothing is wrong with it.
    const { rows } = await api.database.sql<{ status: string }>(
      "select status from simulation where run_id = $1 and position < 9000 and position >= 1 order by position limit 1",
      [acme.runId],
    );
    expect(rows[0]?.status).toBe("queued");

    // And the one already being conducted is exactly where it was.
    const { rows: live } = await api.database.sql<{ status: string }>(
      "select status from simulation where id = $1",
      [running],
    );
    expect(live[0]?.status).toBe("running");
  });

  it("leaves it queued when Egma's key cannot pay for its providers", async () => {
    await aBillingDeployment("cloud_billing_claim_funding");
    const acme = await aCustomerWithARun("ada@acme.example", "Acme");
    // The allowance is untouched. What is spent is the balance, so the door
    // refuses for the other of the two reasons.
    await spendTheBalance(acme);

    const claimed = await api.app.inject({
      method: "POST",
      url: CLAIMS_PATH,
      headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` },
      payload: {
        contract_versions: [5],
        claimant: "sim-1",
        capacity: 10,
        wait_seconds: 0,
      },
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(
      (claimed.json() as { specs: unknown[] }).specs,
    ).toEqual([]);

    const { rows } = await api.database.sql<{ status: string }>(
      "select status from simulation where run_id = $1",
      [acme.runId],
    );
    expect(rows.map((row) => row.status)).toEqual(["queued"]);

    // And the run page says which of the two reasons it was, by name.
    const hold = await ask(
      api.app,
      "GET",
      `/api/runs/${acme.runId}/billing-hold`,
      acme.key,
    );
    const read = hold.body as unknown as HoldAnswer;
    expect(read.holds.map((one) => one.held)).toEqual(["funding"]);
    expect(read.holds[0]?.providers).toEqual(["openai"]);
  });
});
