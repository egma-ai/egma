import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import ajvFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  bannedWordIn,
  reportComplaints,
  specComplaints,
} from "@egma/simulation-contract";

// ajv-formats ships CommonJS whose module.exports is the plugin function
// itself. Under NodeNext, the default import is typed as its namespace and
// the namespace's default is that callable, with its declared type intact.
const addFormats = ajvFormats.default;

/**
 * The simulation contract, held to its own golden fixtures.
 *
 * The two schemas under `schemas/` are the one meeting point between the
 * TypeScript control plane and the Python simulator. This suite is the
 * TypeScript half of the guarantee that the two sides cannot drift apart
 * silently: every fixture under `fixtures/<direction>/valid` must validate,
 * every fixture under `fixtures/<direction>/invalid` must be rejected, and the
 * simulator's own suite reads the same files. An incompatible edit to a schema
 * or a fixture fails this suite, and this suite runs in CI.
 *
 * The fixtures are read from disk rather than imported, deliberately: they are
 * plain files with no TypeScript identity, because the other reader of these
 * bytes is not TypeScript.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

async function readJson(
  ...segments: string[]
): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(packageRoot, ...segments), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

type Fixture = {
  readonly name: string;
  readonly document: Record<string, unknown>;
};

async function fixturesUnder(
  direction: "spec" | "report",
  expectation: "valid" | "invalid",
): Promise<Fixture[]> {
  const directory = path.join(packageRoot, "fixtures", direction, expectation);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      document: await readJson("fixtures", direction, expectation, name),
    })),
  );
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

const specSchema = await readJson("schemas", "simulation-spec.v5.schema.json");
const reportSchema = await readJson(
  "schemas",
  "simulation-report.v1.schema.json",
);

// Compiling is itself part of the suite's job: a schema that is not valid
// 2020-12, or that trips Ajv's strict mode, fails before any fixture is read.
const validators = {
  spec: ajv.compile(specSchema),
  report: ajv.compile(reportSchema),
} as const;

/**
 * Why each deliberately invalid fixture is invalid: the exact place Ajv must
 * point at, and the keyword that must fail there. A substring check over the
 * pooled error text would be looser than it reads — under a oneOf, Ajv
 * reports every branch's complaints, and a fragment can match a branch the
 * fixture was never aimed at. The map is also the inventory: a fixture
 * without an entry, or an entry whose fixture is gone, fails the suite.
 */
type Rejection = {
  /** The instance path the decisive error sits at. */
  readonly at: string;
  /** The JSON Schema keyword that must have failed there. */
  readonly keyword: string;
  /** The missing or offending property, where the keyword names one. */
  readonly property?: string;
};

