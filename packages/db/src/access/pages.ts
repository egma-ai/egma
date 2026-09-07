import { isId, type IdPrefix } from "@egma/ids";

/**
 * Shared keyset pagination for IDs ordered under COLLATE "C". Use the last returned
 * ID as the cursor and fetch one extra row to detect another page.
 */

export const DEFAULT_PAGE_SIZE = 50;
export const LARGEST_PAGE_SIZE = 200;

export type PageRequest = {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
};

/**
 * The request, validated: how many rows a page may hold, and the id the last
 * page ended on. Refusals name what the list holds, so the message reads the
 * same as it always has from each of the three lists.
 */
export function pageWindow(
  page: PageRequest | undefined,
  of: {
    /** As a refusal names one: "test", "persona", "run". */
    readonly singular: string;
    /** As the page-size refusal counts them: "tests", "personas", "runs". */
    readonly plural: string;
    readonly prefix: IdPrefix;
  },
): { readonly limit: number; readonly cursor: string | undefined } {
  const limit = page?.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > LARGEST_PAGE_SIZE) {
    throw new Error(`a page holds between 1 and ${LARGEST_PAGE_SIZE} ${of.plural}`);
  }
  const cursor = page?.cursor;
  if (cursor !== undefined && !isId(of.prefix, cursor)) {
    throw new Error(
      `"${cursor}" is not a ${of.singular} id, so it cannot be a cursor`,
    );
  }
  return { limit, cursor };
}

/**
 * The page out of what was read. Every caller reads one row beyond the page —
 * that is what answers "is there more?" without a second query — and this
 * trims it back off and turns it into the cursor.
 */
export function pageOf<Row extends { readonly id: string }>(
  rows: readonly Row[],
  limit: number,
): { readonly items: readonly Row[]; readonly nextCursor: string | undefined } {
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined,
  };
}
