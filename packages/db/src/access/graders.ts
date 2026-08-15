import { newId } from "@egma/ids";
import {
  isCatalogedMeasure,
  CATALOGED_MEASURES,
  MEASURE_CATALOG_DOCUMENT,
  MEASURE_CATALOG_VERSION,
} from "@egma/simulation-contract";
import { and, desc, eq, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import {
  GRADER_LIBRARY_CATALOG,
  PREDEFINED_GRADERS,
  type LibraryParameter,
  type PredefinedGrader,
} from "../grader-library/catalog.ts";
import {
  grader,
  graderLibrary,
  graderVersion,
  GRADER_SCOPES,
  JUDGE_PROVIDERS,
  type GraderScope,
  type JudgeProvider,
  type LibraryType,
} from "../schema/graders.ts";
import type { AuthContext } from "./context.ts";
import {
  ProjectOutsideOrganizationError,
  UnknownGraderLibraryEntryError,
  UnprocessableInputError,
} from "./errors.ts";
import { pageOf, pageWindow, type PageRequest } from "./pages.ts";
import { authorize, here } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { inActingProject, within } from "./within.ts";

/**
 * Reading and writing the **running copies** — what they are is the schema
 * file's story (`schema/graders.ts`); this file is how they are reached.
 *
 * Project scoping works as the persona and test factories' does, verb for verb.
 * A context acting in a project writes and reads there; a context acting in none
 * — an organization-scoped credential — reads the whole customer and creates
 * nothing, because a grader belongs to a project and a credential for the whole
 * customer is acting in none.
 *
 * **There is one door that makes a grader, and it is Use.** A copy is only ever
 * made from a library entry: the entry decides the type and what the form asks
 * for, the copy holds the answers. That is why nothing here takes a type, and
 * why nothing here takes criteria — a grader nobody could point at a definition
 * would be a check with no words behind it, and the whole two-level shape exists
 * so that the words live in one place and are read through the pointer at
 * judging time.
 *
 * The line this factory holds that the two before it do not is **between what a
 * verdict was decided by and where the decision applies.** The filled-in values
 * and the judge model are what a judgment is made of, so they live in immutable
 * versions and an edit mints the next one, leaving last week's run meaning
 * exactly what it meant. The `required` flag, the scope and the sampling rate
 * change nothing about any judgment already made, so they are written in place
 * and take effect everywhere at once. A developer tightening a bound and a
 * developer turning a blocker into a diagnostic are doing two different things,
 * and only one of them is rewriting history if it is versioned wrongly.
 */

/**
 * The judges egma can ask live beside the other closed vocabularies, in the
 * schema, because the project's default judge is a table of its own and the two
 * must name the same list.
 */
export type { JudgeProvider };

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

/**
 * One **assertion's** filled-in values: the answers to what the library entry's
 * form asked, keyed by the parameter names the entry declared.
 *
 * A latency copy's is `{ metric, bound }`. There is no shape here for anything
 * else, and deliberately: what may be asked is the entry's decision, checked at
 * the write door against the entry's own declaration, so a value nobody could
 * have been asked for cannot be stored.
 */
export type GraderAssertion = Readonly<Record<string, string | number>>;

/**
 * What a copy judges by: one filled-in set per assertion, in the order they
 * were written.
 *
 * **Empty is a complete answer, not an unfinished one.** The expected-behaviors
 * copy holds no assertions of its own because its assertions are the test's own
 * sentences, supplied per test at judging time — so an empty list is what a
 * correctly configured copy of it looks like, forever.
 */
export type GraderConfig = {
  readonly assertions: readonly GraderAssertion[];
};

/** The config as a caller writes one; the same shape, before it is checked. */
export type GraderConfigInput = {
  readonly assertions: readonly Readonly<Record<string, unknown>>[];
};

/**
 * The live settings: where the copy applies, how loudly, and what to call it.
 * Every one of them is optional at Use time, and every one of them takes effect
 * everywhere the moment it is written.
 */
type LiveSettings = {
  /** Defaults to the entry's own name — what the shelf calls this grader. */
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly required?: boolean | undefined;
  readonly scope?: GraderScope | undefined;
  readonly productionSampleRate?: number | undefined;
};

/**
 * Pressing **Use** on a library entry: the pointer, and the answers to whatever
 * that entry's form asked.
 *
 * `params` is **one filled-in set**, because that is what the form is — one
 * measure and one bound, typed once. It becomes the copy's first and only
 * assertion. An entry that asks nothing takes nothing here, and the copy is born
 * with an empty list.
 */
export type UseLibraryEntry = LiveSettings & {
  readonly libraryId: string;
  readonly params?: Readonly<Record<string, unknown>> | undefined;
  readonly judgeModel?: JudgeModel | undefined;
};

export type Grader = {
  readonly id: string;
  readonly projectId: string;
  /** The entry this is a copy of. Never null, and never orphaned. */
  readonly libraryId: string;
  readonly name: string;
  readonly description: string | null;
  /** Copied from the entry at Use time and frozen there. */
  readonly type: LibraryType;
  /** `false` makes this a diagnostic: judged, shown, never able to fail a test. */
  readonly required: boolean;
  readonly scope: GraderScope;
  readonly productionSampleRate: number;
  readonly version: number;
  /** The current version's own `grv_` id — what a verdict row names. */
  readonly versionId: string;
  readonly config: GraderConfig;
  readonly judgeModel: JudgeModel | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * What an edit may touch. The live settings write in place and version nothing;
 * the filled-in values and the judge model are what a verdict was decided by,
 * and version on any change. Absent means keep.
 *
 * **Neither the type nor the pointer is here.** A copy's type came from its
 * entry and every version behind it holds values that type shapes, so changing
 * either would leave the history holding answers to questions this grader no
 * longer asks — a different grader wearing the old one's history. Pressing Use
 * again costs one call and says what actually happened.
 */
export type GraderChanges = {
  readonly name?: string;
  readonly description?: string | null;
  readonly required?: boolean;
  readonly scope?: GraderScope;
  readonly productionSampleRate?: number;
  readonly config?: GraderConfigInput;
  readonly judgeModel?: JudgeModel | null;
};

/** One version, frozen: the copy exactly as some verdict was decided by it. */
export type GraderVersion = {
  readonly id: string;
  readonly graderId: string;
  readonly version: number;
  readonly type: LibraryType;
  readonly config: GraderConfig;
  readonly judgeModel: JudgeModel | null;
  readonly createdAt: Date;
};

const notDeleted: SQL = isNull(grader.deletedAt);

/** An answer's columns, and no more — the tenant-free view. */
const COLUMNS = {
  id: grader.id,
  projectId: grader.projectId,
  libraryId: grader.libraryId,
  name: grader.name,
  description: grader.description,
  type: grader.type,
  required: grader.required,
  scope: grader.scope,
  productionSampleRate: grader.productionSampleRate,
  createdAt: grader.createdAt,
  updatedAt: grader.updatedAt,
} as const;

/**
 * What a copy is worth when whoever pressed Use said nothing about it.
 *
 * Blocking, because a grader somebody bothered to switch on is a grader they
 * expect to be believed, and one that quietly only reports is one whose failure
 * a release walks past. Making it a diagnostic is one word; noticing that it
 * never blocked anything is a postmortem.
 */
const DEFAULT_REQUIRED = true;

/** All of production, if production is ever in scope at all. */
const DEFAULT_PRODUCTION_SAMPLE_RATE = 100;

function validName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new UnprocessableInputError("a grader needs a name");
  return trimmed;
}

/** One of a fixed list, or a refusal naming both the word and the list. */
function knownWord<Value extends string>(
  allowed: readonly Value[],
  value: string,
  what: string,
): Value {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UnprocessableInputError(
      `"${value}" is not a ${what} egma knows; expected one of ${allowed.join(", ")}`,
    );
  }
  return value as Value;
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
    throw new UnprocessableInputError(
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
    throw new UnprocessableInputError(
      "a judge model override needs a model to name",
    );
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
    throw new UnprocessableInputError(`${what} has to be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * What the write door needs off a library entry: the type it copies down, and
 * the declaration every filled-in value is checked against.
 */
type Definition = {
  readonly id: string;
  readonly name: string;
  readonly type: LibraryType;
  readonly params: readonly LibraryParameter[];
};

/**
 * The entry this copy is being made from, or a refusal naming it.
 *
 * **Read through the same door the Library screen reads**: egma's own entries,
 * which belong to nobody and are therefore on everybody's shelf, plus the
 * caller's own organization's when custom authoring arrives. An entry belonging
 * to another customer is not refused differently from one that does not exist,
 * because saying which it was would answer a question about somebody else's
 * shelf.
 */
async function definitionOf(
  on: Queryable,
  auth: AuthContext,
  libraryId: string,
): Promise<Definition> {
  const [row] = await on
    .select({
      id: graderLibrary.id,
      organizationId: graderLibrary.organizationId,
      name: graderLibrary.name,
      type: graderLibrary.type,
      params: graderLibrary.params,
    })
    .from(graderLibrary)
    .where(
      and(
        eq(graderLibrary.id, libraryId),
        sql`(${graderLibrary.organizationId} is null or ${graderLibrary.organizationId} = ${auth.organizationId})`,
      ),
    )
    .limit(1);

  if (row === undefined) throw new UnknownGraderLibraryEntryError(libraryId);

  if (!Array.isArray(row.params)) {
    throw new Error(
      `library entry ${row.id} holds parameters in a shape egma never writes; the row needs repairing before anybody can use it`,
    );
  }

  return {
    id: row.id,
    name: row.name,
    // Pinned by a check constraint on the way in, so what comes back is one of
    // the two words the shelf writes.
    type: row.type as LibraryType,
    params: row.params as readonly LibraryParameter[],
  };
}

/**
 * A measure the simulator actually produces, checked against the catalog.
 *
 * **The one write-door rule that is about the world rather than about the
 * shape.** A copy names what it reads as a string, and a string naming nothing
 * produces a grader that reads nothing, judges nothing and is `skipped` forever
 * — a check somebody wrote, believes in, and that can never fire. Nothing
 * downstream can catch it: a missing measure is a legitimate `skipped` on a
 * conversation whose spans do not carry it, so the engine has no way to tell a
 * typo from a modality. Only the moment of writing can.
 *
 * The refusal names the catalog rather than only the list, because the next
 * question after "that is not a measure" is always "then what is", and the
 * catalog is the document that answers it — and says what each measure means,
 * which a list of names cannot.
 */
function validMeasure(measure: string, parameter: string): string {
  if (!isCatalogedMeasure(measure)) {
    throw new UnprocessableInputError(
      `"${measure}" is not a measure egma computes, so a grader reading it could never fire; ${parameter} takes one of ${CATALOGED_MEASURES.join(", ")}, and the measure catalog (${MEASURE_CATALOG_DOCUMENT}, version ${MEASURE_CATALOG_VERSION}) says what each of them means`,
    );
  }
  return measure;
}

/**
 * One value, checked against the parameter the entry declared it under.
 *
 * The `kind` decides the check exactly as it decides the control the form
 * draws, so what a person could type and what a write will take are one
 * decision. A kind this release has never heard of is refused rather than
 * waved through: a value nothing can check is a value nothing can be judged by.
 */
function validValue(
  parameter: LibraryParameter,
  value: unknown,
): string | number {
  if (value === undefined || value === null) {
    throw new UnprocessableInputError(
      `this grader needs "${parameter.name}": ${parameter.means}`,
    );
  }

  switch (parameter.kind) {
    case "measure": {
      if (typeof value !== "string" || value.trim() === "") {
        throw new UnprocessableInputError(
          `"${parameter.name}" is the name of a measure, so it has to be text`,
        );
      }
      return validMeasure(value.trim(), `"${parameter.name}"`);
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new UnprocessableInputError(
          `"${parameter.name}" has to be a number: ${parameter.means}`,
        );
      }
      return value;
    }
    default: {
      throw new Error(
        `library entry parameter "${parameter.name}" is a kind of value this release cannot check, so nothing may be written under it`,
      );
    }
  }
}

/**
 * One assertion's filled-in values, checked against what the entry asks for —
 * every parameter answered, and nothing answered that was never asked.
 *
 * The second half matters as much as the first. A key the entry never declared
 * is either a typo for one it did or a leftover from a definition that has moved
 * on, and both become a grader quietly judging by less than somebody wrote
 * down. Refusing names the keys the entry actually asks for, because the next
 * question is always "then what should I have sent".
 */
function validAssertion(
  definition: Definition,
  values: unknown,
  what: string,
): GraderAssertion {
  const given = fields(values, what);
  const asked = definition.params.map((parameter) => parameter.name);

  const unexpected = Object.keys(given).filter((key) => !asked.includes(key));
  if (unexpected.length > 0) {
    throw new UnprocessableInputError(
      asked.length === 0
        ? `the ${definition.name} grader asks for nothing, so "${unexpected.join('", "')}" has nowhere to go — its assertions are the test's own expected behaviors`
        : `the ${definition.name} grader does not ask for "${unexpected.join('", "')}"; it asks for "${asked.join('", "')}"`,
    );
  }

  const filled: Record<string, string | number> = {};
  for (const parameter of definition.params) {
    filled[parameter.name] = validValue(parameter, given[parameter.name]);
  }
  return filled;
}