const EXPECTED_REJECTION: Record<string, Rejection> = {
  // A version reference is the platform's own, and it is passed on
  // untouched. One made of spaces is present by the letter and absent by
  // the reading, and it would ask a platform for a version named "   ".
  "spec/agent-version-blank.json": {
    at: "/agent_version",
    keyword: "pattern",
  },
  "spec/chat-carrying-speech-key.json": {
    at: "/models/stt",
    keyword: "not",
  },
  // A rendered variable is a string. A number here would reach a platform
  // as whichever spelling of it the sender's JSON writer happened to pick,
  // so the wire refuses it rather than choosing one.
  "spec/dynamic-variable-not-a-string.json": {
    at: "/dynamic_variables/open_slots",
    keyword: "type",
  },
  "spec/limits-missing.json": {
    at: "",
    keyword: "required",
    property: "limits",
  },
  "spec/modality-unknown.json": { at: "/modality", keyword: "enum" },
  // Catalog membership is checked before claim assembly. On the wire, every
  // selection still has to name the adapter that the catalog resolved.
  "spec/adapter-missing.json": {
    at: "/models/stt",
    keyword: "required",
    property: "adapter",
  },
  "spec/models-missing.json": {
    at: "",
    keyword: "required",
    property: "models",
  },
  // An answer is a value *or* a failure, and the tagged shape is what keeps
  // an authored `null` tellable from no answer at all. One that claims both
  // is refused inside the branch that would have taken the value: the
  // failure has nowhere to sit beside it, and there is no rule that would
  // choose between them.
  "spec/mock-tool-answering-two-ways.json": {
    at: "/mock_tools/0/answer",
    keyword: "additionalProperties",
    property: "error",
  },
  // How long a mocked backend takes is not something a test says: the
  // answer is served the moment it is asked for, and there is no slot on
  // the entry for a number that would hold it back.
  "spec/mock-tool-with-delay.json": {
    at: "/mock_tools/0",
    keyword: "additionalProperties",
    property: "delay_milliseconds",
  },
  // The agent dispatch carries a JSON object, because that is what
  // `json.loads(ctx.job.metadata)` gives the agent on the far side. A list
  // would reach it as something its own reader cannot key into.
  "spec/job-dispatch-metadata-not-an-object.json": {
    at: "/job_dispatch_metadata",
    keyword: "type",
  },
  "spec/unknown-field.json": {
    at: "",
    keyword: "additionalProperties",
    property: "agent_id",
  },
  // The work-order platform block may carry the carrier only. Model and speech choices
  // belong to the pinned persona version and are refused here.
  "spec/platform-block-unknown.json": {
    at: "/platform",
    keyword: "additionalProperties",
    property: "model",
  },
  "spec/phone-carrier-missing.json": {
    at: "",
    keyword: "required",
    property: "platform",
  },
  // The three authored values move together, so each one's absence is a
  // fixture of its own rather than a case one clone-and-delete test covers
  // on one side of the wire.
  "spec/persona-missing-name.json": {
    at: "/persona",
    keyword: "required",
    property: "name",
  },
  "spec/persona-missing-language.json": {
    at: "/persona",
    keyword: "required",
    property: "language",
  },
  "spec/persona-technical-voice.json": {
    at: "/persona",
    keyword: "additionalProperties",
    property: "voice",
  },
  // The persona block the contract carried until v5: authored behavior in a
  // `traits` wrapper, with an accent and a background noise nobody ran. The
  // whole shape is refused at the wrapper, which is what makes the flat block
  // the only one there is rather than the one the simulator prefers.
  "spec/persona-traits-wrapper.json": {
    at: "/persona",
    keyword: "additionalProperties",
    property: "traits",
  },
  // A work order in the version before this one. There is no tolerance for it
  // anywhere: the version is a `const`, so the old number is a refusal and not
  // a branch.
  "spec/wrong-contract-version.json": {
    at: "/contract_version",
    keyword: "const",
  },
  "spec/voice-missing-stt-key.json": {
    at: "/models/stt",
    keyword: "required",
    property: "key",
  },
  "report/completed-claiming-never-ran.json": {
    at: "/events/0/facts/ending",
    keyword: "enum",
  },
  "report/completed-without-facts.json": {
    at: "/events/0",
    keyword: "required",
    property: "facts",
  },
  "report/credentials-echoed.json": {
    at: "",
    keyword: "additionalProperties",
    property: "connection",
  },
  "report/failed-with-blank-reason.json": {
    at: "/events/0/reason",
    keyword: "pattern",
  },
  "report/failed-without-reason.json": {
    at: "/events/0/reason",
    keyword: "type",
  },
  "report/running-with-facts.json": {
    at: "/events/0",
    keyword: "additionalProperties",
    property: "facts",
  },
  // The three kinds this direction used to carry. A conversation's record is
  // its spans now, so a report claiming to carry one is refused at the same
  // place any other unknown kind is — which is what makes the retirement a
  // fact of the contract rather than a habit of the shipped simulator.
  "report/timing-event-retired.json": {
    at: "/events/0/kind",
    keyword: "const",
  },
  "report/tool-call-event-retired.json": {
    at: "/events/0/kind",
    keyword: "const",
  },
  "report/turn-event-retired.json": {
    at: "/events/0/kind",
    keyword: "const",
  },
  "report/unknown-event-kind.json": {
    at: "/events/0/kind",
    keyword: "const",
  },
};

