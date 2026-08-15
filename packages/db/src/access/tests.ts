import { isId, newId } from "@egma/ids";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  type SQL,
} from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { agent } from "../schema/agents.ts";
import { grader, PRIORITIES, type Priority } from "../schema/graders.ts";
import { persona } from "../schema/personas.ts";
import { project } from "../schema/tenancy.ts";
import {
  test,
  testAgent,
  testGrader,
  testPersona,
  testVersion,
} from "../schema/tests.ts";
import type { MockToolAnswer } from "../mock-tools/resolve.ts";
import { admittedCapabilities } from "./capabilities.ts";
import type { AuthContext } from "./context.ts";
import {
  ApplicabilityConflictError,
  IdentityConflictError,
  ProjectOutsideOrganizationError,
  TestAgentRefusedError,
  TestDependencyInactiveError,
  TestMovedOnError,
  UnprocessableInputError,
  type ArchivedDependency,
  type TestNamingGrader,
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
 */

/**
 * One statement about what should happen, and how much it matters. P0 blocks,
 * P1 warns, P2 informs — the same three words a grader carries, because "how
 * much does this matter" is one question whether it is asked of authored logic
 * or of a sentence somebody wrote down.
 */
export type ExpectedBehavior = {
  readonly behavior: string;
  readonly priority: Priority;
};

/**
 * A behavior as it is written down. A bare string is the common case and means
 * a P0: what a developer types when they are stating what the agent must do,
 * which is nearly always the thing that must not ship broken.
 */
export type ExpectedBehaviorInput =
  | string
  | {
      readonly behavior: string;
      readonly priority?: Priority | undefined;
    };

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
  /**
   * What this scenario needs a connection to be able to do before running it
   * means anything — DTMF entry, barge-in, raw audio.
   *
   * **Never a connection, and never a claim about one.** A capability is a
   * measured fact about a target; this is what the test requires, and where the
   * two disagree the simulation is skipped with a reason rather than failed. It
   * is version content because a requirement added today would otherwise change
   * what a run last week is understood to have executed.
   */
  readonly requiredCapabilities: readonly string[];
};