/**
 * Every assertion a copy is being written with, checked together.
 *
 * **An entry that asks for something needs at least one.** A latency copy with
 * no assertions reads nothing, judges nothing, and is a row on the Running
 * graders screen that says a project is checking something it is not. An entry
 * that asks nothing must have none, for the mirror-image reason.
 */
function validConfig(
  definition: Definition,
  config: GraderConfigInput,
): GraderConfig {
  const assertions = config.assertions.map((values, at) =>
    validAssertion(definition, values, `assertion ${at + 1} of this grader`),
  );

  if (definition.params.length > 0 && assertions.length === 0) {
    throw new UnprocessableInputError(
      `the ${definition.name} grader needs at least one assertion — "${definition.params
        .map((parameter) => parameter.name)
        .join('", "')}" — because a copy that checks nothing can never fail`,
    );
  }
  return { assertions };
}

/**
 * The shape guard on every read. Stored jsonb comes back `unknown`, and a row
 * somebody hand-edited must fail here, loudly and naming itself, rather than
 * leak into a caller as a config that isn't one.
 *
 * Shape only, deliberately: what an entry asks for may grow or tighten later,
 * and an old version must stay readable exactly as it was written — so a key
 * nothing asks for any more is taken on trust once it is one of the two kinds
 * of value a form can produce.
 */