describe("the two schemas, as one contract", () => {
  it("pin each direction's current contract version", () => {
    const versionOf = (schema: Record<string, unknown>): unknown =>
      (
        (schema.properties as Record<string, Record<string, unknown>>)
          .contract_version as Record<string, unknown>
      ).const;
    expect(versionOf(specSchema)).toBe(5);
    expect(versionOf(reportSchema)).toBe(1);
  });

  it("each carry an identity a $ref or an error message can name", () => {
    expect(specSchema.$id).toBe("urn:egma:simulation-contract:spec:v5");
    expect(reportSchema.$id).toBe("urn:egma:simulation-contract:report:v1");
  });

  it("accepts only the shared speaking-speed range", async () => {
    const base = await readJson(
      "fixtures",
      "spec",
      "valid",
      "voice-loopback.json",
    );
    const withSpeed = (speed: number): Record<string, unknown> => {
      const spec = structuredClone(base);
      const models = spec.models as Record<string, Record<string, unknown>>;
      const tts = models.tts;
      if (tts === undefined) throw new Error("the valid fixture has no TTS selection");
      tts.speed = speed;
      return spec;
    };

    const tts = (
      specSchema.$defs as Record<
        string,
        { properties: { speed: { minimum: number; maximum: number } } }
      >
    ).tts_selection;
    if (tts === undefined) throw new Error("the contract has no TTS selection");
    const { minimum, maximum } = tts.properties.speed;

    for (const speed of [minimum, maximum]) {
      const spec = withSpeed(speed);
      expect(
        validators.spec(spec),
        `${speed}: ${ajv.errorsText(validators.spec.errors)}`,
      ).toBe(true);
    }

    for (const [speed, keyword] of [
      [minimum - 0.0001, "minimum"],
      [maximum + 0.0001, "maximum"],
    ] as const) {
      expect(validators.spec(withSpeed(speed))).toBe(false);
      expect(validators.spec.errors).toContainEqual(
        expect.objectContaining({
          instancePath: "/models/tts/speed",
          keyword,
        }),
      );
    }
  });

  it("carries a named agent version and this simulation's variables, or neither", async () => {
    // Both are optional and independent: a lane that conducts over a named
    // version may carry no variables, and one that carries variables may
    // take the platform's own default version. Absent is the ordinary case,
    // and every other valid fixture is a spec without them.
    const carried = await readJson(
      "fixtures",
      "spec",
      "valid",
      "voice-retell-web-call.json",
    );
    expect(carried.agent_version).toBe(106);
    expect(carried.dynamic_variables).toMatchObject({
      account_id: carried.simulation_id as string,
    });

    for (const dropped of [
      [],
      ["agent_version"],
      ["dynamic_variables"],
      ["agent_version", "dynamic_variables"],
    ] as const) {
      const spec = structuredClone(carried);
      for (const name of dropped) delete spec[name];
      expect(
        validators.spec(spec),
        `without ${dropped.join(" and ") || "nothing"}: ${ajv.errorsText(
          validators.spec.errors,
        )}`,
      ).toBe(true);
    }

    // A version is whatever the platform calls its versions, and the two
    // lanes that ride this field name them differently: a mocked run names
    // the draft it branched by number, and a run over a moving reference
    // names it in words. Neither is reinterpreted on the way through.
    for (const version of [0, 106, "latest", "prod"]) {
      const spec = structuredClone(carried);
      spec.agent_version = version;
      expect(
        validators.spec(spec),
        `${JSON.stringify(version)}: ${ajv.errorsText(validators.spec.errors)}`,
      ).toBe(true);
    }

    // A variable set to nothing is not the same as a variable nobody set:
    // an empty value renders empty rather than falling back to a default,
    // so the wire has to be able to say it.
    const emptied = structuredClone(carried);
    emptied.dynamic_variables = { account_id: "sim_1", caller_name: "" };
    expect(
      validators.spec(emptied),
      ajv.errorsText(validators.spec.errors),
    ).toBe(true);
  });

  it("carries the agent dispatch's own metadata, whole and unread", async () => {
    // The test's env travels in two halves, and this is the half the
    // agent's own platform never renders: it rides the LiveKit job
    // dispatch and is read on the far side by the agent itself. Absent is
    // the ordinary case, and every other valid fixture is a spec without
    // it.
    const carried = await readJson(
      "fixtures",
      "spec",
      "valid",
      "voice-livekit-job-dispatch-metadata.json",
    );
    expect(carried.job_dispatch_metadata).toEqual({
      tenant: "acme",
      caller_id: "+15550100",
    });
    expect(
      validators.spec(carried),
      ajv.errorsText(validators.spec.errors),
    ).toBe(true);

    const without = structuredClone(carried);
    delete without.job_dispatch_metadata;
    expect(
      validators.spec(without),
      ajv.errorsText(validators.spec.errors),
    ).toBe(true);

    // Nothing inside is read, so nothing inside is constrained: whatever
    // the test wrote reaches the dispatch byte for byte, nested values and
    // empty objects included.
    for (const written of [
      {},
      { tenant: "acme", limits: { seats: 4 }, flags: [true, null] },
    ]) {
      const spec = structuredClone(carried);
      spec.job_dispatch_metadata = written;
      expect(
        validators.spec(spec),
        `${JSON.stringify(written)}: ${ajv.errorsText(validators.spec.errors)}`,
      ).toBe(true);
    }

    // An object and nothing else: the far side keys into it, and a list or
    // a string would arrive as something its own reader cannot use.
    for (const notAnObject of [["tenant", "acme"], "acme", 4, null]) {
      const spec = structuredClone(carried);
      spec.job_dispatch_metadata = notAnObject;
      expect(
        validators.spec(spec),
        `${JSON.stringify(notAnObject)} was accepted`,
      ).toBe(false);
      expect(validators.spec.errors).toContainEqual(
        expect.objectContaining({
          instancePath: "/job_dispatch_metadata",
          keyword: "type",
        }),
      );
    }
  });

  it("keeps catalog membership out of the wire contract", async () => {
    const base = await readJson(
      "fixtures",
      "spec",
      "valid",
      "voice-loopback.json",
    );
    const candidate = structuredClone(base);
    const models = candidate.models as Record<
      "llm" | "stt" | "tts",
      Record<string, unknown>
    >;
    models.llm.provider = "future-llm-provider";
    models.llm.model = "future-llm-model";
    models.llm.adapter = "future_llm_adapter";
    models.stt.provider = "future-stt-provider";
    models.stt.model = "future-stt-model";
    models.stt.adapter = "future_stt_adapter";
    models.tts.provider = "future-tts-provider";
    models.tts.model = "future-tts-model";
    models.tts.adapter = "future_tts_adapter";

    expect(
      validators.spec(candidate),
      ajv.errorsText(validators.spec.errors),
    ).toBe(true);

    const definitions = specSchema.$defs as Record<
      string,
      { properties: Record<string, Record<string, unknown>> }
    >;
    for (const job of ["llm", "stt", "tts"] as const) {
      const selection = definitions[`${job}_selection`];
      if (selection === undefined) {
        throw new Error(`the contract has no ${job} selection`);
      }
      for (const name of ["provider", "model", "adapter"] as const) {
        expect(selection.properties[name]).toEqual({
          type: "string",
          minLength: 1,
        });
      }
    }
  });

  it("carries the authored person flat, whole, and closed", async () => {
    const base = await readJson(
      "fixtures",
      "spec",
      "valid",
      "voice-loopback.json",
    );
    const personaOf = (spec: Record<string, unknown>): Record<string, unknown> => {
      const persona = spec.persona as Record<string, unknown> | undefined;
      if (persona === undefined) throw new Error("the fixture has no persona");
      return persona;
    };

    // Flat: the three authored values sit on the block itself, so there is
    // one place to read who this is.
    expect(Object.keys(personaOf(base)).sort()).toEqual([
      "language",
      "name",
      "personality",
    ]);
    expect(validators.spec(base), ajv.errorsText(validators.spec.errors)).toBe(
      true,
    );

    // Whole: none of the three is optional, and none may be present in name
    // only. A simulator handed a persona without one of them would have to
    // decide what it meant, and deciding that is deciding who the agent
    // heard — which a name of one space leaves just as undecided, while
    // reading "Your name is  ." into the prompt. Absent, empty and blank are
    // one rule with three diagnostics, and it is the rule the persona
    // version's own columns keep: non-empty after trim.
    for (const required of ["name", "personality", "language"] as const) {
      const spec = structuredClone(base);
      delete personaOf(spec)[required];
      expect(validators.spec(spec)).toBe(false);
      expect(validators.spec.errors).toContainEqual(
        expect.objectContaining({
          instancePath: "/persona",
          keyword: "required",
          params: { missingProperty: required },
        }),
      );

      const empty = structuredClone(base);
      personaOf(empty)[required] = "";
      expect(validators.spec(empty)).toBe(false);
      expect(validators.spec.errors).toContainEqual(
        expect.objectContaining({
          instancePath: `/persona/${required}`,
          keyword: "minLength",
        }),
      );

      for (const blank of [" ", "   ", "\t", "\n", " \t\n "]) {
        const whitespace = structuredClone(base);
        personaOf(whitespace)[required] = blank;
        expect(
          validators.spec(whitespace),
          `${required} accepted ${JSON.stringify(blank)}`,
        ).toBe(false);
        expect(validators.spec.errors).toContainEqual(
          expect.objectContaining({
            instancePath: `/persona/${required}`,
            keyword: "pattern",
          }),
        );
      }

      // And the rule stops exactly there. Whitespace around real content is
      // the author's own spacing, not an empty field: the wire refuses what
      // says nothing, and does not tidy what somebody wrote.
      const padded = structuredClone(base);
      personaOf(padded)[required] = ` ${String(personaOf(base)[required])} `;
      expect(
        validators.spec(padded),
        ajv.errorsText(validators.spec.errors),
      ).toBe(true);
    }

    // Closed: the wrapper the block used to have, and the two authored
    // details no run ever read, are refused here rather than ignored — the
    // form cannot promise again what nothing delivers.
    for (const retired of ["traits", "accent", "backgroundNoise"] as const) {
      const spec = structuredClone(base);
      personaOf(spec)[retired] = "retired detail";
      expect(validators.spec(spec)).toBe(false);
      expect(validators.spec.errors).toContainEqual(
        expect.objectContaining({
          instancePath: "/persona",
          keyword: "additionalProperties",
          params: { additionalProperty: retired },
        }),
      );
    }
  });

  it("keeps reasoning effort structural, not catalog-owned", async () => {
    const base = await readJson(
      "fixtures",
      "spec",
      "valid",
      "voice-loopback.json",
    );
    const withReasoning = (reasoningEffort: string): Record<string, unknown> => {
      const spec = structuredClone(base);
      const models = spec.models as Record<string, Record<string, unknown>>;
      const llm = models.llm;
      if (llm === undefined) throw new Error("the fixture has no LLM selection");
      llm.reasoning_effort = reasoningEffort;
      return spec;
    };

    for (const effort of ["none", "future-effort"]) {
      expect(
        validators.spec(withReasoning(effort)),
        `${effort}: ${ajv.errorsText(validators.spec.errors)}`,
      ).toBe(true);
    }

    expect(validators.spec(withReasoning(""))).toBe(false);
    expect(validators.spec.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "/models/llm/reasoning_effort",
        keyword: "minLength",
      }),
    );
  });

  it("accepts only complete carrier routes", async () => {
    const base = await readJson(
      "fixtures",
      "spec",
      "valid",
      "voice-phone-platform-configured.json",
    );
    const without = (...names: string[]): Record<string, unknown> => {
      const spec = structuredClone(base);
      const platform = spec.platform as Record<string, unknown>;
      const carrier = platform.carrier as Record<string, unknown>;
      for (const name of names) delete carrier[name];
      return spec;
    };

    // The fixture proves the only carrier shape: all four values move together.
    expect(validators.spec(base), ajv.errorsText(validators.spec.errors)).toBe(
      true,
    );

    const phoneWithoutCarrier = structuredClone(base);
    delete phoneWithoutCarrier.platform;
    expect(validators.spec(phoneWithoutCarrier)).toBe(false);
    expect(validators.spec.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "",
        keyword: "required",
        params: { missingProperty: "platform" },
      }),
    );

    const nonPhoneWithCarrier = structuredClone(base);
    const connection = nonPhoneWithCarrier.connection as Record<
      string,
      unknown
    >;
    connection.connection_type = "retell_chat_api";
    expect(validators.spec(nonPhoneWithCarrier)).toBe(false);
    expect(validators.spec.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "",
        keyword: "not",
      }),
    );

    for (const missing of [
      "trunk_address",
      "trunk_number",
      "trunk_username",
      "trunk_password",
    ] as const) {
      expect(validators.spec(without(missing))).toBe(false);
      expect(validators.spec.errors).toContainEqual(
        expect.objectContaining({
          instancePath: "/platform/carrier",
          keyword: "required",
          params: { missingProperty: missing },
        }),
      );
    }
  });

  /**
   * The terminal facts are written once per status variant so that each
   * spells out the endings it may honestly claim. The price of writing them
   * out is that they could drift apart; this pins them identical everywhere
   * except the ending.
   */
  it("holds the three terminal-facts shapes identical, apart from their endings", () => {
    const defs = reportSchema.$defs as Record<
      string,
      Record<string, unknown>
    >;
    const stripped = ["completed_facts", "failed_facts", "canceled_facts"].map(
      (name) => {
        const clone = structuredClone(defs[name]) as Record<string, unknown>;
        delete clone.description;
        (clone.properties as Record<string, unknown>).ending = "<varies>";
        return clone;
      },
    );
    expect(stripped[1]).toEqual(stripped[0]);
    expect(stripped[2]).toEqual(stripped[0]);
  });

  it("keeps a voice recording as one opaque reference, with no copied timing or sample-rate facts", async () => {
    const report = await readJson(
      "fixtures",
      "report",
      "valid",
      "completed-voice.json",
    );
    const event = (report.events as Record<string, unknown>[])[0];
    expect(event).toBeDefined();
    if (!event) throw new Error("the completed report has no event");
    const facts = event.facts as Record<string, unknown>;
    const audio = facts.audio as Record<string, unknown>;
    expect(audio).toEqual({
      recording:
        "sim_01K3XQ7M4E8YB2FVN0H9TZQWES/dual-channel.wav",
    });
    expect(
      validators.report(report),
      JSON.stringify(validators.report.errors),
    ).toBe(true);

    for (const [property, value] of [
      ["started_at", "2026-08-05T09:00:17.123456789Z"],
      ["measured_sample_rate_hz", 8_000],
    ] as const) {
      audio[property] = value;
      expect(validators.report(report)).toBe(false);
      expect(validators.report.errors).toContainEqual(
        expect.objectContaining({
          instancePath: "/events/0/facts/audio",
          keyword: "additionalProperties",
          params: { additionalProperty: property },
        }),
      );
      delete audio[property];
    }
  });

  it("gives each terminal status its own endings, sharing none", () => {
    const defs = reportSchema.$defs as Record<string, Record<string, unknown>>;
    const endings = ["completed_facts", "failed_facts", "canceled_facts"].flatMap(
      (name) => {
        const properties = defs[name]?.properties as Record<
          string,
          Record<string, unknown>
        >;
        return properties.ending?.enum as string[];
      },
    );
    expect(new Set(endings).size).toBe(endings.length);
  });
});

