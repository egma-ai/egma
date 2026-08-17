import { AppShell } from "../../../../../ui/shell.tsx";
import { PrototypeHarness } from "./prototype-harness.tsx";

const FALLBACK_SIMULATION = "sim_01M06CP9NCE89AVW94KHZANGTT";

type PrototypePageProps = {
  readonly params: Promise<{ readonly projectId: string }>;
  readonly searchParams: Promise<{
    readonly simulation?: string | readonly string[];
    readonly v?: string | readonly string[];
  }>;
};

function first(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

/**
 * An isolated comparison surface for simulation evidence.
 *
 * Production routes do not import this directory. The picker exists only so a
 * person can compare three complete directions at the real page size before
 * one direction is promoted and this route is removed.
 */
export default async function SimulationEvidencePrototypePage({
  params,
  searchParams,
}: PrototypePageProps) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const simulationId = first(query.simulation)?.trim() || FALLBACK_SIMULATION;
  const requested = Number(first(query.v));
  const initialVariant =
    Number.isInteger(requested) && requested >= 1 && requested <= 3
      ? requested - 1
      : 0;

  return (
    <AppShell>
      <PrototypeHarness
        initialVariant={initialVariant}
        projectId={projectId}
        simulationId={simulationId}
      />
    </AppShell>
  );
}
