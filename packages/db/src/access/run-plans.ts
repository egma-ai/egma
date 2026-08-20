import { newId } from "@egma/ids";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { connection, type Modality } from "../schema/agents.ts";
import { grader, type GraderScope } from "../schema/graders.ts";
import { persona } from "../schema/personas.ts";
import { gradingPlan, type GradingPlanState } from "../schema/plans.ts";
import { simulation, type SimulationSkipReason } from "../schema/runs.ts";
import { test, testPersona, testVersion } from "../schema/tests.ts";
import {
  capabilityStanding,
  CAPABILITIES_UNKNOWN,
  type ConnectionCapabilities,
} from "./capabilities.ts";
import type { AuthContext } from "./context.ts";
import { RunWriteRefusedError, type RunWriteRefusal } from "./errors.ts";
import {
  getGraderVersion,
  type ExecutableGrader,
} from "./graders.ts";
import { personaAvailableToProject } from "./persona-availability.ts";
import { archivedTests, testsApplyingToAgent } from "./tests.ts";
import { within } from "./within.ts";

/**
 * What a run decides before it exists: which conversations it can honestly
 * conduct, and what will judge each one.
 *
 * This module is the **one resolver** behind two surfaces that must never
 * disagree. A run builder's review step asks it what a run *would* freeze;
 * `startRun` asks it what to freeze, in the transaction that writes the run.
 * Two implementations of that question would be two opinions about which tests
 * are skipped and which graders judge — and the whole value of a review step is
 * that what it showed is what happened.
 *
 * Three decisions live here, and each is somewhere it can be seen:
 *
 * **Whether a conversation can honestly happen at all.** A test declares what it
 * needs of a connection; a connection records what an adapter measured. Where
 * the two disagree the simulation is written terminal `skipped` with a reason
 * naming the capabilities, and it is never sent to a simulator and never
 * enqueued for grading. It is not a failure and must never be reported as one:
 * a test that could not run says nothing about the agent.
 *
 * **What will judge it.** The grading plan groups items under a tagged test
 * reference — one group per pinned test version — and each group holds every
 * live running copy of the project whose scope reaches simulations, the seeded
 * expected-behaviors copy among them and never special-cased. Frozen at start,
 * so editing or deleting a grader tomorrow cannot rewrite what this run meant —
 * and a group holding nothing is a run that judges nothing, which is a project's
 * decision to take.
 *
 * **Which model judges.** Every model-judged grader version owns one exact model
 * selection. The plan pins only that immutable version id; copying its model
 * beside it would create two durable answers that could drift. The grader reads
 * the version when it claims work. Provider credentials belong to the
 * deployment and no key or key reference enters this plan.
 */

/* ------------------------------------------------------------------- *
 * Refusing a run.
 * ------------------------------------------------------------------- */

/**
 * The run factory's refusal, raised from here as well as from `runs.ts`.
 *
 * It lives beside the rules rather than beside the writer, because the rules
 * moved here to be shared with the review and a refusal that stayed behind
 * would have to be re-raised by hand at every call site.
 */
export function refuseRun(reason: RunWriteRefusal, message: string): never {
  throw new RunWriteRefusedError(reason, message);
}

/**
 * Everything about the named versions that is answerable without the database:
 * there is at least one, and each is named once.
 *
 * Naming one twice is refused rather than folded, because the two readings —
 * "you meant it once" and "run it twice" — are both plausible and only the
 * caller knows which; a repeat count is a decision nobody has made yet. The
 * whole creation goes, so nothing half-written is left behind to explain.
 */
export function validPinnedVersions(ids: readonly string[]): void {
  if (ids.length === 0) {
    refuseRun(
      "not_admitted",
      "a run needs at least one test version, because a run with no " +
        "simulations checks nothing. Pin the version_id of each test this " +
        "run should execute.",
    );
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      refuseRun(
        "not_admitted",
        `test version ${id} is pinned twice on one run. Pin each version ` +
          `once; a run already conducts one simulation per test per persona.`,
      );
    }
    seen.add(id);
  }
}

/* ------------------------------------------------------------------- *
 * Turning ids into what they name.
 * ------------------------------------------------------------------- */

