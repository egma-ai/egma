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
 * - `not_admitted` — the selection itself: no versions, a version this egma
 *   never issued, one version named twice, more conversations than a run may
 *   hold, or a persona a pinned version names who has since been deleted.
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

/** A test, as a refusal names it: enough to go and find it and fix it. */
export type TestNamingPersona = {
  readonly id: string;
  readonly name: string;
};

/** The same, for the refusal a grader's delete raises. */
export type TestNamingGrader = {
  readonly id: string;
  readonly name: string;
};

/** How many blocking tests the message spells out before it starts counting. */
const TESTS_NAMED_IN_MESSAGE = 5;

function spelledOutAndCounted(
  tests: readonly { readonly id: string; readonly name: string }[],
): string {
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
      `this edit was written against version ${versions.expected}, and test ${test.id} has moved on to ${versions.current}`,
    );
    this.name = "TestMovedOnError";
    this.testId = test.id;
    this.testName = test.name;
    this.expectedVersionId = versions.expected;
    this.currentVersionId = versions.current;
  }
}

/**
 * A grader's delete was refused because live tests still name it.
 *
 * A test's grader array is what its scenario asks to be judged by on top of the
 * project's own graders. Letting the delete through would leave each of those
 * tests quietly checking one thing fewer than it says it checks — a suite going
 * green because a check disappeared, which is the same false trust the persona's
 * refusal exists to prevent and the reason it is spelled the same way here.
 *
 * It carries every blocking test, because the fix is to go and edit each one and
 * a refusal that only said "something names it" would send somebody hunting. The
 * message spells out the first few and counts the rest.
 */
export class GraderNamedByTestsError extends Error {
  readonly graderId: string;
  /** Every live test whose current version names it, oldest first. */
  readonly tests: readonly TestNamingGrader[];

  constructor(graderId: string, tests: readonly TestNamingGrader[]) {
    super(
      `grader ${graderId} is named by ${tests.length} live ${
        tests.length === 1 ? "test" : "tests"
      } (${spelledOutAndCounted(tests)}), and a test must never silently lose one of the checks it was written with; take it off those tests, or delete them, and then delete the grader`,
    );
    this.name = "GraderNamedByTestsError";
    this.graderId = graderId;
    this.tests = tests;
  }
}

/**
 * A delete named a library entry egma owns, and egma's entries are undeletable.
 *
 * A predefined entry is not a row somebody wrote; it is a row an egma release
 * writes, and it is written again on the next boot. Allowing the delete would
 * make it come back — the seeding is deterministic and runs on every start — so
 * what a developer would actually get is a grader that disappears from the
 * shelf until the container restarts, and running copies pointing at nothing in
 * between. Refusing says the true thing instead: this one is egma's, and the
 * way to stop it judging is to stop running a copy of it.
 *
 * It carries the entry's name as well as its id, because the sentence a person
 * reads should name the grader they just tried to remove rather than an
 * identifier they then have to go and look up.
 */
export class PredefinedGraderError extends Error {
  readonly libraryId: string;
  readonly graderName: string;

  constructor(libraryId: string, graderName: string) {
    super(
      `"${graderName}" (${libraryId}) is one of egma's own graders, and those cannot be deleted: it is written by every release and would come back at the next start. Stop running a copy of it instead — a library entry judges nothing on its own.`,
    );
    this.name = "PredefinedGraderError";
    this.libraryId = libraryId;
    this.graderName = graderName;
  }
}

