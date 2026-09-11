import { readFile } from "node:fs/promises";
import path from "node:path";

import { PROVIDER_CATALOG, type ProviderCatalogEntry } from "./catalog.ts";

/**
 * The rate card: what one unit of one provider's work costs, per model in the
 * executable catalog beside this file.
 *
 * The prices themselves are in `rate-card.json`, not here, for the reason
 * Langfuse keeps its model prices in a file: a price change is a data change
 * with a date on it, not a code change, and the file's history is then the
 * price history. This module is the vocabulary that file is written in, the
 * reader that refuses a file which drifted from that vocabulary, and the one
 * statement of which usage types each catalog model's adapter can emit.
 *
 * Nothing here reaches a store. The rows the file becomes are written by
 * `upsertRateCard` on boot, and rating happens where a usage record is
 * stored — never in a worker, so a price change never needs a release of one.
 */

/** The units a provider bills Egma's work in, and a usage record carries. */
export const USAGE_UNITS = ["tokens", "seconds", "characters"] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

/**
 * Every quantity a usage record can carry, normalised across providers.
 *
 * Normalised, because the providers do not agree with each other and one of
 * them does not agree with itself: OpenAI's `prompt_tokens` *includes* the
 * cached ones while Anthropic's `input_tokens` excludes them, and a rate card
 * that multiplied both by the uncached price would charge the cache twice.
 *
 * So `input_tokens` here means **uncached input tokens** everywhere, and
 * `cached_input_tokens` is the rest of the prompt. Whoever reads a provider's
 * body does that subtraction once, and the provider's own object rides beside
 * the record verbatim so a wrong subtraction can be re-rated rather than
 * re-measured.
 */
export const USAGE_TYPES = [
  /** Prompt tokens the provider did not serve from its cache. */
  "input_tokens",
  /** Prompt tokens the provider served from its cache, at the cached price. */
  "cached_input_tokens",
  /** Generated tokens, reasoning tokens included — the providers bill them as one. */
  "output_tokens",
  /** Input tokens that were audio, on a transcription billed by token. */
  "audio_input_tokens",
  /** Input tokens that were text, on the same. */
  "text_input_tokens",
  /** Seconds of audio submitted, on anything billed by duration. */
  "audio_seconds",
  /** Characters handed to a speaking leg. */
  "characters",
] as const;
export type UsageType = (typeof USAGE_TYPES)[number];

const UNIT_OF: Readonly<Record<UsageType, UsageUnit>> = {
  input_tokens: "tokens",
  cached_input_tokens: "tokens",
  output_tokens: "tokens",
  audio_input_tokens: "tokens",
  text_input_tokens: "tokens",
  audio_seconds: "seconds",
  characters: "characters",
};

/** The unit a usage type is counted in. One answer, so nothing states a second. */
export function unitOfUsageType(type: UsageType): UsageUnit {
  return UNIT_OF[type];
}

export function isUsageType(value: string): value is UsageType {
  return USAGE_TYPES.some((known) => known === value);
}

/**
 * The one unit a set of measured quantities is in.
 *
 * A record carries one unit because one provider request is billed in one
 * unit — tokens, or seconds, or characters. Deriving it from the quantities
 * rather than accepting it means no caller can state a unit its own numbers
 * disagree with.
 */
export function unitOfQuantities(
  quantities: Readonly<Partial<Record<UsageType, number>>>,
): UsageUnit {
  const units = new Set<UsageUnit>();
  for (const [type, quantity] of Object.entries(quantities)) {
    if (quantity === undefined) continue;
    if (!isUsageType(type)) {
      throw new Error(`${type} is not a usage type Egma measures`);
    }
    units.add(UNIT_OF[type]);
  }
  const [only, ...rest] = [...units];
  if (only === undefined) {
    throw new Error("a usage record measured nothing");
  }
  if (rest.length > 0) {
    throw new Error(
      `a usage record mixes ${[only, ...rest].join(" and ")}; one provider ` +
        "request is billed in one unit",
    );
  }
  return only;
}

const LLM_USAGE_TYPES: readonly UsageType[] = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
];

