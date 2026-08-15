import { newId } from "@egma/ids";
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { connection, type Modality } from "../schema/agents.ts";
import {
  grader,
  graderVersion,
  judgeConfiguration,
  type GraderRead,
  type GraderScope,
  type Priority,
} from "../schema/graders.ts";
import { persona } from "../schema/personas.ts";
import { gradingPlan, type GradingPlanState } from "../schema/plans.ts";
import type { SimulationSkipReason } from "../schema/runs.ts";
import {
  test,
  testGrader,
  testPersona,
  testVersion,
} from "../schema/tests.ts";
import {
  capabilityStanding,
  CAPABILITIES_UNKNOWN,
  type ConnectionCapabilities,
} from "./capabilities.ts";
import type { AuthContext } from "./context.ts";
import {
  JudgeNotConfiguredError,
  RunWriteRefusedError,
  type RunWriteRefusal,
} from "./errors.ts";
import {
  EXPECTED_BEHAVIORS_GRADER,
  GRADER_TYPE_REGISTRY,
} from "./graders.ts";
import { PLATFORM_JUDGE } from "./judges.ts";
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
 * reference — one group per pinned test version — and each group holds the
 * expected-behaviors built-in plus the authored graders that apply. Frozen at
 * start, so editing or archiving a grader tomorrow cannot rewrite what this run
 * meant.
 *
 * **Who pays for the judging.** Every judge choice is tagged, and a configured
 * one stores the provider, the model, and the *reference* to a credential —
 * never a secret. The grader service resolves the current secret for that
 * reference when it claims, which is what makes rotation reach pending work and
 * what makes a credential's Archive have to refuse while a plan still names it.
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
  /** The graders this version names directly, in the order authored. */
  readonly graderIds: readonly string[];
};

/**
 * Every named version resolved to the test it belongs to, the personas it
 * names, what it requires of a connection, and the graders it names — before
 * anything at all is written.
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

  const scenarioGraders = new Map<string, string[]>();
  for (const entry of await on
    .select({
      testVersionId: testGrader.testVersionId,
      graderId: testGrader.graderId,
      position: testGrader.position,
    })
    .from(testGrader)
    .where(inArray(testGrader.testVersionId, [...found.keys()]))
    .orderBy(asc(testGrader.position))) {
    const held = scenarioGraders.get(entry.testVersionId);
    if (held === undefined) scenarioGraders.set(entry.testVersionId, [entry.graderId]);
    else held.push(entry.graderId);
  }

  return ids.map((id) => {
    const row = found.get(id);
    if (row === undefined) {
      refuseRun(
        "not_admitted",
        `there is no test version ${id} on this egma. Push the test first, ` +
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
      graderIds: scenarioGraders.get(id) ?? [],
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
    ? `This connection was measured and does not support ${named}, so egma ` +
        `did not conduct this simulation. Nothing is being said about the ` +
        `agent; choose a connection that supports it, or a test that does not ` +
        `require it.`
    : `Nobody has measured whether this connection supports ${named}, so egma ` +
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
 * Which model judges, whose account pays, and the honest answer when neither
 * question has one.
 *
 * `not_required` is a deterministic grader: a threshold, a tool-call check, a
 * phrase check. Nothing is asked of a model, so naming one would be a bill
 * nobody incurs.
 *
 * `configured` names the provider, the model and the **reference** to the key —
 * an organization's `jcr_` credential, or the deployment's `platform` sentinel.
 * Never a secret, at any point: the grader service resolves the current one
 * when it claims, which is what makes a rotation reach work already frozen.
 *
 * `unavailable_at_capture` exists only for work upgraded across the migration
 * that added plans, whose project had no judge at the moment the plan was
 * captured. It records the honest no-judge state rather than inventing a
 * credential reference that would resolve to somebody else's key. **New work
 * never starts in it** — a project with no judge is refused before a run is
 * written, because every run carries the judge-backed built-in.
 */
export type JudgeChoice =
  | { readonly tag: "not_required" }
  | {
      readonly tag: "configured";
      readonly provider: string;
      readonly model: string;
      /** A `jcr_` credential of this organization, or `platform`. */
      readonly source: string;
    }
  | { readonly tag: "unavailable_at_capture" };

