import { newId } from "@egma/ids";
import { and, desc, eq, isNull, lt, sql, type SQL } from "drizzle-orm";

import { db } from "../client.ts";
import {
  grader,
  graderVersion,
  GRADER_SCOPES,
  GRADER_TYPES,
  PRIORITIES,
  type GraderScope,
  type GraderType,
  type Priority,
} from "../schema/graders.ts";
import type { AuthContext } from "./context.ts";
import {
  GraderNamedByTestsError,
  ProjectOutsideOrganizationError,
} from "./errors.ts";
import { pageOf, pageWindow, type PageRequest } from "./pages.ts";
import { authorize, here } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { liveTestsNamingGrader } from "./tests.ts";
import { within } from "./within.ts";

/**
 * Reading and writing graders — what they are is the schema file's story
 * (`schema/graders.ts`); this file is how they are reached.
 *
 * Project scoping works as the persona and test factories' does, verb for verb.
 * A context acting in a project writes and reads there; a context acting in none
 * — an organization-scoped credential — reads the whole customer and creates
 * nothing, because a grader belongs to a project and a credential for the whole
 * customer is acting in none.
 *
 * The line this factory holds that the two before it do not is **between what a
 * verdict was decided by and where the decision applies.** The rubric, the
 * threshold, the phrases, the judge model: those are what a judgment is made of,
 * so they live in immutable versions and an edit mints the next one, leaving
 * last week's run meaning exactly what it meant. The priority, the scope and the
 * sampling rate change nothing about any judgment already made, so they are
 * written in place and take effect everywhere at once. A developer tightening a
 * threshold and a developer promoting a warning to a blocker are doing two
 * different things, and only one of them is rewriting history if it is versioned
 * wrongly.
 */

/**
 * How a measure is reduced to one number before the threshold is applied. A
 * latency grader almost always wants a percentile — a mean hides the one turn
 * that took nine seconds, which is the turn the caller hung up on.
 */
const MEASURE_AGGREGATIONS = [
  "mean",
  "max",
  "min",
  "sum",
  "p50",
  "p90",
  "p95",
  "p99",
] as const;
export type MeasureAggregation = (typeof MEASURE_AGGREGATIONS)[number];

/**
 * Which way the threshold points, in words rather than symbols: `<` and `<=`
 * differ by one character in a config file somebody reviews, and the difference
 * between them is whether a run is red.
 */
const THRESHOLD_COMPARATORS = [
  "below",
  "at_most",
  "above",
  "at_least",
] as const;
export type ThresholdComparator = (typeof THRESHOLD_COMPARATORS)[number];

/** Whether a phrase is looked for as written, or as a regular expression. */
const PHRASE_MATCHES = ["contains", "regex"] as const;
export type PhraseMatch = (typeof PHRASE_MATCHES)[number];

/**
 * Whose turns are searched. The default is the agent's, because the agent is
 * what is under test — the persona is egma's own synthetic caller, and judging
 * what egma made it say would be judging egma.
 */
const PHRASE_SPEAKERS = ["agent", "persona", "either"] as const;
export type PhraseSpeaker = (typeof PHRASE_SPEAKERS)[number];

/** The judges egma can ask. Grows one provider at a time, behind one seam. */
const JUDGE_PROVIDERS = ["openai"] as const;
export type JudgeProvider = (typeof JUDGE_PROVIDERS)[number];

/**
 * The judge this grader insists on, instead of the project's default. Provider
 * and model only: the key lives in the encrypted credential store and is named
 * by the project's judge configuration, so nothing here can carry a secret into
 * a report or a log.
 */
export type JudgeModel = {
  readonly provider: JudgeProvider;
  readonly model: string;
};

/** The criteria a judge reads, in the words the team wrote them in. */
export type LlmRubricConfig = {
  readonly rubric: string;
};

/**
 * A measurement turned into a judgment: "p90 of turn_response_latency under
 * 2000ms". The measure is named, not described — the measure catalog says what
 * the simulator emits, and a grader that guessed a string would silently never
 * fire.
 */
export type MetricThresholdConfig = {
  readonly measure: string;
  readonly aggregation: MeasureAggregation;
  readonly comparator: ThresholdComparator;
  readonly threshold: number;
};

/**
 * One tool, and optionally what it must have been called with. The arguments
 * are constraints on the call rather than the call itself: absent means the
 * call happening at all is the whole check.
 */
export type ToolExpectation = {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>> | null;
};

/** What must have fired, and what must never have. */
export type ToolCallsConfig = {
  readonly required: readonly ToolExpectation[];
  readonly forbidden: readonly ToolExpectation[];
};

export type Phrase = {
  readonly text: string;
  readonly match: PhraseMatch;
};

/** The compliance disclosure that must be said, and the promise that must not. */
export type PhraseMatchConfig = {
  readonly required: readonly Phrase[];
  readonly banned: readonly Phrase[];
  readonly speaker: PhraseSpeaker;
};

export type GraderConfig =
  | LlmRubricConfig
  | MetricThresholdConfig
  | ToolCallsConfig
  | PhraseMatchConfig;

