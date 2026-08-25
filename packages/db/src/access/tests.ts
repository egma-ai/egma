import { isId, newId } from "@egma/ids";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  type SQL,
} from "drizzle-orm";

import { db, type Queryable, type Transaction } from "../client.ts";
import { persona } from "../schema/personas.ts";
import {
  test,
  testPersona,
  testSuite,
  testVersion,
} from "../schema/tests.ts";
import type { MockToolAnswer } from "../mock-tools/resolve.ts";
import type { AuthContext } from "./context.ts";
import {
  IdentityConflictError,
  ProjectOutsideOrganizationError,
  TestMovedOnError,
  UnprocessableInputError,
  type TestNamingPersona,
} from "./errors.ts";
import {
  answerFromRow,
  validAnswer,
  validDelay,
  validToolName,
  type MockToolAnswerInput,
} from "./mock-tools.ts";
import { pageOf, pageWindow, type PageRequest } from "./pages.ts";
import { personaAvailableToProject } from "./persona-availability.ts";
import { authorize, here } from "./permissions.ts";
import { lockRepositoryProject } from "./repository-lock.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { within } from "./within.ts";

/**
 * Reading and writing tests — what they are is the schema file's story
 * (`schema/tests.ts`); this file is how they are reached.
 *
 * Project scoping works as the persona factory's does, verb for verb. A context
 * acting in a project writes and reads there; a context acting in none — an
 * organization-scoped credential — reads the whole customer and creates
 * nothing, because a test belongs to a project and a credential for the whole
 * customer is acting in none. What already exists it may edit: the row names
 * its own project, so that write has somewhere to land.
 *
 * **A test is falsifiable from birth.** Its expected behaviors are required
 * non-empty at write time, and grading a simulation against them is part of
 * what running a test means, so there is no window in which a stored test could
 * pass without ever having been able to fail.
 *
 * **A test names no graders.** Which project graders grade a simulation is
 * resolved from each project grader's scope and never through test
 * content — so a version's content is the scenario, the behaviors and the mock
 * overrides, and there is nothing else in here for a writer to name.
 */

/**
 * One statement about what should happen: **a plain sentence, and nothing
 * else.**
 *
 * Per-behavior priorities retired with the P0/P1/P2 ladder. Under binary scoring
 * every behavior has to hold, so a priority had nothing left to say — and the
 * rule it was propping up, that a test always keeps one blocking behavior,
 * collapses back into the plain non-empty rule the falsifiability decision
 * placed on the list.
 *
 * Each sentence is one **assertion** of the expected-behaviors grader, graded in
 * isolation and stored as one nested assertion detail in that grader's single
 * grade row for the trace. Its key comes from its position in this list.
 */
export type ExpectedBehavior = string;

/**
 * One tool this test answers for itself, instead of however the project
 * answers for it.
 *
 * **An override is test content and has no identity of its own.** It is not a
 * mock tool sitting somewhere else that the test points at — it is a sentence
 * in the test, versioned with the test exactly as an expected behavior is. That
 * is what buys override history for nothing: project mock tools are
 * deliberately unversioned, and this half of the mocked world versions anyway,
 * because tests already version.
 *
 * Forcing a branch is what these are for. "The calendar has no free slots" is
 * this test with one tool overridden, and the project's other agents go on
 * seeing the calendar the project describes.
 */
export type MockOverride = {
  /** The agent's own name for the tool, verbatim — matching is by this. */
  readonly toolName: string;
  readonly answer: MockToolAnswer;
  readonly delayMilliseconds: number;
};

/**
 * An override as it is written down. The delay is what a writer may leave out,
 * and the answer arrives unjudged for the reason a project mock tool's does:
 * whether the two keys add up to one branch is one rule, decided in one place,
 * for both halves of the mocked world.
 */
export type MockOverrideInput = {
  readonly toolName: unknown;
  readonly answer: MockToolAnswerInput;
  readonly delayMilliseconds?: number | undefined;
};

/**
 * What a version of a test says. The scenario is the situation as free text —
 * what the persona wants, and the circumstances. The expected behaviors are
 * statements about what should happen, in the order they were authored, and at
 * least one of them always exists. The mock overrides are the tools this
 * scenario answers for itself, and there are usually none.
 *
 * Internal, because the exported API is flat: a caller hands the fields to
 * `createTest` beside the name, and reads them back off a `Test` the same way.
 * The pairing matters only to the version row that stores them together.
 */
type TestContent = {
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehavior[];
  readonly mockOverrides: readonly MockOverride[];
};

export type NewTest = {
  readonly suiteId: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehavior[];
  /**
   * Who calls about the scenario. Naming none — absent, or an empty list —
   * takes the project's default persona, so authoring a first test never waits
   * on authoring a persona.
   */
  readonly personaIds?: readonly string[] | undefined;
  /**
   * The tools this scenario answers for itself, on top of however the project
   * answers for them. Naming none is the ordinary case: the project's mock
   * tools are the world, and a test overrides one only when the branch it is
   * written for needs a different answer.
   */
  readonly mockOverrides?: readonly MockOverrideInput[] | undefined;
};

/**
 * A persona as a test names them: by identity, with their current name, and
 * saying plainly whether they have since been archived. A read that hid that
 * would show a test whose simulations cannot all run and give no sign.
 */
export type TestPersona = {
  readonly id: string;
  readonly name: string;
  /** Set once they are archived; the test goes on naming them either way. */
  readonly archivedAt: Date | null;
};

