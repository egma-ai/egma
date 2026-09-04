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
 * The agent factory turned a write away, and which rule turned it away is
 * carried beside the sentence rather than hidden inside it.
 *
 * Three rules refuse a write here and they are three different answers to
 * whoever asked: a connection payload the type's own registry entry will not
 * take, something the factory needs a name for and did not get one for, and a
 * name a living row already holds. An HTTP layer has to tell them apart, and
 * reading the sentence to do it would make the prose load-bearing — while the
 * sentence is the part deliberately left free to improve. So the reason
 * travels as a value and the sentence travels untouched, to be relayed word
 * for word to whoever asked.
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
 * Which rule refused.
 *
 * - `not_admitted` — the connection registry's per-kind gate: an unknown kind,
 *   a modality the type does not speak, a config key it has no place for, a
 *   credential where none belongs or none where one is required.
 * - `needs_a_name` — an agent or a connection arrived without a usable name.
 * - `name_taken` — a living agent in the project, or a living connection on
 *   the agent, already holds the name.
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
 * Which rule refused.
 *
 * - `no_such_connection` — nothing this credential can see has that id.
 *   Answered as "there is no such thing", because to this caller that is what
 *   it is: confirming somebody else's row exists is itself a leak.
 * - `connection_not_on_agent` — both were named, both are there, and they are
 *   not each other's. Its own answer rather than the one above, because the
 *   caller asked for exactly that check and the two mistakes have different
 *   fixes.
 * - `no_adapter` — the connection's type has no shipped simulator adapter, so
 *   the run could never be conducted. Refused at creation rather than left
 *   queued forever for a conductor that does not exist.
 * - `not_admitted` — the suite is empty, an expected test/version set is stale
 *   or malformed, or a persona a current version names is unavailable.
 * - `already_finished` — a cancel arrived after the run had finished, so there
 *   was nothing left to cancel and the caller missed.
 */
export type RunWriteRefusal =
  | "no_such_connection"
  | "connection_not_on_agent"
  | "no_adapter"
  | "not_admitted"
  | "already_finished";

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
/**
 * The write would have left the organization with no admin.
 *
 * Nobody else can invite, change a role or remove anybody, so an organization
 * with no admin is one nobody can ever administer again — and on a self-hosted
 * instance its admin *is* the instance administrator, with no role above the
 * organization to appeal to. Refused rather than allowed and regretted: making
 * somebody else an admin first is one extra click, and undoing this is not
 * possible from inside the product at all.
 */
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
 * An edit named the revision it was written against, and the resource has
 * moved since.
 *
 * **The counterpart to `TestMovedOnError`, one level up.** That one guards
 * *content*: two people writing different versions of one test. This one
 * guards *identity*: two people renaming, archiving or restoring one row. They
 * are separate because they are separately recoverable — a rename that lost
 * a race is retyped in a second, and a content edit that lost one may be an
 * afternoon's work somebody has to be given the chance to reapply.
 *
 * It carries what a caller has to be told to recover: which resource, which
 * one, and what the revision is now — because the next move is to read it
 * again and send the edit naming the revision it names then.
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
 * Postgres rolled the write back rather than let it wait forever, and it can
 * be sent again unchanged.
 *
 * **Its own class because it is the one refusal that is about nothing the
 * caller did.** A deadlock or a serialization failure is the store noticing
 * two correct transactions have got in each other's way; the request that
 * loses was valid on the way in and will be valid on the way back. Letting the
 * driver's error escape would answer it as an internal failure, which tells
 * whoever pressed the control that egma is broken rather than that they should
 * press it again.
 *
 * Nothing here promises this is rare. It is what a store is entitled to do,
 * and a surface that only worked while it never happened would be a surface
 * with a fault nobody could reproduce.
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
 * A project tried to change or delete a Predefined persona — one of Egma's own.
 *
 * The class keeps the storage word and the sentence uses the product one, which
 * is the split the persona tables record: null tenancy is how a shelf persona
 * is encoded, **Predefined** is what anybody using egma calls it.
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
 * A write refused for what it says, rather than for who asked or for what is
 * there.
 *
 * Three refusals answer three different questions and each wants its own words:
 * who you are, what is there, and what you wrote. This is the third, and it is
 * the only one about the body — so it is the only one whose sentence a writer
 * can act on without knowing anything about egma's tables.
 *
 * It exists so that a layer above can tell a factory's validation apart from a
 * fault. Both were plain errors before, and neither answer available then was
 * right: treating every error as the caller's mistake dresses a bug up as one,
 * and treating none as theirs throws away the sentence they needed. The sentence
 * is the factory's own and travels word for word.
 */
export class UnprocessableInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnprocessableInputError";
  }
}