function configFromRow(value: unknown, versionId: string): GraderConfig {
  const malformed = (): Error =>
    new Error(
      `version ${versionId} holds a config in a shape egma never writes; the row needs repairing before anybody can read it`,
    );

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed();
  }
  const { assertions } = value as Record<string, unknown>;
  if (!Array.isArray(assertions)) throw malformed();

  return {
    assertions: assertions.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw malformed();
      }
      const filled: Record<string, string | number> = {};
      for (const [key, held] of Object.entries(entry)) {
        if (typeof held !== "string" && typeof held !== "number") {
          throw malformed();
        }
        filled[key] = held;
      }
      return filled;
    }),
  };
}

function judgeModelFromRow(
  value: unknown,
  versionId: string,
): JudgeModel | null {
  if (value === null || value === undefined) return null;
  const malformed = (): Error =>
    new Error(
      `version ${versionId} holds a judge model in a shape egma never writes; the row needs repairing before anybody can read it`,
    );

  if (typeof value !== "object" || Array.isArray(value)) throw malformed();
  const { provider, model } = value as Record<string, unknown>;
  if (typeof provider !== "string" || typeof model !== "string") {
    throw malformed();
  }
  return { provider: provider as JudgeProvider, model };
}

/**
 * Byte-identical or not, decided value by value — the same answer canonical
 * serialization would give, without trusting any serializer to order keys the
 * way jsonb re-ordered them.
 *
 * Assertions compare **in order and by position**, because position is what a
 * verdict row keys an assertion by: reordering two bounds is a different grader
 * from the reader's point of view even though the same two checks are made.
 */
