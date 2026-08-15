/**
 * The agents of one project, as `GET /api/agents` answers them.
 *
 * An **agent** is the customer's voice agent — the thing egma is trying to
 * establish trust in. It belongs to a project, which is why this read is never
 * made without one, and why the landing page of the product is this list: you
 * start with the system you are testing.
 *
 * The shape is the API's own, field names included. Renaming its fields on the
 * way in would put a second vocabulary between the contract and the page, and
 * the two would drift the first time the API grew a field.
 */

export type ListedAgent = {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

/**
 * One page of them. Keyset, newest first: `next_cursor` is where this page
 * stopped, and asking for more means handing it back. It is `null` rather than
 * absent when there is no next page, so "there is no more" and "this answer is
 * an older shape" are different answers.
 */
export type AgentPage = {
  readonly items: readonly ListedAgent[];
  readonly next_cursor: string | null;
};

export const AGENTS_PATH = "/api/agents";

/** The next page of the same list. */
export function agentsAfter(cursor: string): string {
  return `${AGENTS_PATH}?cursor=${encodeURIComponent(cursor)}`;
}
