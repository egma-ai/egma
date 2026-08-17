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

/**
 * One folder of golden documents. `spec` is the version-1 spec direction,
 * `spec-v2` the version-2 one, and `report` the direction that comes back.
 *
 * The two spec versions are two folders rather than one because they are two
 * closed documents: a version-2 document is not a version-1 document with an
 * extra field, it is a different contract, and a folder that mixed them would
 * be checked against whichever schema the loop happened to be holding.
 */
type Direction = "spec" | "spec-v2" | "report";

async function fixturesUnder(
  direction: Direction,
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

const specSchema = await readJson("schemas", "simulation-spec.v1.schema.json");
const specSchemaV2 = await readJson(
  "schemas",
  "simulation-spec.v2.schema.json",
);
const reportSchema = await readJson(
  "schemas",
  "simulation-report.v1.schema.json",
);

// Compiling is itself part of the suite's job: a schema that is not valid
// 2020-12, or that trips Ajv's strict mode, fails before any fixture is read.
const validators = {
  spec: ajv.compile(specSchema),
  "spec-v2": ajv.compile(specSchemaV2),
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
  "spec/limits-missing.json": {
    at: "",
    keyword: "required",
    property: "limits",
  },
  "spec/modality-unknown.json": { at: "/modality", keyword: "enum" },
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
  "spec/unknown-field.json": {
    at: "",
    keyword: "additionalProperties",
    property: "agent_id",
  },
  // The platform's own settings are a closed list on both sides — the catalog
  // the control plane stores them under, and the block the simulator reads. A
  // field nobody writes is a setting nobody reads, and a spec carrying one has
  // a deployment believing something is configured that is not, so it is
  // refused rather than carried and dropped.
  "spec/platform-setting-unknown.json": {
    at: "/platform/model",
    keyword: "additionalProperties",
    property: "base_url",
  },
  "spec/wrong-contract-version.json": {
    at: "/contract_version",
    keyword: "const",
  },
  /**
   * The mixed-rollout guard, as a document.
   *
   * A version-1 document carrying version 2's `models` block is exactly what a
   * control plane that got the negotiation wrong would emit, and the failure it
   * would cause is the quiet one: a worker that ignored the unknown block would
   * conduct the simulation with its deployment's own model settings while the
   * control plane believed it had sent the persona's — same conversation,
   * different voice, different brain, different bill, nothing saying so. The
   * version-1 schema closes its top level, so the block is refused loudly here
   * rather than dropped silently there.
   */
  "spec/models-on-the-old-contract.json": {
    at: "",
    keyword: "additionalProperties",
    property: "models",
  },
  // Version 2's block is required, because a version-2 document without it is a
  // version-1 document wearing the wrong number.
  "spec-v2/models-missing.json": {
    at: "",
    keyword: "required",
    property: "models",
  },
  // Under customer-owned access the simulator is calling the provider itself
  // and has nothing else to authenticate with, so every selection carries its
  // own key. A selection without one would reach the provider unauthenticated
  // and fail there, minutes later, naming nothing about configuration.
  "spec-v2/customer-owned-without-a-key.json": {
    at: "/models/stt",
    keyword: "required",
    property: "key",
  },
  // The work order carries the secret itself and never a pointer to one. An
  // identifier would be a second way to reach a credential — one the simulator
  // has no database to follow and the control plane would have to keep
  // resolvable for as long as any worker held it.
  "spec-v2/models-carrying-a-credential-id.json": {
    at: "/models",
    keyword: "additionalProperties",
    property: "credential_id",
  },
  // The persona's pace is bounded by what speech stays intelligible at, in the
  // same range the authoring door enforces — so a document and a form cannot
  // come to disagree about what a persona may be saved as.
  "spec-v2/speaking-faster-than-a-voice-goes.json": {
    at: "/models/tts/speed",
    keyword: "maximum",
  },
  // A chat simulation has no mouth and no ears, so a speech key on its wire is
  // a secret travelling for nothing. Refused rather than carried and ignored.
  "spec-v2/chat-carrying-a-speech-key.json": {
    at: "/models/stt",
    keyword: "not",
  },
  // Egma's provider credentials stay inside the Egma model gateway. A managed
  // work order carrying one is refused on the sending side rather than arriving
  // at a simulator that had no business holding it.
  "spec-v2/managed-carrying-a-provider-key.json": {
    at: "/models",
    keyword: "oneOf",
  },
  // Managed access with nowhere for the traffic to go and nothing to authorize
  // it. Refused rather than delivered, because the only thing a simulator could
  // do with it is fall back to calling a provider directly.
  "spec-v2/managed-without-a-gateway.json": {
    at: "/models",
    keyword: "oneOf",
  },
  // Customer-owned access is Egma off the model traffic path entirely, so a
  // gateway address and a gateway credential are two things nothing would use
  // and one of them is a credential.
  "spec-v2/customer-owned-carrying-a-gateway.json": {
    at: "/models",
    keyword: "oneOf",
  },
  // A version-2 document is one whose persona selected its own models, and
  // those selections carry the credentials that authorize every leg — so the
  // deployment's own model and speech settings beside them would be three more
  // provider keys on the wire with nothing to spend them on. Refused rather
  // than carried and ignored, because a document that may hold two answers is
  // one every reader has to decide between.
  "spec-v2/platform-carrying-model-settings.json": {
    at: "/platform",
    keyword: "additionalProperties",
    property: "model",
  },
  "spec-v2/platform-carrying-speech-settings.json": {
    at: "/platform",
    keyword: "additionalProperties",
    property: "speech",
  },
  "spec-v2/unknown-field.json": {
    at: "",
    keyword: "additionalProperties",
    property: "agent_id",
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
  it("pin the same contract version, so the directions cannot drift apart", () => {
    const versionOf = (schema: Record<string, unknown>): unknown =>
      (
        (schema.properties as Record<string, Record<string, unknown>>)
          .contract_version as Record<string, unknown>
      ).const;
    expect(versionOf(specSchema)).toBe(1);
    expect(versionOf(specSchemaV2)).toBe(2);
    expect(versionOf(reportSchema)).toBe(1);
  });

  it("each carry an identity a $ref or an error message can name", () => {
    expect(specSchema.$id).toBe("urn:egma:simulation-contract:spec:v1");
    expect(specSchemaV2.$id).toBe("urn:egma:simulation-contract:spec:v2");
    expect(reportSchema.$id).toBe("urn:egma:simulation-contract:report:v1");
  });

  /**
   * Version 2 is version 1 with one block added and one block narrowed, and
   * this is what says so.
   *
   * Written out rather than derived, because the two schemas are two frozen
   * documents on purpose: a reader has to be able to see the whole of what a
   * version says without holding the other one in their head. The price is that
   * they could drift apart in a field neither version meant to change, and this
   * pins everything except the version, the identity and the block that is the
   * point of the second version.
   *
   * **Prose is stripped everywhere rather than only at the top.** What must not
   * fork is the shape — which fields exist, what they accept, what is required
   * — and a description is neither. Each version explains itself to the reader
   * who has that version in front of them, so a sentence reworded in one and
   * not the other is the documents doing their job rather than drifting.
   */
  it("differ by the models block, the narrowed platform block, and nothing else", () => {
    /** Every `description`, anywhere, gone — see the note above. */
    const withoutProse = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(withoutProse);
      if (typeof node !== "object" || node === null) return node;
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .filter(([key]) => key !== "description")
          .map(([key, value]) => [key, withoutProse(value)]),
      );
    };

    const stripped = (schema: Record<string, unknown>): unknown => {
      const clone = withoutProse(structuredClone(schema)) as Record<
        string,
        unknown
      >;
      delete clone.$id;
      delete clone.title;
      const properties = clone.properties as Record<string, unknown>;
      delete properties.contract_version;
      delete properties.models;
      // The second difference, and it is pinned on its own below rather than
      // compared here: a version-2 document's persona selected its own models,
      // so the deployment's model and speech settings have nothing to decide
      // and are refused rather than carried. The carrier settings stay, because
      // how a call reaches the telephone network is the deployment's and a
      // persona cannot select it.
      delete properties.platform;
      clone.required = (clone.required as string[]).filter(
        (name) => name !== "models",
      );
      const defs = clone.$defs as Record<string, unknown>;
      // The two version 1 defines for the blocks version 2 refuses, gone with
      // the property that referenced them.
      delete defs.platform_model;
      delete defs.platform_speech;
      for (const added of [
        "models",
        "model_selection",
        "customer_owned_llm",
        "managed_selection",
        "speech_selection",
        "managed_speech_selection",
        "gateway",
      ]) {
        delete defs[added];
      }
      // The one rule that reads two fields at once — which speech keys travel
      // depends on the modality — and therefore the one that cannot live
      // inside the models block. It arrived with version 2 like the block.
      delete clone.allOf;
      return clone;
    };

    expect(stripped(specSchemaV2)).toEqual(stripped(specSchema));
  });

  /**
   * The narrowing itself, pinned where deleting it fails something.
   *
   * Version 1 hands a simulator the deployment's model, speech and carrier
   * settings. Version 2 is a document whose persona selected its own models and
   * whose selections carry the credentials that authorize every leg — so the
   * first two would be three provider keys travelling with nothing to spend
   * them on, and a reader holding both would have to decide which answer wins.
   * Version 2 carries the carrier settings and refuses the rest.
   */
  it("narrow the platform block on version 2 to the carrier settings alone", () => {
    const blockOf = (schema: Record<string, unknown>): readonly string[] => {
      const platform = (
        schema.properties as Record<string, Record<string, unknown> | undefined>
      ).platform;
      return Object.keys(
        (platform?.properties as Record<string, unknown> | undefined) ?? {},
      ).sort();
    };

    expect(blockOf(specSchema)).toEqual(["carrier", "model", "speech"]);
    expect(blockOf(specSchemaV2)).toEqual(["carrier"]);
    // Closed, so the two it drops are refused rather than ignored.
    expect(
      (specSchemaV2.properties as Record<string, Record<string, unknown>>)
        .platform?.additionalProperties,
    ).toBe(false);
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

  it("keeps a voice recording without a second sample-rate fact", async () => {
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

    delete audio.measured_sample_rate_hz;
    expect(
      validators.report(report),
      JSON.stringify(validators.report.errors),
    ).toBe(true);

    audio.measured_sample_rate_hz = 8_000;
    expect(validators.report(report)).toBe(false);
    expect(validators.report.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "/events/0/facts/audio",
        keyword: "additionalProperties",
        params: { additionalProperty: "measured_sample_rate_hz" },
      }),
    );
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

for (const direction of ["spec", "spec-v2", "report"] as const) {
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
 * The coverage stamp: which of the agent's tools egma stood ready to answer
 * for, and which ran their real implementations untouched.
 *
 * It rides the terminal facts because two simulations are only comparable
 * when they were the same kind of
 * thing, and a simulation whose backends were answered by mock tools is not
 * the same kind of thing as one that reached the real ones — so the fact has
 * to be readable from the simulation's own record, without asking anything
 * that is editable afterwards, and without joining anything at all.
 */
describe("the coverage stamp on the terminal facts", () => {
  type Stamp = {
    readonly discovered: readonly string[];
    readonly covered: readonly string[];
    readonly uncovered: readonly string[];
  };

  /** Each valid report fixture's stamp, or undefined where it carries none. */
  async function stamps(): Promise<Map<string, Stamp | undefined>> {
    const byFixture = new Map<string, Stamp | undefined>();
    for (const fixture of await fixturesUnder("report", "valid")) {
      for (const event of fixture.document.events as Record<string, unknown>[]) {
        const facts = event.facts as Record<string, unknown> | undefined;
        if (facts === undefined) continue;
        byFixture.set(fixture.name, facts.mock_tool_coverage as Stamp | undefined);
      }
    }
    return byFixture;
  }

  it("reads back a simulation whose every discovered tool was covered", async () => {
    expect((await stamps()).get("completed-mocked-fully-covered.json")).toEqual({
      discovered: ["check_calendar", "book_appointment", "send_confirmation_sms"],
      covered: ["check_calendar", "book_appointment", "send_confirmation_sms"],
      uncovered: [],
    });
  });

  it("reads back a mixed simulation, which is the one that was not fully isolated", async () => {
    // Three of the agent's four tools ran for real. `send_confirmation_sms` is
    // covered without having been discovered: what the agent reported is a
    // snapshot of the simulation's first moment, while an answer is held ready
    // for every name the simulation covers — so a tool attached afterwards is
    // answered anyway, and a call served for it lands flagged late-attached.
    expect((await stamps()).get("completed-mocked-mixed-coverage.json")).toEqual({
      discovered: [
        "check_calendar",
        "book_appointment",
        "lookup_customer",
        "transfer_to_human",
      ],
      covered: ["check_calendar", "send_confirmation_sms"],
      uncovered: ["book_appointment", "lookup_customer", "transfer_to_human"],
    });
  });

  it("reads back a simulation where nothing was discovered at all, which is a plain unmocked one", async () => {
    expect(
      (await stamps()).get("completed-unmocked-nothing-discovered.json"),
    ).toEqual({ discovered: [], covered: [], uncovered: [] });
  });

  it("leaves the stamp off a simulation nothing offered a seam on, so the expand breaks nobody", async () => {
    const unstamped = [...(await stamps())].filter(
      ([, stamp]) => stamp === undefined,
    );
    // The fixtures that predate mock tools still validate untouched, and their
    // silence is the honest reading: egma never asked this agent what tools it
    // had, so the record claims nothing about them.
    expect(unstamped.length).toBeGreaterThan(0);
  });

  it("says at a glance whether mock tools took part, without joining anything", async () => {
    const involved = [...(await stamps())]
      .filter(([, stamp]) => stamp !== undefined && stamp.covered.length > 0)
      .map(([name]) => name)
      .sort();
    expect(involved).toEqual([
      "completed-mocked-fully-covered.json",
      "completed-mocked-mixed-coverage.json",
    ]);
  });

  it("never has one tool both covered and uncovered, and keeps uncovered to what was discovered", async () => {
    for (const [name, stamp] of await stamps()) {
      if (stamp === undefined) continue;
      const covered = new Set(stamp.covered);
      // Uncovered is exactly the discovered tools nothing answered for. The
      // three lists are written out rather than derived, the way turn_count is
      // written out rather than counted from the spans, and this is what holds
      // the written answer to the arithmetic it stands for.
      expect(stamp.uncovered, name).toEqual(
        stamp.discovered.filter((tool) => !covered.has(tool)),
      );
    }
  });

  /** The stamp of a fully covered simulation, as a fixture holds it. */
  async function fullyCovered(): Promise<Record<string, unknown>> {
    return readJson(
      "fixtures",
      "report",
      "valid",
      "completed-mocked-fully-covered.json",
    );
  }

  /** The same document with its stamp replaced by the given one. */
  function stamped(
    carried: Record<string, unknown>,
    stamp: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...carried,
      events: (carried.events as Record<string, unknown>[]).map((event) => ({
        ...event,
        facts: { ...(event.facts as Record<string, unknown>), mock_tool_coverage: stamp },
      })),
    };
  }

  it("refuses a tool named twice in one list, because a name is a tool and not a count", async () => {
    const carried = await fullyCovered();
    const [event] = carried.events as Record<string, unknown>[];
    const facts = event?.facts as Record<string, unknown> | undefined;
    const stamp = facts?.mock_tool_coverage as Stamp | undefined;
    if (stamp === undefined) throw new Error("the fixture carries no stamp");

    // Matching is by name and one answer per name, so a name written twice
    // says nothing a name written once does not — and a list that permitted it
    // would let a miscount look like a wider reach.
    const repeated = [...stamp.discovered, stamp.discovered[0] ?? ""];
    // The place and the problem, without the pair of indices Ajv adds after
    // them: which two entries collided is not the fact under test, and pinning
    // it would make this fail the day the fixture grows a tool.
    const complaints = reportComplaints(
      stamped(carried, { ...stamp, discovered: repeated }),
    );
    expect(
      complaints.some((complaint) =>
        complaint.startsWith(
          "/events/0/facts/mock_tool_coverage/discovered: must NOT have duplicate items",
        ),
      ),
      complaints.join("; "),
    ).toBe(true);
  });

  it("refuses a stamp naming a tool with no name at all", async () => {
    const carried = await fullyCovered();
    expect(
      reportComplaints(
        stamped(carried, { discovered: [""], covered: [], uncovered: [""] }),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("refuses a half-written stamp, because a coverage claim with a list missing claims nothing", async () => {
    const whole = {
      discovered: ["check_calendar"],
      covered: ["check_calendar"],
      uncovered: [],
    };

    for (const dropped of Object.keys(whole)) {
      const partial: Record<string, unknown> = { ...whole };
      delete partial[dropped];
      expect(
        reportComplaints(stamped(await fullyCovered(), partial)),
        `a stamp missing ${dropped} raised no complaint`,
      ).toContain(
        `/events/0/facts/mock_tool_coverage: must have required property '${dropped}'`,
      );
    }
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