for (const direction of ["spec", "report"] as const) {
  describe(`the ${direction} direction`, () => {
    it("accepts every valid golden fixture", async () => {
      const all = await fixturesUnder(direction, "valid");
      expect(all.length).toBeGreaterThan(0);

      for (const fixture of all) {
        const validate = validators[direction];
        const answer = validate(fixture.document);
        expect(
          answer,
          `${fixture.name}: ${ajv.errorsText(validate.errors)}`,
        ).toBe(true);
      }
    });

    it("rejects every deliberately invalid fixture, at the place it is wrong", async () => {
      const all = await fixturesUnder(direction, "invalid");

      // The pin holds both ways: a fixture with no entry fails here, and so
      // does an entry whose fixture was deleted — the invalid coverage can
      // no more silently shrink than the valid coverage can.
      const expected = Object.keys(EXPECTED_REJECTION)
        .filter((key) => key.startsWith(`${direction}/`))
        .sort();
      expect(all.map((fixture) => `${direction}/${fixture.name}`)).toEqual(
        expected,
      );

      for (const fixture of all) {
        const validate = validators[direction];
        expect(validate(fixture.document), `${fixture.name} was accepted`).toBe(
          false,
        );

        const rejection = EXPECTED_REJECTION[`${direction}/${fixture.name}`];
        if (rejection === undefined) continue; // unreachable: the sets matched
        const decisive = (validate.errors ?? []).some(
          (error) =>
            error.instancePath === rejection.at &&
            error.keyword === rejection.keyword &&
            (rejection.property === undefined ||
              error.params.missingProperty === rejection.property ||
              error.params.additionalProperty === rejection.property),
        );
        expect(
          decisive,
          `${fixture.name}: no ${rejection.keyword} error at "${rejection.at}"; ` +
            `the errors were: ${ajv.errorsText(validate.errors)}`,
        ).toBe(true);
      }
    });
  });
}

