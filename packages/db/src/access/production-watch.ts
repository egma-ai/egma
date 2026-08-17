import { newId } from "@egma/ids";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { db } from "../client.ts";
import { connection, type ConnectionType } from "../schema/agents.ts";
import {
  productionTraceClaim,
  retellWebhookRefusal,
  type ProductionTransport,
  type RetellWebhookRefusal,
} from "../schema/production.ts";
import { openCredentials } from "../sealing.ts";
import { stringRecordFromRow } from "./agents.ts";
import type { AuthContext } from "./context.ts";
import { within } from "./within.ts";

/**
 * Watching somebody else's platform: which connections are switched on, and
 * the ledger that chooses one live writer however a conversation arrived.
 *
 * What the tables *are* is `schema/production.ts`; this file is how they are
 * reached.
 *
 * ## The two categories in here, and why they are two
 *
 * **`resolveRetellWatch`, `sweepStaleProductionClaims` and
 * `countRetellWebhookRefusal` take no `AuthContext` and cannot be given one.**
 * They stand where `claimGradingJobs` stands: egma's own machinery, running
 * behind every organization on the deployment at once, holding no credential
 * because there is no honest one to hold. A poller has no user, and a delivery
 * that arrives at the receiving endpoint has proved nothing yet — the whole job
 * of the door is to find out whose it is.
 *
 * The same three properties that make the grading claim safe are what make
 * these safe, and they are enforced the same way:
 *
 * - **Nothing here can be asked about a customer.** `resolveRetellWatch` takes
 *   a connection id or nothing at all; the sweep takes a lease; the counter
 *   takes a reason. There is no argument by which a caller could name whose
 *   traffic they want.
 * - **Each hands back the context the work is then done under**, narrowed to
 *   the connection's own organization and project and built here from the row
 *   rather than from anything a caller said. Every write that follows — the
 *   claim, the spans, the grading bookkeeping — goes through that.
 * - **The only rows they reach are egma's own**: the connections a customer
 *   switched watching on for, and the ledger egma writes about them.
 *
 * **Everything else takes an `AuthContext`**, and it is always one of those.
 *
 * ## The credential, and why it comes out here
 *
 * A poller cannot ask Retell for a customer's conversations without the
 * customer's key, so `resolveRetellWatch` unseals it — the third door to
 * plaintext in the module, beside the simulator's and the grader's. It is
 * narrower than either: it answers only for a connection whose owner switched
 * watching **on**, and switching it off is what closes it. There is no argument
 * that widens it and no role that opens it, because there is no role in it at
 * all.
 */

/** How long a claim may go unwritten before another pass may replay it. */
const DEFAULT_LEASE_SECONDS = 120;

/** How many stale claims one sweep replays, so a backlog is drained in passes. */
const MOST_REPLAYED_AT_ONCE = 50;

/**
 * The person egma is on this path, which is nobody.
 *
 * Shaped like the grading engine's `THE_ENGINE` and for the same reason: there
 * is no user here, the work was asked for by whoever flipped the switch, and a
 * value shaped like an identifier would quietly attribute a machine's act to a
 * person.
 */
const THE_WATCHER = "watch";

/**
 * The context one switched-on connection's traffic is written under.
 *
 * `member`, because this context files telemetry — `ingest_traces` is a
 * member's permission — and nothing else. It is deliberately not `admin`: a
 * transport that carries conversations in has no business editing anything.
 */
function watchContext(organizationId: string, projectId: string): AuthContext {
  return {
    userId: THE_WATCHER,
    organizationId,
    projectId,
    role: "member",
    via: "watch",
  };
}

/** One connection egma may be watching, and everything a transport needs of it. */
export type RetellWatchTarget = {
  readonly connectionId: string;
  readonly agentId: string;
  readonly connectionType: ConnectionType;
  readonly environment: string | null;
  /** The provider's own name for the agent — what an arriving event carries. */
  readonly retellAgentId: string;
  /** Unsealed here and nowhere else on this path. Never logged, never returned further. */
  readonly apiKey: string;
  readonly watching: boolean;
  /** Everything at or before this is durably stored. Null until the first write. */
  readonly cursor: Date | null;
  readonly webhookRegisteredAt: Date | null;
  readonly webhookDeliveredAt: Date | null;
  /** Narrowed to this connection's own organization and project. */
  readonly auth: AuthContext;
};

