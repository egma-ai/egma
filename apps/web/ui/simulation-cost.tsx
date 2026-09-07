"use client";

import {
  costLabel,
  quantityLabel,
  usageTypeLabel,
  type ModelSpend,
  type SimulationSpend,
} from "../lib/simulation-usage.ts";
import type { Answer } from "../lib/api.ts";
import { DataTable, type Column } from "./data-table.tsx";
import { Section } from "./section.tsx";

/**
 * What this simulation cost, by provider and model.
 *
 * **On every deployment.** A self-hoster and a customer on their own provider
 * keys read exactly this; who the bill lands on is a different question and it
 * is not asked here. That is what makes the measurement part of the product
 * rather than part of the cloud.
 *
 * **One row per model, not one per request.** Forty turns of a voice
 * conversation are a hundred and twenty provider requests, and a list of them
 * answers no question anybody has. What a person came here to learn is which
 * model is expensive, so the grain is the model and the quantities are summed
 * in the unit the provider bills — tokens, seconds, characters — because a
 * reader holding this against a provider's invoice has to find the same words.
 *
 * **Empty is an ordinary answer and says so.** A simulation that failed before
 * it reached a provider spent nothing, and a deployment that has not yet
 * upgraded holds no records for a conversation that ran before this existed.
 * Neither is a fault, and neither is silence.
 */
export function SimulationCost({
  spend,
}: {
  readonly spend: Answer<SimulationSpend> | null;
}) {
  if (spend === null) {
    return (
      <Section title="Cost" lead={COST_IS}>
        <p className="m-0 text-sm text-muted-foreground">
          Reading what this simulation cost…
        </p>
      </Section>
    );
  }

  if (spend.status !== "ready") {
    // A refusal keeps its own sentence: it is written to be shown and it names
    // the next move. The evidence above it is unaffected, so this stays a
    // quiet line rather than taking over the page.
    return (
      <Section title="Cost" lead={COST_IS}>
        <p className="m-0 text-sm text-muted-foreground">
          {spend.status === "signed-out"
            ? "Sign in again to read what this simulation cost."
            : spend.refusal.message}
        </p>
      </Section>
    );
  }

  const read = spend.value;
  if (read.byModel.length === 0) {
    return (
      <Section title="Cost" lead={COST_IS}>
        <p className="m-0 text-sm text-muted-foreground">
          Egma recorded no provider requests for this simulation.
        </p>
      </Section>
    );
  }

  return (
    <Section
      title="Cost"
      lead={COST_IS}
      action={
        <p className="m-0 text-sm font-medium tabular-nums">
          {`${costLabel(read.amountMicros)} · ${countLabel(read.requests)}`}
        </p>
      }
    >
      <DataTable
        label="What this simulation cost, by provider and model"
        columns={COLUMNS}
        rows={read.byModel}
        keyOf={(row) => `${row.provider}/${row.model}`}
        stackWhenConstrained
      />
    </Section>
  );
}

const COST_IS =
  "What each provider request this simulation made consumed, in the unit that " +
  "provider bills, priced at the rate in force when it was made.";

function countLabel(requests: number): string {
  return `${requests.toLocaleString("en-US")} ${
    requests === 1 ? "request" : "requests"
  }`;
}

/** The quantities of one model, as one readable line. */
function consumed(row: ModelSpend): string {
  const parts = Object.entries(row.quantities).map(
    ([usageType, quantity]) =>
      `${quantityLabel(quantity)} ${usageTypeLabel(usageType)}`,
  );
  return parts.length === 0 ? "—" : parts.join(", ");
}

const COLUMNS: readonly Column<ModelSpend>[] = [
  {
    key: "model",
    header: "Model",
    primary: true,
    cell: (row) => row.model,
    width: "220px",
  },
  {
    key: "provider",
    header: "Provider",
    cell: (row) => row.provider,
    width: "140px",
    hideOnMobile: true,
  },
  {
    key: "requests",
    header: "Requests",
    cell: (row) => countLabel(row.requests),
    mono: true,
    width: "120px",
    hideOnMobile: true,
  },
  {
    key: "consumed",
    header: "Consumed",
    cell: (row) => consumed(row),
    mono: true,
  },
  {
    key: "cost",
    header: "Cost",
    cell: (row) => costLabel(row.amountMicros),
    mono: true,
    width: "110px",
  },
];