describe("what the golden fixtures cover", () => {
  it("shows the spec direction in both modalities", async () => {
    const specs = await fixturesUnder("spec", "valid");
    const modalities = new Set(specs.map((fixture) => fixture.document.modality));
    expect(modalities).toEqual(new Set(["chat", "voice"]));
  });

  it("shows the one report event kind, and every terminal status", async () => {
    const reports = await fixturesUnder("report", "valid");
    const events = reports.flatMap(
      (fixture) => fixture.document.events as Record<string, unknown>[],
    );

    // One kind, and this is the assertion that says so: the report direction
    // carries the lifecycle and nothing else, because a conversation's record
    // is the spans it arrived as.
    const kinds = new Set(events.map((event) => event.kind));
    expect(kinds).toEqual(new Set(["status"]));

    const statuses = new Set(
      events
        .filter((event) => event.kind === "status")
        .map((event) => event.status),
    );
    expect(statuses).toEqual(
      new Set(["running", "completed", "failed", "canceled"]),
    );
  });

  it("shows a recording on a voice report, and its absence on chat", async () => {
    const reports = await fixturesUnder("report", "valid");
    const facts = reports
      .flatMap((fixture) => fixture.document.events as Record<string, unknown>[])
      .filter((event) => event.facts !== undefined)
      .map((event) => event.facts as Record<string, unknown>);

    const recordings = facts.map((terminal) => terminal.audio);
    expect(recordings).toContain(null);
    expect(
      recordings.some((audio) => audio !== null && audio !== undefined),
    ).toBe(true);
  });
});