/**
 * One authored grader, as the plan freezes it.
 *
 * Keyed by `(test reference, grader_id)` — so the same grader selected on two
 * test versions is deliberately two items, because a run's judgments are per
 * conversation and a shared item would make one test's grading depend on
 * another's. `origin` says how it got here, and it is worth keeping: a grader
 * added directly to a test is a scoping decision that overrides the grader's
 * own live scope for that test, and a page has to be able to say so.
 */
export type AuthoredPlanItem = {
  readonly kind: "authored";
  readonly graderId: string;
  readonly graderVersionId: string;
  readonly graderName: string;
  readonly origin: "project_default" | "scenario_specific";
  readonly priority: Priority;
  readonly scope: GraderScope;
  readonly reads: readonly GraderRead[];
  readonly modalities: readonly Modality[];
  readonly judge: JudgeChoice;
};

/**
 * The expected-behaviors built-in, as the plan freezes it.
 *
 * **It has no grader identity, no grader version, no scope and no item-level
 * priority**, and every one of those absences is deliberate. It is not a row —
 * applying it is part of what running a test means — so there is nothing to
 * point at. And it produces one verdict per expected behavior, each taking its
 * priority from the behavior it judged in the pinned test version, so an
 * item-wide priority would flatten exactly the distinction the behaviors carry.
 *
 * What it does store is the engine version, because a behavior change in the
 * built-in requires a new one: that is the only way an old run's judgments stay
 * interpretable after the engine learns something new.
 */
export type BuiltInPlanItem = {
  readonly kind: "built_in";
  /** The reserved key. The first and, today, the only one. */
  readonly graderKey: string;
  readonly engineVersion: string;
  readonly reads: readonly GraderRead[];
  readonly modalities: readonly Modality[];
  readonly judge: JudgeChoice;
};

export type PlanItem = AuthoredPlanItem | BuiltInPlanItem;

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

/** The engine version the built-in judges at. A behavior change mints a new one. */
export const EXPECTED_BEHAVIORS_ENGINE_VERSION = "1";

/** One project-default or scenario grader, as the plan needs it. */
type ApplicableGrader = {
  readonly id: string;
  readonly name: string;
  readonly currentVersionId: string;
  readonly priority: Priority;
  readonly scope: GraderScope;
  readonly reads: readonly GraderRead[];
  readonly modalities: readonly Modality[];
  readonly judged: boolean;
  readonly judgeModel: { readonly provider: string; readonly model: string } | null;
};

/**
 * Every active authored grader of the project, with its current version's
 * judged content — read once for the whole plan rather than per test version.
 *
 * Archived graders are left out entirely: Archive means "stop entering new
 * grading plans", and a run frozen before it stays on its own plan. The type
 * registry decides `judged` rather than the row, because whether a kind of
 * judgment asks a model is a fact about the kind.
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
      type: grader.type,
      priority: grader.priority,
      scope: grader.scope,
      currentVersionId: grader.currentVersionId,
      reads: graderVersion.reads,
      modalities: graderVersion.modalities,
      judgeModel: graderVersion.judgeModel,
    })
    .from(grader)
    .innerJoin(graderVersion, eq(grader.currentVersionId, graderVersion.id))
    .where(
      within(
        auth,
        grader,
        and(eq(grader.projectId, projectId), isNull(grader.deletedAt)),
      ),
    )
    .orderBy(asc(grader.id));

  return new Map(
    rows.map((row) => {
      const override = row.judgeModel as {
        provider?: unknown;
        model?: unknown;
      } | null;
      return [
        row.id,
        {
          id: row.id,
          name: row.name,
          currentVersionId: row.currentVersionId,
          priority: row.priority as Priority,
          scope: row.scope as GraderScope,
          reads: row.reads as readonly GraderRead[],
          modalities: row.modalities as readonly Modality[],
          judged: judgedTypes.has(row.type),
          judgeModel:
            override === null ||
            typeof override.provider !== "string" ||
            typeof override.model !== "string"
              ? null
              : { provider: override.provider, model: override.model },
        },
      ] as const;
    }),
  );
}

/**
 * Which grader types ask a model, taken from the type registry rather than
 * written again here — the registry is where "what a kind of judgment reads and
 * whether it needs a judge" is decided, and a second list beside it would be a
 * second opinion about whose account pays.
 */