export type NewTest = {
  readonly name: string;
  readonly description?: string | undefined;
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehaviorInput[];
  /**
   * Which agents this test applies to — the targets a run may execute it
   * against. Every one has to be an active agent of the same project.
   *
   * **Naming none takes every active agent in the project**, which is the
   * meaning the applicable-agent relation arrived with: it is what the upgrade
   * did to every installed test, for the reason it did it there — a test that
   * applied to any agent of its project before must go on applying to them, and
   * choosing one of them without evidence would be egma authoring somebody's
   * coverage. A project with no active agent has nothing honest to link, and the
   * create is refused rather than left targetless.
   *
   * A browser create names them explicitly; the sentence above is what a
   * repository push and a script get.
   */
  readonly agentIds?: readonly string[] | undefined;
  /**
   * What a connection has to be able to do for this test to mean anything.
   * Naming none is the ordinary case and means the test runs anywhere.
   */
  readonly requiredCapabilities?: readonly string[] | undefined;
  /**
   * Who calls about the scenario. Naming none — absent, or an empty list —
   * takes the project's default persona, so authoring a first test never waits
   * on authoring a persona.
   */
  readonly personaIds?: readonly string[] | undefined;
  /**
   * The graders this scenario asks for on top of the project's own, in the
   * order they were authored. Naming none is the ordinary case and means
   * exactly that: every grader in the project already judges this test, and its
   * expected behaviors are judged whatever else happens.
   */
  readonly graderIds?: readonly string[] | undefined;
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

/**
 * A grader as a test names it: by identity, with its current name, and saying
 * plainly whether it has since been deleted — the persona's shape, for the
 * persona's reason. A live test can never reach this state, because a grader's
 * delete is refused while one names it; a frozen version can, and a reader of
 * one has to be told.
 */
export type TestGrader = {
  readonly id: string;
  readonly name: string;
  /** Set once it is deleted; the version goes on naming it either way. */
  readonly deletedAt: Date | null;
};

/**
 * An agent a test applies to: by identity, with its current name, and saying
 * plainly whether it has since been archived.
 *
 * **An archived agent keeps its link and is shown keeping it.** A read that hid
 * it would show a test with fewer targets than it has and give no sign; a read
 * that dropped it would make Archive quietly rewrite somebody's coverage. A
 * test all of whose linked agents are archived is active and unavailable, and
 * that is a state a page has to be able to render.
 */
export type TestAgent = {
  readonly id: string;
  readonly name: string;
  /** Set once it is archived; the test goes on applying to it either way. */
  readonly archivedAt: Date | null;
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
  /** In the order they were authored. */
  readonly graders: readonly TestGrader[];
  /** The tools this scenario answers for itself; usually none. */
  readonly mockOverrides: readonly MockOverride[];
  /** What a connection has to be able to do; usually nothing. */
  readonly requiredCapabilities: readonly string[];
  /** The agents this test applies to, oldest link first. */
  readonly agents: readonly TestAgent[];
  /**
   * The opaque token an identity write or a lifecycle change has to name. It
   * changes on every one of them and means nothing on its own.
   */
  readonly revision: string;
  /**
   * The opaque token a link edit has to name. It moves only when the applicable
   * agents move, so a rename and a link edit can never refuse each other.
   */
  readonly applicabilityRevision: string;
  /** When it was archived, or null while it is active. */
  readonly archivedAt: Date | null;
  /** Why, when an upgrade archived it rather than a person. */
  readonly archiveReason: string | null;
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
  readonly expectedBehaviors?: readonly ExpectedBehaviorInput[];
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
   * The graders the next version should name, in the order it should name them.
   *
   * An empty list means here what it means on a create — name none — because
   * naming none is a state a test can be in and stay falsifiable: the project's
   * graders and its own expected behaviors judge it either way. So `[]` clears
   * the array, and leaving the field out keeps it.
   */
  readonly graderIds?: readonly string[];
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
   * What a connection has to be able to do for the next version to mean
   * anything. An empty list means require nothing, which is the state most
   * tests are in; leaving the field out keeps whatever the current version
   * requires.
   */
  readonly requiredCapabilities?: readonly string[];
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
  /** By identity, in the order they were authored. */
  readonly graders: readonly TestGrader[];
  /** The tools this version answers for itself, as it was frozen. */
  readonly mockOverrides: readonly MockOverride[];
  /** What this version required of a connection, as it was frozen. */
  readonly requiredCapabilities: readonly string[];
  readonly createdAt: Date;
};

const notArchived: SQL = isNull(test.archivedAt);

/** An answer's columns, and no more — the tenant-free view. */
const COLUMNS = {
  id: test.id,
  projectId: test.projectId,
  name: test.name,
  description: test.description,
  revision: test.revision,
  applicabilityRevision: test.applicabilityRevision,
  archivedAt: test.archivedAt,
  archiveReason: test.archiveReason,
  createdAt: test.createdAt,
  updatedAt: test.updatedAt,
} as const;

/**
 * What a behavior is worth when its author said nothing about it. Blocking, so
 * that stating what the agent must do is enough to make a test able to stop a
 * release — nobody has to learn about priorities to write a falsifiable test.
 */
const DEFAULT_BEHAVIOR_PRIORITY: Priority = "P0";

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
 * could never be red is the false confidence this product exists to kill.
 *
 * **A test always keeps at least one P0.** Priorities let a nice-to-have
 * behavior stop blocking a release, which is what they are for; a test whose
 * every behavior has been demoted is one nothing can hold back, and it got there
 * one edit at a time without anybody deciding to make it unfalsifiable. So the
 * rule that refuses an empty list refuses an all-demoted one on the same
 * grounds: falsifiability cannot be downgraded away.
 */
function validContent(input: {
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehaviorInput[];
  readonly mockOverrides: readonly MockOverrideInput[];
  readonly requiredCapabilities: readonly string[];
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
  const expectedBehaviors = input.expectedBehaviors.map((entry) => {
    const written = typeof entry === "string" ? entry : entry.behavior;
    const behavior = typeof written === "string" ? written.trim() : "";
    if (behavior === "") {
      throw new UnprocessableInputError(
        "an expected behavior needs to say something",
      );
    }
    const priority =
      typeof entry === "string" ? undefined : entry.priority;
    if (priority !== undefined && !PRIORITIES.includes(priority)) {
      throw new UnprocessableInputError(
        `"${priority}" is not a priority egma knows; expected one of ${PRIORITIES.join(", ")}`,
      );
    }
    return { behavior, priority: priority ?? DEFAULT_BEHAVIOR_PRIORITY };
  });

  if (!expectedBehaviors.some((behavior) => behavior.priority === "P0")) {
    throw new UnprocessableInputError(
      "a test needs at least one P0 expected behavior, because falsifiability cannot be downgraded away",
    );
  }

  return {
    scenario,
    expectedBehaviors,
    mockOverrides: validOverrides(input.mockOverrides),
    // The catalog's own door, and the only one. Every set a version is about to
    // hold comes through it — including the one an edit carried forward — so no
    // stored version can name a capability no connection could ever be measured
    // for.
    requiredCapabilities: admittedCapabilities(input.requiredCapabilities),
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
 * The same, for the graders a version names: every one is a grader's
 * identifier, and each one is named once. Naming the same grader twice would
 * ask for the same judgment twice, which produces one verdict either way, so
 * the second naming says nothing and is refused rather than silently collapsed.
 */
function validateGraderIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isId("grd", id)) {
      throw new Error(`"${id}" is not a grader id`);
    }
    if (seen.has(id)) {
      throw new Error(`grader ${id} is named twice on one test`);
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
 * **A behavior stored as a bare string is a P0.** Every version written before
 * priorities existed holds one, and each says what the whole list used to say —
 * this must fail, and everything on it blocks. Reading them as P0 is therefore
 * not a default applied to old rows but the meaning they already had, which is
 * what lets priorities arrive as an additive change with no rewrite.
 */
function contentFromRow(value: unknown, versionId: string): TestContent {
  const malformed = () =>
    new Error(
      `version ${versionId} holds content in a shape egma never writes; the row needs repairing before anybody can read it`,
    );

  if (typeof value !== "object" || value === null) throw malformed();
  const { scenario, expectedBehaviors, mockOverrides, requiredCapabilities } =
    value as Record<string, unknown>;
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
  // Absent on every version written before a test could require a capability,
  // and absent means what it meant then: this test requires nothing and runs
  // anywhere. Reading it as an empty list is the meaning those rows already
  // had, which is what lets the field arrive as an additive change with no
  // rewrite. The keys themselves are taken on trust once they are strings, as
  // a persona's voice provider is: the catalog may grow, and an old version has
  // to stay readable however it grows.
  if (requiredCapabilities !== undefined && !Array.isArray(requiredCapabilities)) {
    throw malformed();
  }

  return {
    requiredCapabilities: (requiredCapabilities ?? []).map(
      (entry: unknown): string => {
        if (typeof entry !== "string" || entry.trim() === "") throw malformed();
        return entry;
      },
    ),
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
        return { behavior: entry, priority: DEFAULT_BEHAVIOR_PRIORITY };
      }
      if (typeof entry !== "object" || entry === null) throw malformed();
      const { behavior, priority } = entry as Record<string, unknown>;
      if (typeof behavior !== "string" || behavior.trim() === "") {
        throw malformed();
      }
      // The word itself is taken on trust once it is a string, exactly as a
      // persona's voice provider is: the roster may grow, and an old version
      // has to stay readable however it grows.
      if (typeof priority !== "string" || priority === "") throw malformed();
      return { behavior, priority: priority as Priority };
    }),
  };
}

/**
 * Two ordered lists of strings, compared as written. Order is content
 * everywhere this is asked: the personas and the graders are named in the order
 * they were authored, so a version that reorders either says something the
 * version before it did not.
 */
function sameOrderedList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * The behaviors, compared as written: the same statements, in the same order,
 * each at the same priority. Demoting one from P0 to P1 changes what the test
 * can hold back, so it is an edit and mints a version like any other.
 */
function sameBehaviors(
  a: readonly ExpectedBehavior[],
  b: readonly ExpectedBehavior[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, index) =>
        entry.behavior === b[index]?.behavior &&
        entry.priority === b[index]?.priority,
    )
  );
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
 * The jsonb content is all this table covers. The personas and the graders a
 * version names are content too and version on exactly the same terms, but they
 * are rows rather than fields, so they are compared beside this rather than
 * inside it — `editTest` asks all three questions and mints on any answer.
 */
