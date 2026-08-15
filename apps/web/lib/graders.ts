/**
 * The graders of one project, as `GET /api/graders` answers them — and the
 * shelf of everything egma can judge with, which is a larger thing than the
 * rows.
 *
 * A **grader** is authored logic that produces a verdict. A metric measures and
 * a grader judges: nobody decided that a call took four minutes, and somebody
 * had to decide that verifying identity before disclosing a balance matters and
 * write the criteria down.
 *
 * The shapes are the API's own, field names included. Renaming its fields on
 * the way in would put a second vocabulary between the contract and the page,
 * and the two would drift the first time the API grew a field.
 *
 * **The one thing this module holds an opinion about is the split.** A grader's
 * live half and its versioned half are edited from one form and saved by two
 * rules, and a page that mixed them up would either fill a history with renames
 * or quietly rewrite what last week's run meant. So the split is written down
 * once, here, and every control asks it rather than remembering.
 */

export type GraderType =
  | "llm_rubric"
  | "metric_threshold"
  | "tool_calls"
  | "phrase_match";

export type GraderRead = "transcript" | "outcome" | "tool_calls" | "measures";

export type Modality = "voice" | "chat";

export type Priority = "P0" | "P1" | "P2";

export type Scope = "simulations" | "production" | "both";

export type JudgeModel = {
  readonly provider: string;
  readonly model: string;
};

export type ListedGrader = {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: GraderType;
  readonly priority: Priority;
  readonly scope: Scope;
  readonly production_sample_rate: number;
  readonly revision: string;
  readonly archived_at: string | null;
  readonly version: number;
  readonly version_id: string;
  readonly config: Record<string, unknown>;
  readonly judge_model: JudgeModel | null;
  readonly reads: readonly GraderRead[];
  readonly modalities: readonly Modality[];
  readonly created_at: string;
  readonly updated_at: string;
};

export type GraderPage = {
  readonly items: readonly ListedGrader[];
  readonly next_cursor: string | null;
};

export type GraderVersionRow = {
  readonly id: string;
  readonly version: number;
  readonly type: GraderType;
  readonly config: Record<string, unknown>;
  readonly judge_model: JudgeModel | null;
  readonly reads: readonly GraderRead[];
  readonly modalities: readonly Modality[];
  readonly created_at: string;
};

export type GraderVersionPage = {
  readonly items: readonly GraderVersionRow[];
};

export type GraderUsage = {
  readonly direct_tests: readonly { readonly id: string; readonly name: string }[];
  readonly applies_to_every_test_by_default: boolean;
};

/** One authored type, as the server's own registry describes it. */
export type RegisteredType = {
  readonly type: GraderType;
  readonly reads: readonly GraderRead[];
  readonly reads_are_fixed: boolean;
  readonly modalities: readonly Modality[];
  readonly judged: boolean;
};

/**
 * The built-in, as the shelf shows it.
 *
 * It is never a row and never an attachment: applying it is part of what
 * running a test means. The four flags are what a shelf has to state so that
 * nobody goes looking for the row or tries to take it off.
 */
export type BuiltInGrader = {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly reads: readonly GraderRead[];
  readonly modalities: readonly Modality[];
  readonly judged: boolean;
  readonly implicit: boolean;
  readonly always_active: boolean;
  readonly editable: boolean;
  readonly removable: boolean;
};

export type GraderRegistry = {
  readonly types: readonly RegisteredType[];
  readonly reads: readonly GraderRead[];
  readonly priorities: readonly Priority[];
  readonly scopes: readonly Scope[];
  readonly built_in: readonly BuiltInGrader[];
};

export const GRADER_REGISTRY_PATH = "/api/grader-registry";
export const GRADERS_PATH = "/api/graders";