/**
 * Credentials travel in exactly one direction: the spec. The report schema
 * does not merely lack a credentials field — it is written so that no document
 * carrying one can validate, which is what "structurally forbids" means. These
 * tests hold the schema itself to that shape, so an edit that opened a slot
 * would fail here before any fixture had to catch it.
 */
describe("the report schema structurally forbids credential material", () => {
  /** Every subschema in the document, with the path it sits at. */
  function* subschemas(
    node: unknown,
    at: string,
  ): Generator<{ at: string; schema: Record<string, unknown> }> {
    if (Array.isArray(node)) {
      for (const [index, child] of node.entries()) {
        yield* subschemas(child, `${at}/${index}`);
      }
      return;
    }
    if (typeof node !== "object" || node === null) return;
    yield { at, schema: node as Record<string, unknown> };
    for (const [key, child] of Object.entries(node)) {
      yield* subschemas(child, `${at}/${key}`);
    }
  }

  it("closes every object it defines", () => {
    for (const { at, schema } of subschemas(reportSchema, "#")) {
      if (schema.type !== "object") continue;
      expect(
        schema.additionalProperties,
        `${at} is an open object; every report object must enumerate its properties`,
      ).toBe(false);
    }
  });

  it("names no property a credential could hide under", () => {
    const suspicious = /credential|secret|password|token|api[_-]?key|authorization|bearer/i;
    for (const { at, schema } of subschemas(reportSchema, "#")) {
      if (typeof schema.properties !== "object" || schema.properties === null) {
        continue;
      }
      for (const name of Object.keys(schema.properties)) {
        expect(
          suspicious.test(name),
          `${at}/properties/${name} looks like a slot for credential material`,
        ).toBe(false);
      }
    }
  });

  it("rejects a report smuggling the spec's credential block, wherever it rides", async () => {
    const spec = await readJson("fixtures", "spec", "valid", "chat-retell.json");
    const connection = spec.connection as Record<string, unknown>;
    expect(connection.credentials).toBeDefined();

    const carried = await readJson(
      "fixtures",
      "report",
      "valid",
      "completed-chat.json",
    );

    const smuggled: Record<string, unknown>[] = [
      // On the envelope, as the whole connection block or the secret alone.
      { ...carried, connection },
      { ...carried, credentials: connection.credentials },
      // On an event.
      {
        ...carried,
        events: (carried.events as Record<string, unknown>[]).map((event) => ({
          ...event,
          credentials: connection.credentials,
        })),
      },
      // Inside the terminal facts.
      {
        ...carried,
        events: (carried.events as Record<string, unknown>[]).map((event) =>
          event.facts === undefined
            ? event
            : {
                ...event,
                facts: {
                  ...(event.facts as Record<string, unknown>),
                  credentials: connection.credentials,
                },
              },
        ),
      },
    ];

    for (const [index, document] of smuggled.entries()) {
      const answer = validators.report(document);
      expect(answer, `variant ${index} validated with credentials aboard`).toBe(
        false,
      );
      expect(ajv.errorsText(validators.report.errors)).toContain(
        "must NOT have additional properties",
      );
    }
  });
});

