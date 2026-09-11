import { readFileSync } from "node:fs";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import ajvFormats from "ajv-formats";

// ajv-formats ships CommonJS whose module.exports is the plugin function
// itself. Under NodeNext, the default import is typed as its namespace and
// the namespace's default is that callable, with its declared type intact.
const addFormats = ajvFormats.default;

/**
 * Validate outgoing specs and incoming reports against the JSON schemas also
 * used by the Python simulator. Return path-qualified complaints instead of
 * throwing so an invalid spec does not stop the rest of a claim batch.
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
  compiledSpec ??= compileFromDisk("simulation-spec.v6.schema.json");
  return complaintsFrom(compiledSpec, document);
}

/**
 * Return schema complaints, or an empty list for a valid report. Only simulator
 * endings are accepted; orphaned and dispatch_failed belong to the platform.
 */
export function reportComplaints(document: unknown): readonly string[] {
  compiledReport ??= compileFromDisk("simulation-report.v1.schema.json");
  return complaintsFrom(compiledReport, document);
}