function sameConfig(stored: GraderConfig, next: GraderConfig): boolean {
  return (
    stored.assertions.length === next.assertions.length &&
    stored.assertions.every((assertion, at) => {
      const other = next.assertions[at];
      if (other === undefined) return false;
      const keys = Object.keys(assertion).sort();
      const otherKeys = Object.keys(other).sort();
      return (
        keys.length === otherKeys.length &&
        keys.every((key, index) => key === otherKeys[index]) &&
        keys.every((key) => assertion[key] === other[key])
      );
    })
  );
}

function sameJudgeModel(a: JudgeModel | null, b: JudgeModel | null): boolean {
  if (a === null || b === null) return a === b;
  return a.provider === b.provider && a.model === b.model;
}

/** The named grader, alive, within the caller's tenancy and scope. */
function theGrader(auth: AuthContext, id: string): SQL {
  return within(
    auth,
    grader,
    and(eq(grader.id, id), notDeleted, inActingProject(auth, grader)),
  );
}

/** What a read hands back, from the row the identity and version join made. */
function answer(row: {
  readonly id: string;
  readonly projectId: string;
  readonly libraryId: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: string;
  readonly required: boolean;
  readonly scope: string;
  readonly productionSampleRate: number;
  readonly version: number;
  readonly versionId: string;
  readonly config: unknown;
  readonly judgeModel: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): Grader {
  const { type, config, judgeModel, scope, ...rest } = row;
  return {
    ...rest,
    // The identity row's own enumerated columns are pinned by check
    // constraints, so what comes back is one of the words this module writes.
    type: type as LibraryType,
    scope: scope as GraderScope,
    config: configFromRow(config, row.versionId),
    judgeModel: judgeModelFromRow(judgeModel, row.versionId),
  };
}

/**
 * **Use**: a running copy of a library entry, and its first version, or neither.
 *
 * The entry decides the type and what the form asked; the copy holds the
 * answers and where they apply. The whole write is one transaction — the
 * identity row goes in first naming a version that does not exist yet, its
 * pointer's constraint being deferred so Postgres checks it at commit — and
 * anything that fails on the way out takes both rows with it. A copy with no
 * version is a grader nothing can read a config off, and a version with no copy
 * is a config nothing judges by; neither is a state this door can leave behind.
 *
 * The entry is read **inside** the transaction, so the definition the type was
 * copied from is the definition that existed when the copy was written.
 */
export async function useLibraryEntry(
  auth: AuthContext,
  input: UseLibraryEntry,
): Promise<Grader> {
  authorize(auth, "author_definitions", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "a grader belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  // Everything answerable without the database is answered first; only an input
  // worth writing costs the reads below.
  const name = input.name === undefined ? undefined : validName(input.name);
  const judgeModel =
    input.judgeModel === undefined ? null : validJudgeModel(input.judgeModel);
  const required = input.required ?? DEFAULT_REQUIRED;
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
    const definition = await definitionOf(tx, auth, input.libraryId);
    const config = validConfig(definition, {
      // One filled-in set is one assertion, which is what the form produces.
      // Nothing at all is an entry that asks nothing, and its copy is born with
      // an empty list — the shape a correct expected-behaviors copy keeps.
      assertions: input.params === undefined ? [] : [input.params],
    });

    const [identity] = await tx
      .insert(grader)
      .values({
        id,
        organizationId: auth.organizationId,
        projectId,
        libraryId: definition.id,
        // Defaulted from the entry, so a copy nobody renamed says on screen
        // which grader it is a copy of.
        name: name ?? definition.name,
        description: input.description ?? null,
        type: definition.type,
        required,
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
      config,
      judgeModel,
      createdBy: auth.userId,
    });

    return { identity, config };
  });

  // Through the same shaper every other read goes through, so what Use hands
  // back and what a fetch hands back can never come to differ in a field one of
  // them forgot.
  return answer({
    ...written.identity,
    version: 1,
    versionId,
    config: written.config,
    judgeModel,
  });
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
 * One running copy with what it currently judges by: the entry it points at,
 * its type and filled-in values, the judge it insists on if any, and the live
 * settings saying where it applies and whether it can fail anything.
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
 * verdict already written meant. The filled-in values and the judge model are
 * what a verdict was decided by: either of them differing from the current
 * version inserts the next version and moves the pointer, in one transaction
 * with the identity row locked, so two concurrent edits number one after the
 * other rather than fighting over the same version number. The version being
 * left behind is never touched, because a verdict that named it must still say
 * what decided it. Content byte-identical to the current version is not an edit
 * at all: nothing is written, not even `updated_at`, and the current version
 * comes back.
 *
 * What an edit leaves out, it keeps — and values it does give are checked
 * against the **entry this copy points at**, read live, which is the same check
 * Use made and the reason an edit cannot smuggle in a parameter the form never
 * asked for.
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
  // Use answers it, so an edit is refused on the same grounds a Use is. The
  // config is the one thing that cannot be judged yet: what it may hold depends
  // on the entry the row this edit has not read points at.
  const name = changes.name === undefined ? undefined : validName(changes.name);
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

    const stored = configFromRow(currentVersion.config, currentVersion.id);
    const storedJudgeModel = judgeModelFromRow(
      currentVersion.judgeModel,
      currentVersion.id,
    );

    // Omitted means unchanged, and what a given config is checked against is
    // the entry this copy points at rather than anything the caller said.
    const config =
      changes.config === undefined
        ? stored
        : validConfig(
            await definitionOf(tx, auth, current.libraryId),
            changes.config,
          );
    const nextJudgeModel =
      judgeModel === undefined ? storedJudgeModel : judgeModel;

    const mintsVersion =
      !sameConfig(stored, config) ||
      !sameJudgeModel(storedJudgeModel, nextJudgeModel);
    const settingsChanged =
      changes.name !== undefined ||
      changes.description !== undefined ||
      changes.required !== undefined ||
      scope !== undefined ||
      productionSampleRate !== undefined;

    const settled = {
      ...current,
      type: current.type as LibraryType,
      required: changes.required ?? current.required,
      scope: scope ?? (current.scope as GraderScope),
      productionSampleRate: productionSampleRate ?? current.productionSampleRate,
    };

    if (!mintsVersion && !settingsChanged) {
      return {
        ...settled,
        version: currentVersion.version,
        versionId: currentVersion.id,
        config: stored,
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
        config,
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
        ...(changes.required === undefined ? {} : { required: changes.required }),
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
      config,
      judgeModel: nextJudgeModel,
    });
  });
}

