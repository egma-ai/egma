import {
  upsertRateCardInternal,
  type UpsertedRateCard,
} from "../access/usage.ts";
import { readRateCard, type RateCardEntry } from "../models/rate-card.ts";

/**
 * Write the shipped rate card into its table.
 *
 * This is deployment configuration, not a customer data-access call — the
 * persona shelf and the grader catalog are written the same way and for the
 * same reason. It lives outside the `AuthContext`-bound surface, cannot name an
 * organization or a project, and is safe to run on every boot: the insert does
 * nothing where the price is already there, so only a release that added a
 * price writes a row.
 *
 * The returned list holds only the prices this call inserted. An unchanged boot
 * returns an empty list.
 */
export async function upsertRateCard(
  card?: readonly RateCardEntry[],
): Promise<UpsertedRateCard> {
  return upsertRateCardInternal(card ?? (await readRateCard()));
}

export type { UpsertedRateCard };