const TOKEN_TRANSCRIPTION_USAGE_TYPES: readonly UsageType[] = [
  "audio_input_tokens",
  "text_input_tokens",
  "output_tokens",
];

const DURATION_USAGE_TYPES: readonly UsageType[] = ["audio_seconds"];
const CHARACTER_USAGE_TYPES: readonly UsageType[] = ["characters"];

/**
 * The realtime transcription models OpenAI bills by token, not by second.
 *
 * The completed-transcription event says which shape it used in `usage.type`,
 * and the simulator reads that rather than assuming — but the rate card has to
 * be complete before a single simulation runs, so the split is declared here
 * too. The test beside this module holds the two statements together: every
 * catalog model has a price for every usage type this function names.
 */
const TOKEN_BILLED_TRANSCRIPTION: ReadonlySet<string> = new Set([
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
]);

/** Which quantities one catalog model's adapter can put on a usage record. */
export function billableUsageTypesOf(
  entry: ProviderCatalogEntry,
): readonly UsageType[] {
  switch (entry.adapter) {
    case "openai_chat_completions":
      return LLM_USAGE_TYPES;
    case "openai_realtime":
    case "openai_live":
      return TOKEN_BILLED_TRANSCRIPTION.has(entry.model)
        && entry.adapter === "openai_realtime"
        ? TOKEN_TRANSCRIPTION_USAGE_TYPES
        : DURATION_USAGE_TYPES;
    case "deepgram":
    case "cartesia_manual":
      return DURATION_USAGE_TYPES;
    case "cartesia":
    case "openai":
      return CHARACTER_USAGE_TYPES;
  }
}

/** One price: what a million of one usage type costs, and in what unit. */
export type RateCardPrice = {
  readonly usageType: UsageType;
  readonly unit: UsageUnit;
  /**
   * US dollars per 1,000,000 of the unit, as the decimal string the file
   * carries. A string all the way to Postgres `numeric`, because a price that
   * went through a float would arrive with a rounding error nobody chose.
   */
  readonly usdPerMillion: string;
};

/** One model's prices from one effective date. */
export type RateCardEntry = {
  readonly provider: string;
  readonly model: string;
  /** Rating picks the newest entry effective at or before the usage's instant. */
  readonly effectiveFrom: Date;
  /** The provider page the numbers were read from, and the day they were read. */
  readonly source: string;
  readonly readAt: string;
  readonly note?: string;
  /** True where a price is derived rather than published. */
  readonly approximate: boolean;
  readonly prices: readonly RateCardPrice[];
};

/**
 * The file, resolved so the same path serves the sources and the build.
 *
 * A function rather than a constant, so that importing this module's
 * vocabulary — which the schema does — never asks where this file is.
 *
 * `import.meta.dirname` is `src/models` when this module is run as TypeScript
 * and `dist/models` when it is run as the build's JavaScript. Two levels up is
 * the package root either way, and the file is read from the sources from
 * there — the trick `MIGRATIONS_DIRECTORY` uses for the same reason.
 *
 * **The package's `files` list names this one path inside `src`**, so a packed
 * install carries it exactly as it carries the migrations. It has to: the file
 * is applied on boot like a migration is, and a deployment that shipped
 * without it would boot with an empty rate card and price every provider
 * request at nothing.
 */
export function rateCardFile(): string {
  return path.join(
    import.meta.dirname,
    "..",
    "..",
    "src",
    "models",
    "rate-card.json",
  );
}

const A_DATE = /^\d{4}-\d{2}-\d{2}$/;
const A_DECIMAL = /^\d+(\.\d+)?$/;

/**
 * The rate card as the file states it, refused rather than repaired where the
 * file and this module's vocabulary disagree.
 *
 * Every refusal here is a boot failure by design: a deployment that started
 * with a price it could not read would price nothing, silently, and a
 * simulation's cost would be missing rather than wrong — which is the harder
 * of the two to notice.
 */
