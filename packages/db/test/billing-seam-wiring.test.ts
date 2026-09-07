import { newId } from "@egma/ids";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  RunWriteRefusedError,
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  installBillingPlugIn,
  listSimulations,
  openBillingPlugIn,
  openEntitlementSource,
  recordProviderUsage,
  startRun,
  upsertRateCard,
  type AllowanceKind,
  type AuthContext,
  type EntitlementSource,
  type NewUsageRecord,
  type StartRequest,
  type StoredUsageRecord,
} from "../src/index.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The two seams, asked of the real writes.
 *
 * What is proven is that the product asks and obeys — not what any particular
 * adapter answers. The adapters here are written in the test, because that is
 * the whole point of a port: an answer nobody in this repository can give yet
 * still has to change what the product does.
 */

let database: MigratedDatabase;
let restore: (() => void) | undefined;

const acme = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
};
const globex = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
};

function sessionOf(who: typeof acme): AuthContext {
  return {
    userId: who.userId,
    organizationId: who.organizationId,
    projectId: who.projectId,
    role: "admin",
    via: "session",
  };
}

function conductingContextFor(who: typeof acme): AuthContext {
  return {
    userId: "the-simulator",
    organizationId: who.organizationId,
    projectId: who.projectId,
    role: "member",
    via: "simulator",
  };
}

/** An entitlement source that writes down what it was asked. */
function recording(
  answer: (request: StartRequest) => Awaited<
    ReturnType<EntitlementSource["mayStart"]>
  > = () => ({ allowed: true }),
): { readonly asked: StartRequest[]; readonly source: EntitlementSource } {
  const asked: StartRequest[] = [];
  return {
    asked,
    source: {
      mayStart(request) {
        asked.push(request);
        return Promise.resolve(answer(request));
      },
      mayPlatformKeyFund: openEntitlementSource().mayPlatformKeyFund,
    },
  };
}

function refusing(allowance: AllowanceKind): EntitlementSource {
  return {
    mayStart: () =>
      Promise.resolve({
        allowed: false,
        refusals: [
          {
            allowance,
            resetsAt: new Date("2026-10-15T08:00:00.000Z"),
            message:
              "This organization has used all of its chat simulations. " +
              "They come back on 15 October.",
          },
        ],
      }),
    mayPlatformKeyFund: openEntitlementSource().mayPlatformKeyFund,
  };
}

/** Everything one run needs, made through the module. */
async function readyToRun(who: typeof acme): Promise<{
  agentId: string;
  connectionId: string;
  suiteId: string;
}> {
  const auth = sessionOf(who);
  const label = newId("run").slice(-8);
  const created = await createAgent(auth, {
    agentPlatform: "retell",
    name: `Front desk ${label}`,
    connection: {
      agentPlatform: "retell",
      connectionType: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      config: { retellAgentId: `agent_${label}` },
      credentials: { apiKey: `retell-secret-${label}` },
    },
  });
  const personaId = (
    await createPersona(auth, {
      name: `Impatient Rita ${label}`,
      identityName: "Sam Poole",
      personality: "Speaks plainly and asks one question at a time.",
      language: "en-US",
    })
  ).id;
  const suite = await createTestSuite(auth, { name: `Seam ${label}` });
  await createTest(auth, {
    suiteId: suite.id,
    name: `Reschedules ${label}`,
    scenario: "Their cleaning has to move to any afternoon next week.",
    expectedBehaviors: ["confirms the new time back before finishing"],
    personaIds: [personaId],
  });
  return {
    agentId: created.id,
    connectionId: created.connection?.id ?? "",
    suiteId: suite.id,
  };
}

beforeAll(async () => {
  database = await createConnectedDatabase("billing_seam_wiring");
  await upsertRateCard();
  for (const who of [acme, globex]) {
    await seedOrganization(database, who.organizationId, [
      { id: who.projectId, slug: `p${who.projectId.slice(-6).toLowerCase()}` },
    ]);
    await seedUser(database, who.userId, `${who.userId}@example.test`);
  }
});

afterEach(() => {
  restore?.();
  restore = undefined;
});

afterAll(async () => {
  await database.drop();
});