/** One test identity, its immutable suite membership, and its current version. */
export type Test = {
  readonly id: string;
  readonly projectId: string;
  readonly suiteId: string;
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  /** The current version's own `tstv_` id — what a run pins. */
  readonly versionId: string;
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehavior[];
  /** In the order they were authored. */
  readonly personas: readonly TestPersona[];
  /** The tools this scenario answers for itself; usually none. */
  readonly mockOverrides: readonly MockOverride[];
  /**
   * The opaque token an identity write or a lifecycle change has to name. It
   * changes on every one of them and means nothing on its own.
   */
  readonly revision: string;
  /** When it was permanently removed from authoring, or null while active. */
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * What an edit may touch. Name and description are identity and version
 * nothing; the scenario, the expected behaviors and the personas are what the
 * test checks, and version on any change. Absent means keep.
 */
export type TestChanges = {
  readonly name?: string;
  readonly description?: string | null;
  readonly scenario?: string;
  readonly expectedBehaviors?: readonly ExpectedBehavior[];
  /**
   * Who calls about the scenario, as the next version should name them.
   *
   * An empty list means here exactly what it means on a create: take the
   * project's default persona. The two verbs are deliberately not allowed to
   * disagree about one input — a developer who learns `[]` on a create cannot
   * be ambushed by a different meaning on an edit. It could not mean "name
   * nobody" in any case: a test with no personas produces no simulations, so it
   * could never run. Leaving the set alone is what leaving the field out does.
   */
  readonly personaIds?: readonly string[];
  /**
   * The tools the next version should answer for itself.
   *
   * An empty list means here what it means on a create — override nothing —
   * because overriding nothing is a state a test can be in and is the one most
   * tests are in. So `[]` clears the overrides, and leaving the field out keeps
   * them.
   */
  readonly mockOverrides?: readonly MockOverrideInput[];
  /**
   * The version this edit was written against, when the writer knows it.
   *
   * A precondition rather than a change, and it rides here because it belongs
   * to the same write: it is compared under the lock the edit already takes, so
   * there is no moment between checking and writing for a second writer to
   * arrive in. A mismatch refuses everything with `TestMovedOnError`.
   *
   * Identity-only edits may leave it out. Any content edit must name it.
   */
  readonly expectedVersionId?: string;
  /**
   * The identity revision this edit was written against, for the live half —
   * the name and the description.
   *
   * Separate from the version above because the two guard separate losses. A
   * rename that lost a race is retyped in a second; a scenario edit that lost
   * one may be an afternoon's work, and a writer has to be told which of the
   * two happened. An edit that changes both names both.
   */
  readonly expectedRevision?: string;
};

/** One version, frozen: the test exactly as some simulation executed it. */
export type TestVersion = {
  readonly id: string;
  readonly testId: string;
  /** The test's immutable suite membership. */
  readonly suiteId: string;
  /**
   * What the test is called now. Identity is never versioned, so this is the
   * test's current name rather than the name it carried when this version was
   * written — the only name that would help somebody go and find it.
   */
  readonly testName: string;
  readonly version: number;
  /**
   * Whether the test still stands on this version. False once a later one
   * exists, which is what tells a stale pin from a live one.
   */
  readonly current: boolean;
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehavior[];
  /** By identity, in the order they were authored. */
  readonly personas: readonly TestPersona[];
  /** The tools this version answers for itself, as it was frozen. */
  readonly mockOverrides: readonly MockOverride[];
  readonly createdAt: Date;
};

/**
 * The bounded part of one frozen version that execution and evidence need.
 *
 * It deliberately has no personas. A Simulation already pins the one persona
 * it executes, so reading every other persona named by the same test would make
 * one claim grow with the full audience for no execution reason.
 */
export type TestExecutionContent = {
  readonly id: string;
  readonly testId: string;
  readonly suiteId: string;
  readonly testName: string;
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehavior[];
  readonly mockOverrides: readonly MockOverride[];
};

const notDeleted: SQL = isNull(test.deletedAt);

/** An answer's columns, and no more — the tenant-free view. */
const COLUMNS = {
  id: test.id,
  projectId: test.projectId,
  suiteId: test.suiteId,
  name: test.name,
  description: test.description,
  revision: test.revision,
  deletedAt: test.deletedAt,
  createdAt: test.createdAt,
  updatedAt: test.updatedAt,
} as const;

/**
 * The name as it will be stored: trimmed, so a test somebody has to recognise
 * in a list is not named by invisible characters.
 */
function validName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new UnprocessableInputError("a test needs a name");
  return trimmed;
}

/**
 * The scenario and the behaviors, as they will be stored.
 *
 * An empty behaviors list is refused rather than accepted, because a test with
 * nothing to check is a test that can never be red — and a suite of tests that
 * could never be red is the false confidence this product exists to kill. That
 * is the whole of the falsifiability rule now: with priorities retired there is
 * no way left to demote a test into never being able to fail, so non-empty is
 * the only thing this has to hold.
 */
function validContent(input: {
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehavior[];
  readonly mockOverrides: readonly MockOverrideInput[];
}): TestContent {
  const scenario = input.scenario.trim();
  if (scenario === "") {
    throw new UnprocessableInputError(
      "a test needs a scenario: the situation the agent is put in",
    );
  }

  if (input.expectedBehaviors.length === 0) {
    throw new UnprocessableInputError(
      "a test needs at least one expected behavior, because a test that cannot fail is not a test",
    );
  }
  const expectedBehaviors = input.expectedBehaviors.map((entry: unknown) => {
    // The shape that retired with the P0/P1/P2 ladder, named rather than
    // reported as an empty sentence: a writer sending last month's body should
    // be told what changed, not told their behavior says nothing.
    if (typeof entry === "object" && entry !== null && "behavior" in entry) {
      throw new UnprocessableInputError(
        'an expected behavior is a plain sentence now; the {"behavior", "priority"} ' +
          "shape retired with the P0/P1/P2 ladder. Send the sentence on its own.",
      );
    }
    const behavior = typeof entry === "string" ? entry.trim() : "";
    if (behavior === "") {
      throw new UnprocessableInputError(
        "an expected behavior needs to say something",
      );
    }
    return behavior;
  });

  return {
    scenario,
    expectedBehaviors,
    mockOverrides: validOverrides(input.mockOverrides),
  };
}

/**
 * The overrides as they will be stored.
 *
 * Every gate a project mock tool passes is applied here from the same
 * functions — a blank tool name, a delay past the budget, an answer past what
 * the exchange carries — because an override is served the same way over the
 * same exchange, and a rule enforced in one of the two places would be a rule
 * a test could walk around.
 *
 * **One override per tool name**, for the reason a project holds one answer per
 * tool: matching is by name alone, so two entries for one tool would be two
 * answers with no rule to choose between them.
 */
function validOverrides(
  written: readonly MockOverrideInput[],
): readonly MockOverride[] {
  const overrides: MockOverride[] = [];
  const seen = new Set<string>();

  for (const entry of written) {
    if (typeof entry !== "object" || entry === null) {
      throw new UnprocessableInputError(
        "each mock tool a test overrides is an object naming the tool and " +
          "what it answers with",
      );
    }
    const toolName = validToolName(entry.toolName);
    if (seen.has(toolName)) {
      throw new UnprocessableInputError(
        `this test overrides "${toolName}" twice; override each tool once`,
      );
    }
    seen.add(toolName);
    overrides.push({
      toolName,
      answer: validAnswer(entry.answer),
      delayMilliseconds: validDelay(entry.delayMilliseconds),
    });
  }

  return overrides;
}

/**
 * Everything about the named ids that is answerable without the database: there
 * is at least one, every one is an identifier of a persona, and each one is
 * named once. Naming the same persona twice would ask for the same simulation
 * twice, which is a run's business and not a test's, so it is refused here
 * rather than left to a constraint.
 *
 * **Naming none is refused here too**, so a create that sent no list and an
 * edit that sent an empty one are answered before either costs a read.
 * `personaIdsFor` says the same thing at the write itself, where the set an
 * edit carried forward also passes.
 */
