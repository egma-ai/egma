import { readFile } from "node:fs/promises";
import path from "node:path";

import { ALLOWANCE_KINDS, schema, type AllowanceKind } from "@egma/db";

/**
 * The cloud tables' own vocabulary, reached through the one entry point
 * `@egma/db` offers. The tables are in the shared migration tree because a
 * migration tree with a hole in it is not one; their words are read from there
 * rather than written a second time here, so a plan code this package accepts
 * is a plan code the database's own check allows.
 */
const { PLAN_CODES } = schema;
export type PlanCode = schema.PlanCode;

/**
 * The plan catalog as the shipped file states it.
 *
 * **Prices are data, not code.** The launch values live in `plans.json` beside
 * this file for the reason the rate card's live in theirs: a price change is a
 * change with a date on it that a founder makes, and the file's history is the
 * price history. This module is the vocabulary that file is written in and the
 * reader that refuses a file which drifted from it. Nothing here reaches a
 * store.
 *
 * Invalid plan data raises a billing fault. The process can keep serving while
 * the billing initialization retries.
 */

/** One plan, exactly as a row of `cloud_plan` holds it. */
export type PlanEntry = {
  readonly code: PlanCode;
  readonly name: string;
  readonly feeMicros: number;
  /**
   * The three allowances, in the units the glossary publishes them in:
   * simulations for chat, minutes for the two voice kinds. `null` is
   * unlimited.
   */
  readonly allowances: Readonly<Record<AllowanceKind, number | null>>;
  readonly webCallOverageMicrosPerMinute: number;
  readonly phoneOverageMicrosPerMinute: number;
};

/** The whole file: the plans, and the credit every organization starts with. */
export type PlanCatalog = {
  readonly welcomeCreditMicros: number;
  readonly chargingIntervalSeconds: number;
  readonly plans: readonly PlanEntry[];
};

/**
 * Where the shipped file is.
 *
 * `import.meta.dirname` is `src` when this module runs as TypeScript and
 * `dist` when it runs as the build's JavaScript. One level up is the package
 * root either way, and the file is read from `src` from there — the same trick
 * the rate card uses, and the reason `src/plans.json` is in this package's
 * `files` list.
 */
export function planCatalogFile(): string {
  return path.join(import.meta.dirname, "..", "src", "plans.json");
}

export async function readPlanCatalog(
  file: string = planCatalogFile(),
): Promise<PlanCatalog> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  const read = parsed as Record<string, unknown>;

  const welcomeCreditMicros = read["welcomeCreditMicros"];
  if (!isWholeMoney(welcomeCreditMicros) || welcomeCreditMicros <= 0) {
    throw new Error(
      `${file} states no welcome credit; it is a whole number of ` +
        "micro-dollars above zero",
    );
  }

  const stated = read["plans"];
  if (!Array.isArray(stated) || stated.length === 0) {
    throw new Error(`${file} carries no plans`);
  }

  const plans = stated.map((one) => planFrom(one as Record<string, unknown>, file));
  for (const code of PLAN_CODES) {
    if (!plans.some((plan) => plan.code === code)) {
      throw new Error(`${file} states no ${code} plan`);
    }
  }
  const codes = new Set(plans.map((plan) => plan.code));
  if (codes.size !== plans.length) {
    throw new Error(`${file} states one plan code twice`);
  }

  const chargingIntervalSeconds = read["chargingIntervalSeconds"];
  if (typeof chargingIntervalSeconds !== "number" || !Number.isSafeInteger(chargingIntervalSeconds) || chargingIntervalSeconds <= 0) {
    throw new Error(`${file} needs a positive whole charging interval`);
  }
  return { welcomeCreditMicros, chargingIntervalSeconds, plans };
}

function planFrom(read: Record<string, unknown>, file: string): PlanEntry {
  const code = read["code"];
  if (typeof code !== "string" || !isPlanCode(code)) {
    throw new Error(
      `${file} states a plan whose code is not one of ${PLAN_CODES.join(", ")}`,
    );
  }
  const name = read["name"];
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`the ${code} plan in ${file} has no name`);
  }
  const feeMicros = read["feeMicros"];
  if (!isWholeMoney(feeMicros)) {
    throw new Error(`the ${code} plan in ${file} has no fee in micro-dollars`);
  }

  const allowances = {
    chat_simulations: allowanceFrom(read["chatSimulations"], code, "chatSimulations", file),
    web_call_minutes: allowanceFrom(read["webCallMinutes"], code, "webCallMinutes", file),
    phone_minutes: allowanceFrom(read["phoneMinutes"], code, "phoneMinutes", file),
  } satisfies Record<AllowanceKind, number | null>;
  // The three kinds are the product's, so a fourth kind added there has to be
  // answered here rather than silently defaulting to unlimited.
  for (const kind of ALLOWANCE_KINDS) {
    if (!(kind in allowances)) {
      throw new Error(`the ${code} plan in ${file} states no ${kind} allowance`);
    }
  }

  const webCallOverageMicrosPerMinute = read["webCallOverageMicrosPerMinute"];
  const phoneOverageMicrosPerMinute = read["phoneOverageMicrosPerMinute"];
  if (
    !isWholeMoney(webCallOverageMicrosPerMinute) ||
    !isWholeMoney(phoneOverageMicrosPerMinute)
  ) {
    throw new Error(
      `the ${code} plan in ${file} needs both overage prices in ` +
        "micro-dollars per minute, at zero where the plan pauses instead",
    );
  }

  return {
    code,
    name,
    feeMicros,
    allowances,
    webCallOverageMicrosPerMinute,
    phoneOverageMicrosPerMinute,
  };
}

function allowanceFrom(
  value: unknown,
  code: string,
  field: string,
  file: string,
): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `the ${code} plan in ${file} states ${field} as ${String(value)}; an ` +
        "allowance is a whole number, or null for unlimited",
    );
  }
  return value;
}

function isPlanCode(value: string): value is PlanCode {
  return PLAN_CODES.some((code) => code === value);
}

/** Money is counted, so every amount in the file is a whole micro-dollar. */
function isWholeMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