describe("run start asks the entitlement source", () => {
  it("asks once, naming the organization and the kind of work", async () => {
    const listener = recording();
    restore = installBillingPlugIn({
      ...openBillingPlugIn(),
      entitlements: listener.source,
    });

    const ready = await readyToRun(acme);
    await startRun(sessionOf(acme), {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });

    expect(listener.asked).toEqual([
      {
        organizationId: acme.organizationId,
        allowances: ["chat_simulations"],
      },
    ]);
  });

  it("refuses the run when told no, and writes nothing", async () => {
    const ready = await readyToRun(acme);
    restore = installBillingPlugIn({
      ...openBillingPlugIn(),
      entitlements: refusing("chat_simulations"),
    });

    const refused = await startRun(sessionOf(acme), {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    }).catch((fault: unknown) => fault);

    expect(refused).toBeInstanceOf(RunWriteRefusedError);
    const error = refused as RunWriteRefusedError;
    expect(error.reason).toBe("allowance_spent");
    // The adapter's own sentence, relayed word for word.
    expect(error.message).toContain("come back on 15 October");

    // Nothing was written: no run, and therefore no queued conversation to
    // explain to anybody.
    const { rows } = await database.sql<{ started: string }>(
      "select count(*)::text as started from run where suite_id = $1",
      [ready.suiteId],
    );
    expect(rows[0]?.started).toBe("0");
  });

  it("starts exactly as before when nothing is installed", async () => {
    // The acceptance criterion, stated: with no billing adapter in place the
    // run is the run it always was.
    const ready = await readyToRun(globex);
    const started = await startRun(sessionOf(globex), {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    expect(started.status).toBe("pending");
    expect((await listSimulations(sessionOf(globex), started.id))?.items).toHaveLength(
      1,
    );
  });
});

describe("stored usage records reach the usage sink", () => {
  async function oneSimulation(who: typeof acme): Promise<{
    simulationId: string;
    runId: string;
  }> {
    const ready = await readyToRun(who);
    const started = await startRun(sessionOf(who), {
      suiteId: ready.suiteId,
      agentId: ready.agentId,
      connectionId: ready.connectionId,
      idempotencyKey: newId("run"),
    });
    const one = (await listSimulations(sessionOf(who), started.id))?.items[0];
    if (one === undefined) throw new Error("the run has no simulation");
    return { simulationId: one.id, runId: started.id };
  }

  function llmRecord(
    simulationId: string,
    runId: string,
    spanId: string,
  ): NewUsageRecord {
    return {
      identity: { work: "simulation", simulationId, spanId },
      occurredAt: new Date("2026-09-08T10:00:00.000Z"),
      runId,
      provider: "openai",
      model: "gpt-4o-mini",
      operation: "openai_chat_completions",
      quantities: { input_tokens: 1_000, output_tokens: 100 },
      measurement: "provider_reported",
      providerRef: `chatcmpl-${spanId}`,
      paymentSource: "platform",
      rawUsage: { prompt_tokens: 1_000, completion_tokens: 100 },
    };
  }

  it("hands over what was stored, priced, with its own identity", async () => {
    const received: StoredUsageRecord[][] = [];
    restore = installBillingPlugIn({
      ...openBillingPlugIn(),
      usage: {
        receive(records) {
          received.push([...records]);
          return Promise.resolve();
        },
      },
    });

    const { simulationId, runId } = await oneSimulation(acme);
    const written = await recordProviderUsage(conductingContextFor(acme), [
      llmRecord(simulationId, runId, "aaaaaaaaaaaaaaa1"),
    ]);

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(1);
    const record = received[0]?.[0];
    expect(record?.organizationId).toBe(acme.organizationId);
    expect(record?.projectId).toBe(acme.projectId);
    expect(record?.provider).toBe("openai");
    expect(record?.paymentSource).toBe("platform");
    expect(record?.amountMicros).toBe(written.amountMicros);
    expect(record?.id).toMatch(/^usg_/u);
  });

  it("hands over nothing when a resend stored nothing", async () => {
    const received: StoredUsageRecord[][] = [];
    restore = installBillingPlugIn({
      ...openBillingPlugIn(),
      usage: {
        receive(records) {
          received.push([...records]);
          return Promise.resolve();
        },
      },
    });

    const { simulationId, runId } = await oneSimulation(acme);
    const record = llmRecord(simulationId, runId, "bbbbbbbbbbbbbbb1");
    await recordProviderUsage(conductingContextFor(acme), [record]);
    await recordProviderUsage(conductingContextFor(acme), [record]);

    // Once, for the delivery that actually stored a row. An adapter charging
    // a balance for what it receives therefore cannot charge twice.
    expect(received).toHaveLength(1);
  });

  it("stores the record even when the sink throws", async () => {
    restore = installBillingPlugIn({
      ...openBillingPlugIn(),
      usage: {
        receive: () => Promise.reject(new Error("the ledger is unreachable")),
      },
    });

    const { simulationId, runId } = await oneSimulation(acme);
    const written = await recordProviderUsage(conductingContextFor(acme), [
      llmRecord(simulationId, runId, "ccccccccccccccc1"),
    ]);

    expect(written.stored).toBe(1);
    const { rows } = await database.sql<{ kept: string }>(
      "select count(*)::text as kept from usage_record where simulation_id = $1",
      [simulationId],
    );
    expect(rows[0]?.kept).toBe("1");
  });
});
