/**
 * Which lanes a mocked world is built for, and the one gate that keeps a
 * mocked run honest.
 *
 * ## The lanes
 *
 * A mocked world is built for the connections Egma **opens itself** — the web
 * call and the chat session — because both are created against a named agent
 * version, which is what makes a temporary version reachable at all.
 *
 * The `phone_number` connection is deliberately not one of them, and that is
 * the whole of the phone lane's job: it is the real carrier leg, the real
 * 8 kHz band, and the real tools. A mocked run never dials it, so a real caller
 * ringing mid-run reaches the real agent. Mocking the inbound-call lane is a
 * different mechanism — a standing consented webhook router — and it is out of
 * scope by name, not by omission.
 *
 * ## The gate
 *
 * `simulationAwaitsItsMockedWorld` is the condition that makes "a run that
 * cannot build its world fails before a single simulation" true rather than
 * merely intended. A run whose agent carries the tick and whose connection is
 * one of the lanes above is **not claimable** until its record holds a
 * temporary version. Nothing races it: the run row and its queued simulations
 * are written in one transaction, so the gate is closed from the instant the
 * simulations exist — before the builder has sent its first request, and for
 * however long the build takes.
 *
 * The same condition closes again at teardown, when the record's temporary
 * version goes back to null. That costs nothing: teardown runs only after every
 * simulation is terminal, so there is no queued row left for it to hold.
 */

import { sql, type Column, type SQL } from "drizzle-orm";

import { agent, type ConnectionType } from "../schema/agents.ts";
import { run } from "../schema/runs.ts";

/**
 * The connection types a run over which builds a mocked world.
 *
 * Both are conversations Egma creates against a named version. Everything else
 * — the phone number above all — runs exactly as it did before mock tools
 * existed on this platform.
 */
export const MOCKABLE_CONNECTION_TYPES = [
  "retell_web_call",
  "retell_chat_api",
] as const satisfies readonly ConnectionType[];

export type MockableConnectionType = (typeof MOCKABLE_CONNECTION_TYPES)[number];

/** Whether a run over this connection builds a mocked world when ticked. */
export function connectionTypeTakesMockedWorld(
  connectionType: string,
): connectionType is MockableConnectionType {
  return (MOCKABLE_CONNECTION_TYPES as readonly string[]).includes(
    connectionType,
  );
}

/**
 * A simulation whose run is ready to be conducted — which for most runs is
 * every simulation, always.
 *
 * Read off three facts that are all true the moment the run row is written: the
 * agent's tick, the run's own recorded connection type, and whether the run's
 * mocked world names a temporary version. So the gate never has a window: a
 * simulator polling the queue one millisecond after the run was created finds
 * nothing to claim, and keeps finding nothing until the draft exists.
 *
 * Written as one condition rather than as a Boolean column so that no writer
 * anywhere can forget to set it, and so that the flag and the world cannot
 * disagree. Written as a subquery rather than as a join so that it adds a
 * condition to the claim and changes nothing else about it — the claim still
 * locks simulation rows and only simulation rows.
 *
 * @param runIdColumn the claiming query's own reference to `simulation.run_id`.
 */
export function runIsReadyToConduct(runIdColumn: SQL | Column): SQL {
  return sql`not exists (
    select 1
    from ${run}
    join ${agent} on ${agent.id} = ${run.agentId}
    where ${run.id} = ${runIdColumn}
      and ${agent.mockToolsDuringSimulations} = true
      and ${run.connectionSnapshot}->>'connectionType' in (${sql.join(
        MOCKABLE_CONNECTION_TYPES.map((type) => sql`${type}`),
        sql`, `,
      )})
      and (
        ${run.mockedWorld} is null
        or ${run.mockedWorld}->>'draftVersion' is null
      )
  )`;
}
