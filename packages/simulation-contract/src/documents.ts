import { readFileSync } from "node:fs";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import ajvFormats from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

// ajv-formats ships CommonJS whose module.exports is the plugin function
// itself; under NodeNext TypeScript types the default import as a namespace,
// so the callable gets its name here.
const addFormats = ajvFormats as unknown as FormatsPlugin;

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

let compiledSpec: ValidateFunction | undefined;
let compiledReport: ValidateFunction | undefined;

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
  compiledSpec ??= compileFromDisk("simulation-spec.v1.schema.json");
  return complaintsFrom(compiledSpec, document);
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