function validatePersonaIds(ids: readonly string[]): void {
  if (ids.length === 0) {
    throw new UnprocessableInputError(
      "a test needs at least one persona, because a test says who calls",
    );
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isId("prs", id)) {
      throw new UnprocessableInputError(`"${id}" is not a persona id`);
    }
    if (seen.has(id)) {
      throw new UnprocessableInputError(
        `persona ${id} is named twice on one test; name each persona once`,
      );
    }
    seen.add(id);
  }
}

/**
 * The shape guard on every read. Stored jsonb comes back `unknown`, and a row
 * somebody hand-edited must fail here, loudly and naming itself, rather than
 * leak into a caller as a `TestContent` that isn't one. Shape only,
 * deliberately: an old version must stay readable exactly as it was written.
 *
 * **A behavior stored as `{behavior, priority}` is read as its sentence.** The
 * versions written while priorities existed hold that shape, and every one of
 * them said the same thing the sentence says now — a priority never changed what
 * the behavior asked of the agent, only how loudly a failure spoke, and nothing
 * speaks loudly or quietly any more. So the priority is dropped on the way out
 * rather than migrated away: a version row is frozen the moment a run can pin
 * it, and rewriting one to tidy a retired field would be exactly the edit the
 * whole versioning exists to make impossible.
 */
function contentFromRow(value: unknown, versionId: string): TestContent {
  const malformed = () =>
    new Error(
      `version ${versionId} holds content in a shape Egma never writes; the row needs repairing before anybody can read it`,
    );

  if (typeof value !== "object" || value === null) throw malformed();
  const { scenario, expectedBehaviors, mockOverrides } = value as Record<
    string,
    unknown
  >;
  if (typeof scenario !== "string" || scenario.trim() === "") throw malformed();
  if (!Array.isArray(expectedBehaviors) || expectedBehaviors.length === 0) {
    throw malformed();
  }
  // Absent on every version written before a test could override a tool, and
  // absent means what it meant then: this test overrides nothing. Reading it as
  // an empty list is therefore not a default applied to old rows but the
  // meaning they already had, which is what lets overrides arrive as an
  // additive change with no rewrite.
  if (mockOverrides !== undefined && !Array.isArray(mockOverrides)) {
    throw malformed();
  }
  return {
    mockOverrides: (mockOverrides ?? []).map((entry: unknown): MockOverride => {
      if (typeof entry !== "object" || entry === null) throw malformed();
      const { toolName, answer, delayMilliseconds } = entry as Record<
        string,
        unknown
      >;
      if (typeof toolName !== "string" || toolName.trim() === "") {
        throw malformed();
      }
      if (typeof delayMilliseconds !== "number") throw malformed();
      return {
        toolName,
        // The mock-tool factory's own guard, so a hand-edited answer fails the
        // same way on both halves of the mocked world — naming the version it
        // is actually stored on, because there is no mock tool with this id.
        answer: answerFromRow(answer, versionId, "test version"),
        delayMilliseconds,
      };
    }),
    scenario,
    expectedBehaviors: expectedBehaviors.map((entry): ExpectedBehavior => {
      if (typeof entry === "string") {
        if (entry.trim() === "") throw malformed();
        return entry;
      }
      if (typeof entry !== "object" || entry === null) throw malformed();
      const { behavior } = entry as Record<string, unknown>;
      if (typeof behavior !== "string" || behavior.trim() === "") {
        throw malformed();
      }
      return behavior;
    }),
  };
}

/**
 * Two ordered lists of strings, compared as written. Order is content
 * everywhere this is asked: the personas are named in the order they were
 * authored, so a version that reorders them says something the version before
 * it did not.
 */
function sameOrderedList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * The behaviors, compared as written: the same statements, in the same order.
 *
 * The comparison a persona list gets, because a behavior is a plain sentence
 * now and there is nothing else on it to compare — but named separately,
 * because the reason order matters here is its own: nested assertion details
 * are keyed by a behavior's **position**, so moving a sentence rekeys the
 * details, and minting a version is what keeps old grade rows readable.
 */
function sameBehaviors(
  a: readonly ExpectedBehavior[],
  b: readonly ExpectedBehavior[],
): boolean {
  return sameOrderedList(a, b);
}

/**
 * Byte-identical or not, decided field by field — the same answer canonical
 * serialization would give, without trusting any serializer to order keys the
 * way jsonb re-ordered them.
 *
 * One comparator per field, in a table the compiler holds exhaustive: a field
 * added to the content refuses to build until it is also told how to compare. A
 * hand-maintained comparator that missed a field would call two different
 * versions identical, and an edit would vanish without a version — the one loss
 * the whole versioning exists to rule out.
 *
 * The jsonb content is all this table covers. The personas a version names are
 * content too and version on exactly the same terms, but they are rows rather
 * than fields, so they are compared beside this rather than inside it —
 * `editTest` asks both questions and mints on either answer.
 */
const sameContentField: {
  readonly [K in keyof TestContent]: (a: TestContent, b: TestContent) => boolean;
} = {
  scenario: (a, b) => a.scenario === b.scenario,
  expectedBehaviors: (a, b) =>
    sameBehaviors(a.expectedBehaviors, b.expectedBehaviors),
  mockOverrides: (a, b) => sameOverrides(a.mockOverrides, b.mockOverrides),
};

/**
 * The overrides, compared as written: the same tools, in the same order, each
 * answering the same way after the same delay.
 *
 * The answer is compared by its serialization rather than field by field,
 * because a tool's answer is whatever shape that tool's own contract has and
 * there is no fixed set of fields to hold a comparator exhaustive over. The
 * value went through `JSON.parse` on its way in, so key order is the order it
 * arrived in and two answers that differ only in key order compare as
 * different — which mints one extra version and loses nothing, where the
 * opposite mistake would lose an edit.
 */
function sameOverrides(
  a: readonly MockOverride[],
  b: readonly MockOverride[],
): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        entry.toolName === other.toolName &&
        entry.delayMilliseconds === other.delayMilliseconds &&
        JSON.stringify(entry.answer) === JSON.stringify(other.answer)
      );
    })
  );
}

function sameContent(a: TestContent, b: TestContent): boolean {
  return Object.values(sameContentField).every((same) => same(a, b));
}

/** Acting in a project narrows to it; acting in none reaches the customer. */
function inActingProject(auth: AuthContext): SQL | undefined {
  return auth.projectId === undefined
    ? undefined
    : eq(test.projectId, auth.projectId);
}

/**
 * The named test within the caller's tenancy, including a permanently deleted
 * identity when a historical evidence read needs it.
 */
function anyTest(auth: AuthContext, id: string): SQL {
  return within(auth, test, and(eq(test.id, id), inActingProject(auth)));
}

/** The named test while it is still available for authoring. */
function theTest(auth: AuthContext, id: string): SQL {
  return and(anyTest(auth, id), notDeleted)!;
}

