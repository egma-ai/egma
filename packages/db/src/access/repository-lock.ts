import { sql } from "drizzle-orm";

import type { Transaction } from "../client.ts";

/** Serialize complete repository reconciliation with ordinary authoring writes. */
export async function lockRepositoryProject(
  tx: Transaction,
  projectId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`egma-repository:${projectId}`}, 0))`,
  );
}