/**
 * Which watch targets to resolve.
 *
 * Naming a connection answers for that one whether or not it is switched on,
 * which is what lets a switch-off deregister the webhook it registered.
 * Naming none answers for every switched-on connection on the deployment,
 * which is what the poller asks each tick.
 */
export type RetellWatchQuery = {
  readonly connectionId?: string | undefined;
  /**
   * Every Retell connection on the deployment, switched on or not.
   *
   * The receiving endpoint asks this way and nothing else does. It has to tell
   * *nobody named this agent* from *somebody named it and turned watching off*,
   * because those are two different refusals with two different fixes — and
   * asking twice would read the switch at two different moments.
   */
  readonly everyConnection?: boolean | undefined;
  /**
   * Only the connections that name this Retell agent.
   *
   * **This is what keeps an unauthenticated delivery from costing the whole
   * deployment's key material.** The receiving endpoint has to find the
   * candidates before it can check a signature — that is the order the work
   * comes in — so without this, anybody who could POST a body with an agent id
   * in it made egma unseal every active Retell connection's key, once per
   * request. Narrowing here means a delivery unseals the one or two keys that
   * could possibly have signed it, and a delivery naming an agent nobody
   * registered unseals none at all.
   *
   * The agent id is a config key, which is the clear half of a connection by
   * construction — *what to reach, never how to prove* — so it can be matched
   * in the query rather than after decrypting to look at it.
   */
  readonly retellAgentId?: string | undefined;
};

type TargetRow = {
  readonly connectionId: string;
  readonly agentId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly type: string;
  readonly environment: string | null;
  readonly config: unknown;
  readonly credentials: string | null;
  readonly watchProduction: boolean;
  readonly productionCursor: Date | null;
  readonly webhookRegisteredAt: Date | null;
  readonly webhookDeliveredAt: Date | null;
};

const TARGET_COLUMNS = {
  connectionId: connection.id,
  agentId: connection.agentId,
  organizationId: connection.organizationId,
  projectId: connection.projectId,
  type: connection.type,
  environment: connection.environment,
  config: connection.config,
  credentials: connection.credentials,
  watchProduction: connection.watchProduction,
  productionCursor: connection.productionCursor,
  webhookRegisteredAt: connection.webhookRegisteredAt,
  webhookDeliveredAt: connection.webhookDeliveredAt,
} as const;

/**
 * A row as a target, or `undefined` for one nothing could poll with.
 *
 * A retell connection always seals a key and always names an agent — the
 * registry demands both at the door — so a row missing either was hand-edited.
 * It is skipped rather than thrown over: one broken row must not stop the
 * deployment's whole sweep, and the honest thing for a connection egma cannot
 * reach is that egma does not reach it.
 */
function targetFromRow(row: TargetRow): RetellWatchTarget | undefined {
  if (row.credentials === null) return undefined;

  let config: Record<string, string>;
  let credentials: Record<string, string>;
  try {
    const malformed = () => new Error("unreadable");
    config = stringRecordFromRow(row.config, malformed);
    credentials = stringRecordFromRow(openCredentials(row.credentials), malformed);
  } catch {
    return undefined;
  }

  const retellAgentId = config["retellAgentId"] ?? "";
  const apiKey = credentials["apiKey"] ?? "";
  if (retellAgentId === "" || apiKey === "") return undefined;

  return {
    connectionId: row.connectionId,
    agentId: row.agentId,
    connectionType: row.type as ConnectionType,
    environment: row.environment,
    retellAgentId,
    apiKey,
    watching: row.watchProduction,
    cursor: row.productionCursor,
    webhookRegisteredAt: row.webhookRegisteredAt,
    webhookDeliveredAt: row.webhookDeliveredAt,
    auth: watchContext(row.organizationId, row.projectId),
  };
}

/**
 * The Retell connections egma is watching, across the whole deployment — or
 * one named connection, switched on or not.
 *
 * Archived connections are never answered for. Archive is what stops a
 * connection entering new work, and polling a target somebody retired is new
 * work.
 */