/**
 * A delete named a library entry that graders still point at.
 *
 * **Refusal, and never `set null`.** A copy's `library_id` is the whole of what
 * says what it judges by — the definition is read through it every time a
 * conversation is judged, and never written down onto the copy — so an entry
 * taken off the shelf underneath one would leave a grader that resolves to
 * nothing and judges nothing while still appearing on the Running graders
 * screen. That is a check somebody believes in that can never fire, which is the
 * false trust this product exists to kill. The database says the same thing with
 * `on delete restrict`; this is the half that can name what is in the way.
 *
 * **A copy somebody switched off still counts**, and that is not an oversight.
 * Deleting a copy is a soft delete: the row stays and so do its versions, so
 * that a verdict written under one is still interpretable — and that chain runs
 * verdict → version → copy → entry. Taking the entry away would break it at the
 * last link, leaving old verdicts naming a definition nobody can read.
 *
 * It carries the copies, because the fix is to deal with each of them and a
 * refusal that only said "something uses it" would send somebody hunting.
 */
export class GraderLibraryEntryInUseError extends Error {
  readonly libraryId: string;
  /** Every copy pointing at it, oldest first, switched off ones included. */
  readonly graders: readonly GraderUsingLibraryEntry[];

  constructor(
    libraryId: string,
    graderName: string,
    graders: readonly GraderUsingLibraryEntry[],
  ) {
    super(
      `"${graderName}" (${libraryId}) is still pointed at by ${graders.length} ${
        graders.length === 1 ? "grader" : "graders"
      } (${spelledOutAndCounted(graders)}), and a grader reads its definition through that pointer every time it judges — including one that was switched off, whose past verdicts are still read through it; an entry can only leave the shelf once nothing points at it at all`,
    );
    this.name = "GraderLibraryEntryInUseError";
    this.libraryId = libraryId;
    this.graders = graders;
  }
}

/** One running copy standing in the way of its entry's delete. */
export type GraderUsingLibraryEntry = {
  readonly id: string;
  readonly name: string;
};

/**
 * A write named a library entry the caller cannot see, or none at all.
 *
 * The two are one refusal on purpose: an entry belonging to another customer
 * and an entry that was never written are indistinguishable from outside, and
 * they have to be — telling them apart would answer a question about somebody
 * else's shelf.
 */
export class UnknownGraderLibraryEntryError extends Error {
  readonly libraryId: string;

  constructor(libraryId: string) {
    super(
      `${libraryId} is not a grader on this shelf, so there is nothing to make a copy of; read the library to see what egma ships`,
    );
    this.name = "UnknownGraderLibraryEntryError";
    this.libraryId = libraryId;
  }
}

/**
 * A mock tool was written for a tool this project already answers for.
 *
 * Matching is by tool name and strictly by it — no arguments are read — so two
 * rows answering for one tool would be two answers with no rule to choose
 * between them, and whichever egma picked would be a mocked world nobody
 * authored. The refusal names the row already standing there, because the two
 * things worth doing next are both about that row: edit it, or leave it alone
 * and override the name on the one test that needs the other branch.
 *
 * Its own class rather than an `UnprocessableInputError`, because the answer is
 * different in kind: nothing about the body is wrong, and something is already
 * there.
 *
 * **The row is named when it can be, and the sentence says so either way.** The
 * factory checks before it writes and names what it found; the database's own
 * unique index catches the two writes that arrived at the same instant, and by
 * the time that loser asks which row won, the winner may already have been
 * deleted. Naming a row that is not there any more would be worse than not
 * naming one, so the two states get the two sentences they need — the shape the
 * invitation refusal above already uses for the same reason.
 */
export class MockToolTakenError extends Error {
  readonly toolName: string;
  /** The living mock tool that already answers for it, when one was found. */
  readonly mockToolId: string | undefined;

  constructor(toolName: string, mockToolId: string | undefined) {
    super(
      mockToolId === undefined
        ? `this project already answers for "${toolName}". One answer per ` +
            `tool: edit the mock tool that answers for it, or override it on ` +
            `the test that needs a different branch.`
        : `this project already answers for "${toolName}", with mock tool ` +
            `${mockToolId}. One answer per tool: edit that one, or override ` +
            `it on the test that needs a different branch.`,
    );
    this.name = "MockToolTakenError";
    this.toolName = toolName;
    this.mockToolId = mockToolId;
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