/** What each type's config is, so the pair can never come apart. */
type ConfigOf = {
  readonly llm_rubric: LlmRubricConfig;
  readonly metric_threshold: MetricThresholdConfig;
  readonly tool_calls: ToolCallsConfig;
  readonly phrase_match: PhraseMatchConfig;
};

/**
 * A grader's type and the config that type shapes, as one inseparable pair —
 * every read hands both over together, so a caller who has narrowed the type has
 * narrowed the config with it and never has to guess what the jsonb holds.
 */
export type GraderJudgment = {
  [K in GraderType]: { readonly type: K; readonly config: ConfigOf[K] };
}[GraderType];

/** A phrase as a caller writes one; `match` defaults to looking for the words. */
export type PhraseInput = {
  readonly text: string;
  readonly match?: PhraseMatch | undefined;
};

export type ToolExpectationInput = {
  readonly tool: string;
  readonly arguments?: Readonly<Record<string, unknown>> | undefined;
};

export type ToolCallsConfigInput = {
  readonly required?: readonly ToolExpectationInput[] | undefined;
  readonly forbidden?: readonly ToolExpectationInput[] | undefined;
};

export type PhraseMatchConfigInput = {
  readonly required?: readonly PhraseInput[] | undefined;
  readonly banned?: readonly PhraseInput[] | undefined;
  readonly speaker?: PhraseSpeaker | undefined;
};

/**
 * A judgment as it is written down, before egma fills in what was left out.
 * What lands in the version row is always complete — every default resolved at
 * the write door — so no reader afterwards has to know what a missing field
 * used to mean, and two configs differing only in what they left implicit are
 * one config rather than two versions.
 */
export type NewGraderJudgment =
  | { readonly type: "llm_rubric"; readonly config: LlmRubricConfig }
  | { readonly type: "metric_threshold"; readonly config: MetricThresholdConfig }
  | { readonly type: "tool_calls"; readonly config: ToolCallsConfigInput }
  | { readonly type: "phrase_match"; readonly config: PhraseMatchConfigInput };

/** The config half of the above, for an edit that keeps the grader's type. */
export type GraderConfigInput = NewGraderJudgment["config"];

/**
 * The live settings: where the grader applies and how loudly, plus what to call
 * it. Every one of them is optional on a create, and every one of them takes
 * effect everywhere the moment it is written.
 */
type LiveSettings = {
  readonly name: string;
  readonly description?: string | undefined;
  readonly priority?: Priority | undefined;
  readonly scope?: GraderScope | undefined;
  readonly productionSampleRate?: number | undefined;
};

export type NewGrader = LiveSettings & {
  readonly judgeModel?: JudgeModel | undefined;
} & NewGraderJudgment;

export type Grader = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly priority: Priority;
  readonly scope: GraderScope;
  readonly productionSampleRate: number;
  readonly version: number;
  /** The current version's own `grv_` id — what a verdict row names. */
  readonly versionId: string;
  readonly judgeModel: JudgeModel | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
} & GraderJudgment;

/**
 * What an edit may touch. The live settings write in place and version nothing;
 * the config and the judge model are what a verdict was decided by, and version
 * on any change. Absent means keep.
 *
 * **The type is deliberately not here.** Every version of a grader holds a
 * config that its type shapes, so changing the type would leave the versions
 * behind it holding parameters for a kind of judgment this grader no longer
 * makes — a different grader wearing the old one's history. Making a second
 * grader costs one call and says what actually happened.
 */
export type GraderChanges = {
  readonly name?: string;
  readonly description?: string | null;
  readonly priority?: Priority;
  readonly scope?: GraderScope;
  readonly productionSampleRate?: number;
  readonly config?: GraderConfigInput;
  readonly judgeModel?: JudgeModel | null;
};

/** One version, frozen: the grader exactly as some verdict was decided by it. */
export type GraderVersion = {
  readonly id: string;
  readonly graderId: string;
  readonly version: number;
  readonly judgeModel: JudgeModel | null;
  readonly createdAt: Date;
} & GraderJudgment;

const notDeleted: SQL = isNull(grader.deletedAt);

/** An answer's columns, and no more — the tenant-free view. */
const COLUMNS = {
  id: grader.id,
  projectId: grader.projectId,
  name: grader.name,
  description: grader.description,
  type: grader.type,
  priority: grader.priority,
  scope: grader.scope,
  productionSampleRate: grader.productionSampleRate,
  createdAt: grader.createdAt,
  updatedAt: grader.updatedAt,
} as const;

/**
 * What a grader is worth when its author said nothing about it.
 *
 * Blocking, because a check somebody bothered to write is a check they expect to
 * be believed, and a grader that quietly only warns is one whose failure a
 * release walks past. Demoting it is one word; noticing that it was never
 * blocking is a postmortem.
 */
const DEFAULT_PRIORITY: Priority = "P0";

/** All of production, if production is ever in scope at all. */
const DEFAULT_PRODUCTION_SAMPLE_RATE = 100;

function validName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("a grader needs a name");
  return trimmed;
}

