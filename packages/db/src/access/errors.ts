import type { Role } from "../schema/columns.ts";
import type { AuthContext } from "./context.ts";
import type { Action, ActionScope } from "./permissions.ts";

/**
 * A write named a project belonging to another customer.
 *
 * The composite foreign key over `(project_id, organization_id)` would refuse
 * the row anyway, and that second line is what covers migration scripts and
 * manual fixes. But a write that comes through this module is refused before it
 * reaches the database, in egma's own vocabulary rather than as a driver error,
 * because the row should never be attempted at all.
 */
export class ProjectOutsideOrganizationError extends Error {
  readonly organizationId: string;
  readonly projectId: string;

  constructor(organizationId: string, projectId: string) {
    super(
      `project ${projectId} does not belong to organization ${organizationId}`,
    );
    this.name = "ProjectOutsideOrganizationError";
    this.organizationId = organizationId;
    this.projectId = projectId;
  }
}

/**
 * A guarded key creation found an active key whose name already starts with
 * the caller's reserved prefix.
 *
 * The conflicting row stays private. This refusal carries no key id, creator,
 * or full name because the person creating the replacement might not be
 * allowed to list that key.
 */
export class ActiveApiKeyNameConflictError extends Error {
  constructor() {
    super(
      "an active API key already reserves this name prefix in this project; revoke it before creating a replacement",
    );
    this.name = "ActiveApiKeyNameConflictError";
  }
}

/**
 * An agent write refusal with a stable reason for HTTP handling.
 * Callers must inspect reason instead of parsing the message.
 */
export class AgentWriteRefusedError extends Error {
  readonly reason: AgentWriteRefusal;

  constructor(reason: AgentWriteRefusal, message: string) {
    super(message);
    this.name = "AgentWriteRefusedError";
    this.reason = reason;
  }
}

/**
 * not_admitted: invalid connection data. needs_a_name: a required name is missing.
 * name_taken: an active row already uses the name in its project or agent.
 * platform_contradicts_agent: the supplied platform differs from the agent's.
 */
export type AgentWriteRefusal =
  | "not_admitted"
  | "needs_a_name"
  | "name_taken"
  /**
   * The payload named one platform and the connection would be represented
   * under another — its agent's. Its own refusal because the caller's next
   * move is specific: send the agent's platform, or leave it out.
   */
  | "platform_contradicts_agent";

/**
 * A run was turned away, and which rule turned it away travels beside the
 * sentence rather than inside it — the agent factory's arrangement, for the
 * same reason: an HTTP layer answers each of them differently, and reading the
 * prose to tell them apart would make the prose load-bearing while the prose is
 * the part deliberately left free to improve. The sentence is whole where it is
 * written and is relayed word for word, never finished off somewhere else.
 */
export class RunWriteRefusedError extends Error {
  readonly reason: RunWriteRefusal;

  constructor(reason: RunWriteRefusal, message: string) {
    super(message);
    this.name = "RunWriteRefusedError";
    this.reason = reason;
  }
}

/**
 * no_such_connection: absent or outside the caller's scope.
 * connection_not_on_agent: the visible connection belongs to another agent.
 * no_adapter: no shipped simulator supports the connection.
 * not_admitted: invalid suite, expected versions, or persona selection.
 * already_finished: the run finished before cancellation.

 */
export type RunWriteRefusal =
  | "no_such_connection"
  | "connection_not_on_agent"
  | "no_adapter"
  | "not_admitted"
  | "already_finished"
  | "allowance_spent"
  | "providers_unfunded";

/**
 * The person being invited is already in an organization.
 *
 * One person belongs to one organization in this version, so there is no second
 * one to put them in. It carries whether the organization is the caller's own,
 * because "they are already here" and "they are somewhere else" need different
 * words — and the second must never name where, which is why the caller is
 * handed a flag rather than an organization it could put in a message.
 */
export class AlreadyBelongsToAnOrganizationError extends Error {
  readonly email: string;
  /** True when they are already in the caller's own organization. */
  readonly here: boolean;

  constructor(email: string, here: boolean) {
    super(
      here
        ? `${email} is already in this organization`
        : `${email} already belongs to an organization, and one person belongs to one organization in this version`,
    );
    this.name = "AlreadyBelongsToAnOrganizationError";
    this.email = email;
    this.here = here;
  }
}
/** Prevent removing or demoting the organization's last admin. */
export class LastAdminError extends Error {
  readonly organizationId: string;
  readonly userId: string;

  constructor(organizationId: string, userId: string) {
    super(
      `${userId} is the last admin of organization ${organizationId}, and an organization with no admin is one nobody can administer`,
    );
    this.name = "LastAdminError";
    this.organizationId = organizationId;
    this.userId = userId;
  }
}

/** A test, as a usage answer names it: enough to go and find it. */
export type TestNamingPersona = {
  readonly id: string;
  readonly name: string;
};