const judgedTypes: ReadonlySet<string> = new Set(
  Object.entries(GRADER_TYPE_REGISTRY)
    .filter(([, definition]) => definition.judged)
    .map(([type]) => type),
);

/** The project's judge as a plan freezes it, or the refusal that stops a run. */
export type PlanJudge =
  | { readonly state: "configured"; readonly provider: string; readonly model: string; readonly source: string }
  | { readonly state: "needs_setup" };

/**
 * The judge the plan will name, read off the project's own setting.
 *
 * A `platform` source keeps the sentinel word rather than a credential id,
 * because the deployment's own judge is not the customer's to point at, rotate
 * or archive — and a plan that named an id for it would be naming a row nobody
 * can reach.
 *
 * **It takes the queryable it is to read on, and that is load-bearing.** Run
 * creation asks this from inside its own transaction, and a read that reached
 * for a second pool connection while the first was held would take two
 * connections per run — so a handful of runs starting at once would empty the
 * pool and wait on each other forever. It is the same rule every other read on
 * this path already follows; the shape here just makes it impossible to
 * forget.
 *
 * Nothing sealed is selected. The columns are the provider, the model and where
 * the key comes from — never the envelope, which has exactly one door and it is
 * not this one.
 */
export async function planJudgeOn(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
): Promise<PlanJudge> {
  const [row] = await on
    .select({
      provider: judgeConfiguration.provider,
      model: judgeConfiguration.model,
      source: judgeConfiguration.source,
      credentialId: judgeConfiguration.credentialId,
    })
    .from(judgeConfiguration)
    .where(
      within(
        auth,
        judgeConfiguration,
        eq(judgeConfiguration.projectId, projectId),
      ),
    )
    .limit(1);

  if (row === undefined) return { state: "needs_setup" };
  return {
    state: "configured",
    provider: row.provider,
    model: row.model,
    // A project spending the deployment's own judge holds no credential row to
    // point at, so the plan stores the sentinel word instead.
    source: row.credentialId ?? PLATFORM_JUDGE,
  };
}

/** One authored grader's judge choice, under a configured project judge. */
function judgeFor(one: ApplicableGrader, judge: PlanJudge): JudgeChoice {
  if (!one.judged) return { tag: "not_required" };
  if (judge.state === "needs_setup") return { tag: "unavailable_at_capture" };
  return {
    tag: "configured",
    // A grader may insist on its own provider and model; the account behind it
    // is still the project's, because a grader has no credential of its own and
    // inventing one here would be egma choosing whose key to spend.
    provider: one.judgeModel?.provider ?? judge.provider,
    model: one.judgeModel?.model ?? judge.model,
    source: judge.source,
  };
}

/** The built-in's judge choice. It always asks a model, so it always needs one. */
function builtInJudge(judge: PlanJudge): JudgeChoice {
  return judge.state === "needs_setup"
    ? { tag: "unavailable_at_capture" }
    : {
        tag: "configured",
        provider: judge.provider,
        model: judge.model,
        source: judge.source,
      };
}

/**
 * The plan one selection of pinned versions comes to.
 *
 * For each version: the built-in, then the active project-default graders whose
 * live scope is `simulations` or `both`, then every active grader the version
 * names directly — **whatever its live scope**, because a direct link is the
 * per-test scoping decision and overrides the grader's own.
 *
 * **Deduplication is within one version and never across.** A grader that is
 * both a project default and directly named by one test yields one item for
 * that test, and it is the `scenario_specific` one, because the direct link is
 * the decision somebody actually made. The same grader on two selected versions
 * stays two items: they judge two different conversations.
 */
