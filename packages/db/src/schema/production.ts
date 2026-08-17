import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";

import { connection } from "./agents.ts";
import { organization, project } from "./tenancy.ts";
import { createdAt, idText, moment, oneOf, prefixCheck } from "./columns.ts";

/**
 * What egma writes down while it is watching somebody else's platform.
 *
 * Two tables, and they answer two different questions. The claim chooses one
 * live writer when two transports carry a production trace; the refusal
 * counter is how a delivery that belonged to nobody is remembered without
 * being stored.
 */

/** How a production trace reached egma. Delivery, and nothing else. */
export const PRODUCTION_TRANSPORTS = ["webhook", "pull"] as const;
export type ProductionTransport = (typeof PRODUCTION_TRANSPORTS)[number];

/**
 * Where a claim is in the two-store protocol.
 *
 * `claimed` is the recovery point: the row exists, the payload is on it, and
 * nothing has been appended yet — or something has and nobody got to say so.
 * `written` is the end. There is no third value, deliberately: a claim is
 * either still owed a write or it is not, and a state between them would be a
 * state the sweep would have to guess about.
 */
export const PRODUCTION_CLAIM_STATUSES = ["claimed", "written"] as const;
export type ProductionClaimStatus = (typeof PRODUCTION_CLAIM_STATUSES)[number];

/**
 * The ledger. **An atomic claim, never a check.**
 *
 * A transport does not ask whether a conversation is written — it inserts a
 * row whose unique key is the trace identity, carrying the vendor payload it
 * holds. First insert wins; the loser's insert conflicts and it walks away.
 * Two transports racing on one conversation are settled by the constraint
 * rather than by timing, which is the grading queue's own insert-first-wins
 * pattern reused. It prevents a live transport race; recovery across Postgres
 * and ClickHouse is separately at-least-once.
 *
 * **The payload is on the claim because the claim is the recovery point.** The
 * order across the two stores is claim (here) → append (ClickHouse) → mark
 * written (here). A crash anywhere in the middle leaves a claimed-but-unwritten
 * row, and a sweep re-claims it and replays it *from this payload* — so the
 * retry normalises identical input into an identical batch. ClickHouse can
 * suppress a recent byte-identical append. A later replay may append another
 * copy. Neither store needs a transaction spanning the other.
 */
export const productionTraceClaim = pgTable(
  "production_trace_claim",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    /**
     * Which connection filed it. Part of the identity, so the same agent
     * watched from two projects files one copy per project rather than one
     * copy that two projects fight over.
     */
    connectionId: idText("connection_id")
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    /**
     * The trace identity, minted deterministically from the provider's call id
     * and the connection. **The unique key of the whole ledger** — this is the
     * constraint two racing transports lose to.
     */
    traceId: text("trace_id").notNull(),
    /** The provider's own id for the conversation, kept as the join across audio. */
    providerCallId: text("provider_call_id").notNull(),
    transport: text("transport").notNull(),
    /** The vendor's document, exactly as it arrived. Never normalised here. */
    payload: text("payload").notNull(),
    /**
     * When the conversation ended, as the provider reported it. The poller's
     * cursor is advanced to this and to nothing else, so the cursor is always a
     * statement of fact about what is durably stored.
     */
    endedAt: moment("ended_at").notNull(),
    /**
     * True when the normalizer could not fully read the payload and the trace
     * was written with whatever parsed. The verbatim payload is still here, so
     * nothing is lost — this is the flag that says a reader should not trust
     * the normalised columns, and the count of these is the count of poison
     * items the poller refused to be wedged by.
     */
    degraded: boolean("degraded").notNull().default(false),
    status: text("status").notNull(),
    /**
     * When this claim was taken, and therefore what the lease is measured
     * from. Re-taking a stale claim moves it, so two sweeps cannot replay one
     * conversation at the same moment.
     */
    claimedAt: moment("claimed_at").notNull(),
    writtenAt: moment("written_at"),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("production_trace_claim_id_prefix", table.id, "ptc"),
    oneOf("production_trace_claim_status_allowed", table.status, [
      ...PRODUCTION_CLAIM_STATUSES,
    ]),
    oneOf("production_trace_claim_transport_allowed", table.transport, [
      ...PRODUCTION_TRANSPORTS,
    ]),
    /** The whole ledger, in one line: one row per trace identity, ever. */
    unique("production_trace_claim_trace_id_unique").on(table.traceId),
    check(
      "production_trace_claim_written_agrees",
      sql`(${table.status} = 'written') = (${table.writtenAt} is not null)`,
    ),
    foreignKey({
      name: "production_trace_claim_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    /** What the lease sweep reads: the claims still owed an append, oldest first. */
    index("production_trace_claim_unwritten_idx")
      .on(table.claimedAt)
      .where(sql`${table.status} = 'claimed'`),
  ],
);

/** Why a delivery was turned away. Every one of them is counted; none is stored. */
export const RETELL_WEBHOOK_REFUSALS = [
  /** No switched-on connection anywhere names this agent. */
  "unknown_agent",
  /** A connection names it, and the switch is off. */
  "switched_off",
  /** A switched-on connection names it, and no candidate's key signs the body. */
  "bad_signature",
  /**
   * **Retained by the constraint, and no longer written.**
   *
   * A `call_started` from a connection egma is watching is the provider doing
   * exactly what it was asked to; egma acknowledges it and declines to write a
   * conversation that has not finished. That is not a refusal, and counting it
   * beside the three above buried them under it. The column may still hold the
   * value — a check constraint is what a column *may* hold, not what the code
   * writes — so no migration is owed for a word that stopped being used.
   */
  "other_kind",
] as const;
export type RetellWebhookRefusal = (typeof RETELL_WEBHOOK_REFUSALS)[number];

/**
 * How many deliveries were refused, by reason.
 *
 * A counter rather than a row per delivery, and that is the whole design: the
 * endpoint is reachable by anybody, so a table that grew a row per refusal
 * would be an unauthenticated write. Four rows is the most this table can ever
 * hold, and what somebody actually needs from it is the number.
 *
 * It belongs to the deployment rather than to a customer, because a delivery
 * that matched no switched-on connection belongs to nobody — there is no
 * tenancy to file it under, which is exactly what makes it a refusal.
 */
export const retellWebhookRefusal = pgTable(
  "retell_webhook_refusal",
  {
    id: idText("id").primaryKey(),
    reason: text("reason").notNull(),
    howMany: bigint("how_many", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: moment("updated_at").notNull().defaultNow(),
  },
  (table) => [
    prefixCheck("retell_webhook_refusal_id_prefix", table.id, "rwr"),
    oneOf("retell_webhook_refusal_reason_allowed", table.reason, [
      ...RETELL_WEBHOOK_REFUSALS,
    ]),
    unique("retell_webhook_refusal_reason_unique").on(table.reason),
  ],
);