/** What one pinned version turns into: its test, and who calls about it. */
export type PinnedVersion = {
  readonly versionId: string;
  readonly testId: string;
  readonly testName: string;
  readonly personaIds: readonly string[];
  /** What this version needs of a connection to be meaningful. */
  readonly requiredCapabilities: readonly string[];
};

/**
 * Every named version resolved to the test it belongs to, the personas it
 * names, and what it requires of a connection — before anything at all is
 * written.
 *
 * **It resolves no graders, and there are none on a version to resolve.** What
 * judges a conversation is decided entirely by the project's running copies and
 * their scope; a test names none.
 *
 * A version this egma never issued, or one belonging to another customer or
 * another project, is refused in the same words as one that never existed:
 * confirming that somebody else's row is there is itself a leak. And **one bad
 * id refuses the whole creation**, because a run that quietly executed eleven
 * of the twelve versions somebody named would be a green result about a suite
 * that did not run.
 *
 * Whether the *test* may start is a separate question, asked by
 * `admitTestsForAgent` below once the agent is known. This read only turns ids
 * into what they name.
 */
export async function resolvePinnedVersions(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  ids: readonly string[],
): Promise<readonly PinnedVersion[]> {
  const rows = await on
    .select({
      id: testVersion.id,
      testId: testVersion.testId,
      testName: test.name,
      content: testVersion.content,
    })
    .from(testVersion)
    .innerJoin(test, eq(testVersion.testId, test.id))
    .where(
      within(
        auth,
        test,
        and(inArray(testVersion.id, [...ids]), eq(test.projectId, projectId)),
      ),
    );

  const found = new Map(rows.map((row) => [row.id, row] as const));

  const named = new Map<string, string[]>();
  for (const entry of await on
    .select({
      testVersionId: testPersona.testVersionId,
      personaId: testPersona.personaId,
      position: testPersona.position,
    })
    .from(testPersona)
    .where(inArray(testPersona.testVersionId, [...found.keys()]))
    .orderBy(asc(testPersona.position))) {
    const held = named.get(entry.testVersionId);
    if (held === undefined) named.set(entry.testVersionId, [entry.personaId]);
    else held.push(entry.personaId);
  }

  return ids.map((id) => {
    const row = found.get(id);
    if (row === undefined) {
      refuseRun(
        "not_admitted",
        `there is no test version ${id} on this Egma instance. Push the test first, ` +
          `or read the test and pin the version_id it names now.`,
      );
    }
    const personaIds = named.get(id) ?? [];
    if (personaIds.length === 0) {
      // Unreachable through the test factory, which gives a version with no
      // named persona the project's default one. A version that got here
      // holding nobody would conduct nothing, so it is an instance fault.
      throw new Error(
        `test version ${id} names nobody who calls, so it can produce no simulation`,
      );
    }
    return {
      versionId: id,
      testId: row.testId,
      testName: row.testName,
      personaIds,
      requiredCapabilities: requiredCapabilitiesOf(row.content),
    };
  });
}

/** The stored capability array, read back as the list of keys it is. */
function capabilityKeysFromRow(held: unknown): readonly string[] {
  if (!Array.isArray(held)) return [];
  return held.filter((one): one is string => typeof one === "string");
}

/**
 * What a stored version requires of a connection.
 *
 * Read straight off the content rather than through `getTestVersion`, because
 * this runs inside the run's own transaction over a whole selection at once,
 * and because the only field it wants is this one. Absent means the version
 * predates the field, and absent meant *requires nothing* then too — which is
 * why an old version reads as runnable everywhere rather than as unmeasured.
 */
function requiredCapabilitiesOf(content: unknown): readonly string[] {
  if (typeof content !== "object" || content === null) return [];
  return capabilityKeysFromRow(
    (content as Record<string, unknown>).requiredCapabilities,
  );
}

/**
 * Whether each pinned version's test may be executed against the agent this run
 * has reached. Two rules, and both are about the test as it stands today rather
 * than about the frozen version.
 *
 * **Applicability is a live admission rule.** A test applies to the agents
 * somebody linked it to, and a run over an agent it does not apply to is a
 * result nobody asked for: the comparison the whole relation exists to make
 * honest is between agents a test was written for. A run already pins the agent
 * it chose, so a link removed after this run started cannot rewrite what it
 * executed — this asks only whether it may *start*.
 *
 * **An archived test cannot enter a new run.** Archive is exactly the statement
 * "stop starting new work with this", and it would say nothing at all if a
 * pinned version could walk around it. Its versions stay readable and every run
 * that already pinned one stays interpretable, which is the difference between
 * archiving and deleting.
 *
 * One refused version refuses the whole creation, on the terms every other rule
 * here is held to: a run that quietly executed eleven of the twelve versions
 * somebody named would be a green result about a suite that did not run.
 */