/**
 * An identity edit used a stale revision. Return the resource and both revisions
 * so the caller can reload before retrying. TestMovedOnError separately handles
 * test content version conflicts.
 */
export class IdentityConflictError extends Error {
  /** The kind of thing, as a refusal names it: "persona", "agent", "test". */
  readonly resource: string;
  readonly resourceId: string;
  /** The revision the caller wrote against, and the one it is on now. */
  readonly expected: string;
  readonly current: string;

  constructor(
    resource: string,
    resourceId: string,
    revisions: { readonly expected: string; readonly current: string },
  ) {
    super(
      `${resource} ${resourceId} changed after this edit was written against revision ${revisions.expected}, and is now on ${revisions.current}`,
    );
    this.name = "IdentityConflictError";
    this.resource = resource;
    this.resourceId = resourceId;
    this.expected = revisions.expected;
    this.current = revisions.current;
  }
}

/**
 * A deadlock or serialization failure rolled back the write. The caller may retry
 * the same request; normal validation still applies to the new attempt.
 */
export class WriteAbortedError extends Error {
  /** What was being written, as a refusal names it: "persona", "test". */
  readonly resource: string;

  constructor(resource: string, options?: ErrorOptions) {
    super(
      `this ${resource} write got in the way of another one and was rolled back; nothing was changed, and sending it again is safe`,
      options,
    );
    this.name = "WriteAbortedError";
    this.resource = resource;
  }
}

/**
 * An Egma-provided persona cannot be edited or deleted by a project.
 * Fork it to create an editable Custom persona.
 */
export class EgmaProvidedPersonaError extends Error {
  readonly personaId: string;
  readonly personaName: string;

  constructor(personaId: string, personaName: string) {
    super(
      `persona ${personaId} (${personaName}) is Predefined: Egma builds it, and no project can change or delete one; fork it to make a Custom persona you can edit`,
    );
    this.name = "EgmaProvidedPersonaError";
    this.personaId = personaId;
    this.personaName = personaName;
  }
}

/**
 * Invalid request content, distinct from permission failures and internal faults.
 * The API may relay this validation message to the caller.
 */
export class UnprocessableInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnprocessableInputError";
  }
}

/**
 * An Egma agent is already bound to another agent platform identity.
 * Include both IDs so the caller can register the second identity separately.
 */
export class AgentAlreadyBoundError extends UnprocessableInputError {
  readonly boundTo: string;
  readonly asked: string;

  constructor(agentName: string, boundTo: string, asked: string) {
    super(
      `${agentName} is Retell agent ${boundTo}. Register ${asked} as its own agent.`,
    );
    this.name = "AgentAlreadyBoundError";
    this.boundTo = boundTo;
    this.asked = asked;
  }
}

/**
 * A persona name matches more than one active persona. Require a stable ID
 * instead of choosing by list order.
 */
export class PersonaNameAmbiguousError extends UnprocessableInputError {
  /** The name as the writer wrote it, which is what the sentence names. */
  readonly personaName: string;

  constructor(personaName: string, message: string) {
    super(message);
    this.name = "PersonaNameAmbiguousError";
    this.personaName = personaName;
  }
}

/**
 * A test content edit used a stale version. Return both versions and the test
 * identity so the caller can reload and resolve the conflict.
 */
export class TestMovedOnError extends Error {
  readonly testId: string;
  readonly testName: string;
  /** The version the edit was written against. */
  readonly expectedVersionId: string;
  /** The version the test is on now. */
  readonly currentVersionId: string;

  constructor(test: { readonly id: string; readonly name: string }, versions: {
    readonly expected: string;
    readonly current: string;
  }) {
    super(
      `this write was based on version ${versions.expected}, and test ${test.id} has moved on to ${versions.current}`,
    );
    this.name = "TestMovedOnError";
    this.testId = test.id;
    this.testName = test.name;
    this.expectedVersionId = versions.expected;
    this.currentVersionId = versions.current;
  }
}

/**
 * Another active project in the organization already uses this slug.
 * Project names do not have the same uniqueness rule.
 */
export class ProjectSlugTakenError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    super(
      `project slug ${slug} is already in use in this organization`,
    );
    this.name = "ProjectSlugTakenError";
    this.slug = slug;
  }
}

/**
 * The trace store permanently rejected these span rows. Preserve its code and
 * message. Temporary store failures must remain retryable errors so ingestion
 * does not discard valid evidence.
 */
export class TraceStoreRefusedError extends Error {
  /** ClickHouse's numeric error code, as it reported it. */
  readonly code: string;
  /** Its symbolic name — `INCORRECT_DATA`, `TYPE_MISMATCH` — when it gave one. */
  readonly type: string | undefined;

  constructor(
    code: string,
    type: string | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TraceStoreRefusedError";
    this.code = code;
    this.type = type;
  }
}