export async function resolveRetellWatch(
  query: RetellWatchQuery = {},
): Promise<readonly RetellWatchTarget[]> {
  const rows = await db()
    .select(TARGET_COLUMNS)
    .from(connection)
    .where(
      and(
        eq(connection.type, "retell"),
        isNull(connection.archivedAt),
        query.connectionId !== undefined
          ? eq(connection.id, query.connectionId)
          : query.everyConnection === true
            ? undefined
            : eq(connection.watchProduction, true),
        // Matched in the statement rather than after unsealing every row, so a
        // request nobody has authenticated cannot decide how much key material
        // egma opens. `->>` is the clear config, and a connection whose config
        // holds no such key simply does not match.
        query.retellAgentId === undefined
          ? undefined
          : sql`${connection.config} ->> 'retellAgentId' = ${query.retellAgentId}`,
      ),
    )
    .orderBy(asc(connection.id));

  return rows
    .map((row) => targetFromRow(row))
    .filter((target): target is RetellWatchTarget => target !== undefined);
}

/* ------------------------------------------------------------------- *
 * The ledger.
 * ------------------------------------------------------------------- */

/** What a transport offers the ledger: an identity, and the bytes behind it. */
export type ProductionTraceOffer = {
  readonly connectionId: string;
  readonly traceId: string;
  readonly providerCallId: string;
  readonly transport: ProductionTransport;
  /** The vendor's document verbatim. What a replay normalises again. */
  readonly payload: string;
  readonly endedAt: Date;
};

/** One claim as a replay holds it. */
export type ProductionTraceClaim = ProductionTraceOffer & {
  readonly id: string;
  readonly degraded: boolean;
  /** Narrowed to the claim's own organization and project. */
  readonly auth: AuthContext;
};

/**
 * Take the claim on one conversation, or find out somebody else already has.
 *
 * **This is an insert, never a check.** Asking "is it written?" and then
 * writing has a window in it, and two transports carrying one conversation is
 * exactly the traffic that finds windows. So the identity is a unique key and
 * the insert is the whole arbitration: the winner gets a row back and goes on
 * to append, the loser gets nothing back and walks away.
 *
 * `undefined` therefore means *somebody else has this conversation* and is the
 * ordinary answer at the boundary of every resumed sweep — the window since the
 * cursor is inclusive, so the last conversation written is offered again on the
 * next tick and this is what absorbs it.
 */
export async function claimProductionTrace(
  auth: AuthContext,
  offer: ProductionTraceOffer,
): Promise<ProductionTraceClaim | undefined> {
  const { projectId } = auth;
  if (projectId === undefined) return undefined;

  const [row] = await db()
    .insert(productionTraceClaim)
    .values({
      id: newId("ptc"),
      organizationId: auth.organizationId,
      projectId,
      connectionId: offer.connectionId,
      traceId: offer.traceId,
      providerCallId: offer.providerCallId,
      transport: offer.transport,
      payload: offer.payload,
      endedAt: offer.endedAt,
      status: "claimed",
      claimedAt: new Date(),
    })
    .onConflictDoNothing({ target: productionTraceClaim.traceId })
    .returning({ id: productionTraceClaim.id });

  if (row === undefined) return undefined;
  return { ...offer, id: row.id, degraded: false, auth };
}

/**
 * The conversation is appended: mark the claim written, and — where the poller
 * is what wrote it — move the connection's cursor to it.
 *
 * **One transaction, because they are one fact.** The cursor says everything at
 * or before it is durably stored *by the poller*, and a cursor that moved
 * without the mark, or a mark without the cursor, would make that sentence
 * false in one of the two directions that matter: a conversation offered
 * forever, or a conversation never offered again and never written.
 *
 * **A webhook never moves the cursor, and that is the whole of why
 * `advanceCursor` exists.** A webhook lands a conversation the moment it ends,
 * while the poller is working oldest-first through whatever came before it — so
 * letting a delivery drag the cursor forward would skip everything in between,
 * permanently. The conversation the webhook stored is still stored; the poller
 * will be offered it again on its way past, and the ledger's claim will skip
 * it. **The cost of not moving the cursor is one refused insert; the cost of
 * moving it is a gap**, and only one of those is recoverable.
 *
 * It still only ever moves forward. Two pull writes can settle out of order
 * under two replicas, and `greatest` is what keeps the later one from being
 * undone by the earlier one committing second.
 */