export async function admitTestsForAgent(
  on: Queryable,
  agentId: string,
  versions: readonly PinnedVersion[],
): Promise<void> {
  const testIds = [...new Set(versions.map((one) => one.testId))];

  const archived = await archivedTests(on, testIds);
  for (const version of versions) {
    if (!archived.has(version.testId)) continue;
    refuseRun(
      "not_admitted",
      `Test ${version.testId} is archived, so version ${version.versionId} ` +
        `cannot start. Restore the test in the Tests page, or choose another ` +
        `test for this run.`,
    );
  }

  const applying = await testsApplyingToAgent(on, agentId, testIds);
  for (const version of versions) {
    if (applying.has(version.testId)) continue;
    refuseRun(
      "test_not_applicable",
      `Test ${version.testId} does not apply to agent ${agentId}, so version ` +
        `${version.versionId} cannot start. Choose a test linked to this ` +
        `agent, or link the test in the Tests page before starting the run.`,
    );
  }
}

/**
 * Each requested persona resolved to the version this run will pin: alive,
 * this project's, in the order they were named. A persona of another customer
 * or another project is refused in the same words as one that never existed,
 * because confirming that somebody else's row exists is itself a leak.
 *
 * The read takes a shared lock on every row it finds, held to commit — the
 * same terms a test's write names personas on — so a concurrent delete either
 * lands first and is seen here, or waits and sees the pin this run wrote.
 */
export async function resolvePersonaVersions(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  ids: readonly string[],
): Promise<readonly { personaId: string; personaVersionId: string }[]> {
  const found = new Map(
    (
      await on
        .select({
          id: persona.id,
          archivedAt: persona.archivedAt,
          currentVersionId: persona.currentVersionId,
        })
        .from(persona)
        .where(
          personaAvailableToProject(
            auth,
            projectId,
            inArray(persona.id, [...ids]),
          ),
        )
        .for("share")
    ).map((row) => [row.id, row] as const),
  );

  return ids.map((id) => {
    const row = found.get(id);
    if (row === undefined) {
      refuseRun(
        "not_admitted",
        `there is no persona ${id} in this project. A test that names ` +
          `somebody who is not here can produce no simulation; edit the test ` +
          `to name somebody who is.`,
      );
    }
    if (row.archivedAt !== null) {
      refuseRun(
        "not_admitted",
        `persona ${id} is archived, and a run cannot conduct a simulation ` +
          `with an archived persona. Edit the tests that name them, then pin ` +
          `the versions those edits mint.`,
      );
    }
    return { personaId: id, personaVersionId: row.currentVersionId };
  });
}

/* ------------------------------------------------------------------- *
 * Whether a conversation can honestly happen.
 * ------------------------------------------------------------------- */

/**
 * What a pinned version's required capabilities come to, against the connection
 * this run will use.
 *
 * `runnable` is the ordinary answer. The other two are the product's two
 * structured skip reasons, and they are kept apart because they lead somewhere
 * different: `unsupported` is a settled fact about the target and the fix is to
 * write a different test, while `unknown` means nobody has measured and a
 * Refresh may change the answer. Collapsing them would put a false reason on
 * every simulation an adapter's blind spot touched.
 *
 * **Unsupported wins when both are present.** A requirement egma knows is
 * missing is the stronger fact, and telling somebody to go and measure a
 * connection that is already known not to do the thing would send them the
 * wrong way.
 */
export type CapabilityDecision =
  | { readonly runnable: true }
  | {
      readonly runnable: false;
      readonly reason: SimulationSkipReason;
      /** The catalog keys that decided it, in the order the test named them. */
      readonly capabilities: readonly string[];
    };

