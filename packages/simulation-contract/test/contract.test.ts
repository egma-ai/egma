import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import ajvFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import { reportComplaints, specComplaints } from "@egma/simulation-contract";

// ajv-formats ships CommonJS whose module.exports is the plugin function
// itself. Under NodeNext, the default import is typed as its namespace and
// the namespace's default is that callable, with its declared type intact.
const addFormats = ajvFormats.default;

/**
 * Validate the same valid/invalid JSON fixtures as the Python simulator.
 * Read them from disk so both implementations test the same contract bytes.
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

const specSchema = await readJson("schemas", "simulation-spec.v6.schema.json");
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
    at: "/persona/parameters",
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
  it("carries per-claim Daytona authority only on a voice work order", async () => {
    const base = await readJson(
      "fixtures",
      "spec",
      "valid",
      "voice-loopback.json",
    );
    const runtime = {
      kind: "daytona_voice",
      media: {
        backend: "livekit",
        livekit_url: "wss://livekit.example",
        livekit_room_name: "egma-sim-sim_123",
        livekit_room_token: "room-token",
        livekit_api_token: "api-token",
      },
      storage: {
        backend: "s3",
        endpoint: "https://s3.example",
        bucket: "recordings",
        region: "us-east-1",
        access_key_id: "temporary-access",
        secret_access_key: "temporary-secret",
        session_token: "temporary-session",
      },
    };
    expect(validators.spec({ ...base, runtime })).toBe(true);
    expect(validators.spec({ ...base, modality: "chat", runtime })).toBe(false);
    expect(
      validators.spec({
        ...base,
        runtime: { ...runtime, storage: { ...runtime.storage, session_token: "" } },
      }),
    ).toBe(false);
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
    connection.connection_type = "retell_text_mode";
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

  it("carries a drawn recording as peaks between zero and one, or not at all", async () => {
    const report = await readJson(
      "fixtures",
      "report",
      "valid",
      "completed-voice.json",
    );
    const event = (report.events as Record<string, unknown>[])[0];
    if (event === undefined) throw new Error("the completed report has no event");
    const facts = event.facts as Record<string, unknown>;
    const audio = facts.audio as Record<string, unknown>;
    const waveform = audio.waveform as Record<string, number[]>;

    // Full scale is the loudest a peak can be, so anything above it is not a
    // measurement of this recording.
    const human = waveform.human as number[];
    human[0] = 1.5;
    expect(validators.report(report)).toBe(false);
    expect(validators.report.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "/events/0/facts/audio/waveform/human/0",
        keyword: "maximum",
      }),
    );
    human[0] = 0.04;

    // The channels are the transcript's two speakers and nobody else.
    waveform.mixed = [0.5];
    expect(validators.report(report)).toBe(false);
    expect(validators.report.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "/events/0/facts/audio/waveform",
        keyword: "additionalProperties",
        params: { additionalProperty: "mixed" },
      }),
    );
    delete waveform.mixed;

    // A recording nothing measured is still a recording.
    delete audio.waveform;
    expect(
      validators.report(report),
      JSON.stringify(validators.report.errors),
    ).toBe(true);
  });
});

for (const direction of ["spec", "report"] as const) {
  describe(`the ${direction} direction`, () => {
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
    const spec = await readJson("fixtures", "spec", "valid", "chat-retell-text-mode-api.json");
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

describe("the exported spec check, which the control plane sends through", () => {
  it("compiles and accepts current separate, Live voice, and Live chat specs", async () => {
    const [captured] = await fixturesUnder("spec", "valid");
    if (captured === undefined) throw new Error("no valid spec fixture");
    const currentPersona = {
      name: "Mara",
      personality: "Careful and direct.",
      parameters: {
        language: "en-US",
        background_sound_id: "none",
        interruption_level: "none",
        execution_policy_version: 2,
      },
    };
    const llm = {
      provider: "openai",
      model: "gpt-4o-mini",
      adapter: "openai_chat_completions",
      key: "fixture-backend-key",
    };
    const separate = {
      ...captured.document,
      contract_version: 7,
      persona: currentPersona,
      models: {
        mode: "separate",
        llm,
        stt: {
          provider: "deepgram",
          model: "nova-3-general",
          adapter: "deepgram",
          key: "fixture-stt-key",
        },
        tts: {
          provider: "cartesia",
          model: "sonic-3.5",
          adapter: "cartesia",
          voice_id: "measured-alto-3",
          key: "fixture-tts-key",
        },
      },
    };
    const live = {
      provider: "openai",
      model: "gpt-live-1",
      adapter: "openai_live",
      voice_id: "marin",
      key: "fixture-live-key",
    };

    expect(specComplaints(separate)).toEqual([]);
    const liveVoice = {
      ...separate,
      modality: "voice",
      persona: {
        ...currentPersona,
        parameters: {
          language: "en-US",
          background_sound_id: "none",
          execution_policy_version: 2,
        },
      },
      models: { mode: "live", llm, live },
    };
    expect(specComplaints(liveVoice)).toEqual([]);
    const { key: _liveKey, ...liveWithoutKey } = live;
    expect(specComplaints({
      ...liveVoice,
      modality: "chat",
      models: { mode: "live", llm, live: liveWithoutKey },
    })).toEqual([]);
    expect(specComplaints({
      ...liveVoice,
      modality: "chat",
      models: { mode: "live", llm, live },
    })).toContain("/models/live: must NOT be valid");
    expect(specComplaints({
      ...liveVoice,
      modality: "voice",
      models: { mode: "live", llm, live: liveWithoutKey },
    })).toContain("/models/live: must have required property 'key'");

    for (const retired of [
      "accent",
      "emotion",
      "speech_speed",
      "tts_speed",
      "speech_volume",
      "background_volume",
    ]) {
      const candidate = structuredClone(separate);
      (candidate.persona.parameters as Record<string, unknown>)[retired] = 1;
      expect(specComplaints(candidate)).toContain(
        `/persona/parameters: must NOT have additional properties`,
      );
    }

    const liveWithInterruption = structuredClone(liveVoice);
    (liveWithInterruption.persona.parameters as Record<string, unknown>)
      .interruption_level = "none";
    expect(specComplaints(liveWithInterruption)).toContain(
      "/persona/parameters: must NOT be valid",
    );

    const cascadedWithoutInterruption = structuredClone(separate);
    delete (cascadedWithoutInterruption.persona.parameters as Record<string, unknown>)
      .interruption_level;
    expect(specComplaints(cascadedWithoutInterruption)).toContain(
      "/persona/parameters: must have required property 'interruption_level'",
    );
  });

  it("has no complaints about any valid golden fixture", async () => {
    for (const fixture of await fixturesUnder("spec", "valid")) {
      expect(specComplaints(fixture.document), fixture.name).toEqual([]);
    }
  });

  it("keeps validating captured version 5 work with the version 5 schema", async () => {
    const [current] = await fixturesUnder("spec", "valid");
    if (current === undefined) throw new Error("no valid spec fixture");
    const persona = current.document.persona as Record<string, unknown>;
    const legacy = {
      ...current.document,
      contract_version: 5,
      persona: { name: persona.name, personality: persona.personality, language: "en-US" },
    };
    expect(specComplaints(legacy)).toEqual([]);
  });
});

describe("the exported report check, which the report route reads through", () => {
  it("has no complaints about any valid golden fixture", async () => {
    for (const fixture of await fixturesUnder("report", "valid")) {
      expect(reportComplaints(fixture.document), fixture.name).toEqual([]);
    }
  });
});
