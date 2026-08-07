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
 * - `not_admitted` — the connection registry's per-type gate: an unknown type,
 *   a modality the type does not speak, a config key it has no place for, a
 *   credential where none belongs or none where one is required.
 * - `needs_a_name` — an agent or a connection arrived without a usable name.
 * - `name_taken` — a living agent in the project, or a living connection on
 *   the agent, already holds the name.
 */
export type AgentWriteRefusal = "not_admitted" | "needs_a_name" | "name_taken";

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

/** A test, as a refusal names it: enough to go and find it and fix it. */
export type TestNamingPersona = {
  readonly id: string;
  readonly name: string;
};

/** How many blocking tests the message spells out before it starts counting. */
const TESTS_NAMED_IN_MESSAGE = 5;

function spelledOutAndCounted(tests: readonly TestNamingPersona[]): string {
  const named = tests
    .slice(0, TESTS_NAMED_IN_MESSAGE)
    .map((test) => `${test.id} "${test.name}"`)
    .join(", ");
  const rest = tests.length - TESTS_NAMED_IN_MESSAGE;
  return rest > 0 ? `${named}, and ${rest} more` : named;
}

/**
 * A persona's delete was refused because live tests still name them.
 *
 * A test names the people who call about its scenario, and executing it
 * produces one simulation per person named. Letting the delete through would
 * leave each of those tests quietly running one simulation fewer than it says
 * it runs — a suite going green while the case somebody wrote it for never
 * ran. So the delete is refused, and the developer decides what those tests
 * should say instead.
 *
 * It carries every blocking test, because the fix is to go and edit each one
 * and a refusal that only said "something names them" would send somebody
 * hunting. The message spells out the first few and counts the rest: the
 * persona a project points at by default is named by every test created
 * without naming one, so an uncapped message would be a page long.
 */
export class PersonaNamedByTestsError extends Error {
  readonly personaId: string;
  /** Every live test whose current version names them, oldest first. */
  readonly tests: readonly TestNamingPersona[];

  constructor(personaId: string, tests: readonly TestNamingPersona[]) {
    super(
      `persona ${personaId} is named by ${tests.length} live ${
        tests.length === 1 ? "test" : "tests"
      } (${spelledOutAndCounted(tests)}), and a test must never silently lose one of the people who call about it; name somebody else on those tests, or delete them, and then delete the persona`,
    );
    this.name = "PersonaNamedByTestsError";
    this.personaId = personaId;
    this.tests = tests;
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