export function capabilityDecision(
  required: readonly string[],
  held: ConnectionCapabilities,
): CapabilityDecision {
  const unsupported: string[] = [];
  const unmeasured: string[] = [];

  for (const key of required) {
    const standing = capabilityStanding(held, key);
    if (standing === "unsupported") unsupported.push(key);
    else if (standing === "not_measured") unmeasured.push(key);
  }

  if (unsupported.length > 0) {
    return {
      runnable: false,
      reason: "required_capability_unsupported",
      capabilities: unsupported,
    };
  }
  if (unmeasured.length > 0) {
    return {
      runnable: false,
      reason: "required_capability_unknown",
      capabilities: unmeasured,
    };
  }
  return { runnable: true };
}

/** The sentence a skipped conversation carries, in the product's own words. */
export function skipExplanation(
  decision: Extract<CapabilityDecision, { runnable: false }>,
): string {
  const named = decision.capabilities.join(", ");
  return decision.reason === "required_capability_unsupported"
    ? `This connection was measured and does not support ${named}, so Egma ` +
        `did not conduct this simulation. Nothing is being said about the ` +
        `agent; choose a connection that supports it, or a test that does not ` +
        `require it.`
    : `Nobody has measured whether this connection supports ${named}, so Egma ` +
        `did not conduct this simulation. Nothing is being said about the ` +
        `agent; refresh the connection's capabilities and start the run again.`;
}

/** The capability record of one connection, read off its row. */
export function capabilitiesFromRow(row: {
  readonly capabilityState: string;
  readonly capabilitiesMeasured: unknown;
  readonly capabilitiesSupported: unknown;
  readonly capabilitiesCheckedAt: Date | null;
  readonly capabilitySource: string | null;
}): ConnectionCapabilities {
  if (
    row.capabilityState !== "known" ||
    row.capabilitiesCheckedAt === null ||
    row.capabilitySource === null
  ) {
    return CAPABILITIES_UNKNOWN;
  }
  return {
    state: "known",
    measured: capabilityKeysFromRow(row.capabilitiesMeasured),
    supported: capabilityKeysFromRow(row.capabilitiesSupported),
    checkedAt: row.capabilitiesCheckedAt,
    source: row.capabilitySource,
  };
}

/* ------------------------------------------------------------------- *
 * The plan.
 * ------------------------------------------------------------------- */

/**
 * One running copy, as the plan freezes it.
 *
 * Keyed by `(test reference, grader_id)` — so the same copy judging two test
 * versions is deliberately two items, because a run's judgments are per
 * conversation and a shared item would make one test's grading depend on
 * another's.
 *
 * **There is one kind of item now, and the collapse is the redesign.** There
 * used to be two: an authored grader, and the expected-behaviors built-in as a
 * rowless sentinel with a reserved key and an engine version instead of an
 * identity. The built-in is a real running copy today — every project is seeded
 * with one, pointing at the library's `expected_behaviors` entry — so it enters
 * a plan through the same door as everything else and there is nothing left for
 * a second arm to describe. `origin` went the same way with the junction: a
 * test names no graders, so every item got here one way and a field that could
 * only ever say `project_default` would be furniture.
 *
 * **`required` rides the item so a page can mark a diagnostic**, and it is the
 * copy's flag as it stood when the plan froze. What a *verdict* is folded under
 * is the flag as it stands at read time — see `GraderOutcome` — which is the
 * same distinction the two hold everywhere: the plan says what was set up, the
 * fold says what the project lets a failure do today.
 */
export type PlanItem = {
  readonly kind: "authored";
  readonly graderId: string;
  readonly graderVersionId: string;
  readonly graderName: string;
  /** The stable Library identity; `graderVersionId` pins its exact definition. */
  readonly libraryId: string;
  /** `false` makes it a diagnostic: judged, shown, never able to fail a test. */
  readonly required: boolean;
  readonly scope: GraderScope;
};

/**
 * One group of plan items, under the test reference they judge.
 *
 * `version` is every group a new run writes: a pinned test version, and the
 * items that judge the conversations executing it.
 *
 * `legacy_testless` is the one group an upgraded instance can hold, for
 * simulations written before a simulation could pin a test at all. It carries
 * only the active project-default authored graders, because there is no stored
 * test content to support a scenario grader or the expected-behaviors built-in
 * — and inventing either would be a claim about a conversation nobody can check.
 */
export type PlanGroup =
  | {
      readonly tag: "version";
      readonly testId: string;
      readonly testVersionId: string;
      readonly testName: string;
      readonly items: readonly PlanItem[];
    }
  | { readonly tag: "legacy_testless"; readonly items: readonly PlanItem[] };