export async function readRateCard(
  file: string = rateCardFile(),
): Promise<readonly RateCardEntry[]> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${file} carries no rate-card entries`);
  }

  const seen = new Set<string>();
  return entries.map((entry) => {
    const read = entry as Record<string, unknown>;
    const provider = read["provider"];
    const model = read["model"];
    if (typeof provider !== "string" || typeof model !== "string") {
      throw new Error("a rate-card entry names no provider and model");
    }
    const effectiveFrom = read["effectiveFrom"];
    if (typeof effectiveFrom !== "string" || !A_DATE.test(effectiveFrom)) {
      throw new Error(
        `the rate-card entry for ${provider}/${model} has no YYYY-MM-DD effectiveFrom`,
      );
    }
    const key = `${provider}/${model}/${effectiveFrom}`;
    if (seen.has(key)) {
      throw new Error(
        `the rate card states ${provider}/${model} twice from ${effectiveFrom}; ` +
          "a price change is a new entry with a later effective date",
      );
    }
    seen.add(key);

    const source = read["source"];
    const readAt = read["readAt"];
    if (typeof source !== "string" || source === "") {
      throw new Error(
        `the rate-card entry for ${provider}/${model} names no source page`,
      );
    }
    if (typeof readAt !== "string" || !A_DATE.test(readAt)) {
      throw new Error(
        `the rate-card entry for ${provider}/${model} does not say when its source was read`,
      );
    }

    const prices = read["prices"];
    if (typeof prices !== "object" || prices === null || Array.isArray(prices)) {
      throw new Error(
        `the rate-card entry for ${provider}/${model} carries no prices`,
      );
    }

    const priced = Object.entries(prices as Record<string, unknown>).map(
      ([usageType, price]): RateCardPrice => {
        if (!isUsageType(usageType)) {
          throw new Error(
            `the rate card prices ${usageType} for ${provider}/${model}, which is not a usage type Egma measures`,
          );
        }
        const stated = price as Record<string, unknown>;
        const unit = stated["unit"];
        const usdPerMillion = stated["usdPerMillion"];
        // The unit is written down for whoever reads the file, and checked
        // here against the one this module already knows — so the file can
        // say what a provider bills without becoming a second opinion about it.
        if (unit !== singularUnit(UNIT_OF[usageType])) {
          throw new Error(
            `the rate card prices ${provider}/${model} ${usageType} per ` +
              `${String(unit)}; Egma counts it in ${UNIT_OF[usageType]}`,
          );
        }
        if (typeof usdPerMillion !== "string" || !A_DECIMAL.test(usdPerMillion)) {
          throw new Error(
            `the rate card's ${provider}/${model} ${usageType} price is not a decimal string`,
          );
        }
        return { usageType, unit: UNIT_OF[usageType], usdPerMillion };
      },
    );
    if (priced.length === 0) {
      throw new Error(
        `the rate-card entry for ${provider}/${model} prices nothing`,
      );
    }

    const note = read["note"];
    return {
      provider,
      model,
      effectiveFrom: new Date(`${effectiveFrom}T00:00:00.000Z`),
      source,
      readAt,
      ...(typeof note === "string" ? { note } : {}),
      approximate: read["approximate"] === true,
      prices: priced,
    };
  });
}

/** `tokens` counts in a `token`, and so on: the file names one, this the many. */
function singularUnit(unit: UsageUnit): string {
  return unit === "tokens"
    ? "token"
    : unit === "seconds"
      ? "second"
      : "character";
}

/**
 * The catalog models with no current price for something their adapter emits.
 *
 * Empty is the only acceptable answer, and the test that says so is the one
 * thing standing between a model becoming selectable and a simulation on it
 * costing nothing at all.
 */
export function catalogModelsMissingAPrice(
  card: readonly RateCardEntry[],
  at: Date = new Date(),
): readonly string[] {
  const missing: string[] = [];
  for (const entry of PROVIDER_CATALOG) {
    const priced = new Set<UsageType>();
    for (const row of card) {
      if (row.provider !== entry.provider || row.model !== entry.model) continue;
      if (row.effectiveFrom.getTime() > at.getTime()) continue;
      for (const price of row.prices) priced.add(price.usageType);
    }
    for (const usageType of billableUsageTypesOf(entry)) {
      if (!priced.has(usageType)) {
        missing.push(`${entry.provider}/${entry.model} ${usageType}`);
      }
    }
  }
  return missing;
}
