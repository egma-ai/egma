import assert from "node:assert/strict";

import { newId } from "@egma/ids";

import { ALLOWANCE_KINDS } from "./allowance.ts";
import type {
  EntitlementSource,
  StoredUsageRecord,
  UsageSink,
} from "./ports.ts";

/**
 * What every adapter of each port must do, whichever one it is.
 *
 * **Shipped as functions rather than as a test file, so both adapters are held
 * to one list.** The open adapters are run through this from
 * `test/billing-ports.test.ts`; the cloud adapter in `ee/` is run through the
 * same functions by its own suite, seeded with the plan and balance rows Stripe
 * would have written. Neither list can drift from the other, because there is
 * only one.
 *
 * It imports no test runner. Each check is a name and a function that throws
 * when the adapter is wrong, so any runner can drive it — and so an adapter
 * can be checked from a script, which is what the day of a plug-in swap
 * actually looks like.
 *
 * **It says nothing about what an adapter should answer.** "Yes" and "no" are
 * both correct answers to "may this organization start a chat simulation": the
 * open adapter always says yes and the cloud one says it depends. What the
 * contract holds is the shape of the conversation — that a refusal names an
 * allowance that was actually asked about, that asking twice does not change
 * the answer, that a sink takes what it is handed — because those are the
 * promises a caller writes its own code against.
 */

/** One thing an adapter must do. `run` throws when it does not. */
export type PortCheck = {
  readonly name: string;
  readonly run: () => Promise<void>;
};

/** How a suite gets a fresh adapter for each check. */
export type AdapterFactory<T> = () => T | Promise<T>;

/**
 * The world these checks run in, for an adapter that keeps rows.
 *
 * **The open adapters need none of it and the cloud one needs all of it.** An
 * adapter that answers "yes, unlimited" and throws its records away is correct
 * about an organization nobody has ever created; an adapter that writes a
 * ledger row is not — its writes have foreign keys, and a check that handed it
 * a made-up organization would prove only that the adapter had swallowed the
 * failure. So a suite driving one supplies a customer that exists, and a way
 * to make each record real before it is delivered.
 *
 * Both are optional and both default to nothing, so the open adapters are held
 * to exactly the list they were held to before this existed.
 */
export type PortWorld = {
  /** The organization every check below asks about. */
  readonly organizationId?: string;
  /** The project its records belong to. */
  readonly projectId?: string;
  /**
   * Make one record real — store the `usage_record` row it names — before it
   * is handed to the sink. Called once per record, before every delivery of
   * it, so a check that delivers the same record twice prepares it once.
   */
  prepare?(record: StoredUsageRecord): Promise<void>;
};

const THE_MADE_UP_ORGANIZATION = newId("org");

/**
 * What every entitlement source must do.
 *
 * The factory is called once per check, so an adapter that keeps state cannot
 * pass by having been warmed up by the check before.
 */
export function entitlementSourceContract(
  make: AdapterFactory<EntitlementSource>,
  world: PortWorld = {},
): readonly PortCheck[] {
  const source = async (): Promise<EntitlementSource> => make();
  const AN_ORGANIZATION = world.organizationId ?? THE_MADE_UP_ORGANIZATION;

  return [
    {
      name: "answers a request that asks about nothing",
      async run() {
        const decision = await (
          await source()
        ).mayStart({ organizationId: AN_ORGANIZATION, allowances: [] });
        assert.deepEqual(
          decision,
          { allowed: true },
          "nothing was asked about, so nothing can be refused",
        );
      },
    },
    {
      name: "answers every allowance kind, asked together",
      async run() {
        const decision = await (
          await source()
        ).mayStart({
          organizationId: AN_ORGANIZATION,
          allowances: [...ALLOWANCE_KINDS],
        });
        assertStartDecision(decision, [...ALLOWANCE_KINDS]);
      },
    },
    ...ALLOWANCE_KINDS.map((allowance) => ({
      name: `answers a request for ${allowance}`,
      async run() {
        const decision = await (
          await source()
        ).mayStart({ organizationId: AN_ORGANIZATION, allowances: [allowance] });
        assertStartDecision(decision, [allowance]);
      },
    })),
    {
      name: "asking does not spend anything",
      async run() {
        const asked = await source();
        const request = {
          organizationId: AN_ORGANIZATION,
          allowances: [...ALLOWANCE_KINDS],
        };
        const first = await asked.mayStart(request);
        const second = await asked.mayStart(request);
        assert.equal(
          first.allowed,
          second.allowed,
          "the same question answered twice must answer the same way: it is a " +
            "question about an allowance, never a reservation of one",
        );
      },
    },
    {
      name: "answers a funding request that names no provider",
      async run() {
        const decision = await (
          await source()
        ).mayPlatformKeyFund({
          organizationId: AN_ORGANIZATION,
          providers: [],
        });
        assert.deepEqual(decision, { funded: true });
      },
    },
    {
      name: "answers a funding request, naming only providers it was asked about",
      async run() {
        const providers = ["openai", "deepgram", "cartesia"];
        const decision = await (
          await source()
        ).mayPlatformKeyFund({
          organizationId: AN_ORGANIZATION,
          providers,
        });
        if (decision.funded) {
          assert.deepEqual(decision, { funded: true });
          return;
        }
        assert.ok(
          decision.providers.length > 0,
          "a refusal has to say which providers have no funding",
        );
        for (const provider of decision.providers) {
          assert.ok(
            providers.includes(provider),
            `${provider} was not asked about`,
          );
        }
        assertSentence(decision.message);
      },
    },
  ];
}