export type GradingPlan = {
  readonly runId: string;
  readonly state: GradingPlanState;
  /** Null exactly on `not_recorded`, where there is no plan. */
  readonly capturedAt: Date | null;
  readonly groups: readonly PlanGroup[];
};

/** One of the project's running copies, as the plan needs it. */
type ApplicableGrader = {
  readonly id: string;
  readonly name: string;
  readonly currentVersionId: string;
  readonly libraryId: string;
  readonly required: boolean;
  readonly scope: GraderScope;
};

/**
 * Every live running copy of the project, with its current version's judged
 * content — read once for the whole plan rather than per test version.
 *
 * Deleted copies are left out entirely: switching one off means "stop entering
 * new grading plans", and a run frozen before it stays on its own plan. The
 * A plan needs only the running-copy facts and the exact version id. Execution
 * resolves the version's type, config, and model through that one pin.
 */
async function applicableGraders(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
): Promise<ReadonlyMap<string, ApplicableGrader>> {
  const rows = await on
    .select({
      id: grader.id,
      name: grader.name,
      libraryId: grader.libraryId,
      required: grader.required,
      scope: grader.scope,
      currentVersionId: grader.currentVersionId,
    })
    .from(grader)
    .where(
      within(
        auth,
        grader,
        and(eq(grader.projectId, projectId), isNull(grader.deletedAt)),
      ),
    )
    .orderBy(asc(grader.id));

  return new Map(
    rows.map((row) =>
      [
        row.id,
        {
          id: row.id,
          name: row.name,
          currentVersionId: row.currentVersionId,
          libraryId: row.libraryId,
          required: row.required,
          scope: row.scope as GraderScope,
        },
      ] as const,
    ),
  );
}

/**
 * The plan one selection of pinned versions comes to.
 *
 * For each version: every live running copy of the project whose scope is
 * `simulations` or `both`, in copy-id order. The list is the same for every
 * version of a selection, and that is not a simplification of a rule that used
 * to be per test — a test names no graders, so where a copy applies is the
 * copy's own setting and nothing else.
 *
 * The same copy on two selected versions stays two items: they judge two
 * different conversations, and a shared item would make one test's grading
 * depend on another's.
 *
 * **The seeded expected-behaviors copy is one of these**, which is what makes
 * a first run judged with no setup at all. It is not special-cased here, and
 * it used to be: switching it off is a project's decision like any other, and
 * an item this function added regardless would be a check nobody could turn
 * off appearing beside the ones they chose.
 */
export function planGroupsFor(
  versions: readonly PinnedVersion[],
  graders: ReadonlyMap<string, ApplicableGrader>,
): readonly PlanGroup[] {
  const applying = [...graders.values()].filter(
    (one) => one.scope === "simulations" || one.scope === "both",
  );

  return versions.map((version) => ({
    tag: "version" as const,
    testId: version.testId,
    testVersionId: version.versionId,
    testName: version.testName,
    items: applying.map(planItemFor),
  }));
}

/** One running copy frozen as a plan item. */
function planItemFor(one: ApplicableGrader): PlanItem {
  return {
    kind: "authored",
    graderId: one.id,
    graderVersionId: one.currentVersionId,
    graderName: one.name,
    libraryId: one.libraryId,
    required: one.required,
    scope: one.scope,
  };
}

/*
 * **There is no companion asking which graders a selection lost.** There was
 * one — `scenarioGradersMissingFrom` — and it existed so a Retry could refuse
 * rather than quietly produce a run judged by fewer graders than the one it
 * copies. It could only ever answer about graders a test named *directly*, and
 * a test names none now: what judges a run is the project's live copies, and a
 * copy switched off between two runs is a decision about the project rather
 * than something a Retry may overrule. A Retry of a run whose copies have
 * changed is a Retry under today's conditions, which is what every other
 * resource it rechecks already means.
 */

/**
 * The plan row, written in the same transaction as the run it belongs to.
 */
export async function writeGradingPlan(
  on: Queryable,
  input: {
    readonly runId: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly state: GradingPlanState;
    readonly capturedAt: Date | null;
    readonly groups: readonly PlanGroup[];
  },
): Promise<void> {
  await on.insert(gradingPlan).values({
    id: newId("gpl"),
    runId: input.runId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    state: input.state,
    capturedAt: input.capturedAt,
    groups: input.groups,
  });
}