/**
 * One frozen version, by its own `grv_` id — the read that keeps a verdict
 * interpretable after the copy moves on: exactly what decided it, in the values
 * it was decided by.
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
        and(eq(graderVersion.id, versionId), inActingProject(auth, grader)),
      ),
    )
    .limit(1);

  if (row === undefined) return undefined;

  const { type, config, judgeModel, ...rest } = row;
  return {
    ...rest,
    type: type as LibraryType,
    config: configFromRow(config, row.id),
    judgeModel: judgeModelFromRow(judgeModel, row.id),
  };
}

/**
 * One page of the running copies the caller can reach — the acting project's,
 * or the whole customer's for a credential acting in none — and where the next
 * page starts.
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
        and(notDeleted, inActingProject(auth, grader), olderThanCursor),
      ),
    )
    .orderBy(desc(grader.id))
    .limit(limit + 1);

  const { items, nextCursor } = pageOf(rows, limit);
  return { items: items.map(answer), nextCursor };
}

/**
 * What somebody reading a verdict row needs to know about the copy that wrote
 * it, and nothing else about that copy.
 */
export type GraderFacts = {
  /** The library entry it is a copy of — which says what its keys mean. */
  readonly libraryId: string;
  /** `false` makes it a diagnostic: judged, reported, never able to fail. */
  readonly required: boolean;
};

