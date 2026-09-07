import {
  allowanceKindOf,
  allowanceKindsAmong,
  type AllowanceKind,
  type EntitlementSource,
  type SimulationClaim,
} from "@egma/db";

/**
 * Whether the work a claim batch just picked up may go on.
 *
 * **The second of the two moments the entitlement source is asked**, and it
 * exists because a run admitted an hour ago can outlive the allowance that
 * admitted it: the first conversation of a hundred-conversation run is not the
 * hundredth. A simulation the source refuses here goes back on the queue and
 * waits — for the month to reset, for a plan to change, for credit to arrive —
 * rather than failing, because nothing about it is wrong.
 *
 * **Once per organization per batch, and never once per simulation.** A batch
 * of fifty conversations spanning three customers asks three questions, each
 * naming every kind of work that customer has in the batch. That is the whole
 * of the rule the spec sets for this path, and the shape here is what enforces
 * it: the batch is grouped first and the source is handed a set of allowance
 * kinds, so there is no arrangement of this code in which a per-simulation ask
 * is the easy thing to write.
 *
 * **The source is handed in rather than fetched.** The process that booted
 * chose the adapter and holds it; a route that could reach into the package
 * for one would be a route able to ask billing anything from anywhere. It
 * arrives the way this route's provider credentials and carrier route do.
 *
 * **It cannot serialise claims.** Nothing here holds a lock, opens a
 * transaction or waits on another claimant: the batch has already been taken —
 * `claimSimulations` committed before this runs — and the questions for
 * different organizations are asked at the same time rather than one after
 * another, so one customer's slow adapter cannot hold up another's work. How
 * many simulations run at once is decided by the simulator's own declared
 * capacity, exactly as it was before this existed. On a deployment with no
 * billing the whole of it is one resolved promise per organization.
 */

/** What a batch may not go on with, by simulation id. */
export type WithheldClaims = ReadonlyMap<string, WithheldClaim>;

export type WithheldClaim = {
  readonly allowance: AllowanceKind;
  /** The adapter's own sentence, for the log and for a queued conversation. */
  readonly reason: string;
};

export async function claimsWithheldByEntitlement(
  entitlements: EntitlementSource,
  claims: readonly SimulationClaim[],
): Promise<WithheldClaims> {
  if (claims.length === 0) return new Map();

  const byOrganization = new Map<string, SimulationClaim[]>();
  for (const claim of claims) {
    const held = byOrganization.get(claim.organizationId);
    if (held === undefined) byOrganization.set(claim.organizationId, [claim]);
    else held.push(claim);
  }

  // Together, not in turn. One question per customer, all in flight at once.
  const answers = await Promise.all(
    [...byOrganization.entries()].map(async ([organizationId, theirs]) => ({
      theirs,
      decision: await entitlements.mayStart({
        organizationId,
        allowances: allowanceKindsAmong(theirs),
      }),
    })),
  );

  const withheld = new Map<string, WithheldClaim>();
  for (const { theirs, decision } of answers) {
    if (decision.allowed) continue;
    const refusedKinds = new Map(
      decision.refusals.map((refusal) => [refusal.allowance, refusal] as const),
    );
    for (const claim of theirs) {
      const refusal = refusedKinds.get(allowanceKindOf(claim));
      if (refusal === undefined) continue;
      // A refusal of one kind withholds that kind's conversations and leaves
      // the rest of the customer's batch alone: a spent phone allowance does
      // not stop a chat.
      withheld.set(claim.id, {
        allowance: refusal.allowance,
        reason: refusal.message,
      });
    }
  }
  return withheld;
}
