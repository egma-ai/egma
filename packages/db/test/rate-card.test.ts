import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PROVIDER_CATALOG,
  billableUsageTypesOf,
  catalogModelsMissingAPrice,
  readRateCard,
  unitOfUsageType,
  upsertRateCard,
  type RateCardEntry,
} from "../src/index.ts";
import { catalogModelsWithoutAStoredPrice } from "../src/access/usage.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";

/**
 * The rate card: the file Egma ships, and the table a deployment rates
 * against.
 *
 * The one thing this suite exists to prevent is a model becoming selectable
 * with no price — a simulation on it would then cost nothing, silently, and
 * the number a customer is shown would be wrong in the one direction nobody
 * notices.
 */

let database: MigratedDatabase;
let card: readonly RateCardEntry[];

beforeAll(async () => {
  database = await createConnectedDatabase("rate_card");
  card = await readRateCard();
});

afterAll(async () => {
  await database.drop();
});

describe("the shipped rate-card file", () => {
  it("prices every usage type every catalog model's adapter can emit", () => {
    expect(catalogModelsMissingAPrice(card)).toEqual([]);
  });

  it("covers the whole catalog and nothing that is not in it", () => {
    const priced = new Set(card.map((entry) => `${entry.provider}/${entry.model}`));
    const catalog = new Set(
      PROVIDER_CATALOG.map((entry) => `${entry.provider}/${entry.model}`),
    );
    expect([...priced].sort()).toEqual([...catalog].sort());
  });

  it("states each price in the unit that usage type is counted in", () => {
    for (const entry of card) {
      for (const price of entry.prices) {
        expect(price.unit, `${entry.provider}/${entry.model}`).toBe(
          unitOfUsageType(price.usageType),
        );
      }
    }
  });

  it("says where every number came from and when it was read", () => {
    for (const entry of card) {
      expect(entry.source, `${entry.provider}/${entry.model}`).toMatch(
        /^https:\/\//,
      );
      expect(entry.readAt, `${entry.provider}/${entry.model}`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    }
  });

  it("explains every price it derived rather than read", () => {
    const derived = card.filter((entry) => entry.approximate);
    // One today: gpt-4o-mini-tts, which OpenAI bills by audio output token
    // while Egma measures characters.
    expect(derived.length).toBeGreaterThan(0);
    for (const entry of derived) {
      expect(entry.note, `${entry.provider}/${entry.model}`).toBeTypeOf(
        "string",
      );
    }
  });

  it("refuses a file that prices something in the wrong unit", async () => {
    await expect(
      readRateCard(
        new URL("./fixtures/rate-card-wrong-unit.json", import.meta.url).pathname,
      ),
    ).rejects.toThrow(/per minute; Egma counts it in seconds/);
  });

  it("refuses a file that states one model's price twice from one date", async () => {
    await expect(
      readRateCard(
        new URL("./fixtures/rate-card-twice.json", import.meta.url).pathname,
      ),
    ).rejects.toThrow(/a price change is a new entry with a later effective date/);
  });
});

describe("the boot upsert", () => {
  it("writes the whole file the first time and nothing the second", async () => {
    const first = await upsertRateCard();
    expect(first.written.length).toBe(
      card.reduce((all, entry) => all + entry.prices.length, 0),
    );

    const again = await upsertRateCard();
    expect(again.written).toEqual([]);

    const { rows } = await database.sql<{ n: string }>(
      "select count(*) as n from rate_card",
    );
    expect(Number(rows[0]?.n)).toBe(first.written.length);
  });

  it("leaves the stored card able to price every catalog model", async () => {
    expect(await catalogModelsWithoutAStoredPrice()).toEqual([]);
  });

  it("keeps the old row when a later price arrives", async () => {
    const model = "gpt-4o-mini";
    const later: readonly RateCardEntry[] = [
      {
        provider: "openai",
        model,
        effectiveFrom: new Date("2027-01-01T00:00:00.000Z"),
        source: "https://developers.openai.com/api/docs/pricing",
        readAt: "2027-01-01",
        approximate: false,
        prices: [
          {
            usageType: "input_tokens",
            unit: "tokens",
            usdPerMillion: "0.30",
          },
        ],
      },
    ];
    const written = await upsertRateCard(later);
    expect(written.written).toEqual([
      "openai/gpt-4o-mini input_tokens from 2027-01-01",
    ]);

    const { rows } = await database.sql<{
      usd_per_million: string;
      effective_from: Date;
    }>(
      "select usd_per_million, effective_from from rate_card " +
        "where provider = 'openai' and model = $1 and usage_type = 'input_tokens' " +
        "order by effective_from",
      [model],
    );
    // Both prices are on the record. The old one is what a simulation that ran
    // before the change is still priced at.
    expect(rows.map((row) => row.usd_per_million)).toEqual([
      "0.150000000000",
      "0.300000000000",
    ]);
  });
});

describe("what a catalog model's adapter emits", () => {
  it("is tokens for chat completions, and the cached half is named separately", () => {
    const entry = PROVIDER_CATALOG.find(
      (candidate) => candidate.model === "gpt-4o-mini",
    );
    expect(entry).toBeDefined();
    expect(billableUsageTypesOf(entry!)).toEqual([
      "input_tokens",
      "cached_input_tokens",
      "output_tokens",
    ]);
  });

  it("tells the two shapes of realtime transcription apart", () => {
    const duration = PROVIDER_CATALOG.find(
      (candidate) => candidate.model === "gpt-live-transcribe",
    );
    const tokens = PROVIDER_CATALOG.find(
      (candidate) => candidate.model === "gpt-4o-transcribe",
    );
    expect(billableUsageTypesOf(duration!)).toEqual(["audio_seconds"]);
    expect(billableUsageTypesOf(tokens!)).toEqual([
      "audio_input_tokens",
      "text_input_tokens",
      "output_tokens",
    ]);
  });

  it("is characters for every speaking leg, whatever the provider bills", () => {
    for (const entry of PROVIDER_CATALOG.filter((one) => one.job === "tts")) {
      expect(billableUsageTypesOf(entry), entry.model).toEqual(["characters"]);
    }
  });
});