/** What every usage sink must do. */
export function usageSinkContract(
  make: AdapterFactory<UsageSink>,
  world: PortWorld = {},
): readonly PortCheck[] {
  const sink = async (): Promise<UsageSink> => make();
  /** One record, made real where the suite gave a way to make one real. */
  const record = async (
    overrides: Partial<StoredUsageRecord> = {},
  ): Promise<StoredUsageRecord> => {
    const one = storedRecord({
      ...(world.organizationId === undefined
        ? {}
        : { organizationId: world.organizationId }),
      ...(world.projectId === undefined ? {} : { projectId: world.projectId }),
      ...overrides,
    });
    await world.prepare?.(one);
    return one;
  };

  return [
    {
      name: "takes an empty delivery",
      async run() {
        await (await sink()).receive([]);
      },
    },
    {
      name: "takes one stored record",
      async run() {
        await (await sink()).receive([await record()]);
      },
    },
    {
      name: "takes a batch",
      async run() {
        await (
          await sink()
        ).receive([await record(), await record(), await record()]);
      },
    },
    {
      name: "takes a record the customer's own key paid for",
      async run() {
        // Nothing is owed for one, and a sink that assumed every record was
        // Egma's key would charge a customer for their own provider account.
        await (
          await sink()
        ).receive([await record({ paymentSource: "customer" })]);
      },
    },
    {
      name: "takes a record that cost nothing",
      async run() {
        // A quantity with no price effective at its instant is stored at zero.
        // It is real usage and the sink still sees it.
        await (await sink()).receive([await record({ amountMicros: 0 })]);
      },
    },
    {
      name: "takes the same record again without failing",
      async run() {
        // Notifications can repeat with the same durable usage identity.
        const receiving = await sink();
        const delivered = await record();
        await receiving.receive([delivered]);
        await receiving.receive([delivered]);
      },
    },
  ];
}

/** A refusal names an allowance that was asked about, and says why. */
function assertStartDecision(
  decision: Awaited<ReturnType<EntitlementSource["mayStart"]>>,
  asked: readonly string[],
): void {
  if (decision.allowed) {
    assert.deepEqual(
      decision,
      { allowed: true },
      "an allowed decision carries nothing else",
    );
    return;
  }
  assert.ok(
    decision.refusals.length > 0,
    "a refusal has to say which allowance is spent",
  );
  for (const refusal of decision.refusals) {
    assert.ok(
      asked.includes(refusal.allowance),
      `${refusal.allowance} was not asked about`,
    );
    assert.ok(
      refusal.resetsAt instanceof Date && !Number.isNaN(refusal.resetsAt.getTime()),
      "a refusal has to name the date the allowance comes back",
    );
    assertSentence(refusal.message);
  }
}

function assertSentence(message: string): void {
  assert.ok(
    typeof message === "string" && message.trim() !== "",
    "a refusal is shown to a person, so it carries a sentence",
  );
}

function storedRecord(
  overrides: Partial<StoredUsageRecord> = {},
): StoredUsageRecord {
  return {
    id: JSON.stringify([THE_MADE_UP_ORGANIZATION, "project", "trace", newId("sim")]),
    organizationId: THE_MADE_UP_ORGANIZATION,
    projectId: newId("prj"),
    occurredAt: new Date("2026-09-07T10:00:00.000Z"),
    provider: "openai",
    model: "gpt-4o-mini",
    paymentSource: "platform",
    amountMicros: 240,
    ...overrides,
  };
}