/**
 * One run's frozen plan, or nothing where the run is not this caller's.
 *
 * A run created before plans existed and left with nothing outstanding has a
 * `not_recorded` row and empty groups — the honest answer, and deliberately not
 * an absent row, so a reader can tell "this run never recorded one" from "this
 * run is not yours".
 */
export async function getGradingPlan(
  auth: AuthContext,
  runId: string,
): Promise<GradingPlan | undefined> {
  const [row] = await db()
    .select({
      runId: gradingPlan.runId,
      state: gradingPlan.state,
      capturedAt: gradingPlan.capturedAt,
      groups: gradingPlan.groups,
    })
    .from(gradingPlan)
    .where(within(auth, gradingPlan, eq(gradingPlan.runId, runId)))
    .limit(1);

  if (row === undefined) return undefined;
  return {
    runId: row.runId,
    state: row.state as GradingPlanState,
    capturedAt: row.capturedAt,
    groups: (row.groups ?? []) as readonly PlanGroup[],
  };
}

/**
 * The exact grader versions frozen for one simulation's initial grading.
 *
 * This is the only simulation execution read. It follows the simulation to its
 * run plan, selects the group for the simulation's pinned test version, then
 * reads every named grader version by id. It never consults a grader's current
 * pointer, so editing a grader after a run starts cannot change that run.
 */
export async function pinnedSimulationGraders(
  auth: AuthContext,
  simulationId: string,
): Promise<readonly ExecutableGrader[] | undefined> {
  const [row] = await db()
    .select({
      testVersionId: simulation.testVersionId,
      groups: gradingPlan.groups,
    })
    .from(simulation)
    .innerJoin(gradingPlan, eq(gradingPlan.runId, simulation.runId))
    .where(within(auth, simulation, eq(simulation.id, simulationId)))
    .limit(1);

  if (row === undefined) return undefined;

  const groups = (row.groups ?? []) as readonly PlanGroup[];
  const group = groups.find((candidate) =>
    row.testVersionId === null
      ? candidate.tag === "legacy_testless"
      : candidate.tag === "version" &&
        candidate.testVersionId === row.testVersionId,
  );
  if (group === undefined) {
    throw new Error(
      `simulation ${simulationId} has no grading-plan group for its pinned test version`,
    );
  }

  return Promise.all(
    group.items.map(async (item): Promise<ExecutableGrader> => {
      const version = await getGraderVersion(auth, item.graderVersionId);
      if (version === undefined || version.graderId !== item.graderId) {
        throw new Error(
          `grading plan for simulation ${simulationId} names an unreadable grader version ${item.graderVersionId}`,
        );
      }
      return {
        id: version.graderId,
        versionId: version.id,
        config: version.config,
        judgeModel: version.judgeModel,
        definition: version.definition,
      };
    }),
  );
}

/* ------------------------------------------------------------------- *
 * The review: what a run would freeze, before anybody starts it.
 * ------------------------------------------------------------------- */

/** What a run builder asks about. */
export type RunPlanRequest = {
  readonly connectionId: string;
  /** Checked against the connection's own agent when given. */
  readonly agentId?: string | undefined;
  /** The test versions the author selected, in the order they chose them. */
  readonly testVersionIds: readonly string[];
};

/** One selected test version, as a review step shows it. */
export type PlannedSimulationGroup = {
  readonly testId: string;
  readonly testVersionId: string;
  readonly testName: string;
  /** Who will call, with the exact version this run would pin for each. */
  readonly personas: readonly {
    readonly personaId: string;
    readonly personaVersionId: string;
    readonly name: string;
  }[];
  readonly requiredCapabilities: readonly string[];
  /** Runnable, or the reason and the capabilities that decided it. */
  readonly capability: CapabilityDecision;
  /** What would judge it, at the exact versions this run would freeze. */
  readonly items: readonly PlanItem[];
};

/**
 * Everything a review step shows, and the same resolution `startRun` will do.
 *
 * A test that would be skipped is a group carrying its reason here and a
 * terminal skipped row at start. What it still refuses outright is a selection
 * that could never be written at all — an unknown version, a doubled one, or a
 * test that does not apply to this agent — because those are mistakes to fix
 * rather than states to render.
 */
