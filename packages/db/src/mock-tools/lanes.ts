/**
 * Mock capability and temporary-version requirements by connection type.
 * Retell web calls need a temporary version; text mode carries replies per request;
 * LiveKit uses the room RPC seam. Phone and Retell chat API connections do not mock.
 * Block claims for runs that require a temporary version until it is recorded.
 * Read mock tools from pinned test versions, never a connection switch.
 */

import { and, eq, isNotNull, sql, type Column, type SQL } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";

import type { ConnectionType } from "../schema/agents.ts";
import { run, simulation } from "../schema/runs.ts";
import { testVersion } from "../schema/tests.ts";

/**
 * The run's own simulations, under a name of their own.
 *
 * This condition is added to a query that is already selecting simulations, so
 * an unaliased second reference would shadow the caller's — legal, and one
 * rename away from silently asking about the wrong rows.
 */
const mockedSimulation = alias(simulation, "mocked_simulation");
const mockedVersion = alias(testVersion, "mocked_test_version");

/**
 * Connection types with a mock reply path. Add types only when their adapter
 * can serve test-owned answers: text-mode requests, web-call URLs, or LiveKit RPC.
 */
export const LANES_SERVING_MOCK_TOOLS = [
  "retell_text_mode",
  "retell_web_call",
  "livekit_room",
] as const satisfies readonly ConnectionType[];

/**
 * The connection types a run over which branches a temporary copy of the
 * customer's agent when its tests mock something.
 *
 * One entry, and the list stays a list because the reasoning is per lane: a
 * lane joins it when Egma opens the conversation against a named version and
 * cannot carry its answers on the request itself.
 */
export const DRAFT_MOCK_CONNECTION_TYPES = [
  "retell_web_call",
] as const satisfies readonly ConnectionType[];

export type DraftMockConnectionType =
  (typeof DRAFT_MOCK_CONNECTION_TYPES)[number];

/** Whether a mocked run over this connection branches a temporary copy. */
export function connectionTypeBranchesMockDraft(
  connectionType: string,
): connectionType is DraftMockConnectionType {
  return (DRAFT_MOCK_CONNECTION_TYPES as readonly string[]).includes(
    connectionType,
  );
}

/**
 * Block claims when a run requires a mock draft, pins mock tools, and has no
 * temporary version recorded. Empty mock lists are stored as null, allowing an
 * existence check on pinned test versions.
 * @param runIdColumn The outer claim query's simulation.run_id reference.
 */
export function runIsReadyToConduct(runIdColumn: SQL | Column): SQL {
  return sql`not exists (
    select 1
    from ${run}
    where ${run.id} = ${runIdColumn}
      and ${run.connectionSnapshot}->>'connectionType' in (${sql.join(
        DRAFT_MOCK_CONNECTION_TYPES.map((type) => sql`${type}`),
        sql`, `,
      )})
      and ${run.tempMockAgentVersion} is null
      and exists (${
        new QueryBuilder()
          .select({ mocked: sql`1` })
          .from(mockedSimulation)
          .innerJoin(
            mockedVersion,
            eq(mockedVersion.id, mockedSimulation.testVersionId),
          )
          .where(
            and(
              eq(mockedSimulation.runId, run.id),
              isNotNull(mockedVersion.mockTools),
            ),
          )
      })
  )`;
}