/**
 * Whether the ids a write names are personas this project can use: each one
 * exists, is alive, and is this project's.
 *
 * One read for the whole set, and then one refusal per id that did not come
 * back whole. A persona of another customer or another project is not found and
 * is refused in the same words as one that never existed, because confirming
 * that somebody else's row exists is itself a leak.
 *
 * **The read takes a shared lock on every row it finds, and this write's
 * transaction holds it until it commits.** Deleting a persona takes an
 * exclusive lock on the same row before it counts the tests naming them, and
 * the two lock modes conflict, so a delete and a write naming the same persona
 * cannot walk past each other: whichever reaches the row first makes the other
 * wait and then see how it ended. If this write got there first, the delete
 * counts the rows it wrote and refuses. If the delete got there first, this
 * read resumes on the row it left behind and the deleted marker below refuses
 * this write — which is why the marker is selected and judged here rather than
 * filtered out in the `where`, where a re-read would simply find nothing and
 * say the persona never existed. Without the lock both could pass their own
 * check and a live test would end up naming a deleted persona, which is the one
 * state this rule exists to make impossible.
 */
async function validateNamedPersonas(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  ids: readonly string[],
): Promise<void> {
  const found = new Map(
    (
      await on
        .select({ id: persona.id, archivedAt: persona.archivedAt })
        .from(persona)
        .where(
          personaAvailableToProject(
            auth,
            projectId,
            inArray(persona.id, [...ids]),
          ),
        )
        .for("share")
    ).map((row) => [row.id, row.archivedAt] as const),
  );

  for (const id of ids) {
    if (!found.has(id)) {
      throw new UnprocessableInputError(
        `there is no persona ${id} in this project`,
      );
    }
    if (found.get(id) !== null) {
      throw new UnprocessableInputError(
        `persona ${id} is archived, and a test cannot name an archived persona`,
      );
    }
  }
}

/**
 * Which personas a write should name, from what it was handed.
 *
 * One function for both write verbs, so the two can never come to disagree
 * about the same input. Naming some checks them, and the ids come back in the
 * order they were given, because that order is content.
 *
 * **Naming none is refused, on a create and on an edit alike.** Until
 * 2026-08-24 an empty list quietly took the project's default persona, so a
 * test could exist that nobody had ever said who calls about — the substitution
 * answered for the author, and the answer read as authored. A test says who
 * calls because its author said so, and every other way of saying nothing is
 * refused here too.
 *
 * Every set a version is about to name comes through here, including the one an
 * edit carried forward from the version before it. A version names personas
 * that exist, are alive, and are this project's — a rule about the row being
 * written, not about who typed the ids.
 *
 * Called inside the write's transaction, so the set that was checked is the set
 * the join rows name.
 */
async function personaIdsFor(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  named: readonly string[],
): Promise<readonly string[]> {
  if (named.length === 0) {
    throw new UnprocessableInputError(
      "a test needs at least one persona, because a test says who calls",
    );
  }
  await validateNamedPersonas(on, auth, projectId, named);
  return named;
}

/** The join rows of one version, in the order the ids were authored. */
async function namePersonasOn(
  on: Queryable,
  versionId: string,
  personaIds: readonly string[],
): Promise<void> {
  await on.insert(testPersona).values(
    personaIds.map((personaId, index) => ({
      testVersionId: versionId,
      personaId,
      position: index + 1,
    })),
  );
}