export type RunPlan = {
  readonly agentId: string;
  readonly connectionId: string;
  readonly connection: {
    readonly type: string;
    readonly modality: Modality;
    readonly environment: string | null;
    readonly capabilities: ConnectionCapabilities;
  };
  readonly groups: readonly PlannedSimulationGroup[];
  /** How many conversations would actually be conducted. */
  readonly runnableSimulationCount: number;
  /** How many would be written off before they began. */
  readonly skippedSimulationCount: number;
};

export async function planRun(
  auth: AuthContext,
  request: RunPlanRequest,
): Promise<RunPlan> {
  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "a run happens inside a project, and this credential is for the whole organization and acting in none",
    );
  }

  validPinnedVersions(request.testVersionIds);

  const on = db();
  const [reached] = await on
    .select({
      id: connection.id,
      agentId: connection.agentId,
      type: connection.type,
      modality: connection.modality,
      environment: connection.environment,
      capabilityState: connection.capabilityState,
      capabilitiesMeasured: connection.capabilitiesMeasured,
      capabilitiesSupported: connection.capabilitiesSupported,
      capabilitiesCheckedAt: connection.capabilitiesCheckedAt,
      capabilitySource: connection.capabilitySource,
    })
    .from(connection)
    .where(
      within(
        auth,
        connection,
        and(
          eq(connection.id, request.connectionId),
          eq(connection.projectId, projectId),
          isNull(connection.archivedAt),
        ),
      ),
    )
    .limit(1);

  if (reached === undefined) {
    refuseRun(
      "no_such_connection",
      `there is no connection ${request.connectionId} in this project. ` +
        `Check the id, or read your agents to see how each one is reached.`,
    );
  }
  if (request.agentId !== undefined && request.agentId !== reached.agentId) {
    refuseRun(
      "connection_not_on_agent",
      `connection ${request.connectionId} is not on agent ${request.agentId}. ` +
        `Name the agent that connection is on, or leave the agent out and ` +
        `Egma takes the connection's own.`,
    );
  }

  const versions = await resolvePinnedVersions(
    on,
    auth,
    projectId,
    request.testVersionIds,
  );
  await admitTestsForAgent(on, reached.agentId, versions);

  const distinctPersonaIds = [
    ...new Set(versions.flatMap((one) => one.personaIds)),
  ];
  const pinned = new Map(
    (await resolvePersonaVersions(on, auth, projectId, distinctPersonaIds)).map(
      (one) => [one.personaId, one.personaVersionId] as const,
    ),
  );
  const names = new Map(
    (
      await on
        .select({ id: persona.id, name: persona.name })
        .from(persona)
        .where(inArray(persona.id, distinctPersonaIds))
    ).map((row) => [row.id, row.name] as const),
  );

  const graders = await applicableGraders(on, auth, projectId);
  const plan = planGroupsFor(versions, graders);
  const capabilities = capabilitiesFromRow(reached);

  let runnable = 0;
  let skipped = 0;
  const groups = versions.map((version, index) => {
    const decision = capabilityDecision(
      version.requiredCapabilities,
      capabilities,
    );
    if (decision.runnable) runnable += version.personaIds.length;
    else skipped += version.personaIds.length;

    return {
      testId: version.testId,
      testVersionId: version.versionId,
      testName: version.testName,
      personas: version.personaIds.map((personaId) => ({
        personaId,
        personaVersionId: pinned.get(personaId) ?? "",
        name: names.get(personaId) ?? "",
      })),
      requiredCapabilities: version.requiredCapabilities,
      capability: decision,
      items: plan[index]?.items ?? [],
    };
  });

  return {
    agentId: reached.agentId,
    connectionId: reached.id,
    connection: {
      type: reached.type,
      modality: reached.modality as Modality,
      environment: reached.environment,
      capabilities,
    },
    groups,
    runnableSimulationCount: runnable,
    skippedSimulationCount: skipped,
  };
}

/**
 * Everything a run's creation needs from this module, resolved in the caller's
 * own transaction.
 */
export async function resolveRunPlan(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  versions: readonly PinnedVersion[],
): Promise<{
  readonly groups: readonly PlanGroup[];
}> {
  const graders = await applicableGraders(on, auth, projectId);
  return { groups: planGroupsFor(versions, graders) };
}
