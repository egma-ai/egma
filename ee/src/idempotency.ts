/**
 * What makes a movement of an inference balance happen at most once.
 *
 * **The keys are derived here and nowhere else**, for the reason a usage
 * record's deterministic identity is derived in one place: a second derivation
 * is a second answer to "is this the same movement", and the two would be
 * found disagreeing by a customer whose money moved twice rather than by a
 * test. Nothing here reaches a store — a fact goes in, a string comes out —
 * and the unique index on `cloud_ledger_entry.idempotency_key` is what turns
 * the string into the guarantee.
 *
 * Each key names the thing that caused the movement rather than the movement,
 * so a replay of the cause writes nothing: an organization for its one welcome
 * credit, a usage record for its one charge.
 */

/** The key a welcome credit is written under. One per organization, forever. */
export function welcomeCreditKey(organizationId: string): string {
  return `welcome_credit:${organizationId}`;
}

/** The key an inference charge is written under. One per usage record. */
export function inferenceChargeKey(usageRecordId: string): string {
  return `inference_charge:${usageRecordId}`;
}
