import { readFileSync } from "node:fs";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import ajvFormats from "ajv-formats";

// ajv-formats ships CommonJS whose module.exports is the plugin function
// itself. Under NodeNext, the default import is typed as its namespace and
// the namespace's default is that callable, with its declared type intact.
const addFormats = ajvFormats.default;

/**
 * The contract's documents, as TypeScript can check them.
 *
 * The schemas under `schemas/` are the authority, read from disk because the
 * other reader of those bytes is not TypeScript — the simulator compiles the
 * same files (`contract.py`) and holds every claimed spec to the spec schema.
 * This is the control plane's half of the same guarantee, both ways round: a
 * spec is checked *before it is sent*, so a document that does not speak the
 * contract is a fault caught on the sending side rather than a refusal the
 * simulator has to explain back — and a report is checked *as it arrives*,
 * so nothing off the wire reaches a lifecycle write without having proven it
 * speaks the contract the simulator's own check already applied on the way
 * out.
 *
 * The answer is a list of complaints rather than a thrown violation, because
 * the caller's next move is not an exception's: one unbuildable spec is
 * skipped and said out loud, and the rest of the batch still goes; one
 * refused report is answered with its complaints, and the simulator's log
 * shows the same sentences its own check would have raised. Each complaint
 * names the place and the problem — `/modality: must be equal to one of the
 * allowed values` — in the same shape the simulator's check logs, so the two
 * sides of the wire read alike in two languages.
 */

/**
 * Compiled once each, on first use rather than at import, so loading the
 * package for its measure catalog never pays for — or fails on — schema
 * compilation. Compiling is itself part of the check: a schema that is not
 * valid 2020-12 fails loudly here, rather than quietly accepting everything.
 */
function compileFromDisk(schemaFile: string): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const schema: unknown = JSON.parse(
    readFileSync(new URL(`../schemas/${schemaFile}`, import.meta.url), "utf8"),
  );
  return ajv.compile(schema as Record<string, unknown>);
}

/**
 * The spec versions this contract package holds a schema for, oldest first.
 *
 * **Two closed documents rather than one with optional fields.** Version 2 adds
 * the persona's model selections and the keys behind them; a worker that
 * implements only version 1 must refuse a version-2 document *by its version*
 * rather than accept it and quietly drop the block it does not understand. That
 * dropping is the failure this shape exists to make unreachable: the simulation
 * would be conducted with the deployment's own model settings while the control
 * plane believed it had sent the persona's, and nothing anywhere would say so.
 *
 * The control plane emits the newest version a claiming worker says it speaks,
 * so during a mixed rollout an old worker keeps receiving version 1 and a new
 * one receives version 2 — with no drain step required and no document ever
 * arriving at a worker that cannot read it.
 */
export const SPEC_CONTRACT_VERSIONS = [1, 2] as const;

/** One version of the spec direction. */
export type SpecContractVersion = (typeof SPEC_CONTRACT_VERSIONS)[number];

const SPEC_SCHEMA_FILE: { readonly [V in SpecContractVersion]: string } = {
  1: "simulation-spec.v1.schema.json",
  2: "simulation-spec.v2.schema.json",
};

const compiledSpec = new Map<SpecContractVersion, ValidateFunction>();
let compiledReport: ValidateFunction | undefined;

/** Whether this number is a spec version this package can check at all. */
export function isSpecContractVersion(
  version: unknown,
): version is SpecContractVersion {
  return SPEC_CONTRACT_VERSIONS.some((known) => known === version);
}

/**
 * Everything wrong with a document by one validator's lights, or nothing.
 * `allErrors`, deliberately, so one answer says everything wrong at once
 * rather than one complaint per attempt.
 */
function complaintsFrom(
  validate: ValidateFunction,
  document: unknown,
): readonly string[] {
  if (validate(document)) return [];
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath}: ${error.message ?? "does not validate"}`,
  );
}

/**
 * Everything wrong with one would-be spec document, or nothing.
 *
 * An empty answer is the green light: the document speaks the spec direction
 * of the contract and a simulator holding this contract version will accept
 * it. Anything else is the full list, because a log line about a skipped
 * simulation should say everything wrong with it at once rather than one
 * complaint per attempt that will never be retried.
 */
export function specComplaints(document: unknown): readonly string[] {
  const version = versionOf(document);
  if (!isSpecContractVersion(version)) {
    // Said before any schema is consulted, because no schema could say it
    // usefully: a document whose version this package does not hold would be
    // checked against a contract it never claimed to speak, and every complaint
    // after that would be about the wrong document.
    return [
      `/contract_version: must be one of ${SPEC_CONTRACT_VERSIONS.join(", ")}, and this document says ${JSON.stringify(version)}`,
    ];
  }

  let compiled = compiledSpec.get(version);
  if (compiled === undefined) {
    compiled = compileFromDisk(SPEC_SCHEMA_FILE[version]);
    compiledSpec.set(version, compiled);
  }
  return complaintsFrom(compiled, document);
}

/**
 * Everything wrong with this document **read as one named version**, whatever
 * version it says it is.
 *
 * The check a worker that implements one version makes, offered here so the
 * control plane can prove what an old worker would do with a new document. The
 * answer is what makes the mixed-rollout rule real rather than intended: a
 * version-1 worker handed a version-2 document complains loudly, and a
 * version-1 document that somehow carried a version-2 block is refused for the
 * block rather than accepted with it silently dropped.
 */
export function specComplaintsAsVersion(
  version: SpecContractVersion,
  document: unknown,
): readonly string[] {
  let compiled = compiledSpec.get(version);
  if (compiled === undefined) {
    compiled = compileFromDisk(SPEC_SCHEMA_FILE[version]);
    compiledSpec.set(version, compiled);
  }
  return complaintsFrom(compiled, document);
}

/** The version a would-be spec claims, whatever shape the rest of it is in. */
function versionOf(document: unknown): unknown {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return undefined;
  }
  return (document as Record<string, unknown>)["contract_version"];
}

/**
 * Everything wrong with one arrived report document, or nothing.
 *
 * An empty answer means the document speaks the report direction of the
 * contract, and only then does the control plane read anything out of it —
 * which is also where the vocabulary line is held: the endings a caller may
 * report are the ones the schema enumerates, so the platform's own words
 * (`orphaned` is the sweep's, `dispatch_failed` the claim path's) are refused
 * here as documents rather than reasoned about as states.
 */
export function reportComplaints(document: unknown): readonly string[] {
  compiledReport ??= compileFromDisk("simulation-report.v1.schema.json");
  return complaintsFrom(compiledReport, document);
}