/**
 * These copies, by id, as a reader of their verdicts needs them.
 *
 * **Read live, and never off the verdict row.** `required` is a live setting on
 * the copy rather than judged content on its versions, so a project that turns a
 * blocker into a diagnostic this morning reads its whole history that way from
 * this morning on. That is the decision the flag's placement already made:
 * nothing about the judgment changed, only what the project lets a failure do.
 * The pointer is read live for the opposite reason — it can never be edited at
 * all, so there is no other value it could have.
 *
 * **Deliberately no deleted filter.** A deleted copy's verdicts are still shown
 * — its versions outlive it so that they stay interpretable — and a diagnostic
 * that somebody switched off must not start failing a run's headline the moment
 * it goes. Whether the copy is still running is not what this question asks.
 *
 * **A copy this cannot see is simply absent**, and every caller reads that
 * absence the safe way: a copy it cannot see is required, and an unresolvable
 * key stays a key.
 * Another customer's id, or one the credential's project narrowing hides, comes
 * back with nothing rather than with a guess.
 *
 * Exported to the module, not from the package: this answers questions the
 * verdict read and the assertion read have to ask, and the grader table has one
 * owner, which is this file.
 */
export async function graderFacts(
  auth: AuthContext,
  graderIds: readonly string[],
): Promise<ReadonlyMap<string, GraderFacts>> {
  const asked = [...new Set(graderIds)];
  if (asked.length === 0) return new Map();

  const rows = await db()
    .select({
      id: grader.id,
      libraryId: grader.libraryId,
      required: grader.required,
    })
    .from(grader)
    .where(
      within(
        auth,
        grader,
        and(inArray(grader.id, asked), inActingProject(auth, grader)),
      ),
    );

  return new Map(
    rows.map(({ id, ...facts }) => [id, facts] as const),
  );
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
 * The soft-delete marker, and only the marker. The copy vanishes from lists and
 * fetches at once; the version rows stay exactly where they are, because a
 * verdict that named one must stay interpretable for as long as it is kept.
 *
 * **Nothing refuses this, and that is the junction's departure showing.** It
 * used to be refused while the current version of a live test named the copy,
 * because letting it through would leave that test quietly checking one thing
 * fewer than it says it checks. A test names no graders now — where a copy
 * applies is its own scope — so switching one off is one decision about the
 * project, taken in one place, with nothing to hunt through first. Deleting the
 * copy is exactly how a project stops being judged by it, including the seeded
 * expected-behaviors one.
 *
 * Like Use, this refuses a credential acting in no project. An edit lands on a
 * row that already names its own project; a delete decides the grader should
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
  const [row] = await db()
    .update(grader)
    .set({ deletedAt, updatedAt: deletedAt })
    .where(theGrader(auth, id))
    .returning({
      id: grader.id,
      projectId: grader.projectId,
      name: grader.name,
    });

  if (row === undefined) return undefined;
  return { ...row, deletedAt };
}