/** One of a fixed list, or a refusal naming both the word and the list. */
function knownWord<Value extends string>(
  allowed: readonly Value[],
  value: string,
  what: string,
): Value {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(
      `"${value}" is not a ${what} egma knows; expected one of ${allowed.join(", ")}`,
    );
  }
  return value as Value;
}

function validPriority(priority: string): Priority {
  return knownWord(PRIORITIES, priority, "priority");
}

function validScope(scope: string): GraderScope {
  return knownWord(GRADER_SCOPES, scope, "scope");
}

/**
 * A percentage of the production traffic that arrives — whole numbers only,
 * because "judge 12.5% of the calls" is a promise about traffic egma cannot
 * keep any more precisely than it can count conversations.
 */
function validProductionSampleRate(rate: number): number {
  if (!Number.isInteger(rate) || rate < 0 || rate > 100) {
    throw new Error(
      "a production sample rate is a whole percentage between 0 and 100",
    );
  }
  return rate;
}

function validJudgeModel(judgeModel: JudgeModel): JudgeModel {
  const provider = knownWord(
    JUDGE_PROVIDERS,
    judgeModel.provider,
    "judge provider",
  );
  const model = judgeModel.model.trim();
  if (model === "") {
    throw new Error("a judge model override needs a model to name");
  }
  return { provider, model };
}

/**
 * The object something has to be before any field of it can be read, named by
 * what it is so a refusal points at the thing that is wrong rather than at the
 * grader as a whole.
 */
function fields(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} has to be an object`);
  }
  return value as Record<string, unknown>;
}

/** A list a caller may leave out entirely, which means it names nothing. */
function listOf(value: unknown, type: GraderType, field: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`a ${type} grader's ${field} has to be a list`);
  }
  return value;
}

function validLlmRubricConfig(config: unknown): LlmRubricConfig {
  const { rubric } = fields(config, "an llm_rubric grader's config");
  if (typeof rubric !== "string" || rubric.trim() === "") {
    throw new Error(
      "an llm_rubric grader needs a rubric: the criteria a judge reads, in words",
    );
  }
  return { rubric: rubric.trim() };
}

function validMetricThresholdConfig(config: unknown): MetricThresholdConfig {
  const { measure, aggregation, comparator, threshold } = fields(
    config,
    "a metric_threshold grader's config",
  );

  // Named against the measure catalog, not validated against it — that check
  // arrives with the catalog itself. Naming nothing is refused here and now,
  // because a threshold grader with no measure reads nothing and can never fire.
  if (typeof measure !== "string" || measure.trim() === "") {
    throw new Error(
      "a metric_threshold grader needs a measure: the name of what it reads",
    );
  }
  if (typeof aggregation !== "string") {
    throw new Error(
      `a metric_threshold grader needs an aggregation; expected one of ${MEASURE_AGGREGATIONS.join(", ")}`,
    );
  }
  if (typeof comparator !== "string") {
    throw new Error(
      `a metric_threshold grader needs a comparator; expected one of ${THRESHOLD_COMPARATORS.join(", ")}`,
    );
  }
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
    throw new Error(
      "a metric_threshold grader needs a threshold, and it has to be a number",
    );
  }

  return {
    measure: measure.trim(),
    aggregation: knownWord(MEASURE_AGGREGATIONS, aggregation, "aggregation"),
    comparator: knownWord(THRESHOLD_COMPARATORS, comparator, "comparator"),
    threshold,
  };
}

function validToolExpectations(
  value: unknown,
  field: "required" | "forbidden",
): readonly ToolExpectation[] {
  return listOf(value, "tool_calls", field).map((entry) => {
    const { tool, arguments: expected } = fields(
      entry,
      `a tool_calls grader's ${field} entry`,
    );
    if (typeof tool !== "string" || tool.trim() === "") {
      throw new Error(
        `a tool_calls grader needs a tool name on every ${field} entry`,
      );
    }
    if (expected !== undefined && expected !== null) {
      if (
        typeof expected !== "object" ||
        Array.isArray(expected)
      ) {
        throw new Error(
          `a tool_calls grader's ${field} arguments have to be an object of argument names and the values they must carry`,
        );
      }
    }
    return {
      tool: tool.trim(),
      arguments: (expected ?? null) as Readonly<Record<string, unknown>> | null,
    };
  });
}

function validToolCallsConfig(config: unknown): ToolCallsConfig {
  const { required, forbidden } = fields(
    config,
    "a tool_calls grader's config",
  );
  const judgment = {
    required: validToolExpectations(required, "required"),
    forbidden: validToolExpectations(forbidden, "forbidden"),
  };

  if (judgment.required.length === 0 && judgment.forbidden.length === 0) {
    throw new Error(
      "a tool_calls grader needs at least one required or forbidden tool, because one that names neither can never fail",
    );
  }
  return judgment;
}