/**
 * One thing has one name. The contract is where a word becomes permanent —
 * a schema property outlives the prose that explained it — so the words the
 * project has settled against are held out of it here rather than caught in
 * review. The scan covers everything a reader of this package meets: both
 * schemas, every document beside them, and every golden fixture.
 *
 * The list itself is `src/vocabulary.ts`, shared with the guard over the
 * platform's own mock-tool surface. Two lists written separately had already
 * drifted apart, which is precisely the failure a vocabulary guard exists to
 * prevent — so there is one, and both scanners read it.
 */
describe("the contract's surface, held to the words the project settled on", () => {
  it("uses none of them, anywhere a reader of this package looks", async () => {
    const files = (
      await readdir(packageRoot, { recursive: true, withFileTypes: true })
    ).filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".json") || entry.name.endsWith(".md")) &&
        !entry.parentPath.includes("node_modules"),
    );
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const at = path.join(file.parentPath, file.name);
      const found = bannedWordIn(await readFile(at, "utf8"));
      expect(
        found?.found,
        `${path.relative(packageRoot, at)} uses "${found?.found}"; ` +
          `say ${found?.instead}`,
      ).toBeUndefined();
    }
  });
});

describe("the exported spec check, which the control plane sends through", () => {
  it("has no complaints about any valid golden fixture", async () => {
    for (const fixture of await fixturesUnder("spec", "valid")) {
      expect(specComplaints(fixture.document), fixture.name).toEqual([]);
    }
  });

  it("complains about every deliberately invalid fixture", async () => {
    for (const fixture of await fixturesUnder("spec", "invalid")) {
      expect(
        specComplaints(fixture.document).length,
        `${fixture.name} raised no complaint`,
      ).toBeGreaterThan(0);
    }
  });

  it("names the place a document is wrong, the way the simulator's check does", async () => {
    const [valid] = await fixturesUnder("spec", "valid");
    if (valid === undefined) throw new Error("no valid spec fixture");

    const { limits: _limits, ...missingLimits } = valid.document;
    expect(specComplaints(missingLimits)).toEqual([
      ": must have required property 'limits'",
    ]);

    expect(
      specComplaints({ ...valid.document, modality: "carrier-pigeon" }),
    ).toEqual(["/modality: must be equal to one of the allowed values"]);
  });

  it("complains about a document that is not an object at all", () => {
    expect(specComplaints(null).length).toBeGreaterThan(0);
    expect(specComplaints("a string").length).toBeGreaterThan(0);
  });
});