/**
 * A save asked one egma agent to bind to a second platform agent.
 *
 * **A subclass, because the sentence is the whole of the answer** — every
 * layer that relays an `UnprocessableInputError` word for word is right about
 * this one too. What the subclass buys is the two ids, so a caller that wants
 * to say something else can, and so a test can assert the binding rather than
 * the prose.
 *
 * **The sentence names both agents and gives the way out.** Retell gives a
 * voice agent and a chat agent different ids; one egma agent holds one
 * binding, so the second platform agent belongs to a second egma agent. Saying
 * only "already bound" would leave somebody guessing which of the two ids
 * Egma is keeping.
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
 * A write named a persona by a name that more than one active persona in the
 * project answers to.
 *
 * **A subclass rather than a sibling**: it is the caller's
 * body, and every layer that relays an `UnprocessableInputError` word for word
 * is right about this one too. What the subclass buys is the code, and the code
 * matters here because the reader is usually a repository file rather than a
 * form: a version-1 test file carries persona *names* and nothing else, and the
 * fix is to put the stable identifier in the file — which is a different
 * instruction from anything a browser would be told.
 *
 * **Never resolved by picking one.** There is no uniqueness rule on a persona's
 * name, so choosing by list order would silently put somebody in a test nobody
 * chose, and the run would be about a caller the author never named.
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
 * An edit named the version it was written against, and the test has moved.
 *
 * A test is edited by two people who both start from what they last read: a
 * developer with the file in their repository, and a teammate in the dashboard.
 * Nothing here merges them, because there is no merge that could be right — two
 * people saying different things about one test have to settle it between
 * themselves, and a heuristic that picked one would be egma deciding which of
 * them was wrong.
 *
 * It carries both versions and the test's identity, because the caller's next
 * move is to go and read the test as it now stands, and a refusal that only said
 * "somebody else got there first" would send them hunting for which test.
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
 * A project could not take the slug it was asked for, because a living project
 * of the same organization already holds it.
 *
 * **Its own class rather than a general validation refusal, because the slug is
 * the one project field a person chooses and can be told is taken.** A name is
 * free — two projects may both be called Outbound — and the slug is what has to
 * be unique inside the organization, so this is the only collision the product
 * can meet here and the sentence names the one field to change.
 *
 * It carries the slug because the refusal quotes it back: somebody who typed
 * `outbound` has to be told that `outbound` is the word that is taken, rather
 * than that "the project" is.
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
 * The trace store read a batch of spans and refused it, and would refuse the
 * identical bytes again.
 *
 * The distinction this exists to make is between *these rows* and *right now*.
 * A store that cannot be reached, or that is out of memory, or that is behind on
 * its merges, will take the same batch happily in a minute — and a door that
 * told an exporter "rejected" for one of those would have thrown a customer's
 * telemetry away, because OTLP is explicit that rejected data must not be
 * retried. So only a refusal that is about the data itself is turned into this;
 * everything else stays an error and is answered as one, and an exporter
 * retries.
 *
 * It carries the store's own code and name rather than a rewritten message,
 * because the person who has to fix a batch the store will not take needs the
 * words the store used.
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
 * A record naming a field longer than the column it would be filed in.
 *
 * Its own class because it is the one refusal about the evidence rather than
 * about the store: nothing failed, nothing was reached, and the answer is not
 * "try again" but "this record cannot be stored as what it claims to be". The
 * alternative — cutting the field to fit — is what this replaces, and it was
 * worse than a refusal in the way that matters most: a shortened transcript is
 * stored looking exactly like a whole one, so the customer whose evidence egma
 * edited is the last person who could ever find out.
 *
 * It carries the field, the bound and the size rather than a sentence about
 * them, because the caller has to report all three to whoever sent the record
 * and the sentence is the part deliberately left free to improve.
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
 * A record whose span begins at an instant the trace store cannot hold.
 *
 * Its own class beside `OversizeRecordError` because it is the other refusal
 * about the evidence rather than about the store: the store is not reached and
 * nothing failed, and the answer is not "try again" but "this instant is not one
 * a `DateTime64` row and a partitioned read can be built around". A start time
 * outside the store's range seals into a valid segment and then stops the read
 * probe that guards every replay, so it is refused at the door instead, exactly
 * as an oversize field is.
 *
 * It carries the instant and the bound it crossed rather than a sentence about
 * them, because the caller reports both to whoever sent the record and the
 * sentence is the part left free to improve.
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
 * A trace query egma will not run, because of how it was asked rather than
 * because of who asked it.
 *
 * There are exactly two ways to get one, and both are refusals the read surface
 * exists to make: a window that is missing, backwards, or wider than one request
 * may name; and a page token that is not one egma issued. Neither is a fault and
 * neither is a permission problem — they are a caller being told what a bounded
 * read requires, which is why they carry a sentence a person can act on rather
 * than a code they have to look up.
 *
 * It is one error with a `reason` rather than two classes, because the two are
 * answered identically at every layer above: a 400, and the message. Splitting
 * them would multiply the handling without changing any of it.
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
        ? `a ${auth.role} may not ${action}`
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
 * A connection could not be brought back on the terms its own shape sets.
 *
 * Four rules refuse a Restore and they are four different answers to whoever
 * asked — bring a credential, do not bring one, say which of the two you mean,
 * and restore the agent first. The reason travels beside the sentence rather
 * than inside it, as the agent factory's refusals do and for the same reason:
 * an HTTP layer answers each of them with its own code, and reading the prose
 * to tell them apart would make the prose load-bearing.
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

/**
 * A start action reused an idempotency key over a different request.
 *
 * **The whole value of remembering a key is that it can refuse this.** Answering
 * the original run would tell somebody their new selection had started when it
 * had not; starting a second run would make the key mean nothing. So the third
 * answer is the only honest one, and it says which of the two moves to make:
 * send the original request again, or send a new key for the new one.
 */
export class IdempotencyConflictError extends Error {
  readonly idempotencyKey: string;
  /** What the key already produced, so a caller can go and read it. */
  readonly resultId: string;

  constructor(idempotencyKey: string, resultId: string) {
    super(
      `idempotency key ${idempotencyKey} already started run ${resultId}, and this request is not the one it started`,
    );
    this.name = "IdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
    this.resultId = resultId;
  }
}