function validPhrases(value: unknown, field: "required" | "banned"): readonly Phrase[] {
  return listOf(value, "phrase_match", field).map((entry) => {
    const { text, match } = fields(
      entry,
      `a phrase_match grader's ${field} phrase`,
    );
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error(
        `a phrase_match grader needs text on every ${field} phrase`,
      );
    }
    return {
      text: text.trim(),
      match:
        match === undefined || match === null
          ? "contains"
          : knownWord(PHRASE_MATCHES, String(match), "phrase match"),
    };
  });
}

function validPhraseMatchConfig(config: unknown): PhraseMatchConfig {
  const { required, banned, speaker } = fields(
    config,
    "a phrase_match grader's config",
  );
  const judgment = {
    required: validPhrases(required, "required"),
    banned: validPhrases(banned, "banned"),
    speaker:
      speaker === undefined || speaker === null
        ? ("agent" as PhraseSpeaker)
        : knownWord(PHRASE_SPEAKERS, String(speaker), "speaker"),
  };

  if (judgment.required.length === 0 && judgment.banned.length === 0) {
    throw new Error(
      "a phrase_match grader needs at least one required or banned phrase, because one that names neither can never fail",
    );
  }
  return judgment;
}

/**
 * A type and its config, checked together — the one write-door rule this
 * factory exists to hold. One entry per type, in a table the compiler holds
 * exhaustive: a fifth type refuses to build until it is also told what its
 * config must hold. A type that fell through with no validator would accept any
 * jsonb at all, and the first anyone would hear of it is a grader that judges
 * nothing.
 */
const judgmentOfType: {
  readonly [K in GraderType]: (config: unknown) => GraderJudgment;
} = {
  llm_rubric: (config) => ({
    type: "llm_rubric",
    config: validLlmRubricConfig(config),
  }),
  metric_threshold: (config) => ({
    type: "metric_threshold",
    config: validMetricThresholdConfig(config),
  }),
  tool_calls: (config) => ({
    type: "tool_calls",
    config: validToolCallsConfig(config),
  }),
  phrase_match: (config) => ({
    type: "phrase_match",
    config: validPhraseMatchConfig(config),
  }),
};

function validJudgment(type: string, config: unknown): GraderJudgment {
  return judgmentOfType[knownWord(GRADER_TYPES, type, "grader type")](config);
}

/**
 * The shape guard on every read. Stored jsonb comes back `unknown`, and a row
 * somebody hand-edited must fail here, loudly and naming itself, rather than
 * leak into a caller as a config that isn't one. Shape only, deliberately: the
 * aggregations, the comparators and the allowed providers may all grow or
 * tighten later, and an old version must stay readable exactly as it was
 * written — so a word egma no longer offers is taken on trust once it is a
 * string.
 */
function malformedAt(versionId: string): () => Error {
  return () =>
    new Error(
      `version ${versionId} holds a config in a shape egma never writes; the row needs repairing before anybody can read it`,
    );
}

function textFromRow(value: unknown, malformed: () => Error): string {
  if (typeof value !== "string" || value.trim() === "") throw malformed();
  return value;
}

function rowFields(
  value: unknown,
  malformed: () => Error,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed();
  }
  return value as Record<string, unknown>;
}

function listFromRow(value: unknown, malformed: () => Error): unknown[] {
  if (!Array.isArray(value)) throw malformed();
  return value;
}

const judgmentFromRowOfType: {
  readonly [K in GraderType]: (
    value: unknown,
    malformed: () => Error,
  ) => GraderJudgment;
} = {
  llm_rubric: (value, malformed) => ({
    type: "llm_rubric",
    config: { rubric: textFromRow(rowFields(value, malformed).rubric, malformed) },
  }),
  metric_threshold: (value, malformed) => {
    const { measure, aggregation, comparator, threshold } = rowFields(
      value,
      malformed,
    );
    if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
      throw malformed();
    }
    return {
      type: "metric_threshold",
      config: {
        measure: textFromRow(measure, malformed),
        aggregation: textFromRow(aggregation, malformed) as MeasureAggregation,
        comparator: textFromRow(comparator, malformed) as ThresholdComparator,
        threshold,
      },
    };
  },
  tool_calls: (value, malformed) => {
    const { required, forbidden } = rowFields(value, malformed);
    const tools = (entries: unknown): readonly ToolExpectation[] =>
      listFromRow(entries, malformed).map((entry) => {
        const { tool, arguments: expected } = rowFields(entry, malformed);
        if (expected !== null && typeof expected !== "object") throw malformed();
        if (Array.isArray(expected)) throw malformed();
        return {
          tool: textFromRow(tool, malformed),
          arguments: expected as Readonly<Record<string, unknown>> | null,
        };
      });
    return {
      type: "tool_calls",
      config: { required: tools(required), forbidden: tools(forbidden) },
    };
  },
  phrase_match: (value, malformed) => {
    const { required, banned, speaker } = rowFields(value, malformed);
    const phrases = (entries: unknown): readonly Phrase[] =>
      listFromRow(entries, malformed).map((entry) => {
        const phrase = rowFields(entry, malformed);
        return {
          text: textFromRow(phrase.text, malformed),
          match: textFromRow(phrase.match, malformed) as PhraseMatch,
        };
      });
    return {
      type: "phrase_match",
      config: {
        required: phrases(required),
        banned: phrases(banned),
        speaker: textFromRow(speaker, malformed) as PhraseSpeaker,
      },
    };
  },
};

