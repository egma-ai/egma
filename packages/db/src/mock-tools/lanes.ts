/**
 * Which lanes branch a temporary version, and the one gate that keeps a mocked
 * run honest.
 *
 * ## The lanes
 *
 * A **temporary copy** of the customer's agent is branched for one lane only:
 * `retell_web_call`. A web call is a conversation Egma creates against a named
 * agent version, so a temporary version is reachable at all — and the customer's
 * published number is never dialled for one.
 *
 * `retell_text_mode` is mocked too and branches nothing: its answers ride each
 * request, so there is no draft to sweep, no binding to restore, and nothing to
 * wait for. `phone_number` is deliberately not mockable at all, and that is the
 * whole of the phone lane's job: the real carrier leg, the real 8 kHz band, and
 * the real tools.
 *
 * ## The gate
 *
 * `runIsReadyToConduct` is the condition that makes "a run that cannot build
 * its world fails before a single simulation" true rather than merely intended.
 * A run whose **connection snapshot** says mock tools are on, over a lane that
 * branches a copy, is not claimable until its record names a temporary version.
 * Nothing races it: the run row and its queued simulations are written in one
 * transaction, so the gate is closed from the instant the simulations exist.
 *
 * **The snapshot, never the connection row.** A connection's switch may be
 * unticked while a run is going, and a run keeps the world it started with —
 * so the fact the gate reads is the one frozen onto the run at its start.
 */

import { sql, type Column, type SQL } from "drizzle-orm";

import type { ConnectionType } from "../schema/agents.ts";
import { run } from "../schema/runs.ts";

/**
 * The connection types a mocked run over which branches a temporary copy of
 * the customer's agent.
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
 * A simulation whose run is ready to be conducted — which for most runs is
 * every simulation, always.
 *
 * Read off two facts that are both true the moment the run row is written: the
 * switch and the connection type frozen onto the run's own snapshot, and
 * whether the run names a temporary version. So the gate never has a window: a
 * simulator polling the queue one millisecond after the run was created finds
 * nothing to claim, and keeps finding nothing until the copy exists.
 *
 * Written as one condition rather than as a Boolean column so that no writer
 * anywhere can forget to set it, and so that the flag and the record cannot
 * disagree. Written as a subquery rather than as a join so that it adds a
 * condition to the claim and changes nothing else about it.
 *
 * @param runIdColumn the claiming query's own reference to `simulation.run_id`.
 */
export function runIsReadyToConduct(runIdColumn: SQL | Column): SQL {
  return sql`not exists (
    select 1
    from ${run}
    where ${run.id} = ${runIdColumn}
      and ${run.connectionSnapshot}->>'mockToolsEnabled' = 'true'
      and ${run.connectionSnapshot}->>'connectionType' in (${sql.join(
        DRAFT_MOCK_CONNECTION_TYPES.map((type) => sql`${type}`),
        sql`, `,
      )})
      and ${run.tempMockAgentVersion} is null
  )`;
}
