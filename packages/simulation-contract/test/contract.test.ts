import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import ajvFormats from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";

import { specComplaints } from "@egma/simulation-contract";

// ajv-formats ships CommonJS whose module.exports is the plugin function
// itself; under NodeNext TypeScript types the default import as a namespace,
// so the callable gets its name here.
const addFormats = ajvFormats as unknown as FormatsPlugin;

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

const specSchema = await readJson("schemas", "simulation-spec.v1.schema.json");
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
  "spec/limits-missing.json": {
    at: "",
    keyword: "required",
    property: "limits",
  },
  "spec/modality-unknown.json": { at: "/modality", keyword: "enum" },
  "spec/unknown-field.json": {
    at: "",
    keyword: "additionalProperties",
    property: "agent_id",
  },
  "spec/wrong-contract-version.json": {
    at: "/contract_version",
    keyword: "const",
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
    expect(versionOf(reportSchema)).toBe(1);
  });

  it("each carry an identity a $ref or an error message can name", () => {
    expect(specSchema.$id).toBe("urn:egma:simulation-contract:spec:v1");
    expect(reportSchema.$id).toBe("urn:egma:simulation-contract:report:v1");
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

  it("shows every report event kind, and every terminal status", async () => {
    const reports = await fixturesUnder("report", "valid");
    const events = reports.flatMap(
      (fixture) => fixture.document.events as Record<string, unknown>[],
    );

    const kinds = new Set(events.map((event) => event.kind));
    expect(kinds).toEqual(new Set(["status", "turn", "tool_call", "timing"]));

    const statuses = new Set(
      events
        .filter((event) => event.kind === "status")
        .map((event) => event.status),
    );
    expect(statuses).toEqual(
      new Set(["running", "completed", "failed", "canceled"]),
    );
  });

  it("shows a measured audio band on a voice report, and its absence on chat", async () => {
    const reports = await fixturesUnder("report", "valid");
    const facts = reports
      .flatMap((fixture) => fixture.document.events as Record<string, unknown>[])
      .filter((event) => event.facts !== undefined)
      .map((event) => event.facts as Record<string, unknown>);

    const bands = facts.map((terminal) => terminal.audio);
    expect(bands).toContain(null);
    expect(bands.some((audio) => audio !== null && audio !== undefined)).toBe(
      true,
    );
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