const sameContentField: {
  readonly [K in keyof TestContent]: (a: TestContent, b: TestContent) => boolean;
} = {
  scenario: (a, b) => a.scenario === b.scenario,
  expectedBehaviors: (a, b) =>
    sameBehaviors(a.expectedBehaviors, b.expectedBehaviors),
  mockOverrides: (a, b) => sameOverrides(a.mockOverrides, b.mockOverrides),
  // Order is content here too, and deliberately: `admittedCapabilities` answers
  // the keys in the order they were written, so two authors who chose the same
  // two capabilities in different orders wrote two different versions. One
  // extra version costs nothing; the opposite mistake loses an edit.
  requiredCapabilities: (a, b) =>
    sameOrderedList(a.requiredCapabilities, b.requiredCapabilities),
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
 * The named test, within the caller's tenancy and scope, **whatever its
 * lifecycle state**.
 *
 * Archive takes a test out of the lists somebody authors from and out of every
 * new run; it does not take it out of the product. A detail page has to render
 * an archived test — that is where Restore is — and Restore itself has to find
 * one. A predicate that filtered them out here would make an archived test
 * unreachable by the one operation that exists to bring it back. The reads that
 * must not see one say so themselves.
 */
function theTest(auth: AuthContext, id: string): SQL {
  return within(auth, test, and(eq(test.id, id), inActingProject(auth)));
}

/**
 * The agents several tests apply to at once, keyed by test and each list oldest
 * link first — one read for a whole page rather than one read per row.
 *
 * The `where` starts from a bare `inArray` rather than `within`: every caller
 * hands it test ids that have already come off tenancy-checked rows, so the
 * predicate cannot reach further than that check already did.
 */
async function agentsOfTests(
  on: Queryable,
  testIds: readonly string[],
): Promise<Map<string, TestAgent[]>> {
  const byTest = new Map<string, TestAgent[]>();
  if (testIds.length === 0) return byTest;

  const rows = await on
    .select({
      testId: testAgent.testId,
      id: agent.id,
      name: agent.name,
      archivedAt: agent.archivedAt,
      linkedAt: testAgent.createdAt,
    })
    .from(testAgent)
    .innerJoin(agent, eq(testAgent.agentId, agent.id))
    .where(inArray(testAgent.testId, [...testIds]))
    .orderBy(asc(testAgent.testId), asc(testAgent.createdAt), asc(agent.id));

  for (const { testId, linkedAt: _linkedAt, ...applies } of rows) {
    const already = byTest.get(testId);
    if (already === undefined) byTest.set(testId, [applies]);
    else already.push(applies);
  }
  return byTest;
}

/** The one test's applicable agents, oldest link first. */
async function agentsOf(
  on: Queryable,
  testId: string,
): Promise<readonly TestAgent[]> {
  return (await agentsOfTests(on, [testId])).get(testId) ?? [];
}

/**
 * The ids a link write names, checked against what this project can offer:
 * every one is an active agent of this project, and each is named once.
 *
 * **An archived agent is refused a new link and keeps every link it has.** The
 * two are the same rule seen from two sides — Archive says "stop starting new
 * work here", and it would say nothing at all if a link written afterwards
 * could reach it. Removing the links it already has would be the opposite
 * mistake: it would rewrite somebody's coverage as a side effect of tidying up,
 * and the test would silently lose a target it was authored for.
 *
 * The read takes a shared lock on every row it finds and holds it to commit, on
 * the terms a persona is named under: an Archive of one of these agents either
 * lands before this read and refuses the link, or waits behind it and archives
 * an agent this test now applies to — which is a state the product allows and
 * says out loud.
 */
async function validateNamedAgents(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;

  const found = new Map(
    (
      await on
        .select({ id: agent.id, archivedAt: agent.archivedAt })
        .from(agent)
        .where(
          within(
            auth,
            agent,
            and(inArray(agent.id, [...ids]), eq(agent.projectId, projectId)),
          ),
        )
        .for("share")
    ).map((row) => [row.id, row.archivedAt] as const),
  );

  for (const id of ids) {
    // An agent of another customer or another project is refused in the same
    // words as one that never existed: confirming that somebody else's row is
    // there is itself a leak.
    if (!found.has(id) || found.get(id) !== null) {
      throw new TestAgentRefusedError(
        "agent_not_available",
        `Agent ${id} is not active in this project. Choose an active agent ` +
          `from this project's Agents page.`,
        { agentId: id },
      );
    }
  }
}

/**
 * Everything about the named agent ids that is answerable without the database:
 * every one is an agent's identifier, and each one is named once. Naming the
 * same agent twice asks for one link twice, which the primary key would refuse
 * in the database's words rather than in egma's.
 */
function validateAgentIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isId("agt", id)) {
      throw new UnprocessableInputError(`"${id}" is not an agent id`);
    }
    if (seen.has(id)) {
      throw new UnprocessableInputError(
        `agent ${id} is named twice on one test; name each agent once`,
      );
    }
    seen.add(id);
  }
}

/**
 * The active agents of one project, oldest first — what a create that named no
 * agent applies to.
 *
 * Shared-locked for the reason a named agent is: an Archive landing between
 * this read and the link rows would otherwise leave a brand-new test applying
 * to an agent that is not active, which is exactly what the named path refuses.
 */
async function activeAgentsOfProject(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
): Promise<readonly string[]> {
  const rows = await on
    .select({ id: agent.id })
    .from(agent)
    .where(
      within(
        auth,
        agent,
        and(eq(agent.projectId, projectId), isNull(agent.archivedAt)),
      ),
    )
    .orderBy(asc(agent.id))
    .for("share");

  return rows.map((row) => row.id);
}

