import { readdir, readFile } from "node:fs/promises";

import {
  PROVIDER_CATALOG,
  RECOMMENDED_ENTRY,
  RECOMMENDED_GRADER_MODEL,
  RECOMMENDED_PERSONA_MODELS,
  SPEED_RANGE,
  connectionTypeUsesPlatformCarrier,
  connectionOptionMetadata,
  validPersonaModels,
  type PersonaModels,
  type ProviderCatalogEntry,
} from "@egma/db";
import {
  PROVIDER_ACCOUNTS,
  providerAccountFor,
} from "@egma/provider-credentials";
import { specComplaints } from "@egma/simulation-contract";
import { describe, expect, it } from "vitest";

type JsonObject = Readonly<Record<string, unknown>>;

const schema = JSON.parse(
  await readFile(
    new URL(
      "../../../packages/simulation-contract/schemas/simulation-spec.v4.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as JsonObject;

const validVoiceSpec = JSON.parse(
  await readFile(
    new URL(
      "../../../packages/simulation-contract/fixtures/spec/valid/voice-loopback.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, unknown>;

const validFixtureDirectory = new URL(
  "../../../packages/simulation-contract/fixtures/spec/valid/",
  import.meta.url,
);

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL(name, validFixtureDirectory), "utf8"),
  ) as Record<string, unknown>;
}

const validSpecs = await Promise.all(
  (await readdir(validFixtureDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map(fixture),
);

function object(value: unknown, name: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is not an object`);
  }
  return value as JsonObject;
}

function schemaLiterals(node: unknown): string[] {
  if (typeof node !== "object" || node === null) return [];
  if (Array.isArray(node)) {
    return [...new Set(node.flatMap(schemaLiterals))];
  }

  const held = node as Record<string, unknown>;
  const values: string[] = [];
  if (typeof held.const === "string") values.push(held.const);
  if (Array.isArray(held.enum)) {
    values.push(
      ...held.enum.filter(
        (value): value is string => typeof value === "string",
      ),
    );
  }
  for (const child of Object.values(held)) {
    values.push(...schemaLiterals(child));
  }
  return [...new Set(values)];
}

function modelsUsing(entry: ProviderCatalogEntry): PersonaModels {
  if (entry.job === "llm") {
    return {
      ...RECOMMENDED_PERSONA_MODELS,
      llm: {
        provider: entry.provider,
        model: entry.model,
      },
    };
  }
  if (entry.job === "stt") {
    return {
      ...RECOMMENDED_PERSONA_MODELS,
      stt: { provider: entry.provider, model: entry.model },
    };
  }
  return {
    ...RECOMMENDED_PERSONA_MODELS,
    tts: {
      ...RECOMMENDED_PERSONA_MODELS.tts,
      provider: entry.provider,
      model: entry.model,
      voiceId:
        entry.recommendedVoiceId ?? RECOMMENDED_PERSONA_MODELS.tts.voiceId,
    },
  };
}

function contractSpecUsing(entry: ProviderCatalogEntry): Record<string, unknown> {
  const candidate = structuredClone(validVoiceSpec);
  const selections = candidate.models as Record<
    "llm" | "stt" | "tts",
    Record<string, unknown>
  >;
  const selected = selections[entry.job];
  selected.provider = entry.provider;
  selected.model = entry.model;
  selected.adapter = entry.adapter;
  if (entry.job === "llm") {
    if (entry.reasoningEffort === undefined) {
      delete selected.reasoning_effort;
    } else {
      selected.reasoning_effort = entry.reasoningEffort;
    }
  }
  return candidate;
}

describe("one executable model catalog", () => {
  it("keeps catalog membership in the catalog and wire shape in the contract", () => {
    expect(
      [...new Set(PROVIDER_CATALOG.map((entry) => entry.provider))].sort(),
    ).toEqual([...PROVIDER_ACCOUNTS].sort());

    for (const entry of PROVIDER_CATALOG) {
      expect(validPersonaModels(modelsUsing(entry))[entry.job]).toMatchObject({
        provider: entry.provider,
        model: entry.model,
      });
      expect(specComplaints(contractSpecUsing(entry))).toEqual([]);
      expect(providerAccountFor(entry.provider)).toBe(entry.provider);
    }

    const definitions = object(schema.$defs, "contract definitions");
    expect(schemaLiterals(definitions.stt_selection)).toEqual([]);
    expect(schemaLiterals(definitions.tts_selection)).toEqual([]);
    expect(schemaLiterals(definitions.llm_selection)).toEqual([]);

    const tts = object(definitions.tts_selection, "tts selection");
    const speed = object(
      object(tts.properties, "tts properties").speed,
      "tts speed",
    );
    expect({ slowest: speed.minimum, fastest: speed.maximum }).toEqual(
      SPEED_RANGE,
    );

    for (const job of ["llm", "stt", "tts"] as const) {
      expect(RECOMMENDED_PERSONA_MODELS[job]).toMatchObject({
        provider: RECOMMENDED_ENTRY[job].provider,
        model: RECOMMENDED_ENTRY[job].model,
      });
    }
    expect(RECOMMENDED_PERSONA_MODELS.tts).toMatchObject({
      voiceId: RECOMMENDED_ENTRY.tts.recommendedVoiceId,
      speed: RECOMMENDED_ENTRY.tts.recommendedSpeed,
    });
    const graderEntry = PROVIDER_CATALOG.find(
      (entry) =>
        entry.job === "llm" &&
        "graderEligible" in entry &&
        entry.graderEligible === true,
    );
    expect(RECOMMENDED_GRADER_MODEL).toEqual({
      provider: graderEntry?.provider,
      model: graderEntry?.model,
    });

    const terra = PROVIDER_CATALOG.find(
      (entry) => entry.job === "llm" && entry.model === "gpt-5.6-terra",
    );
    expect(terra).toMatchObject({
      provider: "openai",
      adapter: "openai_chat_completions",
      reasoningEffort: "none",
    });
  });

  it("agrees about which connection types receive the platform carrier", () => {
    const carrierSpec = validSpecs.find((document) => {
      const connection = object(document.connection, "fixture connection");
      return connection.connection_type === "phone_number";
    });
    const carrier = carrierSpec?.platform;
    if (carrier === undefined || carrier === null) {
      throw new Error("the phone fixture has no carrier");
    }

    const fixtureKinds = new Set<string>();
    const schemaCarrierKinds = new Set<string>();

    for (const document of validSpecs) {
      const connection = object(document.connection, "fixture connection");
      if (typeof connection.connection_type !== "string") {
        throw new Error("the fixture connection has no kind");
      }
      fixtureKinds.add(connection.connection_type);
      const carriesPlatform =
        document.platform !== undefined && document.platform !== null;
      if (carriesPlatform) schemaCarrierKinds.add(connection.connection_type);
      expect(specComplaints(document)).toEqual([]);

      const wrong = structuredClone(document);
      if (carriesPlatform) delete wrong.platform;
      else wrong.platform = structuredClone(carrier);
      expect(specComplaints(wrong)).not.toEqual([]);
    }

    const productOptions = connectionOptionMetadata();
    expect(
      productOptions.every((entry) => fixtureKinds.has(entry.connectionType)),
    ).toBe(true);
    expect(
      [
        ...new Set(
          productOptions
            .filter((entry) => entry.usesPlatformCarrier)
            .map((entry) => entry.connectionType),
        ),
      ].sort(),
    ).toEqual([...schemaCarrierKinds].sort());
    for (const entry of productOptions) {
      expect(connectionTypeUsesPlatformCarrier(entry.connectionType)).toBe(
        entry.usesPlatformCarrier,
      );
    }
  });
});