/** Create one test inside one existing, active suite. */
export async function createTest(
  auth: AuthContext,
  input: NewTest,
): Promise<Test> {
  authorize(auth, "author_definitions", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "a test belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  // Everything answerable without the database is answered first; only an input
  // worth writing costs the reads below.
  if (!isId("ste", input.suiteId)) {
    throw new UnprocessableInputError(`"${input.suiteId}" is not a test suite id`);
  }
  const name = validName(input.name);
  const content = validContent({
    ...input,
    mockOverrides: input.mockOverrides ?? [],
  });
  const named = input.personaIds ?? [];
  validatePersonaIds(named);

  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  return db().transaction((tx) => createTestOn(tx, auth, input));
}

/** The table-owned half used by the repository transaction. */
async function createTestOn(
  on: Transaction,
  auth: AuthContext,
  input: NewTest,
): Promise<Test> {
  const projectId = auth.projectId;
  if (projectId === undefined) {
    throw new Error(
      "a test belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }
  await lockRepositoryProject(on, projectId);
  if (!isId("ste", input.suiteId)) {
    throw new UnprocessableInputError(`"${input.suiteId}" is not a test suite id`);
  }
  const name = validName(input.name);
  const content = validContent({
    ...input,
    mockOverrides: input.mockOverrides ?? [],
  });
  const named = input.personaIds ?? [];
  validatePersonaIds(named);

  const id = newId("tst");
  const versionId = newId("tstv");

  const [suite] = await on
      .select({ id: testSuite.id })
      .from(testSuite)
      .where(
        within(
          auth,
          testSuite,
          and(
            eq(testSuite.id, input.suiteId),
            eq(testSuite.projectId, projectId),
            isNull(testSuite.deletedAt),
          ),
        ),
      )
      .limit(1)
      .for("update");
  if (suite === undefined) {
    throw new UnprocessableInputError(
      `there is no active test suite ${input.suiteId} in this project`,
    );
  }

  const personaIds = await personaIdsFor(on, auth, projectId, named);

  const [identity] = await on
      .insert(test)
      .values({
        id,
        organizationId: auth.organizationId,
        projectId,
        suiteId: suite.id,
        name,
        description: input.description ?? null,
        currentVersionId: versionId,
        revision: newId("rev"),
        createdBy: auth.userId,
      })
      .returning(COLUMNS);

  if (identity === undefined) throw new Error("the test was not written");

  await on.insert(testVersion).values({
    id: versionId,
    testId: id,
    version: 1,
    content,
    createdBy: auth.userId,
  });

  await namePersonasOn(on, versionId, personaIds);

  const written = {
    ...identity,
    personas: await personasOf(on, versionId),
  };

  return { ...written, version: 1, versionId, ...content };
}

/**
 * The personas of several versions at once, keyed by version and each list in
 * the order it was authored — one read for a whole page of tests rather than
 * one read per row.
 *
 * The `where` starts from a bare `inArray` rather than `within`: every caller
 * hands it version ids that have already come off tenancy-checked rows, so the
 * predicate cannot reach further than that check already did.
 */
async function personasOfVersions(
  on: Queryable,
  versionIds: readonly string[],
): Promise<Map<string, TestPersona[]>> {
  const byVersion = new Map<string, TestPersona[]>();
  if (versionIds.length === 0) return byVersion;

  const rows = await on
    .select({
      versionId: testPersona.testVersionId,
      id: persona.id,
      name: persona.name,
      archivedAt: persona.archivedAt,
    })
    .from(testPersona)
    .innerJoin(
      persona,
      eq(testPersona.personaId, persona.id),
    )
    .where(inArray(testPersona.testVersionId, [...versionIds]))
    .orderBy(
      asc(testPersona.testVersionId),
      asc(testPersona.position),
    );

  for (const { versionId, ...named } of rows) {
    const already = byVersion.get(versionId);
    if (already === undefined) byVersion.set(versionId, [named]);
    else already.push(named);
  }
  return byVersion;
}

/** The one version's personas, in the order they were authored. */
async function personasOf(
  on: Queryable,
  versionId: string,
): Promise<readonly TestPersona[]> {
  return (await personasOfVersions(on, [versionId])).get(versionId) ?? [];
}

/**
 * The identity row joined to its current version — the shape every read of a
 * whole test answers with, written once so two readers can never drift.
 */
function selectWithCurrentVersion(on: Queryable = db()) {
  return on
    .select({
      ...COLUMNS,
      version: testVersion.version,
      versionId: testVersion.id,
      content: testVersion.content,
    })
    .from(test)
    .innerJoin(testVersion, eq(test.currentVersionId, testVersion.id));
}

/**
 * One test with what it currently checks: its name and description, its
 * scenario, its expected behaviors, and the personas who call about it — in the
 * order they were authored, deleted ones included and marked.
 */
export async function getTest(
  auth: AuthContext,
  id: string,
): Promise<Test | undefined> {
  authorize(auth, "read", here(auth));

  return readTestOn(db(), auth, id);
}

/**
 * The test as it stands on one connection.
 *
 * **A write reads its own answer back through this, on its own
 * transaction.** `getTest` asks the pool, which is a different connection and
 * cannot see an uncommitted write — so a write that answered through it
 * would hand back the row exactly as it was a moment before, and every caller
 * would believe nothing had happened.
 */
async function readTestOn(
  on: Queryable,
  auth: AuthContext,
  id: string,
): Promise<Test | undefined> {
  const [row] = await selectWithCurrentVersion(on)
    .where(theTest(auth, id))
    .limit(1);

  if (row === undefined) return undefined;

  const { content, ...rest } = row;
  return {
    ...rest,
    ...contentFromRow(content, row.versionId),
    personas: await personasOf(on, row.versionId),
  };
}

/**
 * One door for every change, so no caller needs the version rules to pick a
 * function — the rules live here. Name and description write in place and
 * version nothing. The scenario, the expected behaviors and the personas are
 * what the test checks: any of them differing from the current version inserts
 * the next version, with its own join rows, and moves the pointer — all in one
 * transaction with the identity row locked, so two concurrent edits number one
 * after the other rather than fighting over the same version number. The rows of
 * the version being left behind are never touched, because a run that pinned it
 * must still say what it executed. Content byte-identical to the current version
 * is not an edit at all: nothing is written, not even `updated_at`, and the
 * current version comes back.
 *
 * What an edit leaves out, it keeps. A field absent from the changes is read
 * off the current version and carried into the next one, which is what lets an
 * edit to the scenario alone stay an edit to the scenario alone. Carried
 * forward is not a way past validation, though: the personas a version is about
 * to name are checked whether the edit typed them or inherited them, so no
 * version can come to name one that is missing, deleted, or another project's.
 *
 * **`expectedVersionId` is compared inside that same transaction, on the row
 * this edit has already locked**, and a mismatch refuses the whole edit with
 * `TestMovedOnError`. Where the comparison happens is the whole guarantee: a
 * caller that read the current version and then called this would have a window
 * between the two, and a second writer walks straight through it — both edits
 * would be accepted, and the later one would quietly become what the test says.
 *
 * Editing what the caller cannot see returns what reading it would have:
 * `undefined`, with nothing disturbed.
 */
export async function editTest(
  auth: AuthContext,
  id: string,
  changes: TestChanges,
): Promise<Test | undefined> {
  authorize(auth, "author_definitions", here(auth));

  // Everything answerable without the database is answered first, exactly as
  // create answers it, so an edit is refused on the same grounds a create is.
  const name = changes.name === undefined ? undefined : validName(changes.name);
  const named = changes.personaIds;
  if (named !== undefined) validatePersonaIds(named);
  return db().transaction((tx) => editTestOn(tx, auth, id, changes));
}

/** The table-owned half used by the repository transaction. */
async function editTestOn(
  on: Transaction,
  auth: AuthContext,
  id: string,
  changes: TestChanges,
): Promise<Test | undefined> {
  const name = changes.name === undefined ? undefined : validName(changes.name);
  const named = changes.personaIds;
  if (named !== undefined) validatePersonaIds(named);
  const changesContent =
    changes.scenario !== undefined ||
    changes.expectedBehaviors !== undefined ||
    changes.personaIds !== undefined ||
    changes.mockOverrides !== undefined;
  if (changesContent && changes.expectedVersionId === undefined) {
    throw new UnprocessableInputError(
      "a test content edit needs expected_version_id from the version it read",
    );
  }
  if (
    changes.expectedVersionId !== undefined &&
    !isId("tstv", changes.expectedVersionId)
  ) {
    throw new UnprocessableInputError(
      `"${changes.expectedVersionId}" is not a test version id`,
    );
  }
  if (
    changes.expectedRevision !== undefined &&
    !isId("rev", changes.expectedRevision)
  ) {
    throw new UnprocessableInputError(
      `"${changes.expectedRevision}" is not a revision id`,
    );
  }
  const [located] = await on
      .select({ projectId: test.projectId, suiteId: test.suiteId })
      .from(test)
      .where(theTest(auth, id))
      .limit(1);
  if (located === undefined) return undefined;
  await lockRepositoryProject(on, located.projectId);
  await on
      .select({ id: testSuite.id })
      .from(testSuite)
      .where(eq(testSuite.id, located.suiteId))
      .limit(1)
      .for("update");

  const [locked] = await on
      .select({ ...COLUMNS, currentVersionId: test.currentVersionId })
      .from(test)
      .where(theTest(auth, id))
      .limit(1)
      .for("update");

  if (locked === undefined) return undefined;
  const { currentVersionId, ...current } = locked;

    // Before anything is read about the content, and inside the lock. Nothing
    // has been written yet, and returning through a throw takes the transaction
    // with it, so a refused edit leaves the test exactly as it found it.
    //
    // The identity expectation goes first because it is the cheaper loss to
    // report: somebody whose rename lost a race retypes it, and telling them
    // that instead of telling them the content moved would send them looking at
    // the wrong half of their own edit.
  expectRevision(current, changes.expectedRevision);
  if (
    changes.expectedVersionId !== undefined &&
    changes.expectedVersionId !== currentVersionId
  ) {
    throw new TestMovedOnError(current, {
      expected: changes.expectedVersionId,
      current: currentVersionId,
    });
  }

    // This select and the update below are the two `where`s in this file that
    // start from a bare `eq` rather than `within`: each names an id that just
    // came off the tenancy-checked row locked above, in this same transaction,
    // so neither predicate can reach further than that check already did.
  const [currentVersion] = await on
      .select({
        id: testVersion.id,
        version: testVersion.version,
        content: testVersion.content,
      })
      .from(testVersion)
      .where(eq(testVersion.id, currentVersionId))
      .limit(1);
  if (currentVersion === undefined) {
    throw new Error("the test's current version is missing");
  }

  const storedContent = contentFromRow(currentVersion.content, currentVersion.id);
  const storedPersonas = await personasOf(on, currentVersion.id);
  const storedIds = storedPersonas.map((named) => named.id);

    // Omitted means unchanged: what the edit did not mention is read off the
    // current version, and the whole is then held to what a create is held to.
    // One path, both ways round — a set carried forward is a set this write is
    // about to name, and it is checked like any other.
    //
    // `contentFromRow` hands back what the row holds, untrimmed, because an old
    // version has to stay readable exactly as it was written; `validContent`
    // trims what it is given. Only raw SQL can make the two disagree, and when
    // one has, the next edit mints a version that trims the row and every edit
    // after it agrees.
  const content = validContent({
    scenario: changes.scenario ?? storedContent.scenario,
    expectedBehaviors:
      changes.expectedBehaviors ?? storedContent.expectedBehaviors,
    mockOverrides: changes.mockOverrides ?? storedContent.mockOverrides,
  });
  const personaIds = await personaIdsFor(
    on,
    auth,
    current.projectId,
    named ?? storedIds,
  );
  const mintsVersion =
    !sameContent(storedContent, content) ||
    !sameOrderedList(storedIds, personaIds);
  const identityChanged =
    (name !== undefined && name !== current.name) ||
    (changes.description !== undefined &&
      changes.description !== current.description);

  if (!mintsVersion && !identityChanged) {
    return {
      ...current,
      version: currentVersion.version,
      versionId: currentVersion.id,
      ...storedContent,
      personas: storedPersonas,
    };
  }

  let versionId = currentVersion.id;
  let version = currentVersion.version;
  let personas = storedPersonas;
  if (mintsVersion) {
    versionId = newId("tstv");
    version = currentVersion.version + 1;
    await on.insert(testVersion).values({
      id: versionId,
      testId: current.id,
      version,
      content,
      createdBy: auth.userId,
    });
    await namePersonasOn(on, versionId, personaIds);
    personas = await personasOf(on, versionId);
  }

  const [updated] = await on
      .update(test)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(changes.description === undefined
          ? {}
          : { description: changes.description }),
        ...(mintsVersion ? { currentVersionId: versionId } : {}),
        // **Only when the identity moved**, which is the whole worth of two
        // tokens. A version-only edit refuses a rename somebody is typing in
        // another tab if this moves for it — and a rename is not stale for a
        // scenario somebody else sharpened, because the name they read is
        // still the name. A repository copy is made stale by the version, so
        // nothing downstream needs this to move for content.
        ...(identityChanged ? { revision: newId("rev") } : {}),
        updatedAt: new Date(),
      })
      .where(eq(test.id, current.id))
      .returning(COLUMNS);

  if (updated === undefined) throw new Error("the test was not written");
  return {
    ...updated,
    version,
    versionId,
    ...content,
    personas,
  };
}

/** One authored test in a complete repository change set. */
export type RepositoryTest = NewTest & {
  readonly clientRef: string;
  readonly expectedVersionId?: string;
  readonly expectedRevision?: string;
};

export type AppliedRepositoryTest = {
  readonly clientRef: string;
  readonly test: Test;
};

/**
 * Reconcile all active tests in one project on the repository transaction.
 * The version and identity-revision pins together identify an existing test;
 * neither pin means a new test.
 * Any active server test not named by a pin refuses the whole push.
 */
export async function applyRepositoryTestsOn(
  on: Transaction,
  auth: AuthContext,
  wanted: readonly RepositoryTest[],
): Promise<readonly AppliedRepositoryTest[]> {
  const projectId = auth.projectId;
  if (projectId === undefined) {
    throw new Error(
      "a repository belongs to a project, and this credential is acting in none",
    );
  }

  const clientRefs = new Set<string>();
  const expectedIds: string[] = [];
  for (const entry of wanted) {
    if (entry.clientRef.trim() === "") {
      throw new UnprocessableInputError("client_ref must name one repository file");
    }
    if (clientRefs.has(entry.clientRef)) {
      throw new UnprocessableInputError(
        `the repository names client_ref ${JSON.stringify(entry.clientRef)} more than once`,
      );
    }
    clientRefs.add(entry.clientRef);
    const hasVersionPin = entry.expectedVersionId !== undefined;
    const hasRevisionPin = entry.expectedRevision !== undefined;
    if (hasVersionPin !== hasRevisionPin) {
      throw new UnprocessableInputError(
        "an existing repository test needs both expected_version_id and expected_revision; a new test needs neither",
      );
    }
    if (entry.expectedRevision !== undefined && !isId("rev", entry.expectedRevision)) {
      throw new UnprocessableInputError(
        `"${entry.expectedRevision}" is not a revision id`,
      );
    }
    if (entry.expectedVersionId !== undefined) {
      if (!isId("tstv", entry.expectedVersionId)) {
        throw new UnprocessableInputError(
          `"${entry.expectedVersionId}" is not a test version id`,
        );
      }
      expectedIds.push(entry.expectedVersionId);
    }
  }

  const activeTests = await on
    .select({
      id: test.id,
      suiteId: test.suiteId,
      currentVersionId: test.currentVersionId,
    })
    .from(test)
    .where(
      within(
        auth,
        test,
        and(eq(test.projectId, projectId), isNull(test.deletedAt)),
      ),
    )
    .for("update", { of: test });

  const pinned = expectedIds.length === 0
    ? []
    : await on
        .select({
          versionId: testVersion.id,
          testId: test.id,
          suiteId: test.suiteId,
        })
        .from(testVersion)
        .innerJoin(test, eq(testVersion.testId, test.id))
        .where(
          within(
            auth,
            test,
            and(
              eq(test.projectId, projectId),
              isNull(test.deletedAt),
              inArray(testVersion.id, expectedIds),
            ),
          ),
        );
  const byVersion = new Map(pinned.map((row) => [row.versionId, row] as const));
  const existingByRef = new Map<string, { id: string; suiteId: string }>();
  const namedTestIds = new Set<string>();
  for (const entry of wanted) {
    if (entry.expectedVersionId === undefined) continue;
    const found = byVersion.get(entry.expectedVersionId);
    if (found === undefined) {
      throw new UnprocessableInputError(
        `expected_version_id ${entry.expectedVersionId} does not name an active test in this project`,
      );
    }
    if (namedTestIds.has(found.testId)) {
      throw new UnprocessableInputError(
        `the repository names test ${found.testId} more than once`,
      );
    }
    if (found.suiteId !== entry.suiteId) {
      throw new UnprocessableInputError(
        `test ${found.testId} belongs to suite ${found.suiteId}; a test cannot move to suite ${entry.suiteId}`,
      );
    }
    namedTestIds.add(found.testId);
    existingByRef.set(entry.clientRef, { id: found.testId, suiteId: found.suiteId });
  }

  const unseen = activeTests.find((row) => !namedTestIds.has(row.id));
  if (unseen !== undefined) {
    throw new UnprocessableInputError(
      `the repository does not include active test ${unseen.id}; pull before pushing so no server test is deleted by inference`,
    );
  }

  const applied: AppliedRepositoryTest[] = [];
  for (const entry of wanted) {
    const existing = existingByRef.get(entry.clientRef);
    if (existing === undefined) {
      const created = await createTestOn(on, auth, entry);
      applied.push({ clientRef: entry.clientRef, test: created });
      continue;
    }
    const edited = await editTestOn(on, auth, existing.id, {
      name: entry.name,
      description: entry.description ?? null,
      scenario: entry.scenario,
      expectedBehaviors: entry.expectedBehaviors,
      personaIds: entry.personaIds ?? [],
      mockOverrides: entry.mockOverrides ?? [],
      ...(entry.expectedVersionId === undefined
        ? {}
        : { expectedVersionId: entry.expectedVersionId }),
      ...(entry.expectedRevision === undefined
        ? {}
        : { expectedRevision: entry.expectedRevision }),
    });
    if (edited === undefined) {
      throw new Error(`test ${existing.id} disappeared inside the repository transaction`);
    }
    applied.push({ clientRef: entry.clientRef, test: edited });
  }
  return applied;
}

/** The revision check, written once for the writes that make it. */
function expectRevision(
  current: { readonly id: string; readonly revision: string },
  expected: string | undefined,
): void {
  if (expected === undefined || expected === current.revision) return;
  throw new IdentityConflictError("test", current.id, {
    expected,
    current: current.revision,
  });
}

/**
 * One frozen version, by its own `tstv_` id — the read a run uses to stay
 * interpretable after the test moves on, and the read a grade row's assertion
 * key is resolved back into words through: the scenario and expected behaviors
 * as they were, and the personas the version named, by identity and in the order
 * they were authored. Which version of each of them a simulation met is the
 * run's to pin, never this row's.
 *
 * **Which graders ran is not here and is not a version's business.** A project
 * grader's scope decides where it applies, so the grading plan is resolved from
 * project graders rather than from the frozen content of a test.
 *
 * It also answers the two things about the test itself that whoever holds only a
 * version id cannot get anywhere else: what the test is called, and whether it
 * still stands here. Both come off the row this read already joins, so a caller
 * holding a version somebody committed months ago learns in one request whether
 * it is the current one and, when it is not, which test to go and look at. A
 * second fetch would answer neither for a version of a test that has since been
 * deleted.
 *
 * Deliberately no deleted filter: versions outlive their test's deletion, so a
 * run that pinned one can always say exactly what it executed.
 */
export async function getTestVersion(
  auth: AuthContext,
  versionId: string,
): Promise<TestVersion | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select({
      id: testVersion.id,
      testId: testVersion.testId,
      suiteId: test.suiteId,
      testName: test.name,
      currentVersionId: test.currentVersionId,
      version: testVersion.version,
      content: testVersion.content,
      createdAt: testVersion.createdAt,
    })
    .from(testVersion)
    .innerJoin(test, eq(testVersion.testId, test.id))
    .where(
      within(
        auth,
        test,
        and(eq(testVersion.id, versionId), inActingProject(auth)),
      ),
    )
    .limit(1);

  if (row === undefined) return undefined;

  const { content, currentVersionId, ...rest } = row;
  return {
    ...rest,
    current: currentVersionId === row.id,
    ...contentFromRow(content, row.id),
    personas: await personasOf(db(), row.id),
  };
}