export function gradersPath(options: {
  readonly archived?: boolean;
  readonly cursor?: string;
}): string {
  const query = new URLSearchParams();
  if (options.archived === true) query.set("archived", "true");
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  const search = query.toString();
  return search === "" ? GRADERS_PATH : `${GRADERS_PATH}?${search}`;
}

export function graderPath(graderId: string): string {
  return `${GRADERS_PATH}/${encodeURIComponent(graderId)}`;
}

export function graderVersionsPath(graderId: string): string {
  return `${graderPath(graderId)}/versions`;
}

export function graderUsagePath(graderId: string): string {
  return `${graderPath(graderId)}/usage`;
}

/**
 * What a person is told a type judges by, in one line.
 *
 * On the shelf beside the name, because "llm_rubric" is a word for a schema and
 * not for a decision somebody made. The built-in's own line comes from the
 * server with it, because it is the server that knows what the built-in does.
 */
export const TYPE_SUMMARY: Readonly<Record<GraderType, string>> = {
  llm_rubric: "Asks a judge model to decide, against criteria you write.",
  metric_threshold: "Turns one measured number into a pass or a fail.",
  tool_calls: "Checks which of the agent's tools fired, and which never should.",
  phrase_match: "Looks for words that must be said, and words that must not.",
};

/**
 * Which fields of a grader are live, and which are versioned content.
 *
 * **This is the split the whole editor is built around.** The live ones take
 * effect everywhere the moment they are written and change nothing about any
 * verdict already made. The versioned ones are what a verdict was *decided by*,
 * so an edit to any of them mints an immutable version and applies from then
 * on — last week's run keeps meaning exactly what it meant.
 *
 * A page reads this rather than knowing it, so the label beside a control and
 * the request the control sends can never disagree about which kind of change
 * somebody is making.
 */
export const LIVE_FIELDS = [
  "name",
  "description",
  "priority",
  "scope",
  "production_sample_rate",
] as const;

export const VERSIONED_FIELDS = [
  "config",
  "judge_model",
  "reads",
  "modalities",
] as const;

export type LiveField = (typeof LIVE_FIELDS)[number];
export type VersionedField = (typeof VERSIONED_FIELDS)[number];

export function isVersioned(field: string): field is VersionedField {
  return (VERSIONED_FIELDS as readonly string[]).includes(field);
}

/**
 * What the production sampling control is for, and when it means anything.
 *
 * A rate is a promise about traffic egma did not cause, so it only says
 * anything once production is in scope. Showing it for a simulations-only
 * grader would offer somebody a number that changes nothing.
 */
export function samplingApplies(scope: Scope): boolean {
  return scope === "production" || scope === "both";
}

/**
 * Whether this type lets its author choose what the grader reads.
 *
 * The answer comes off the server's registry rather than off a list here: a
 * second copy would be free to disagree with the engine about what a
 * `metric_threshold` looks at, and the disagreement would arrive as a check
 * that can never fire.
 */
export function readsAreChosen(
  registry: GraderRegistry | null,
  type: GraderType,
): boolean {
  const registered = registry?.types.find((one) => one.type === type);
  return registered !== undefined && !registered.reads_are_fixed;
}

/** The reads a new grader of this type starts with, from the same registry. */
export function defaultReads(
  registry: GraderRegistry | null,
  type: GraderType,
): readonly GraderRead[] {
  return registry?.types.find((one) => one.type === type)?.reads ?? [];
}

/**
 * A set as the server settles it: the registry's own order, duplicates gone.
 *
 * Two orders of one set are one set, and saving the same set twice must mint no
 * version — so the page hands the server what the server would have stored,
 * and "nothing changed" is visible before the request rather than after it.
 */
export function settled<Value extends string>(
  order: readonly Value[],
  chosen: readonly string[],
): readonly Value[] {
  return order.filter((value) => chosen.includes(value));
}

/** Whether a set may be saved at all. One that names nothing can never fire. */
export function isUsableSet(chosen: readonly string[]): boolean {
  return chosen.length > 0;
}