function judgmentFromRow(
  type: string,
  config: unknown,
  versionId: string,
): GraderJudgment {
  const malformed = malformedAt(versionId);
  const known = GRADER_TYPES.find((candidate) => candidate === type);
  if (known === undefined) throw malformed();
  return judgmentFromRowOfType[known](config, malformed);
}

function judgeModelFromRow(
  value: unknown,
  versionId: string,
): JudgeModel | null {
  if (value === null || value === undefined) return null;
  const malformed = malformedAt(versionId);
  const { provider, model } = rowFields(value, malformed);
  return {
    provider: textFromRow(provider, malformed) as JudgeProvider,
    model: textFromRow(model, malformed),
  };
}

/**
 * Two stored JSON values, compared as values rather than as text: key order is
 * whatever jsonb decided on the way in, and two argument constraints that
 * differ only in that order are one constraint. Written here rather than taken
 * from a serializer, for the reason every other comparator in this module is —
 * a serializer that reordered keys differently on two occasions would mint a
 * version out of nothing.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => sameJson(entry, b[index]))
    );
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const left = Object.keys(a).sort();
    const right = Object.keys(b).sort();
    return (
      left.length === right.length &&
      left.every((key, index) => key === right[index]) &&
      left.every((key) =>
        sameJson(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
      )
    );
  }
  return false;
}

/**
 * Byte-identical or not, decided field by field — the same answer canonical
 * serialization would give, without trusting any serializer to order keys the
 * way jsonb re-ordered them.
 *
 * One comparator per type, in a table the compiler holds exhaustive, and one
 * comparator per field inside each: a field added to a config refuses to build
 * until it is also told how to compare. A hand-maintained comparator that missed
 * a field would call two different configs identical, and an edit would vanish
 * without a version — the one loss the whole versioning exists to rule out.
 */
const sameConfigOfType: {
  readonly [K in GraderType]: (a: ConfigOf[K], b: ConfigOf[K]) => boolean;
} = {
  llm_rubric: (a, b) => a.rubric === b.rubric,
  metric_threshold: (a, b) =>
    a.measure === b.measure &&
    a.aggregation === b.aggregation &&
    a.comparator === b.comparator &&
    a.threshold === b.threshold,
  tool_calls: (a, b) =>
    sameTools(a.required, b.required) && sameTools(a.forbidden, b.forbidden),
  phrase_match: (a, b) =>
    a.speaker === b.speaker &&
    samePhrases(a.required, b.required) &&
    samePhrases(a.banned, b.banned),
};

function sameTools(
  a: readonly ToolExpectation[],
  b: readonly ToolExpectation[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, index) =>
        entry.tool === b[index]?.tool &&
        sameJson(entry.arguments, b[index]?.arguments),
    )
  );
}

function samePhrases(a: readonly Phrase[], b: readonly Phrase[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (phrase, index) =>
        phrase.text === b[index]?.text && phrase.match === b[index]?.match,
    )
  );
}

function sameJudgment(stored: GraderJudgment, next: GraderJudgment): boolean {
  if (stored.type !== next.type) return false;
  // A grader's type is set at creation and never edited, so both sides are
  // always the same kind. The compiler cannot see that the entry keyed by one
  // side's type is the entry the other side's config fits, so this says so.
  const same = sameConfigOfType[stored.type] as (
    a: GraderConfig,
    b: GraderConfig,
  ) => boolean;
  return same(stored.config, next.config);
}

function sameJudgeModel(a: JudgeModel | null, b: JudgeModel | null): boolean {
  if (a === null || b === null) return a === b;
  return a.provider === b.provider && a.model === b.model;
}

/** Acting in a project narrows to it; acting in none reaches the customer. */
function inActingProject(auth: AuthContext): SQL | undefined {
  return auth.projectId === undefined
    ? undefined
    : eq(grader.projectId, auth.projectId);
}

/** The named grader, alive, within the caller's tenancy and scope. */
function theGrader(auth: AuthContext, id: string): SQL {
  return within(
    auth,
    grader,
    and(eq(grader.id, id), notDeleted, inActingProject(auth)),
  );
}

