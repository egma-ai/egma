import type { Role } from "../schema/columns.ts";

/**
 * Who is asking, which customer, which project, what role.
 *
 * Every function this module exports that reads or writes a customer's data
 * takes one of these, and the module builds the tenancy predicates from it. A
 * caller cannot forget the filter because a caller cannot call without the
 * context, and cannot widen it because no exported function accepts one.
 *
 * The organization is resolved from the credential — the person's membership,
 * or the API key's own row — and never from a request payload, so a buggy or
 * malicious client cannot ask for another customer's data by asking nicely.
 *
 * Deliberately store-neutral. When the ClickHouse client arrives behind this
 * same boundary it takes this same context on the same terms.
 */
export type AuthContext = {
  /** egma's own user id. */
  readonly userId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly role: Role;
  readonly via: Via;
};

/** How the caller proved who they are. */
export const VIA = ["session", "api_key"] as const;
export type Via = (typeof VIA)[number];

export type { Role };