/** The exact sentence a test with nowhere to run is refused with. */
const NEEDS_AN_AGENT =
  "Every test must apply to at least one active agent. Select an active " +
  "agent and save the test again.";

/**
 * Which agents a write should link, from what it was handed.
 *
 * One function for the create and for the clone, so the two can never come to
 * disagree about the same input — the shape `personaIdsFor` has, for the same
 * reason. Naming some checks them; naming none takes the project's active
 * agents, and a project with none is refused rather than given a test nothing
 * can execute.
 */
async function agentIdsFor(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  named: readonly string[],
): Promise<readonly string[]> {
  if (named.length > 0) {
    await validateNamedAgents(on, auth, projectId, named);
    return named;
  }

  const active = await activeAgentsOfProject(on, auth, projectId);
  if (active.length === 0) {
    throw new TestAgentRefusedError("test_needs_agent", NEEDS_AN_AGENT);
  }
  return active;
}

/** The link rows of one test. */
async function linkAgentsTo(
  on: Queryable,
  auth: AuthContext,
  testId: string,
  projectId: string,
  agentIds: readonly string[],
): Promise<void> {
  if (agentIds.length === 0) return;

  await on.insert(testAgent).values(
    agentIds.map((agentId) => ({
      testId,
      agentId,
      projectId,
      createdBy: auth.userId,
    })),
  );
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
 * Whether the ids a write names are graders this project can use: each one
 * exists, is alive, and is this project's.
 *
 * The persona check's shape, for the persona check's reasons — one read for the
 * whole set, one refusal per id that did not come back whole, and a grader of
 * another customer or another project refused in the same words as one that
 * never existed, because confirming that somebody else's row exists is itself a
 * leak.
 *
 * **The read takes a shared lock on every row it finds**, and this write's
 * transaction holds it until it commits, which is the other half of the delete's
 * exclusive lock in `graders.ts`: the two modes conflict, so a delete and a
 * write naming the same grader cannot walk past each other. Without it both
 * could pass their own check and a live test would end up naming a deleted
 * grader — a test quietly checking one thing fewer than it says it checks, which
 * is the one state this rule exists to make impossible.
 */
async function validateNamedGraders(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;

  const found = new Map(
    (
      await on
        .select({ id: grader.id, deletedAt: grader.deletedAt })
        .from(grader)
        .where(
          within(
            auth,
            grader,
            and(inArray(grader.id, [...ids]), eq(grader.projectId, projectId)),
          ),
        )
        .for("share")
    ).map((row) => [row.id, row.deletedAt] as const),
  );

  for (const id of ids) {
    if (!found.has(id)) {
      throw new Error(`there is no grader ${id} in this project`);
    }
    if (found.get(id) !== null) {
      throw new Error(
        `grader ${id} is deleted, and a test cannot name a deleted grader`,
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
  // name, so an Archive of that row must either land before this read and
  // refuse the write, or wait behind it and be refused itself. A default
  // resolved without the lock would be the one way past the rule.
  const [pointed] = await on
    .select({ id: persona.id, archivedAt: persona.archivedAt })
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
  if (pointed.archivedAt !== null) {
    throw new Error(
      `this test names no persona and the project's default persona ${id} is archived; name one on the test, or point the project's default at an active persona`,
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
 * The same for the graders — and unlike the personas, this list is allowed to
 * be empty, so a version that names none writes no rows rather than an insert
 * with nothing in it.
 */
async function nameGradersOn(
  on: Queryable,
  versionId: string,
  graderIds: readonly string[],
): Promise<void> {
  if (graderIds.length === 0) return;

  await on.insert(testGrader).values(
    graderIds.map((graderId, index) => ({
      testVersionId: versionId,
      graderId,
      position: index + 1,
    })),
  );
}

/**
 * The test, its first version, the version's personas and graders, and its
 * applicable agents — or none of them. The identity row goes in first naming a
 * version that does not exist yet — its pointer's constraint is deferred, so
 * Postgres checks it at commit — and anything that fails on the way out takes
 * the whole write with it.
 *
 * Every set is resolved inside the transaction, so what was checked is what the
 * rows name.
 *
 * **A test is born with a target.** The applicable agents are as much a part of
 * creating one as its expected behaviors are: a specification nothing can be
 * executed against is a specification nobody can act on, and the state exists
 * only where an upgrade had no honest link to give.
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
    requiredCapabilities: input.requiredCapabilities ?? [],
  });
  const named = input.personaIds ?? [];
  validatePersonaIds(named);
  const namedGraders = input.graderIds ?? [];
  validateGraderIds(namedGraders);
  const namedAgents = input.agentIds ?? [];
  validateAgentIds(namedAgents);

  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  const id = newId("tst");
  const versionId = newId("tstv");

  const written = await db().transaction(async (tx) => {
    const personaIds = await personaIdsFor(tx, auth, projectId, named);
    await validateNamedGraders(tx, auth, projectId, namedGraders);
    const agentIds = await agentIdsFor(tx, auth, projectId, namedAgents);

    const [identity] = await tx
      .insert(test)
      .values({
        id,
        organizationId: auth.organizationId,
        projectId,
        name,
        description: input.description ?? null,
        currentVersionId: versionId,
        revision: newId("rev"),
        applicabilityRevision: newId("rev"),
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
    await nameGradersOn(tx, versionId, namedGraders);
    await linkAgentsTo(tx, auth, id, projectId, agentIds);

    // Read back inside the transaction, so what the create answers with is what
    // the transaction wrote and checked, rather than whatever the table holds
    // by the time it has committed.
    return {
      ...identity,
      personas: await personasOf(tx, versionId),
      graders: await gradersOf(tx, versionId),
      agents: await agentsOf(tx, id),
    };
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
 * The graders of several versions at once, on exactly the terms the personas
 * are read on: keyed by version, each list in the order it was authored, one
 * read for a whole page.
 */
async function gradersOfVersions(
  on: Queryable,
  versionIds: readonly string[],
): Promise<Map<string, TestGrader[]>> {
  const byVersion = new Map<string, TestGrader[]>();
  if (versionIds.length === 0) return byVersion;

  const rows = await on
    .select({
      versionId: testGrader.testVersionId,
      id: grader.id,
      name: grader.name,
      deletedAt: grader.deletedAt,
    })
    .from(testGrader)
    .innerJoin(grader, eq(testGrader.graderId, grader.id))
    .where(inArray(testGrader.testVersionId, [...versionIds]))
    .orderBy(asc(testGrader.testVersionId), asc(testGrader.position));

  for (const { versionId, ...named } of rows) {
    const already = byVersion.get(versionId);
    if (already === undefined) byVersion.set(versionId, [named]);
    else already.push(named);
  }
  return byVersion;
}

/** The one version's graders, in the order they were authored. */
async function gradersOf(
  on: Queryable,
  versionId: string,
): Promise<readonly TestGrader[]> {
  return (await gradersOfVersions(on, [versionId])).get(versionId) ?? [];
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
 * scenario, its expected behaviors and their priorities, the personas who call
 * about it, and the graders it names — both in the order they were authored,
 * deleted ones included and marked.
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
 * **A lifecycle write reads its own answer back through this, on its own
 * transaction.** `getTest` asks the pool, which is a different connection and
 * cannot see an uncommitted write — so an Archive that answered through it
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
    graders: await gradersOf(on, row.versionId),
    agents: await agentsOf(on, row.id),
  };
}

/**
 * One door for every change, so no caller needs the version rules to pick a
 * function — the rules live here. Name and description write in place and
 * version nothing. The scenario, the expected behaviors, the personas and the
 * graders are what the test checks: any of them differing from the current
 * version inserts the next version, with its own join rows, and moves the
 * pointer — all in one transaction with the identity row locked, so two
 * concurrent edits number one after the other rather than fighting over the same
 * version number. The rows of the version being left behind are never touched,
 * because a run that pinned it must still say what it executed. Content
 * byte-identical to the current version is not an edit at all: nothing is
 * written, not even `updated_at`, and the current version comes back.
 *
 * What an edit leaves out, it keeps. A field absent from the changes is read
 * off the current version and carried into the next one, which is what lets an
 * edit to the scenario alone stay an edit to the scenario alone. Carried
 * forward is not a way past validation, though: the personas and the graders a
 * version is about to name are checked whether the edit typed them or inherited
 * them, so no version can come to name one that is missing, deleted, or another
 * project's.
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
  const namedGraders = changes.graderIds;
  if (namedGraders !== undefined) validateGraderIds(namedGraders);

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
    const storedGraders = await gradersOf(tx, currentVersion.id);
    const storedGraderIds = storedGraders.map((named) => named.id);

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
      requiredCapabilities:
        changes.requiredCapabilities ?? storedContent.requiredCapabilities,
    });
    const personaIds = await personaIdsFor(
      tx,
      auth,
      current.projectId,
      named ?? storedIds,
    );
    const graderIds = namedGraders ?? storedGraderIds;
    await validateNamedGraders(tx, auth, current.projectId, graderIds);

    const mintsVersion =
      !sameContent(storedContent, content) ||
      !sameOrderedList(storedIds, personaIds) ||
      !sameOrderedList(storedGraderIds, graderIds);
    const identityChanged =
      changes.name !== undefined || changes.description !== undefined;

    if (!mintsVersion && !identityChanged) {
      return {
        ...current,
        version: currentVersion.version,
        versionId: currentVersion.id,
        ...storedContent,
        personas: storedPersonas,
        graders: storedGraders,
        agents: await agentsOf(tx, current.id),
      };
    }

    let versionId = currentVersion.id;
    let version = currentVersion.version;
    let personas = storedPersonas;
    let graders = storedGraders;
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
      await nameGradersOn(tx, versionId, graderIds);
      // Read back inside the transaction, for the reason create reads back
      // inside it: the answer is what this transaction wrote and checked.
      personas = await personasOf(tx, versionId);
      graders = await gradersOf(tx, versionId);
    }

    const [updated] = await tx
      .update(test)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(changes.description === undefined
          ? {}
          : { description: changes.description }),
        ...(mintsVersion ? { currentVersionId: versionId } : {}),
        // The identity moved, so the token that names it moves too — whichever
        // half of the edit moved it. The applicability revision is deliberately
        // left alone: no edit here can touch which agents the test applies to,
        // and moving it would refuse a link edit somebody is typing elsewhere
        // for a change that has nothing to do with links.
        revision: newId("rev"),
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
      graders,
      agents: await agentsOf(tx, current.id),
    };
  });
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
 * interpretable after the test moves on, and the read grading resolves what to
 * judge from: the scenario and expected behaviors as they were, and the personas
 * and graders the version named, by identity and in the order they were
 * authored. Which version of each of them a simulation met is the run's to pin,
 * never this row's.
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
    graders: await gradersOf(db(), row.id),
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

/**
 * Which tests a list is of, beyond the page.
 *
 * **Two lists, never one with a column saying which** — an authoring list
 * mixing archived rows into active ones is a list somebody picks the wrong row
 * out of. The other two filters narrow within one of those lists.
 */
export type TestListRequest = PageRequest & {
  /** `false`, the default, is the authoring list. `true` is the archive. */
  readonly archived?: boolean | undefined;
  /**
   * Only the tests that apply to this agent — the agent's own coverage, and the
   * set a run builder may choose from once an agent is chosen.
   */
  readonly agentId?: string | undefined;
  /**
   * Only the tests whose name contains this, ignoring case. Blank narrows
   * nothing, which is what an empty search box means.
   */
  readonly name?: string | undefined;
};

/** Every character Postgres reads as a wildcard, escaped so a search is one. */
function literalPattern(written: string): string {
  return `%${written.replace(/([\\%_])/gu, "\\$1")}%`;
}

export async function listTests(
  auth: AuthContext,
  page?: TestListRequest,
): Promise<TestPage> {
  authorize(auth, "read", here(auth));

  const { limit, cursor } = pageWindow(page, {
    singular: "test",
    plural: "tests",
    prefix: "tst",
  });
  const olderThanCursor = cursor === undefined ? undefined : lt(test.id, cursor);
  const lifecycle =
    page?.archived === true ? isNotNull(test.archivedAt) : notArchived;
  const named = page?.name?.trim() ?? "";
  const matchingName =
    named === "" ? undefined : ilike(test.name, literalPattern(named));

  // The agent filter is a semi-join written as an `exists`, so a test that
  // applies to one agent comes back once whatever else it applies to. A plain
  // join would multiply the page by the link count and make the cursor lie.
  const applyingToAgent =
    page?.agentId === undefined
      ? undefined
      : inArray(
          test.id,
          db()
            .select({ id: testAgent.testId })
            .from(testAgent)
            .where(eq(testAgent.agentId, page.agentId)),
        );

  const rows = await selectWithCurrentVersion()
    .where(
      within(
        auth,
        test,
        and(
          lifecycle,
          inActingProject(auth),
          matchingName,
          applyingToAgent,
          olderThanCursor,
        ),
      ),
    )
    .orderBy(desc(test.id))
    .limit(limit + 1);

  // A page's personas, graders and agents come back in one read each, not one
  // per row: a page of two hundred tests is four queries, the same as a page of
  // one.
  const { items: wanted, nextCursor } = pageOf(rows, limit);
  const versionIds = wanted.map((row) => row.versionId);
  const personasByVersion = await personasOfVersions(db(), versionIds);
  const gradersByVersion = await gradersOfVersions(db(), versionIds);
  const agentsByTest = await agentsOfTests(
    db(),
    wanted.map((row) => row.id),
  );

  return {
    items: wanted.map(({ content, ...rest }) => ({
      ...rest,
      ...contentFromRow(content, rest.versionId),
      personas: personasByVersion.get(rest.versionId) ?? [],
      graders: gradersByVersion.get(rest.versionId) ?? [],
      agents: agentsByTest.get(rest.id) ?? [],
    })),
    nextCursor,
  };
}

/**
 * A new test whose version 1 carries the source's current content: the same
 * scenario, the same expected behaviors at the same priorities, the same
 * personas and the same graders in the same order, under the same name — there
 * is no per-project name uniqueness, so the name copies verbatim exactly as the
 * persona factory copies it.
 *
 * A clone is a create with the retyping saved: fresh `tst_` and `tstv_` ids,
 * version numbering starting over at 1, and no link back — the source's history
 * is the source's, and nothing of it comes along. The source is read through
 * the same seam as `getTest`, so a clone can only be taken of what the caller
 * could have fetched: same customer, same acting project, not deleted.
 *
 * The personas and the graders are handed on exactly as the source names them,
 * and `createTest` is the only thing that judges them — one rule about what a
 * version may name, in one place. So a source whose current version names a
 * deleted one of either is refused by that same validation, rather than quietly
 * cloned without it or quietly given the project's default; neither silence
 * would be a copy, and a clone that checked something the source does not is
 * worse than no clone. That refusal is out of reach in practice: both deletes
 * are refused while a live test's current version names the row, and a test that
 * cannot be fetched cannot be cloned, so no clonable source can name a deleted
 * persona or a deleted grader.
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

  /**
   * The source's **active** links, and only those.
   *
   * A clone is a new test being created now, and a create may not link an
   * archived agent — so copying the archived links would either be refused or
   * would make clone the one door past that rule. Copying only the active ones
   * is what a person would have chosen anyway: the copy is for running, and an
   * archived agent is exactly the target it cannot run against. A source whose
   * every link is archived therefore falls back to the project's active agents,
   * and a project with none refuses the clone in the create's own words.
   */
  const active = source.agents
    .filter((applies) => applies.archivedAt === null)
    .map((applies) => applies.id);

  return createTest(auth, {
    name: source.name,
    description: source.description ?? undefined,
    scenario: source.scenario,
    expectedBehaviors: source.expectedBehaviors,
    personaIds: source.personas.map((named) => named.id),
    graderIds: source.graders.map((named) => named.id),
    // Copied whole, including the overrides no browser form shows. A clone that
    // dropped them would hand somebody a test that looks identical and runs in
    // a different world.
    mockOverrides: source.mockOverrides,
    requiredCapabilities: source.requiredCapabilities,
    agentIds: active,
  });
}

/**
 * What a link edit takes: the whole set the test should apply to, and the
 * applicability revision it was written against.
 *
 * **The whole set rather than one add or one remove**, because a browser edits
 * a list of checkboxes and sends what it now says. Two people editing the set
 * from two tabs is what the revision is for, and add-and-remove verbs would
 * make each of them right about their own change and wrong about the set.
 */
export type ApplicabilityChange = {
  readonly agentIds: readonly string[];
  /**
   * Optional here and required at the browser's door — the stance every
   * expectation in this codebase takes. A script acting on a row it read a line
   * earlier has nobody to race; a person with a page open in a tab they left
   * over lunch has exactly somebody to race.
   */
  readonly expectedApplicabilityRevision?: string | undefined;
};

/**
 * Which agents this test applies to, set to exactly what the caller says.
 *
 * **This mints no version and moves no identity revision.** Target coverage is
 * not test content and not the test's live identity: a repository copy stays
 * current, a rename being typed in another tab stays saveable, and the version
 * history stays a history of what the test checks. Only the applicability
 * revision moves, and only a link edit names it.
 *
 * Three rules refuse, all of them under the lock:
 *
 * - **The set may not be emptied.** A test with no agent is a specification
 *   nothing can execute, so the last link cannot be removed — the refusal names
 *   the agent being removed, because the fix is to link another one first.
 * - **A new link needs an active agent of this project.** Links already there
 *   are left alone whatever their agent's state.
 * - **The revision has to match**, or the whole edit is refused with
 *   `ApplicabilityConflictError` and nothing is written.
 *
 * Setting the set to exactly what it already is writes nothing at all, not even
 * a new revision: a save that changed nothing must not make somebody else's
 * open link editor stale.
 */
export async function setTestAgents(
  auth: AuthContext,
  id: string,
  change: ApplicabilityChange,
): Promise<Test | undefined> {
  authorize(auth, "author_definitions", here(auth));

  validateAgentIds(change.agentIds);

  return db().transaction(async (tx) => {
    const [locked] = await tx
      .select({
        id: test.id,
        projectId: test.projectId,
        applicabilityRevision: test.applicabilityRevision,
      })
      .from(test)
      .where(theTest(auth, id))
      .limit(1)
      .for("update");

    if (locked === undefined) return undefined;

    const expected = change.expectedApplicabilityRevision;
    if (expected !== undefined && expected !== locked.applicabilityRevision) {
      throw new ApplicabilityConflictError(locked.id, {
        expected,
        current: locked.applicabilityRevision,
      });
    }

    const held = (await agentsOf(tx, locked.id)).map((applies) => applies.id);
    const wanted = change.agentIds;
    const added = wanted.filter((agentId) => !held.includes(agentId));
    const removed = held.filter((agentId) => !wanted.includes(agentId));

    if (added.length === 0 && removed.length === 0) {
      return readTestOn(tx, auth, locked.id);
    }

    if (wanted.length === 0) {
      // Named after the link that would have been last out, because that is the
      // one the author is looking at.
      const [last] = removed;
      throw new TestAgentRefusedError(
        "last_test_agent",
        `Test ${locked.id} must apply to at least one agent. Link another ` +
          `active agent before you remove ${String(last)}.`,
        { testId: locked.id, ...(last === undefined ? {} : { agentId: last }) },
      );
    }

    // Only what is being added is held to the active rule. A link already there
    // stays there however its agent has moved since.
    await validateNamedAgents(tx, auth, locked.projectId, added);

    if (removed.length > 0) {
      await tx
        .delete(testAgent)
        .where(
          and(
            eq(testAgent.testId, locked.id),
            inArray(testAgent.agentId, [...removed]),
          ),
        );
    }
    await linkAgentsTo(tx, auth, locked.id, locked.projectId, added);

    await tx
      .update(test)
      .set({ applicabilityRevision: newId("rev") })
      .where(eq(test.id, locked.id));

    return readTestOn(tx, auth, locked.id);
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

/** What a lifecycle change takes, beyond the test it names. */
export type ArchiveTestRequest = {
  readonly expectedRevision?: string | undefined;
};

export type RestoreTestRequest = {
  readonly expectedRevision?: string | undefined;
  /**
   * The agents the test should apply to when it comes back, for the one test
   * that has none.
   *
   * A test archived by an upgrade because its project held no active agent has
   * no link to come back to, and restoring it without one would produce an
   * active test that refuses every run. So the choice is part of the Restore
   * rather than a step after it: doing it afterwards would leave a window in
   * which the test is active and unusable, and a window nobody would think to
   * close is one that stays open. Meaningless for a test that already has
   * links, which keeps them.
   */
  readonly agentIds?: readonly string[] | undefined;
};

/**
 * Archive: the test leaves every authoring list and cannot enter a new run.
 *
 * Every row stays exactly where it was — the identity, every version, every
 * link, every run that pinned one — because Archive is a statement about what
 * should be *offered*, not about what happened. `restoreTest` is therefore an
 * ordinary write rather than a recovery, and that is the whole point of
 * archiving instead of deleting.
 *
 * **Nothing refuses this, ever.** A persona's Archive can be refused because a
 * live test's current version naming them would silently lose one of the people
 * who call about it; a test has no dependant of its own that could lose
 * anything that way. A run keeps what it needs by pinning a version that
 * outlives the archive.
 *
 * Archiving one already archived writes nothing and answers what is there. It
 * is not an error: two tabs pressing Archive is an ordinary thing to happen,
 * and the second one has nothing to complain about.
 *
 * Like create, this refuses a credential acting in no project. An edit lands on
 * a row that already names its own project; an Archive decides the test should
 * stop being offered in one, and that is an act taken from inside it.
 */
export async function archiveTest(
  auth: AuthContext,
  id: string,
  request: ArchiveTestRequest = {},
): Promise<Test | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "archiving a test happens inside its project, and this credential is for the whole organization and acting in none",
    );
  }

  const archivedAt = new Date();
  return db().transaction(async (tx) => {
    const [locked] = await tx
      .select({
        id: test.id,
        revision: test.revision,
        archivedAt: test.archivedAt,
      })
      .from(test)
      .where(theTest(auth, id))
      .limit(1)
      .for("update");

    if (locked === undefined) return undefined;
    expectRevision(locked, request.expectedRevision);
    if (locked.archivedAt !== null) return readTestOn(tx, auth, locked.id);

    await tx
      .update(test)
      .set({
        archivedAt,
        // Null, and deliberately: a reason is what an upgrade owes somebody who
        // did not choose this. A person archiving a test knows why.
        archiveReason: null,
        revision: newId("rev"),
        updatedAt: archivedAt,
      })
      .where(eq(test.id, locked.id));

    return readTestOn(tx, auth, locked.id);
  });
}

/**
 * Restore: the test is offered again, and can enter a run again.
 *
 * **Two rules refuse it, and both are about whether the test could actually
 * run.** Restoring is a promise that it can.
 *
 * - Its current version names an archived persona or an archived scenario
 *   grader. Bringing it back would produce a test that is active and refuses
 *   every run — restore those first, or edit the test, and the refusal names
 *   each of them.
 * - It has no applicable agent at all, which only an upgrade can produce. The
 *   Restore takes at least one active agent and links it in the same
 *   transaction.
 *
 * **A test whose every linked agent is archived may restore.** It comes back
 * active and unavailable, which is an honest state and a different one: the
 * links are somebody's coverage decision, and the fix is to restore an agent
 * rather than to re-author the test.
 *
 * Restoring one already active writes nothing.
 */
export async function restoreTest(
  auth: AuthContext,
  id: string,
  request: RestoreTestRequest = {},
): Promise<Test | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "restoring a test happens inside its project, and this credential is for the whole organization and acting in none",
    );
  }

  const named = request.agentIds ?? [];
  validateAgentIds(named);

  const restoredAt = new Date();
  return db().transaction(async (tx) => {
    const [locked] = await tx
      .select({
        id: test.id,
        projectId: test.projectId,
        currentVersionId: test.currentVersionId,
        revision: test.revision,
        archivedAt: test.archivedAt,
      })
      .from(test)
      .where(theTest(auth, id))
      .limit(1)
      .for("update");

    if (locked === undefined) return undefined;
    expectRevision(locked, request.expectedRevision);
    if (locked.archivedAt === null) return readTestOn(tx, auth, locked.id);

    const blocking = await archivedDependenciesOf(tx, locked.currentVersionId);
    if (blocking.length > 0) {
      throw new TestDependencyInactiveError(locked.id, blocking);
    }

    const held = (await agentsOf(tx, locked.id)).map((applies) => applies.id);
    if (held.length === 0) {
      if (named.length === 0) {
        throw new TestAgentRefusedError("test_needs_agent", NEEDS_AN_AGENT, {
          testId: locked.id,
        });
      }
      await validateNamedAgents(tx, auth, locked.projectId, named);
      await linkAgentsTo(tx, auth, locked.id, locked.projectId, named);
      await tx
        .update(test)
        .set({ applicabilityRevision: newId("rev") })
        .where(eq(test.id, locked.id));
    }

    await tx
      .update(test)
      .set({
        archivedAt: null,
        // The reason goes with the archive it explained. A restored test that
        // kept it would tell the next reader it is still waiting for an agent.
        archiveReason: null,
        revision: newId("rev"),
        updatedAt: restoredAt,
      })
      .where(eq(test.id, locked.id));

    return readTestOn(tx, auth, locked.id);
  });
}

/**
 * What one version names that has since been archived — the set that refuses
 * the test's Restore, and the set that refusal names.
 *
 * Both junctions in one answer because both are the same fact about the same
 * version: somebody it needs is not available. Personas first, then graders,
 * each by id, so two runs of the same refusal read the same way.
 */
async function archivedDependenciesOf(
  on: Queryable,
  versionId: string,
): Promise<readonly ArchivedDependency[]> {
  const personas = await on
    .select({ id: persona.id, name: persona.name })
    .from(testPersona)
    .innerJoin(persona, eq(testPersona.personaId, persona.id))
    .where(
      and(
        eq(testPersona.testVersionId, versionId),
        isNotNull(persona.archivedAt),
      ),
    )
    .orderBy(asc(persona.id));

  const graders = await on
    .select({ id: grader.id, name: grader.name })
    .from(testGrader)
    .innerJoin(grader, eq(testGrader.graderId, grader.id))
    .where(
      and(eq(testGrader.testVersionId, versionId), isNotNull(grader.deletedAt)),
    )
    .orderBy(asc(grader.id));

  return [
    ...personas.map((one) => ({ kind: "persona" as const, ...one })),
    ...graders.map((one) => ({ kind: "grader" as const, ...one })),
  ];
}

/**
 * Every version of one test, newest first — the history a detail page shows,
 * and the list an older-version read is chosen from.
 *
 * Deliberately no lifecycle filter on the test: an archived test's history is
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
    .select({ id: test.id, name: test.name, currentVersionId: test.currentVersionId })
    .from(test)
    .where(theTest(auth, testId))
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
  const gradersByVersion = await gradersOfVersions(db(), versionIds);

  return {
    items: items.map(({ content, ...row }) => ({
      ...row,
      testName: found.name,
      current: row.id === found.currentVersionId,
      ...contentFromRow(content, row.id),
      personas: personasByVersion.get(row.id) ?? [],
      graders: gradersByVersion.get(row.id) ?? [],
    })),
    nextCursor,
  };
}

export type TestVersionPage = {
  readonly items: readonly TestVersion[];
  readonly nextCursor: string | undefined;
};

/**
 * Which of these tests currently apply to this agent — the admission rule a run
 * is held to, asked of the whole selection in one read.
 *
 * **The same relation the Tests page edits, read the same way**, so a run
 * builder that offered a test and a run start that refused it can never
 * disagree. It answers the ids that do apply and leaves the refusal to the
 * caller, because what to say about one that does not is the run factory's
 * business and it names the version it was asked to pin.
 *
 * Exported to the module, not from the package, exactly as the two "which tests
 * name this" reads beside it are: the test tables have one owner, and this is
 * it.
 */
export async function testsApplyingToAgent(
  on: Queryable,
  agentId: string,
  testIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (testIds.length === 0) return new Set();

  const rows = await on
    .select({ testId: testAgent.testId })
    .from(testAgent)
    .where(
      and(
        eq(testAgent.agentId, agentId),
        inArray(testAgent.testId, [...testIds]),
      ),
    );

  return new Set(rows.map((row) => row.testId));
}

/**
 * Whether each of these tests is archived — what a run start asks before it
 * pins a version, because an archived test cannot enter a new run.
 *
 * By identity rather than by version, deliberately: a version is frozen content
 * and stays readable forever, and whether it may *start* is a fact about the
 * test it belongs to as it stands today.
 */
export async function archivedTests(
  on: Queryable,
  testIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (testIds.length === 0) return new Set();

  const rows = await on
    .select({ id: test.id })
    .from(test)
    .where(and(inArray(test.id, [...testIds]), isNotNull(test.archivedAt)));

  return new Set(rows.map((row) => row.id));
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
        notArchived,
      ),
    )
    .orderBy(asc(test.id));
}

/**
 * The live tests whose current version names this grader — the set that refuses
 * the grader's own delete, and the set that refusal names.
 *
 * The persona question, asked of the other junction and answered on identical
 * terms: current versions of live tests and nothing else, walked from the join
 * table where `grader_id` is indexed for exactly this, and with no tenancy
 * predicate because whether the delete is refused is a fact about the grader
 * rather than about who is asking. The grader's own delete has checked its
 * tenancy on that row before asking this, and a version may only ever name a
 * grader of its own project, so every row this can return is a test of that same
 * project.
 *
 * Exported to the module, not from the package: this answers a question the
 * grader factory has to ask before it deletes, and the test tables have one
 * owner, which is this file.
 */
export async function liveTestsNamingGrader(
  on: Queryable,
  graderId: string,
): Promise<readonly TestNamingGrader[]> {
  return on
    .select({ id: test.id, name: test.name })
    .from(testGrader)
    .innerJoin(test, eq(test.currentVersionId, testGrader.testVersionId))
    .where(and(eq(testGrader.graderId, graderId), notArchived))
    .orderBy(asc(test.id));
}