export async function finishProductionTrace(
  auth: AuthContext,
  finished: {
    readonly traceId: string;
    readonly connectionId: string;
    readonly endedAt: Date;
    readonly degraded: boolean;
    /** True for the poller, false for a delivery. See above. */
    readonly advanceCursor: boolean;
  },
): Promise<void> {
  const now = new Date();
  await db().transaction(async (tx) => {
    await tx
      .update(productionTraceClaim)
      .set({ status: "written", writtenAt: now, degraded: finished.degraded })
      .where(
        within(
          auth,
          productionTraceClaim,
          eq(productionTraceClaim.traceId, finished.traceId),
        ),
      );

    if (!finished.advanceCursor) return;

    await tx
      .update(connection)
      .set({
        productionCursor: sql`greatest(${connection.productionCursor}, ${finished.endedAt.toISOString()}::timestamptz)`,
      })
      .where(
        within(auth, connection, eq(connection.id, finished.connectionId)),
      );
  });
}

/**
 * Everything this connection produced at or before `through` is accounted for.
 *
 * **Accounted for, which is a wider word than written, and deliberately.** A
 * conversation the poller writes is written by the poller; a conversation the
 * poller finds already claimed is owed to whoever holds the claim, and the
 * lease sweep replays it from the payload on that claim if they never deliver.
 * Either way the ledger owns the duty, and the cursor's job is only to say
 * where the poller has finished looking.
 *
 * That distinction is what keeps the poller from freezing behind a healthy
 * webhook. Every conversation a webhook stored is already claimed when the
 * poller reaches it, so a cursor that moved only on the poller's own writes
 * stood still while the backlog past it grew — and once that backlog passed
 * what one tick can page through, a conversation the webhook happened to miss
 * beyond it was unreachable for good.
 *
 * Forward only, like every other move of this cursor, and never to an instant
 * the provider did not report — that rule belongs to the caller, which knows
 * whether the instant it holds is an answer or a stand-in for one.
 */
export async function advanceProductionCursor(
  auth: AuthContext,
  connectionId: string,
  through: Date,
): Promise<void> {
  await db()
    .update(connection)
    .set({
      productionCursor: sql`greatest(${connection.productionCursor}, ${through.toISOString()}::timestamptz)`,
    })
    .where(within(auth, connection, eq(connection.id, connectionId)));
}

/**
 * The claims whose append never landed, re-taken so this pass owns them.
 *
 * **The lease is what makes a crash cost nothing.** A transport that died
 * between the claim and the append left a row that says a conversation is owed
 * a write and holds the payload to write it from; this re-stamps `claimed_at`
 * and hands the payload back, so the caller normalises the identical input into
 * the identical batch. A crash between the append and the mark replays the same
 * append. During this rollout, ClickHouse suppresses a retry carrying the prior
 * release's compatibility token, but a replay after that deduplication window
 * can append a second copy.
 *
 * Re-stamping under `for update skip locked` is what keeps two API replicas
 * from replaying one conversation at the same moment. It is the grading claim's
 * own arrangement, for the same reason.
 *
 * **Only claims whose connection is still live are offered.** A claim belonging
 * to an archived connection can never be replayed — there is nothing left to
 * normalise it against — so a sweep that kept picking it up would spend its
 * whole window on rows it must then skip, and fifty of them would starve every
 * pass for as long as they existed. Filtering here rather than abandoning the
 * row is deliberate twice over: archive is not deletion, so the record of a
 * conversation somebody claimed stays exactly where it is; and restoring the
 * connection puts its claims straight back in the window, which marking them
 * terminal would not.
 *
 * The lock is taken `of` the claim table alone. The connection is read to
 * decide reachability and nothing more, and a sweep that held a lock on it
 * would make an ordinary connection edit wait behind a background job.
 */
