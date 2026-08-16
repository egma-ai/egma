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
 * the ledger that makes a conversation land exactly once however it arrived.
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
 * The conversation is appended: mark the claim written, and move the
 * connection's cursor to it.
 *
 * **One transaction, because they are one fact.** The cursor says everything at
 * or before it is durably stored, and a cursor that moved without the mark — or
 * a mark without the cursor — would make that sentence false in one of the two
 * directions that matter: a conversation offered forever, or a conversation
 * never offered again and never written.
 *
 * The cursor only ever moves **forward**. A webhook lands conversations the
 * moment they end and the poller works oldest-first through a backlog, so the
 * two routinely finish out of order; taking the later of the two is what keeps
 * a webhook's fresh conversation from dragging the poller's cursor past a
 * backlog it has not reached yet.
 */
export async function finishProductionTrace(
  auth: AuthContext,
  finished: {
    readonly traceId: string;
    readonly connectionId: string;
    readonly endedAt: Date;
    readonly degraded: boolean;
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
 * The claims whose append never landed, re-taken so this pass owns them.
 *
 * **The lease is what makes a crash cost nothing.** A transport that died
 * between the claim and the append left a row that says a conversation is owed
 * a write and holds the payload to write it from; this re-stamps `claimed_at`
 * and hands the payload back, so the caller normalises the identical input into
 * the identical batch. A crash between the append and the mark replays the same
 * append, which ClickHouse's block-level insert dedup absorbs — so exactly one
 * copy survives either window.
 *
 * Re-stamping under `for update skip locked` is what keeps two API replicas
 * from replaying one conversation at the same moment. It is the grading claim's
 * own arrangement, for the same reason.
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
      .where(
        and(
          eq(productionTraceClaim.status, "claimed"),
          lt(productionTraceClaim.claimedAt, staleSince),
        ),
      )
      .orderBy(asc(productionTraceClaim.id))
      .limit(MOST_REPLAYED_AT_ONCE)
      .for("update", { skipLocked: true });

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