/** What a read hands back, from the row the identity and version join made. */
function answer(row: {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: string;
  readonly priority: string;
  readonly scope: string;
  readonly productionSampleRate: number;
  readonly version: number;
  readonly versionId: string;
  readonly config: unknown;
  readonly judgeModel: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): Grader {
  const { type, config, judgeModel, priority, scope, ...rest } = row;
  return {
    ...rest,
    // The identity row's own enumerated columns are pinned by check
    // constraints, so what comes back is one of the words this module writes.
    priority: priority as Priority,
    scope: scope as GraderScope,
    ...judgmentFromRow(type, config, row.versionId),
    judgeModel: judgeModelFromRow(judgeModel, row.versionId),
  };
}

/**
 * The grader and its first version, or neither. The identity row goes in first
 * naming a version that does not exist yet — its pointer's constraint is
 * deferred, so Postgres checks it at commit — and anything that fails on the way
 * out takes the whole write with it.
 */
export async function createGrader(
  auth: AuthContext,
  input: NewGrader,
): Promise<Grader> {
  authorize(auth, "author_definitions", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "a grader belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  // Everything answerable without the database is answered first; only an input
  // worth writing costs the project-membership read below.
  const name = validName(input.name);
  const judgment = validJudgment(input.type, input.config);
  const judgeModel =
    input.judgeModel === undefined ? null : validJudgeModel(input.judgeModel);
  const priority =
    input.priority === undefined
      ? DEFAULT_PRIORITY
      : validPriority(input.priority);
  const scope = input.scope === undefined ? "simulations" : validScope(input.scope);
  const productionSampleRate =
    input.productionSampleRate === undefined
      ? DEFAULT_PRODUCTION_SAMPLE_RATE
      : validProductionSampleRate(input.productionSampleRate);

  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  const id = newId("grd");
  const versionId = newId("grv");

  const written = await db().transaction(async (tx) => {
    const [identity] = await tx
      .insert(grader)
      .values({
        id,
        organizationId: auth.organizationId,
        projectId,
        name,
        description: input.description ?? null,
        type: judgment.type,
        priority,
        scope,
        productionSampleRate,
        currentVersionId: versionId,
        createdBy: auth.userId,
      })
      .returning(COLUMNS);

    if (identity === undefined) throw new Error("the grader was not written");

    await tx.insert(graderVersion).values({
      id: versionId,
      graderId: id,
      version: 1,
      config: judgment.config,
      judgeModel,
      createdBy: auth.userId,
    });

    return identity;
  });

  return {
    ...written,
    priority,
    scope,
    version: 1,
    versionId,
    ...judgment,
    judgeModel,
  };
}

/**
 * The identity row joined to its current version — the shape `get` and `list`
 * both answer with, written once so the two can never drift.
 */
function selectWithCurrentVersion() {
  return db()
    .select({
      ...COLUMNS,
      version: graderVersion.version,
      versionId: graderVersion.id,
      config: graderVersion.config,
      judgeModel: graderVersion.judgeModel,
    })
    .from(grader)
    .innerJoin(graderVersion, eq(grader.currentVersionId, graderVersion.id));
}

/**
 * One grader with what it currently judges by: its type and config, the judge it
 * insists on if any, and the live settings saying where it applies and how
 * loudly.
 */
export async function getGrader(
  auth: AuthContext,
  id: string,
): Promise<Grader | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await selectWithCurrentVersion()
    .where(theGrader(auth, id))
    .limit(1);

  if (row === undefined) return undefined;
  return answer(row);
}

/**
 * One door for every change, so no caller needs the version rules to pick a
 * function — the rules live here. The live settings write in place and version
 * nothing, and read back immediately, because none of them changes what any
 * verdict already written meant. The config and the judge model are what a
 * verdict was decided by: either of them differing from the current version
 * inserts the next version and moves the pointer, in one transaction with the
 * identity row locked, so two concurrent edits number one after the other rather
 * than fighting over the same version number. The version being left behind is
 * never touched, because a verdict that named it must still say what decided it.
 * Content byte-identical to the current version is not an edit at all: nothing
 * is written, not even `updated_at`, and the current version comes back.
 *
 * What an edit leaves out, it keeps — and a config it does give is checked
 * against the type the grader already has, which is the only type it will ever
 * have.
 *
 * Editing what the caller cannot see returns what reading it would have:
 * `undefined`, with nothing disturbed.
 */
export async function editGrader(
  auth: AuthContext,
  id: string,
  changes: GraderChanges,
): Promise<Grader | undefined> {
  authorize(auth, "author_definitions", here(auth));

  // Everything answerable without the database is answered first, exactly as
  // create answers it, so an edit is refused on the same grounds a create is.
  // The config is the one thing that cannot be judged yet: what it must hold
  // depends on the type of the row this edit has not read.
  const name = changes.name === undefined ? undefined : validName(changes.name);
  const priority =
    changes.priority === undefined ? undefined : validPriority(changes.priority);
  const scope =
    changes.scope === undefined ? undefined : validScope(changes.scope);
  const productionSampleRate =
    changes.productionSampleRate === undefined
      ? undefined
      : validProductionSampleRate(changes.productionSampleRate);
  const judgeModel =
    changes.judgeModel === undefined || changes.judgeModel === null
      ? changes.judgeModel
      : validJudgeModel(changes.judgeModel);

  return db().transaction(async (tx) => {
    const [locked] = await tx
      .select({ ...COLUMNS, currentVersionId: grader.currentVersionId })
      .from(grader)
      .where(theGrader(auth, id))
      .limit(1)
      .for("update");

    if (locked === undefined) return undefined;
    const { currentVersionId, ...current } = locked;

    // This select and the update below are the two `where`s in this file that
    // start from a bare `eq` rather than `within`: each names an id that just
    // came off the tenancy-checked row locked above, in this same transaction,
    // so neither predicate can reach further than that check already did.
    const [currentVersion] = await tx
      .select({
        id: graderVersion.id,
        version: graderVersion.version,
        config: graderVersion.config,
        judgeModel: graderVersion.judgeModel,
      })
      .from(graderVersion)
      .where(eq(graderVersion.id, currentVersionId))
      .limit(1);
    if (currentVersion === undefined) {
      throw new Error("the grader's current version is missing");
    }

    const stored = judgmentFromRow(
      current.type,
      currentVersion.config,
      currentVersion.id,
    );
    const storedJudgeModel = judgeModelFromRow(
      currentVersion.judgeModel,
      currentVersion.id,
    );

    // Omitted means unchanged, and the type is the row's rather than the
    // caller's: an edit says what the grader judges by, never what kind of
    // grader it is.
    const judgment =
      changes.config === undefined
        ? stored
        : validJudgment(current.type, changes.config);
    const nextJudgeModel =
      judgeModel === undefined ? storedJudgeModel : judgeModel;

    const mintsVersion =
      !sameJudgment(stored, judgment) ||
      !sameJudgeModel(storedJudgeModel, nextJudgeModel);
    const settingsChanged =
      changes.name !== undefined ||
      changes.description !== undefined ||
      priority !== undefined ||
      scope !== undefined ||
      productionSampleRate !== undefined;

    const settled = {
      ...current,
      priority: priority ?? (current.priority as Priority),
      scope: scope ?? (current.scope as GraderScope),
      productionSampleRate: productionSampleRate ?? current.productionSampleRate,
    };

    if (!mintsVersion && !settingsChanged) {
      return {
        ...settled,
        version: currentVersion.version,
        versionId: currentVersion.id,
        ...stored,
        judgeModel: storedJudgeModel,
      };
    }

    let versionId = currentVersion.id;
    let version = currentVersion.version;
    if (mintsVersion) {
      versionId = newId("grv");
      version = currentVersion.version + 1;
      await tx.insert(graderVersion).values({
        id: versionId,
        graderId: current.id,
        version,
        config: judgment.config,
        judgeModel: nextJudgeModel,
        createdBy: auth.userId,
      });
    }

    const [updated] = await tx
      .update(grader)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(changes.description === undefined
          ? {}
          : { description: changes.description }),
        ...(priority === undefined ? {} : { priority }),
        ...(scope === undefined ? {} : { scope }),
        ...(productionSampleRate === undefined ? {} : { productionSampleRate }),
        ...(mintsVersion ? { currentVersionId: versionId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(grader.id, current.id))
      .returning(COLUMNS);

    if (updated === undefined) throw new Error("the grader was not written");
    return answer({
      ...updated,
      version,
      versionId,
      config: judgment.config,
      judgeModel: nextJudgeModel,
    });
  });
}

/**
 * One frozen version, by its own `grv_` id — the read that keeps a verdict
 * interpretable after the grader moves on: exactly what decided it, in the
 * words it was decided by.
 *
 * Deliberately no deleted filter: versions outlive their grader's deletion, so a
 * verdict that named one can always say what judged it.
 */
export async function getGraderVersion(
  auth: AuthContext,
  versionId: string,
): Promise<GraderVersion | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select({
      id: graderVersion.id,
      graderId: graderVersion.graderId,
      version: graderVersion.version,
      type: grader.type,
      config: graderVersion.config,
      judgeModel: graderVersion.judgeModel,
      createdAt: graderVersion.createdAt,
    })
    .from(graderVersion)
    .innerJoin(grader, eq(graderVersion.graderId, grader.id))
    .where(
      within(
        auth,
        grader,
        and(eq(graderVersion.id, versionId), inActingProject(auth)),
      ),
    )
    .limit(1);

  if (row === undefined) return undefined;

  const { type, config, judgeModel, ...rest } = row;
  return {
    ...rest,
    ...judgmentFromRow(type, config, row.id),
    judgeModel: judgeModelFromRow(judgeModel, row.id),
  };
}

/**
 * One page of the graders the caller can reach — the acting project's, or the
 * whole customer's for a credential acting in none — and where the next page
 * starts.
 *
 * Newest first, on the id, which is the mint order; the page rules are the
 * three lists before this one's, written once in `pages.ts`.
 */
export type GraderPage = {
  readonly items: readonly Grader[];
  /** Hand back as `cursor` to continue; absent on the last page. */
  readonly nextCursor: string | undefined;
};

export async function listGraders(
  auth: AuthContext,
  page?: PageRequest,
): Promise<GraderPage> {
  authorize(auth, "read", here(auth));

  const { limit, cursor } = pageWindow(page, {
    singular: "grader",
    plural: "graders",
    prefix: "grd",
  });
  const olderThanCursor =
    cursor === undefined ? undefined : lt(grader.id, cursor);

  const rows = await selectWithCurrentVersion()
    .where(
      within(
        auth,
        grader,
        and(notDeleted, inActingProject(auth), olderThanCursor),
      ),
    )
    .orderBy(desc(grader.id))
    .limit(limit + 1);

  const { items, nextCursor } = pageOf(rows, limit);
  return { items: items.map(answer), nextCursor };
}

/**
 * Whether this grader judges the production trace in front of it — and the
 * accumulator moved on by one trace, whatever the answer.
 *
 * **Deterministic, and that is the entire point.** The rate is added to the
 * accumulator; crossing a hundred is this grader's turn and takes a hundred back
 * off. A quarter is every fourth trace, exactly; a hundred per cent is all of
 * them and nought per cent is none; a rate that divides a hundred less neatly
 * spends what it accumulates and carries the remainder rather than rounding it
 * away. A customer who chose 25% and watched four calls go past can be shown
 * which one was judged and why the other three were not, which is an answer
 * randomness cannot give at any price.
 *
 * The crossing is read back off the accumulator rather than remembered: after
 * adding a rate under a hundred, the remainder is *below* the rate exactly when
 * a hundred came off it, because what is left is `before + rate - 100` and
 * `before` was under a hundred to begin with. At a hundred per cent the
 * accumulator never moves and is always under the rate — every trace, as
 * promised — and at nought it never moves and is never under it. So the whole
 * rule is one statement with no read before the write, which is also what makes
 * two copies of the grader service judging two traces at once share one sequence
 * instead of racing to the same tick.
 *
 * **Forward only.** The accumulator says where sampling has got to and nothing
 * about which traces were judged, so raising a rate speeds the next decision up
 * and lowering it slows the next one down; neither reaches back. Nothing is
 * re-judged and nothing is deleted, on exactly the same terms as an edit to a
 * scope.
 *
 * A retried job takes another tick. A copy of the service that died mid-judgment
 * and a second copy that picks the conversation up are two decisions about one
 * trace, and the phase shifts by one — never the rate. The alternative is
 * remembering every trace every grader ever declined, which is a table that
 * grows with traffic to answer a question nobody asks.
 *
 * No permission is asked for, on the same terms as `appendVerdicts`: what may
 * judge is decided by holding the claim, and this is egma's own count of how
 * often it did rather than anything the customer wrote. A grader nobody can
 * reach from this context judges nothing — the safe direction, and the only one.
 */
export async function advanceProductionSampling(
  auth: AuthContext,
  graderId: string,
): Promise<boolean> {
  const [row] = await db()
    .update(grader)
    .set({
      productionSampleAccumulator: sql`(${grader.productionSampleAccumulator} + ${grader.productionSampleRate}) % 100`,
    })
    // Deliberately not `updated_at`: this is traffic passing, not somebody
    // editing a grader, and a definition whose modified time moved every time a
    // call came in would make "what changed on Tuesday" unanswerable.
    .where(theGrader(auth, graderId))
    .returning({
      accumulator: grader.productionSampleAccumulator,
      rate: grader.productionSampleRate,
    });

  return row !== undefined && row.accumulator < row.rate;
}

export type DeletedGrader = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly deletedAt: Date;
};

