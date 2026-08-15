import { isId, newId } from "@egma/ids";
import { and, asc, desc, eq, inArray, isNull, lt, type SQL } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { persona } from "../schema/personas.ts";
import { project } from "../schema/tenancy.ts";
import { test, testPersona, testVersion } from "../schema/tests.ts";
import type { MockToolAnswer } from "../mock-tools/resolve.ts";
import type { AuthContext } from "./context.ts";
import {
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
import { authorize, here } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { theProject, within } from "./within.ts";

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
 * non-empty at write time, and judging a simulation against them is part of
 * what running a test means, so there is no window in which a stored test could
 * pass without ever having been able to fail.
 *
 * **A test names no graders.** What judges a simulation is the project's
 * running copies and their scope, decided grader-side and never through test
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
 * Each sentence is one **assertion** of the expected-behaviors grader, judged in
 * isolation and written one verdict row each, keyed by its position in this
 * list.
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
 * saying plainly whether they have since been deleted. A read that hid that
 * would show a test whose simulations cannot all run and give no sign.
 */
export type TestPersona = {
  readonly id: string;
  readonly name: string;
  /** Set once they are deleted; the test goes on naming them either way. */
  readonly deletedAt: Date | null;
};

export type Test = {
  readonly id: string;
  readonly projectId: string;
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
   * Left out, nothing is compared — which is only ever right for a writer that
   * is the sole writer, such as a migration or a development script. Anything
   * serving more than one names it, and the public route requires it.
   */
  readonly expectedVersionId?: string;
};

/** One version, frozen: the test exactly as some simulation executed it. */
export type TestVersion = {
  readonly id: string;
  readonly testId: string;
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

const notDeleted: SQL = isNull(test.deletedAt);

/** An answer's columns, and no more — the tenant-free view. */
const COLUMNS = {
  id: test.id,
  projectId: test.projectId,
  name: test.name,
  description: test.description,
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
 * Everything about the named ids that is answerable without the database: every
 * one is an identifier of a persona, and each one is named once. Naming the
 * same persona twice would ask for the same simulation twice, which is a run's
 * business and not a test's, so it is refused here rather than left to a
 * constraint.
 */
function validatePersonaIds(ids: readonly string[]): void {
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
      `version ${versionId} holds content in a shape egma never writes; the row needs repairing before anybody can read it`,
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
 * because the reason order matters here is its own: a verdict row is keyed by a
 * behavior's **position**, so moving a sentence rekeys every row about it, and
 * minting a version is what keeps the old rows readable.
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

/** The named test, alive, within the caller's tenancy and scope. */
function theTest(auth: AuthContext, id: string): SQL {
  return within(auth, test, and(eq(test.id, id), notDeleted, inActingProject(auth)));
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
        .select({ id: persona.id, deletedAt: persona.deletedAt })
        .from(persona)
        .where(
          within(
            auth,
            persona,
            and(
              inArray(persona.id, [...ids]),
              eq(persona.projectId, projectId),
            ),
          ),
        )
        .for("share")
    ).map((row) => [row.id, row.deletedAt] as const),
  );

  for (const id of ids) {
    if (!found.has(id)) {
      throw new UnprocessableInputError(
        `there is no persona ${id} in this project`,
      );
    }
    if (found.get(id) !== null) {
      throw new UnprocessableInputError(
        `persona ${id} is deleted, and a test cannot name a deleted persona`,
      );
    }
  }
}

/**
 * The one persona the project points at, for a write that named none.
 *
 * The pointer can be wrong in two different ways and they need different words,
 * because they need different fixes. A pointer at a persona who has since been
 * deleted wants a living one; a pointer at nothing, or at another project's
 * persona — which the column's plain foreign key allows — wants pointing
 * somewhere real. Reading the row without the deleted filter is what lets the
 * two be told apart, instead of reporting every reachable failure as a
 * deletion.
 *
 * **Every way this fails is the instance's fault rather than the writer's**, and
 * these stay plain errors for that reason. Signup seeds a project's persona and
 * points the project at them in the same transaction that makes the project, so
 * a project pointing at nobody is a project something else broke — and a write
 * answered as though the body were at fault would send the writer looking at
 * their own file for a problem that is not in it.
 *
 * Every way this fails says what to do about it and writes nothing: a test
 * whose persona egma picked for itself would be a test nobody authored.
 */
async function projectDefaultPersona(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
): Promise<string> {
  const [row] = await on
    .select({ defaultPersonaId: project.defaultPersonaId })
    .from(project)
    .where(theProject(auth, projectId))
    .limit(1);

  const id = row?.defaultPersonaId ?? null;
  if (id === null) {
    throw new Error(
      "this test names no persona and the project has no default persona; name one on the test, or set the project's default",
    );
  }

  // The shared lock a named persona is read under, for the same reason and on
  // the same terms: the pointer resolves to a persona this write is about to
  // name, so a delete of that row must either land before this read and refuse
  // the write, or wait behind it and be refused itself. A default resolved
  // without the lock would be the one way past the rule.
  const [pointed] = await on
    .select({ id: persona.id, deletedAt: persona.deletedAt })
    .from(persona)
    .where(
      within(
        auth,
        persona,
        and(
          eq(persona.id, id),
          eq(persona.projectId, projectId),
        ),
      ),
    )
    .limit(1)
    .for("share");

  if (pointed === undefined) {
    throw new Error(
      `this test names no persona and the project's default points at ${id}, and there is no persona ${id} in this project; name one on the test, or point the project's default at a living persona of this project`,
    );
  }
  if (pointed.deletedAt !== null) {
    throw new Error(
      `this test names no persona and the project's default persona ${id} is deleted; name one on the test, or point the project's default at a living persona`,
    );
  }

  return id;
}

/**
 * Which personas a write should name, from what it was handed.
 *
 * One function for both write verbs, so the two can never come to disagree
 * about the same input. Naming none — an empty list — takes the project's
 * default on a create and on an edit alike; a developer who learns the meaning
 * once has learned it everywhere. Naming some checks them, and the ids come
 * back in the order they were given, because that order is content.
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
    return [await projectDefaultPersona(on, auth, projectId)];
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

/**
 * The test, its first version and the version's personas, or none of them. The
 * identity row goes in first naming a version that does not exist yet — its
 * pointer's constraint is deferred, so Postgres checks it at commit — and
 * anything that fails on the way out takes the whole write with it.
 *
 * The set is resolved inside the transaction, so what was checked is what the
 * join rows name.
 */
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

  const id = newId("tst");
  const versionId = newId("tstv");

  const written = await db().transaction(async (tx) => {
    const personaIds = await personaIdsFor(tx, auth, projectId, named);

    const [identity] = await tx
      .insert(test)
      .values({
        id,
        organizationId: auth.organizationId,
        projectId,
        name,
        description: input.description ?? null,
        currentVersionId: versionId,
        createdBy: auth.userId,
      })
      .returning(COLUMNS);

    if (identity === undefined) throw new Error("the test was not written");

    await tx.insert(testVersion).values({
      id: versionId,
      testId: id,
      version: 1,
      content,
      createdBy: auth.userId,
    });

    await namePersonasOn(tx, versionId, personaIds);

    // Read back inside the transaction, so what the create answers with is what
    // the transaction wrote and checked, rather than whatever the table holds
    // by the time it has committed.
    return { ...identity, personas: await personasOf(tx, versionId) };
  });

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
      deletedAt: persona.deletedAt,
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
function selectWithCurrentVersion() {
  return db()
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

  const [row] = await selectWithCurrentVersion()
    .where(theTest(auth, id))
    .limit(1);

  if (row === undefined) return undefined;

  const { content, ...rest } = row;
  return {
    ...rest,
    ...contentFromRow(content, row.versionId),
    personas: await personasOf(db(), row.versionId),
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

  return db().transaction(async (tx) => {
    const [locked] = await tx
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
    const [currentVersion] = await tx
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
    const storedPersonas = await personasOf(tx, currentVersion.id);
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
      tx,
      auth,
      current.projectId,
      named ?? storedIds,
    );
    const mintsVersion =
      !sameContent(storedContent, content) ||
      !sameOrderedList(storedIds, personaIds);
    const identityChanged =
      changes.name !== undefined || changes.description !== undefined;

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
      await tx.insert(testVersion).values({
        id: versionId,
        testId: current.id,
        version,
        content,
        createdBy: auth.userId,
      });
      await namePersonasOn(tx, versionId, personaIds);
      // Read back inside the transaction, for the reason create reads back
      // inside it: the answer is what this transaction wrote and checked.
      personas = await personasOf(tx, versionId);
    }

    const [updated] = await tx
      .update(test)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(changes.description === undefined
          ? {}
          : { description: changes.description }),
        ...(mintsVersion ? { currentVersionId: versionId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(test.id, current.id))
      .returning(COLUMNS);

    if (updated === undefined) throw new Error("the test was not written");
    return { ...updated, version, versionId, ...content, personas };
  });
}

/**
 * One frozen version, by its own `tstv_` id — the read a run uses to stay
 * interpretable after the test moves on, and the read a verdict row's assertion
 * key is resolved back into words through: the scenario and expected behaviors
 * as they were, and the personas the version named, by identity and in the order
 * they were authored. Which version of each of them a simulation met is the
 * run's to pin, never this row's.
 *
 * **Which graders judged is not here and never was a version's business again.**
 * A running copy's scope decides where it applies, so what judged a conversation
 * is answered from the copies rather than from the frozen content of a test.
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
  page?: PageRequest,
): Promise<TestPage> {
  authorize(auth, "read", here(auth));

  const { limit, cursor } = pageWindow(page, {
    singular: "test",
    plural: "tests",
    prefix: "tst",
  });
  const olderThanCursor = cursor === undefined ? undefined : lt(test.id, cursor);

  const rows = await selectWithCurrentVersion()
    .where(
      within(
        auth,
        test,
        and(notDeleted, inActingProject(auth), olderThanCursor),
      ),
    )
    .orderBy(desc(test.id))
    .limit(limit + 1);

  // A page's personas come back in one read, not one per row: a page of two
  // hundred tests is two queries, the same as a page of one.
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
 * A new test whose version 1 carries the source's current content: the same
 * scenario, the same expected behaviors and the same personas in the same
 * order, under the same name — there is no per-project name uniqueness, so the
 * name copies verbatim exactly as the persona factory copies it.
 *
 * A clone is a create with the retyping saved: fresh `tst_` and `tstv_` ids,
 * version numbering starting over at 1, and no link back — the source's history
 * is the source's, and nothing of it comes along. The source is read through
 * the same seam as `getTest`, so a clone can only be taken of what the caller
 * could have fetched: same customer, same acting project, not deleted.
 *
 * The personas are handed on exactly as the source names them, and `createTest`
 * is the only thing that judges them — one rule about what a version may name,
 * in one place. So a source whose current version names a deleted persona is
 * refused by that same validation, rather than quietly cloned without them or
 * quietly given the project's default; neither silence would be a copy, and a
 * clone that checked something the source does not is worse than no clone. That
 * refusal is out of reach in practice: a persona's delete is refused while a
 * live test's current version names them, and a test that cannot be fetched
 * cannot be cloned.
 *
 * Authorization is layered on purpose, not by accident of delegation. The
 * leading check refuses a viewer before anything is read, and a credential
 * acting in no project is refused right after it, still before the read — the
 * same stance as create and delete, and it keeps `undefined` meaning invisible
 * rather than refused.
 */
export async function cloneTest(
  auth: AuthContext,
  id: string,
): Promise<Test | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "a clone lands in the acting project, and this credential is for the whole organization and acting in none",
    );
  }

  const source = await getTest(auth, id);
  if (source === undefined) return undefined;

  return createTest(auth, {
    name: source.name,
    description: source.description ?? undefined,
    scenario: source.scenario,
    expectedBehaviors: source.expectedBehaviors,
    personaIds: source.personas.map((named) => named.id),
    mockOverrides: source.mockOverrides,
  });
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