export function planGroupsFor(
  versions: readonly PinnedVersion[],
  graders: ReadonlyMap<string, ApplicableGrader>,
  judge: PlanJudge,
): readonly PlanGroup[] {
  const defaults = [...graders.values()].filter(
    (one) => one.scope === "simulations" || one.scope === "both",
  );

  return versions.map((version) => {
    const items: PlanItem[] = [
      {
        kind: "built_in",
        graderKey: EXPECTED_BEHAVIORS_GRADER.key,
        engineVersion: EXPECTED_BEHAVIORS_ENGINE_VERSION,
        reads: [...EXPECTED_BEHAVIORS_GRADER.reads],
        modalities: [...EXPECTED_BEHAVIORS_GRADER.modalities],
        judge: builtInJudge(judge),
      },
    ];

    /** Where each authored grader landed, so a direct link can replace it. */
    const placed = new Map<string, number>();

    const add = (
      one: ApplicableGrader,
      origin: AuthoredPlanItem["origin"],
    ): void => {
      const item: AuthoredPlanItem = {
        kind: "authored",
        graderId: one.id,
        graderVersionId: one.currentVersionId,
        graderName: one.name,
        origin,
        priority: one.priority,
        scope: one.scope,
        reads: one.reads,
        modalities: one.modalities,
        judge: judgeFor(one, judge),
      };
      const already = placed.get(one.id);
      if (already === undefined) {
        placed.set(one.id, items.length);
        items.push(item);
        return;
      }
      // The direct link is the scoping decision, so it replaces the default in
      // place rather than adding a second item for one grader.
      items[already] = item;
    };

    for (const one of defaults) add(one, "project_default");
    for (const graderId of version.graderIds) {
      const one = graders.get(graderId);
      // An archived grader named by an older version simply does not enter a
      // new plan. Archive is what that means, and the run still starts.
      if (one !== undefined) add(one, "scenario_specific");
    }

    return {
      tag: "version",
      testId: version.testId,
      testVersionId: version.versionId,
      testName: version.testName,
      items,
    };
  });
}

/** Every `jcr_` credential a plan names, deduplicated, in the order first met. */
export function judgeCredentialsIn(
  groups: readonly PlanGroup[],
): readonly string[] {
  const named: string[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      if (item.judge.tag !== "configured") continue;
      if (item.judge.source === PLATFORM_JUDGE) continue;
      if (!named.includes(item.judge.source)) named.push(item.judge.source);
    }
  }
  return named;
}

/**
 * The plan row, written in the same transaction as the run it belongs to.
 *
 * The credential list is derived here rather than by a caller, so a plan and
 * the index of what it needs can never come apart — which is the whole basis of
 * a credential Archive's refusal.
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
    judgeCredentialIds: judgeCredentialsIn(input.groups),
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
 * **It answers rather than refuses, wherever the answer is a state a page has to
 * draw.** A project with no judge is a `needs_setup` field here and a refusal at
 * start; a test that would be skipped is a group carrying its reason here and a
 * terminal skipped row at start. What it still refuses outright is a selection
 * that could never be written at all — an unknown version, a doubled one, a test
 * that does not apply to this agent — because those are mistakes to fix rather
 * than states to render.
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
  readonly judge: PlanJudge;
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
        `egma takes the connection's own.`,
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

  const judge = await planJudgeOn(on, auth, projectId);
  const graders = await applicableGraders(on, auth, projectId);
  const plan = planGroupsFor(versions, graders, judge);
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
    judge,
    groups,
    runnableSimulationCount: runnable,
    skippedSimulationCount: skipped,
  };
}

/**
 * The refusal a run start owes a project with no judge, raised where both the
 * review and the writer can reach it.
 */
export function demandJudge(judge: PlanJudge, projectId: string): void {
  if (judge.state === "needs_setup") {
    throw new JudgeNotConfiguredError(projectId);
  }
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
  readonly judge: PlanJudge;
  readonly groups: readonly PlanGroup[];
}> {
  const judge = await planJudgeOn(on, auth, projectId);
  demandJudge(judge, projectId);
  const graders = await applicableGraders(on, auth, projectId);
  return { judge, groups: planGroupsFor(versions, graders, judge) };
}

/* ------------------------------------------------------------------- *
 * What a credential's Archive has to ask.
 * ------------------------------------------------------------------- */

/**
 * Whether any run's frozen plan still needs this credential, and which.
 *
 * Two questions, one query each, because they are two different reasons and a
 * refusal names them separately: a run with a conversation still moving will
 * be graded against this plan when it lands, and a grading job that is
 * `pending` or `claimed` is about to resolve this credential's secret.
 *
 * It is deliberately not scoped by project: a credential belongs to the
 * organization and one is archived once, so the question is about everything
 * the organization has ever frozen.
 */
export function plansNeedingCredential(credentialId: string): SQL {
  return sql`${gradingPlan.judgeCredentialIds} @> ${JSON.stringify([credentialId])}::jsonb`;
}