/** Read only the immutable content one Simulation executes or displays. */
export async function getTestVersionExecutionContent(
  auth: AuthContext,
  versionId: string,
): Promise<TestExecutionContent | undefined> {
  authorize(auth, "read", here(auth));
  const [row] = await db()
    .select({
      id: testVersion.id,
      testId: testVersion.testId,
      suiteId: test.suiteId,
      testName: test.name,
      content: testVersion.content,
    })
    .from(testVersion)
    .innerJoin(test, eq(testVersion.testId, test.id))
    .where(
      within(
        auth,
        test,
        and(eq(testVersion.id, versionId), inActingProject(auth)),
      ),
    )
    .limit(1);
  if (row === undefined) return undefined;
  const { content, ...identity } = row;
  return { ...identity, ...contentFromRow(content, row.id) };
}

/**
 * One page of the tests the caller can reach — the acting project's, or the
 * whole customer's for a credential acting in none — and where the next page
 * starts.
 *
 * The ids are Crockford base32 of UUIDv7 under `COLLATE "C"`, so ordering by id
 * *is* ordering by mint time and the last id of a page is the whole cursor
 * — no second sort column, no offset to drift when rows arrive mid-scroll.
 * Newest first, because the test somebody is looking for is usually the one
 * they just wrote.
 */