describe("the exported report check, which the report route reads through", () => {
  it("has no complaints about any valid golden fixture", async () => {
    for (const fixture of await fixturesUnder("report", "valid")) {
      expect(reportComplaints(fixture.document), fixture.name).toEqual([]);
    }
  });

  it("complains about every deliberately invalid fixture", async () => {
    for (const fixture of await fixturesUnder("report", "invalid")) {
      expect(
        reportComplaints(fixture.document).length,
        `${fixture.name} raised no complaint`,
      ).toBeGreaterThan(0);
    }
  });

  it("names the place a document is wrong, in the shape the spec check uses", async () => {
    const carried = await readJson(
      "fixtures",
      "report",
      "valid",
      "completed-chat.json",
    );

    const { events: _events, ...missingEvents } = carried;
    expect(reportComplaints(missingEvents)).toEqual([
      ": must have required property 'events'",
    ]);
  });

  it("refuses the endings that are the platform's own words, never a reporter's", async () => {
    // `orphaned` is the sweep's verdict on a simulator that went silent, and
    // a simulator still talking cannot claim it; `dispatch_failed` is the
    // claim path's own landing for work it could not hand over. The wire's
    // vocabulary carries neither, so a report claiming either is refused at
    // validation — before any route has to reason about it.
    const carried = await readJson(
      "fixtures",
      "report",
      "valid",
      "failed-agent-never-joined.json",
    );

    for (const ending of ["orphaned", "dispatch_failed", "capacity"]) {
      const claiming = {
        ...carried,
        events: (carried.events as Record<string, unknown>[]).map((event) => ({
          ...event,
          facts: {
            ...(event.facts as Record<string, unknown>),
            ending,
          },
        })),
      };
      expect(
        reportComplaints(claiming).length,
        `a report claiming "${ending}" raised no complaint`,
      ).toBeGreaterThan(0);
    }
  });

  it("complains about a document that is not an object at all", () => {
    expect(reportComplaints(null).length).toBeGreaterThan(0);
    expect(reportComplaints("a string").length).toBeGreaterThan(0);
  });
});
