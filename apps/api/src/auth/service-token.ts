import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The secret the simulator holds, and how a request carrying one is let in.
 *
 * This is the sibling of `api-key.ts`, and the whole of the difference is
 * what the secret resolves to: nothing. An egma key becomes a customer
 * `AuthContext`; the service token opens the work-claiming door and becomes
 * no context at all, which is what makes it structurally unable to widen
 * into anybody's data — the claim it guards hands back per-simulation
 * contexts built from the claimed rows, never from the caller. One
 * deployment-level value, read from the environment on both sides, on the
 * pattern every self-host-first pull worker ships.
 */

/**
 * The static prefix every egma service token starts with.
 *
 * It exists for the same two reasons `egma_sk_` does — a secret-scanning
 * service can recognise a leaked token, and the two resolvers can never
 * mistake each other's credential: the customer-key path demands `egma_sk_`,
 * this one demands `egma_st_`, and a token is one or the other by its first
 * bytes.
 */
export const SERVICE_TOKEN_PREFIX = "egma_st_";

/**
 * The service token on a request, if it carries one.
 *
 * `Authorization: Bearer <token>`, and the prefix has to be the service
 * one — anything else is a customer key, a session token or a header meant
 * for the provider, and none of those is this door's business.
 */
function serviceTokenOn(header: string | undefined): string | null {
  if (header === undefined) return null;

  const [scheme, ...rest] = header.trim().split(/\s+/u);
  if (scheme?.toLowerCase() !== "bearer") return null;

  const token = rest.join("");
  return token.startsWith(SERVICE_TOKEN_PREFIX) ? token : null;
}

/**
 * Whether this request holds the deployment's service token.
 *
 * Both sides are hashed before the compare, the house habit from
 * `api-key.ts`: `timingSafeEqual` demands equal-length inputs, and hashing
 * is what makes the lengths equal without an early return that would leak
 * how much of the token matched. The presented token is never echoed, never
 * logged, and never stored — there is nothing to resolve it into.
 */
export function acceptsServiceToken(
  header: string | undefined,
  configured: string,
): boolean {
  const presented = serviceTokenOn(header);
  if (presented === null) return false;

  const digest = (value: string): Buffer =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(presented), digest(configured));
}
