import { traceStore } from "../clickhouse/client.ts";
import { USAGE_IDENTITIES } from "../clickhouse/usage.ts";

/** One snapshot includes late visible records without treating an interval mark as a watermark. */
export async function readPlatformUsageTotal(input: { organizationId: string; occurredAtOrAfter: Date }): Promise<{ amountMicros: bigint; requests: bigint }> {
  const result = await traceStore().query({
    query: `SELECT toString(sumIf(toUInt128(amount), payment_source = 'platform' AND occurred_at >= fromUnixTimestamp64Milli({floor:Int64}))) AS amount, toString(countIf(payment_source = 'platform' AND occurred_at >= fromUnixTimestamp64Milli({floor:Int64}))) AS requests, countIf(variants != 1) AS conflicts FROM (${USAGE_IDENTITIES})`,
    query_params: { org: input.organizationId, floor: input.occurredAtOrAfter.getTime() }, format: "JSONEachRow",
  });
  const [row] = await result.json<{ amount: string; requests: string; conflicts: number }>();
  if (!row || Number(row.conflicts) !== 0) throw new Error("provider usage contains conflicting immutable identities");
  return { amountMicros: BigInt(row.amount), requests: BigInt(row.requests) };
}

