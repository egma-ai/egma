import { readJson, type Answer } from "./api.ts";

/**
 * What one simulation cost, by provider and model.
 *
 * **On every deployment, whoever paid.** A self-hoster running on their own
 * keys and a customer on Egma's see the same numbers here; what differs is who
 * the bill lands on, and that is not this page's subject.
 *
 * The quantities are in the unit the provider bills, not a unit Egma invented
 * for the display: tokens, seconds of audio, characters. A reader comparing
 * this against a provider's own invoice has to find the same words.
 */

/** One model's share of a simulation's spend. */
export type ModelSpend = {
  readonly provider: string;
  readonly model: string;
  /** `tokens`, `seconds` or `characters` — the provider's own. */
  readonly unit: string;
  /** How many provider requests this model answered for this simulation. */
  readonly requests: number;
  /** What was consumed, by usage type, summed over those requests. */
  readonly quantities: Readonly<Record<string, number>>;
  readonly amountMicros: number;
};

export type SimulationSpend = {
  readonly simulationId: string;
  readonly amountMicros: number;
  readonly requests: number;
  readonly byModel: readonly ModelSpend[];
};

export function readSimulationSpend(
  simulationId: string,
  projectId: string,
): Promise<Answer<SimulationSpend>> {
  return readJson<SimulationSpend>(
    `/api/simulations/${encodeURIComponent(simulationId)}/usage` +
      `?projectId=${encodeURIComponent(projectId)}`,
  );
}

/**
 * Money, in the smallest amount worth showing.
 *
 * A simulation costs fractions of a cent, so two decimal places would round
 * every honest number to `$0.00` and read as free. Four is where a hundredth
 * of a cent becomes visible, which is the grain these numbers actually have,
 * and it is the same grain in every row and in the total — a table where one
 * line is rounded and its neighbour is not does not add up on the page.
 *
 * A dollar is where that stops being useful: an amount that large is read in
 * cents like any other price, and four places on it would be noise.
 */
export function costLabel(amountMicros: number): string {
  const dollars = amountMicros / 1_000_000;
  return `$${dollars.toFixed(dollars >= 1 ? 2 : 4)}`;
}

/** `input_tokens` as a person reads it, without inventing a new word for it. */
export function usageTypeLabel(usageType: string): string {
  return usageType.replaceAll("_", " ");
}

/**
 * A quantity, in the unit the provider counts it in.
 *
 * Whole where the unit is whole — a token is a token — and to one decimal
 * place for seconds, which arrive fractional because that is how the audio was
 * measured.
 */
export function quantityLabel(quantity: number): string {
  return Number.isInteger(quantity)
    ? quantity.toLocaleString("en-US")
    : quantity.toLocaleString("en-US", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
}