export type DeletedTest = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly deletedAt: Date;
};

/**
 * The soft-delete marker, and only the marker. The test vanishes from lists and
 * fetches at once; the version rows stay exactly where they are, because a run
 * that pinned one must stay interpretable for as long as the run itself is
 * kept. Sweeping orphaned versions is the deletion worker's job, not this
 * function's.
 *
 * Nothing blocks this, ever. A persona's delete is the one that can be refused,
 * because a live test's current version naming them would silently lose one of
 * the people who call about it; a test has no dependant of its own that could
 * lose anything that way. A suite selects tests and a run executes them, and
 * neither is a reason to keep a test somebody has abandoned, because both keep
 * what they need by pinning versions that outlive it.
 *
 * Like create, this refuses a credential acting in no project. An edit lands on
 * a row that already names its own project; a delete decides the test should
 * stop appearing in one, and emptying a project is an act taken from inside it
 * — the persona factory's stance, held here.
 */
export async function deleteTest(
  auth: AuthContext,
  id: string,
): Promise<DeletedTest | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "deleting a test happens inside its project, and this credential is for the whole organization and acting in none",
    );
  }

  const deletedAt = new Date();
  const [row] = await db()
    .update(test)
    .set({ deletedAt, updatedAt: deletedAt })
    .where(theTest(auth, id))
    .returning({
      id: test.id,
      projectId: test.projectId,
      name: test.name,
    });

  if (row === undefined) return undefined;
  return { ...row, deletedAt };
}

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
 * No tenancy predicate, deliberately, and this is the one read in the file
 * without one. Whether the delete is refused is a fact about the persona rather
 * than about who is asking, and a refusal that depended on the asker would let
 * one credential delete what another credential's test needs. The persona's own
 * delete has checked its tenancy on that row before asking this, and a version
 * may only ever name a persona of its own project, so every row this can return
 * is a test of that same project.
 *
 * Exported to the module, not from the package: this answers a question the
 * persona factory has to ask before it deletes, and the test tables have one
 * owner, which is this file.
 */
export async function liveTestsNamingPersona(
  on: Queryable,
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
      and(
        eq(testPersona.personaId, personaId),
        notDeleted,
      ),
    )
    .orderBy(asc(test.id));
}

/**
 * **There is no companion asking which tests name a grader.** There was one, and
 * it refused a grader's delete while a live test's current version pointed at
 * it. A test names no graders now, so nothing here can stand in a delete's way:
 * switching a running copy off is a decision about the project, made once,
 * without hunting for the tests that would quietly stop checking something.
 *
 * The persona question above stands untouched, because a persona is still named
 * by test content and losing one really would empty a test of somebody who calls
 * about it.
 */
