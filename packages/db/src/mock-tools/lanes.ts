/**
 * Which lanes serve a mocked world, which of them branch a temporary version,
 * and the one gate that keeps a mocked run honest.
 *
 * ## The lanes
 *
 * Two lists, and they answer two different questions. **Serving** a mock tool
 * is Egma standing in the tool path at all; **branching** is the one lane that
 * needs a temporary copy of the customer's agent to stand there. Every lane
 * that branches serves, and not every lane that serves branches.
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
 * A run over a lane that branches a copy, **whose own tests ask for a mocked
 * world**, is not claimable until its record names a temporary version. Nothing
 * races it: the run row and its queued simulations are written in one
 * transaction, so the gate is closed from the instant the simulations exist.
 *
 * **The tests, never a switch on the connection.** A test carries its own mock
 * tools and a simulation pins the version it executes, so the question "does
 * this run mock anything" is answered by the immutable rows the run already
 * points at. A connection switch could be unticked mid-run and would be a
 * second answer to a question the pinned versions already settle.
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
 * The lanes on which Egma stands in front of the agent's own tools.
 *
 * A named list rather than a fact worked out from something else, because what
 * it decides is narrow: on these three lanes Egma is in the tool path and can
 * answer for a name the test wrote down — text mode carries its answers on the
 * request, a web call reaches Egma's own endpoint, and the LiveKit seam is in
 * the room by construction. A phone call reaches the customer's real backend by
 * design and is never on this list; the Retell chat API has no place to put an
 * answer either.
 *
 * Written against `ConnectionType` so that a lane added to the product is a
 * decision made here as well: a new kind that belongs on this list is added by
 * hand, and a name that is not a connection type at all does not compile.
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
 * A simulation whose run is ready to be conducted — which for most runs is
 * every simulation, always.
 *
 * Read off facts that are all true the moment the run's simulations are
 * written: the connection type frozen onto the run's own snapshot, whether any
 * simulation of the run pins a test version that mocks anything, and whether
 * the run names a temporary version. So the gate never has a window: a
 * simulator polling the queue one millisecond after the run was created finds
 * nothing to claim, and keeps finding nothing until the copy exists.
 *
 * **`mock_tools is not null` is the whole question**, which is why an empty
 * list is stored as null: the gate asks the column and never the value, so a
 * suite of a thousand tests costs one index-free existence check rather than a
 * thousand jsonb reads.
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
