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
 * This is the control plane's half of the same guarantee, pointed the other
 * way: a spec is checked *before it is sent*, so a document that does not
 * speak the contract is a fault caught on the sending side rather than a
 * refusal the simulator has to explain back.
 *
 * The answer is a list of complaints rather than a thrown violation, because
 * the caller's next move is not an exception's: one unbuildable spec is
 * skipped and said out loud, and the rest of the batch still goes. Each
 * complaint names the place and the problem — `/modality: must be equal to
 * one of the allowed values` — in the same shape the simulator's own check
 * logs, so the two sides of the wire read alike in two languages.
 *
 * Only the spec direction is checked from here today, because only specs are
 * composed on this side; the report direction's TypeScript half arrives with
 * the route that consumes reports.
 */

/**
 * Compiled once, on first use rather than at import, so loading the package
 * for its measure catalog never pays for — or fails on — schema compilation.
 * Compiling is itself part of the check: a schema that is not valid 2020-12
 * fails loudly here, rather than quietly accepting everything.
 */
let compiledSpec: ValidateFunction | undefined;

function specValidator(): ValidateFunction {
  if (compiledSpec === undefined) {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const schema: unknown = JSON.parse(
      readFileSync(
        new URL("../schemas/simulation-spec.v1.schema.json", import.meta.url),
        "utf8",
      ),
    );
    compiledSpec = ajv.compile(schema as Record<string, unknown>);
  }
  return compiledSpec;
}

/**
 * Everything wrong with one would-be spec document, or nothing.
 *
 * An empty answer is the green light: the document speaks the spec direction
 * of the contract and a simulator holding this contract version will accept
 * it. Anything else is the full list — `allErrors`, deliberately, so a log
 * line about a skipped simulation says everything wrong with it at once
 * rather than one complaint per attempt that will never be retried.
 */
export function specComplaints(document: unknown): readonly string[] {
  const validate = specValidator();
  if (validate(document)) return [];
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath}: ${error.message ?? "does not validate"}`,
  );
}
