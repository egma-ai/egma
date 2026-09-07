import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

import { organization, project } from "./tenancy.ts";
import { user } from "./identity.ts";
import { createdAt, idText, oneOf, prefixCheck } from "./columns.ts";

/**
 * The operations a client may safely send twice.
 *
 * **A run is the expensive kind of write**: it dials real telephony, spends a
 * real grader, and is the object a team's release workflow reads. A browser that
 * retried a request whose answer was lost — a dropped connection, a proxy
 * timeout, somebody's second click — would produce a second run over the same
 * agent, and the two would disagree about nothing in particular while costing
 * twice.
 *
 * So the client names the attempt and egma remembers the name. The scope is
 * the organization, the project, the actor and the operation, because a key is
 * a word somebody's client chose and two people's clients may well choose the
 * same word: narrowing it to the actor is what stops one person's `retry-1`
 * from answering another's.
 *
 * The body is remembered as a digest rather than kept, because the point of
 * comparing is only to tell *the same request again* from *a different request
 * under a reused name* — and the second has to be refused out loud rather than
 * quietly answered with somebody else's run.
 */
export const IDEMPOTENT_OPERATIONS = ["start_run"] as const;
export type IdempotentOperation = (typeof IDEMPOTENT_OPERATIONS)[number];

export const idempotentOperation = pgTable(
  "idempotent_operation",
  {
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    /**
     * Who sent it. Never nullable, unlike a run's `triggered_by`: a run of a
     * person since erased is still the team's record, but a key without an
     * actor could be reused across people and is not a key this table can hold.
     */
    actorId: idText("actor_id").notNull(),
    operation: text("operation").notNull(),
    /** The client's own word for this attempt. Opaque, and never egma's. */
    idempotencyKey: text("idempotency_key").notNull(),
    /**
     * A hex digest of the request this key first carried, so a reused key with
     * different contents is refused rather than answered with the first run.
     */
    requestDigest: text("request_digest").notNull(),
    /** What the first attempt produced — a `run_` id for `start_run`. */
    resultId: idText("result_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // The scope *is* the identity: organization, project, actor, operation and
    // the key, exactly as the contract states it. A second row for the same
    // five is what the insert races against, and losing that race is how a
    // duplicate learns it is one.
    primaryKey({
      name: "idempotent_operation_pk",
      columns: [
        table.organizationId,
        table.projectId,
        table.actorId,
        table.operation,
        table.idempotencyKey,
      ],
    }),
    // The table's identity is the whole five-column key, so there is no id of
    // its own to pin. Its leading column is pinned instead — the shape the two
    // junction tables use, where the row's identity is a tuple and the half
    // this table owns is the one that carries the format.
    prefixCheck(
      "idempotent_operation_organization_id_prefix",
      table.organizationId,
      "org",
    ),
    oneOf("idempotent_operation_allowed", table.operation, [
      ...IDEMPOTENT_OPERATIONS,
    ]),
    check(
      "idempotent_operation_key_is_not_empty",
      sql`length(${table.idempotencyKey}) > 0`,
    ),
    foreignKey({
      name: "idempotent_operation_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "idempotent_operation_actor_fk",
      columns: [table.actorId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
  ],
);