/**
 * Reject an evidence field that exceeds its storage limit; never truncate it.
 * Return the field, bound, and byte count so the sender can correct the record.
 */
export class OversizeRecordError extends Error {
  /** The `NewSpan` field, by the name the sender knows it as. */
  readonly field: string;
  /** What that field may hold, in bytes of UTF-8. */
  readonly bound: number;
  /** What arrived, in the same unit. */
  readonly bytes: number;

  constructor(field: string, bound: number, bytes: number) {
    super(
      `this record's ${field} is ${bytes} bytes of UTF-8, and the column holds ` +
        `${bound}. It is refused rather than shortened: a value cut to fit is ` +
        `stored looking exactly like a whole one, and nothing afterwards can ` +
        `tell that it was cut. Send the record with a shorter ${field}.`,
    );
    this.name = "OversizeRecordError";
    this.field = field;
    this.bound = bound;
    this.bytes = bytes;
  }
}

/**
 * Reject a span start outside the trace store's supported time range before
 * sealing it into a segment that replay cannot read.
 */
export class UnstorableInstantError extends Error {
  /** The offending start instant, in microseconds since the epoch. */
  readonly microseconds: bigint;
  /** The store's earliest and latest holdable instant, same unit. */
  readonly earliest: bigint;
  readonly latest: bigint;

  constructor(microseconds: bigint, bounds: { earliest: bigint; latest: bigint }) {
    super(
      `this record's start instant is ${microseconds} microseconds since the ` +
        `epoch, and the trace store holds ${bounds.earliest} to ${bounds.latest}. ` +
        `It is refused rather than stored: a span whose instant the store cannot ` +
        `hold seals into a segment that then cannot be read back. Send the record ` +
        `with a start time inside that range.`,
    );
    this.name = "UnstorableInstantError";
    this.microseconds = microseconds;
    this.earliest = bounds.earliest;
    this.latest = bounds.latest;
  }
}

/**
 * A trace query has an invalid time window or cursor.
 * Expose the reason and message as a request error.
 */
export class UnreadableTraceQueryError extends Error {
  readonly reason: "time_window" | "cursor";

  constructor(reason: "time_window" | "cursor", message: string) {
    super(message);
    this.name = "UnreadableTraceQueryError";
    this.reason = reason;
  }
}

/**
 * The caller's role does not permit the action, or the action named a customer
 * that is not theirs.
 *
 * It carries the facts a refusal has to be able to state — who, at what role,
 * refused what, where — because an HTTP layer that has to reconstruct them ends
 * up guessing, and a permission failure a developer cannot read is one they
 * work around rather than fix.
 */
export class NotPermittedError extends Error {
  readonly userId: string;
  readonly role: Role;
  readonly action: Action;
  readonly organizationId: string;
  /** Absent when the action was taken for a whole customer rather than in one. */
  readonly projectId: string | undefined;

  constructor(auth: AuthContext, action: Action, scope: ActionScope) {
    super(
      scope.organizationId === auth.organizationId
        ? auth.via === "api_key" && auth.projectId !== undefined
          ? `This API key is limited to project ${auth.projectId} and its creator's current permissions. Use a permitted browser session or an API key for the required project or organization.`
          : `a ${auth.role} may not ${action}`
        : `${action} named organization ${scope.organizationId}, and the credential is for ${auth.organizationId}`,
    );
    this.name = "NotPermittedError";
    this.userId = auth.userId;
    this.role = auth.role;
    this.action = action;
    this.organizationId = scope.organizationId;
    this.projectId = scope.projectId;
  }
}

/**
 * Connection restore failed a credential rule or requires restoring its agent first.
 * Use reason for HTTP handling instead of parsing the message.
 */
export class ConnectionRestoreRefusedError extends Error {
  readonly reason: ConnectionRestoreRefusal;
  /** Whichever of the two the sentence named, for a layer that has to relay it. */
  readonly connectionId: string | undefined;
  readonly agentId: string | undefined;
  readonly connectionType: string | undefined;

  constructor(
    reason: ConnectionRestoreRefusal,
    message: string,
    named: {
      readonly connectionId?: string;
      readonly agentId?: string;
      readonly connectionType?: string;
    } = {},
  ) {
    super(message);
    this.name = "ConnectionRestoreRefusedError";
    this.reason = reason;
    this.connectionId = named.connectionId;
    this.agentId = named.agentId;
    this.connectionType = named.connectionType;
  }
}

export type ConnectionRestoreRefusal =
  | "credential_required"
  | "credential_forbidden"
  | "credential_choice_required"
  | "parent_agent_archived";

/** New model work cannot start from a reliably exhausted balance. */
export class FundingRefusedError extends Error {
  constructor(message: string) {
    super(message.trim() || "Add inference credit or provider keys before starting this work.");
    this.name = "FundingRefusedError";
  }
}