export type TestPage = {
  readonly items: readonly Test[];
  /** Hand back as `cursor` to continue; absent on the last page. */
  readonly nextCursor: string | undefined;
};

export async function listTests(
  auth: AuthContext,
  suiteId: string,
  page?: PageRequest,
): Promise<TestPage | undefined> {
  authorize(auth, "read", here(auth));

  if (!isId("ste", suiteId)) {
    throw new UnprocessableInputError(`"${suiteId}" is not a test suite id`);
  }

  const { limit, cursor } = pageWindow(page, {
    singular: "test",
    plural: "tests",
    prefix: "tst",
  });
  const olderThanCursor = cursor === undefined ? undefined : lt(test.id, cursor);

  const [suite] = await db()
    .select({ id: testSuite.id })
    .from(testSuite)
    .where(
      within(
        auth,
        testSuite,
        and(
          eq(testSuite.id, suiteId),
          isNull(testSuite.deletedAt),
          auth.projectId === undefined
            ? undefined
            : eq(testSuite.projectId, auth.projectId),
        ),
      ),
    )
    .limit(1);
  if (suite === undefined) return undefined;

  const rows = await selectWithCurrentVersion()
    .where(
      within(
        auth,
        test,
        and(
          eq(test.suiteId, suite.id),
          notDeleted,
          inActingProject(auth),
          olderThanCursor,
        ),
      ),
    )
    .orderBy(desc(test.id))
    .limit(limit + 1);

  // A page's personas come back in one read, not one per row.
  const { items: wanted, nextCursor } = pageOf(rows, limit);
  const personasByVersion = await personasOfVersions(
    db(),
    wanted.map((row) => row.versionId),
  );
  return {
    items: wanted.map(({ content, ...rest }) => ({
      ...rest,
      ...contentFromRow(content, rest.versionId),
      personas: personasByVersion.get(rest.versionId) ?? [],
    })),
    nextCursor,
  };
}