export async function sweepStaleProductionClaims(
  options: { readonly leaseSeconds?: number | undefined } = {},
): Promise<readonly ProductionTraceClaim[]> {
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new Error("a lease is a positive whole number of seconds");
  }

  const now = new Date();
  const staleSince = new Date(now.getTime() - leaseSeconds * 1000);

  const rows = await db().transaction(async (tx) => {
    const candidates = await tx
      .select({ id: productionTraceClaim.id })
      .from(productionTraceClaim)
      .innerJoin(connection, eq(connection.id, productionTraceClaim.connectionId))
      .where(
        and(
          eq(productionTraceClaim.status, "claimed"),
          lt(productionTraceClaim.claimedAt, staleSince),
          isNull(connection.archivedAt),
        ),
      )
      .orderBy(asc(productionTraceClaim.id))
      .limit(MOST_REPLAYED_AT_ONCE)
      .for("update", { of: productionTraceClaim, skipLocked: true });

    if (candidates.length === 0) return [];

    return tx
      .update(productionTraceClaim)
      .set({ claimedAt: now })
      .where(
        inArray(
          productionTraceClaim.id,
          candidates.map((row) => row.id),
        ),
      )
      .returning({
        id: productionTraceClaim.id,
        organizationId: productionTraceClaim.organizationId,
        projectId: productionTraceClaim.projectId,
        connectionId: productionTraceClaim.connectionId,
        traceId: productionTraceClaim.traceId,
        providerCallId: productionTraceClaim.providerCallId,
        transport: productionTraceClaim.transport,
        payload: productionTraceClaim.payload,
        endedAt: productionTraceClaim.endedAt,
        degraded: productionTraceClaim.degraded,
      });
  });

  return rows.map((row) => ({
    id: row.id,
    connectionId: row.connectionId,
    traceId: row.traceId,
    providerCallId: row.providerCallId,
    transport: row.transport as ProductionTransport,
    payload: row.payload,
    endedAt: row.endedAt,
    degraded: row.degraded,
    auth: watchContext(row.organizationId, row.projectId),
  }));
}

/* ------------------------------------------------------------------- *
 * What the door writes down about itself.
 * ------------------------------------------------------------------- */

/**
 * One more delivery turned away, by reason.
 *
 * No `AuthContext`, and there could not be one: a delivery refused for an
 * unknown agent or a signature nobody's key made resolved to no customer at
 * all. That is what being refused *is* on this door, and the count belongs to
 * the deployment.
 */
export async function countRetellWebhookRefusal(
  reason: RetellWebhookRefusal,
): Promise<void> {
  await db()
    .insert(retellWebhookRefusal)
    .values({ id: newId("rwr"), reason, howMany: 1 })
    .onConflictDoUpdate({
      target: retellWebhookRefusal.reason,
      set: {
        howMany: sql`${retellWebhookRefusal.howMany} + 1`,
        updatedAt: new Date(),
      },
    });
}

/**
 * A delivery arrived and was accepted: stamp when.
 *
 * This is the whole of what decides the poller's cadence. While deliveries are
 * arriving the poller is a safety net and runs slowly; when they stop it is the
 * transport again and runs at full cadence. **Never off** — a missed webhook has
 * to cost minutes rather than the conversation.
 */
export async function recordRetellWebhookDelivery(
  auth: AuthContext,
  connectionId: string,
): Promise<void> {
  await db()
    .update(connection)
    .set({ webhookDeliveredAt: new Date() })
    .where(within(auth, connection, eq(connection.id, connectionId)));
}

/**
 * egma registered — or deregistered — its receiving endpoint with the provider.
 *
 * `null` is deregistration and is also the state of every deployment that has
 * no public address to register. The two are the same row value on purpose:
 * pull is the transport in both cases, and there is nothing wrong with either.
 */
export async function recordRetellWebhookRegistration(
  auth: AuthContext,
  connectionId: string,
  registeredAt: Date | null,
): Promise<void> {
  await db()
    .update(connection)
    .set({ webhookRegisteredAt: registeredAt })
    .where(within(auth, connection, eq(connection.id, connectionId)));
}
