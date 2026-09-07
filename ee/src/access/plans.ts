import { newId } from "@egma/ids";
import { fencedDatabase, schema, type Queryable } from "@egma/db";
import { eq } from "drizzle-orm";

import { readPlanCatalog, type PlanCatalog, type PlanEntry, type PlanCode } from "../plans.ts";

const { cloudPlan } = schema;

/**
 * The plan rows: written on boot from the shipped file, read by everything
 * that has to know what a plan includes.
 *
 * **The deployment configuring itself**, the way the rate card, the persona
 * shelf and the grader catalog do: no customer, no session, and an upsert that
 * writes nothing when the file has not changed — so every instance can run it
 * on every boot.
 *
 * **It updates where the rate card does not, and the difference is real.** A
 * rate-card row is cited by a stored usage record, so editing one would
 * silently re-price work already charged for; a plan row is current
 * configuration, and changing Pro's phone allowance means changing it for
 * everybody on Pro from that moment. So the file is the plan and the row
 * follows it.
 *
 * **The three Stripe price columns are never touched here.** They are written
 * by whoever creates the Stripe objects, not by this file, and an upsert that
 * set them from the file would blank them on the next boot.
 */

/** One plan as a row of `cloud_plan` holds it. */
export type CloudPlan = {
  readonly code: PlanCode;
  readonly name: string;
  readonly feeMicros: number;
  /** `null` is unlimited. */
  readonly chatSimulationsAllowance: number | null;
  readonly webCallMinutesAllowance: number | null;
  readonly phoneMinutesAllowance: number | null;
  readonly webCallOverageMicrosPerMinute: number;
  readonly phoneOverageMicrosPerMinute: number;
};

const PLAN_COLUMNS = {
  code: cloudPlan.code,
  name: cloudPlan.name,
  feeMicros: cloudPlan.feeMicros,
  chatSimulationsAllowance: cloudPlan.chatSimulationsAllowance,
  webCallMinutesAllowance: cloudPlan.webCallMinutesAllowance,
  phoneMinutesAllowance: cloudPlan.phoneMinutesAllowance,
  webCallOverageMicrosPerMinute: cloudPlan.webCallOverageMicrosPerMinute,
  phoneOverageMicrosPerMinute: cloudPlan.phoneOverageMicrosPerMinute,
} as const;

/** What one boot of the plan seed wrote. */
export type SeededPlans = {
  /** The plan codes this call inserted or changed. Empty on an unchanged boot. */
  readonly written: readonly PlanCode[];
};

export async function seedCloudPlans(
  catalog?: PlanCatalog,
): Promise<SeededPlans> {
  const read = catalog ?? (await readPlanCatalog());
  const written: PlanCode[] = [];
  for (const plan of read.plans) {
    const changed = await upsertOnePlan(plan);
    if (changed) written.push(plan.code);
  }
  return { written };
}

async function upsertOnePlan(plan: PlanEntry): Promise<boolean> {
  const values = {
    name: plan.name,
    feeMicros: plan.feeMicros,
    chatSimulationsAllowance: plan.allowances.chat_simulations,
    webCallMinutesAllowance: plan.allowances.web_call_minutes,
    phoneMinutesAllowance: plan.allowances.phone_minutes,
    webCallOverageMicrosPerMinute: plan.webCallOverageMicrosPerMinute,
    phoneOverageMicrosPerMinute: plan.phoneOverageMicrosPerMinute,
  };
  const [before] = await fencedDatabase()
    .select(PLAN_COLUMNS)
    .from(cloudPlan)
    .where(eq(cloudPlan.code, plan.code))
    .limit(1);

  await fencedDatabase()
    .insert(cloudPlan)
    .values({ id: newId("cpl"), code: plan.code, ...values })
    .onConflictDoUpdate({
      target: cloudPlan.code,
      set: { ...values, updatedAt: new Date() },
    });

  if (before === undefined) return true;
  return (
    before.name !== values.name ||
    before.feeMicros !== values.feeMicros ||
    before.chatSimulationsAllowance !== values.chatSimulationsAllowance ||
    before.webCallMinutesAllowance !== values.webCallMinutesAllowance ||
    before.phoneMinutesAllowance !== values.phoneMinutesAllowance ||
    before.webCallOverageMicrosPerMinute !==
      values.webCallOverageMicrosPerMinute ||
    before.phoneOverageMicrosPerMinute !== values.phoneOverageMicrosPerMinute
  );
}

/**
 * The plan a code names.
 *
 * It throws where the row is missing rather than answering "unlimited",
 * because a deployment whose plan rows failed to seed must refuse to answer a
 * question about an allowance rather than answer it generously: the customer
 * whose month is enforced against a plan nobody wrote is worse off than the
 * one whose page says the read failed.
 */
export async function readPlan(
  code: PlanCode,
  on: Queryable = fencedDatabase(),
): Promise<CloudPlan> {
  const [plan] = await on
    .select(PLAN_COLUMNS)
    .from(cloudPlan)
    .where(eq(cloudPlan.code, code))
    .limit(1);
  if (plan === undefined) {
    throw new Error(
      `the ${code} plan has no row; the plan seed has not run on this ` +
        "deployment, and an allowance cannot be answered without one",
    );
  }
  return { ...plan, code };
}