/**
 * What each of several versions overrides, keyed by version — the read a run
 * takes before it freezes the world it will execute in.
 *
 * The content column is parsed by this file's own guard rather than by the run
 * factory, because what a version says is this file's business and a second
 * reader of the same jsonb is a second opinion about its shape.
 *
 * The `where` starts from a bare `inArray`: the caller hands it version ids
 * that have already come off tenancy-checked rows, so the predicate cannot
 * reach further than that check already did.
 *
 * Exported to the module, not from the package, exactly as the two
 * "which tests name this" reads beside it are.
 */
export async function mockOverridesOfVersions(
  on: Queryable,
  versionIds: readonly string[],
): Promise<Map<string, readonly MockOverride[]>> {
  const byVersion = new Map<string, readonly MockOverride[]>();
  if (versionIds.length === 0) return byVersion;

  const rows = await on
    .select({ id: testVersion.id, content: testVersion.content })
    .from(testVersion)
    .where(inArray(testVersion.id, [...versionIds]));

  for (const row of rows) {
    byVersion.set(row.id, contentFromRow(row.content, row.id).mockOverrides);
  }
  return byVersion;
}

/** Permanently remove a test from authoring while retaining its evidence. */
export async function deleteTest(
  auth: AuthContext,
  id: string,
): Promise<boolean> {
  authorize(auth, "author_definitions", here(auth));
  const projectId = auth.projectId;
  if (projectId === undefined) {
    throw new Error("deleting a test happens inside its project");
  }

  const deletedAt = new Date();
  return db().transaction(async (tx) => {
    await lockRepositoryProject(tx, projectId);
    const [located] = await tx
      .select({ suiteId: test.suiteId })
      .from(test)
      .where(theTest(auth, id))
      .limit(1);
    if (located === undefined) return false;
    await tx
      .select({ id: testSuite.id })
      .from(testSuite)
      .where(eq(testSuite.id, located.suiteId))
      .limit(1)
      .for("update");

    const [locked] = await tx
      .select({ id: test.id })
      .from(test)
      .where(theTest(auth, id))
      .limit(1)
      .for("update");
    if (locked === undefined) return false;

    await tx
      .update(test)
      .set({
        deletedAt,
        revision: newId("rev"),
        updatedAt: deletedAt,
      })
      .where(eq(test.id, locked.id));
    return true;
  });
}

/**
 * Every version of one test, newest first — the history a detail page shows,
 * and the list an older-version read is chosen from.
 *
 * Deliberately no lifecycle filter on the test: a deleted test's history is
 * exactly as readable as an active one's, because a run that pinned one of
 * these versions is still on the record and still has to be interpretable.
 */
export async function listTestVersions(
  auth: AuthContext,
  testId: string,
  page?: PageRequest,
): Promise<TestVersionPage | undefined> {
  authorize(auth, "read", here(auth));

  const { limit, cursor } = pageWindow(page, {
    singular: "test version",
    plural: "test versions",
    prefix: "tstv",
  });

  const [found] = await db()
    .select({
      id: test.id,
      suiteId: test.suiteId,
      name: test.name,
      currentVersionId: test.currentVersionId,
    })
    .from(test)
    .where(anyTest(auth, testId))
    .limit(1);

  // Told apart from a test with no history, which cannot exist: a test always
  // has a version 1, so an empty page would only ever mean the test is not
  // there — and saying so is what lets a page show a not-found rather than an
  // empty history.
  if (found === undefined) return undefined;

  const rows = await db()
    .select({
      id: testVersion.id,
      testId: testVersion.testId,
      version: testVersion.version,
      content: testVersion.content,
      createdAt: testVersion.createdAt,
    })
    .from(testVersion)
    .where(
      and(
        eq(testVersion.testId, found.id),
        cursor === undefined ? undefined : lt(testVersion.id, cursor),
      ),
    )
    .orderBy(desc(testVersion.id))
    .limit(limit + 1);

  const { items, nextCursor } = pageOf(rows, limit);
  const versionIds = items.map((row) => row.id);
  const personasByVersion = await personasOfVersions(db(), versionIds);

  return {
    items: items.map(({ content, ...row }) => ({
      ...row,
      suiteId: found.suiteId,
      testName: found.name,
      current: row.id === found.currentVersionId,
      ...contentFromRow(content, row.id),
      personas: personasByVersion.get(row.id) ?? [],
    })),
    nextCursor,
  };
}

export type TestVersionPage = {
  readonly items: readonly TestVersion[];
  readonly nextCursor: string | undefined;
};

/**
 * The live tests whose current version names this persona — the set that
 * refuses the persona's own delete, and the set that refusal names.
 *
 * Current versions of live tests, and nothing else. A historical version names
 * who it named for as long as it is kept, because a run that pinned it has to
 * stay readable, and no delete taken today can change what that run executed; a
 * deleted test has no simulation left to lose. So neither is a reason to keep a
 * persona somebody wants gone, and neither appears here.
 *
 * The walk starts from the join table, where `persona_id` is indexed for
 * exactly this question, and keeps the rows a live test currently points at.
 *
 * The project is required. An Egma-provided persona can be named by tests in every
 * customer, so the persona id alone is not a boundary. The customer predicate
 * comes from the caller's context and the project is the one whose usage or
 * deletion is being decided. A Custom persona reaches the same set it did
 * before; the explicit scope stops a shared id from joining unrelated tests.
 *
 * Exported to the module, not from the package: this answers a question the
 * persona factory has to ask before it deletes, and the test tables have one
 * owner, which is this file.
 */
export async function liveTestsNamingPersona(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  personaId: string,
): Promise<readonly TestNamingPersona[]> {
  return on
    .select({ id: test.id, name: test.name })
    .from(testPersona)
    .innerJoin(
      test,
      eq(test.currentVersionId, testPersona.testVersionId),
    )
    .where(
      within(
        auth,
        test,
        and(
          eq(test.projectId, projectId),
          eq(testPersona.personaId, personaId),
          notDeleted,
        ),
      ),
    )
    .orderBy(asc(test.id));
}

/*
 * **There is no companion asking which tests name a grader.** There was one, and
 * it refused a grader's delete while a live test's current version pointed at
 * it. A test names no graders now. Which tests a grader covers is a selector in
 * the project grader's scope, resolved from that side without a test-to-grader
 * junction.
 *
 * The persona question above stands untouched, because a persona is still named
 * by test content and losing one really would empty a test of somebody who calls
 * about it.
 */