/**
 * The soft-delete marker, and only the marker. The grader vanishes from lists
 * and fetches at once; the version rows stay exactly where they are, because a
 * verdict that named one must stay interpretable for as long as it is kept.
 *
 * **Refused while the current version of a live test names it**, naming every
 * test standing in the way; `GraderNamedByTestsError` says why. Historical
 * versions never block, and neither does a deleted test — the persona's rule,
 * for the persona's reason: a live test would quietly stop checking something
 * somebody wrote down, and a suite going green because a check disappeared is
 * the exact false trust this product exists to kill.
 *
 * Like create, this refuses a credential acting in no project. An edit lands on
 * a row that already names its own project; a delete decides the grader should
 * stop appearing in one, and emptying a project is an act taken from inside it.
 */
export async function deleteGrader(
  auth: AuthContext,
  id: string,
): Promise<DeletedGrader | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "deleting a grader happens inside its project, and this credential is for the whole organization and acting in none",
    );
  }

  const deletedAt = new Date();
  return db().transaction(async (tx) => {
    // Locked before the tests naming it are counted, and held until this
    // transaction ends, so nothing can come to name it between the count and
    // the write — which a count taken on this transaction's own snapshot could
    // not promise. The other half is the shared lock a test being written takes
    // on this same row, which `validateNamedGraders` in `tests.ts` explains.
    const [locked] = await tx
      .select({ id: grader.id })
      .from(grader)
      .where(theGrader(auth, id))
      .limit(1)
      .for("update");

    if (locked === undefined) return undefined;

    const blocking = await liveTestsNamingGrader(tx, locked.id);
    if (blocking.length > 0) {
      throw new GraderNamedByTestsError(locked.id, blocking);
    }

    // A bare `eq` on an id that just came off the tenancy-checked row locked
    // above, in this same transaction, so it reaches no further than that check
    // already did — the move `editGrader` makes, for the same reason.
    const [row] = await tx
      .update(grader)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(eq(grader.id, locked.id))
      .returning({
        id: grader.id,
        projectId: grader.projectId,
        name: grader.name,
      });

    if (row === undefined) throw new Error("the grader was not written");
    return { ...row, deletedAt };
  });
}
