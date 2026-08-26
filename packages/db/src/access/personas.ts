import { isId, newId } from "@egma/ids";
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { db, type Queryable, type Transaction } from "../client.ts";
import {
  PERSONA_LIBRARY_CATALOG,
  type EgmaProvidedPersona,
} from "../persona-library/catalog.ts";
import {
  RECOMMENDED_PERSONA_MODELS,
  personaModelsFromRow,
  samePersonaModels,
  validPersonaModels,
  type PersonaModels,
} from "../models/selections.ts";
import {
  persona,
  personaVersion,
} from "../schema/personas.ts";
import { project } from "../schema/tenancy.ts";
import type { AuthContext } from "./context.ts";
import {
  EgmaProvidedPersonaError,
  ProjectOutsideOrganizationError,
  PersonaNameAmbiguousError,
  UnprocessableInputError,
  WriteAbortedError,
  type TestNamingPersona,
} from "./errors.ts";
import { pageOf, pageWindow, type PageRequest } from "./pages.ts";
import { authorize, here } from "./permissions.ts";
import {
  personaAvailableToProject,
  readablePersona,
} from "./persona-availability.ts";
import { liveTestsNamingPersona } from "./tests.ts";
import { within } from "./within.ts";

/**
 * Reading and writing personas — what they are is the schema file's
 * story (`schema/personas.ts`); this file is how they are reached.
 *
 * The first project-scoped entity, so the first table where `within` narrows
 * by the project as well as the organization. A context acting in a project
 * writes and reads there; a context acting in none — an organization-scoped
 * credential — reads the whole customer and creates nothing, because a
 * persona belongs to a project and a credential for the whole customer
 * is acting in none. What already exists it may edit: the row names its own
 * project, so that write has somewhere to land. Deleting it refuses like
 * creating, because taking a persona out of a project's authoring lists is an
 * act taken inside one — `deletePersona` says why.
 *
 * **Nothing here removes a row.** Delete is the product word and it is
 * permanent to whoever presses it: the persona leaves every list and picker
 * and there is no way back through any surface. Underneath it stamps
 * `archived_at`, so a run that pinned one of these versions stays
 * interpretable forever. The two words differ deliberately; see the schema
 * file.
 */

/**
 * The authored content one version pins — everything a change to which mints
 * the next version, and nothing a change to which does not.
 *
 * The team's `name` and `description` are deliberately not here. They are the
 * identity row's, they are a label rather than behavior, and relabeling a
 * library must never pollute the history a result is read against.
 */
export type PersonaBehavior = {
  /** The human name this persona gives the agent, spoken on every call. */
  readonly identityName: string;
  readonly personality: string;
  readonly language: string;
  readonly models: PersonaModels;
};

/** Trimmed exactly the way a stored version is, so a save can be compared. */
function normalizedBehavior(behavior: PersonaBehavior): PersonaBehavior {
  return {
    identityName: behavior.identityName.trim(),
    personality: behavior.personality.trim(),
    language: behavior.language.trim(),
    models: behavior.models,
  };
}

export type NewPersona = {
  readonly name: string;
  readonly description?: string | undefined;
  readonly identityName: string;
  readonly personality: string;
  readonly language: string;
  /** Absent means the release's complete recommended selection. */
  readonly models?: PersonaModels | undefined;
};

export type PersonaOwner = "egma" | "organization";

export type Persona = {
  readonly id: string;
  readonly owner: PersonaOwner;
  readonly projectId: string | null;
  /** The team's word for them, shown in lists and pickers. Never spoken. */
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  /** The current version's own `prsv_` id — what a run pins. */
  readonly versionId: string;
  readonly identityName: string;
  readonly personality: string;
  readonly language: string;
  readonly models: PersonaModels;
  /** When they were deleted, or null while they are in use. */
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * What an edit may touch. Name and description are identity and version
 * nothing; the behavior fields version on a change. Absent means keep.
 *
 * **No expectation fields, on purpose.** A persona write is last-write-wins.
 * The revision token and the expected version id are gone from this door and
 * from every door above it — pre-launch, with two authors, the ceremony cost
 * more than the clobber it prevented. The reopen condition is written down in
 * the spec: the first real clobber incident.
 */
export type PersonaChanges = {
  readonly name?: string;
  readonly description?: string | null;
  readonly identityName?: string;
  readonly personality?: string;
  readonly language?: string;
  readonly models?: PersonaModels;
};

/** One version, frozen: the persona exactly as some simulation met them. */
export type PersonaVersion = {
  readonly id: string;
  readonly personaId: string;
  readonly version: number;
  readonly identityName: string;
  readonly personality: string;
  readonly language: string;
  readonly models: PersonaModels;
  readonly createdAt: Date;
};

const notArchived: SQL = isNull(persona.archivedAt);

/** An answer's columns, and no more — the hash-free, tenant-free view. */
const COLUMNS = {
  id: persona.id,
  organizationId: persona.organizationId,
  projectId: persona.projectId,
  name: persona.name,
  description: persona.description,
  archivedAt: persona.archivedAt,
  createdAt: persona.createdAt,
  updatedAt: persona.updatedAt,
} as const;

/** The stored behavior, column by column. */
const BEHAVIOR_COLUMNS = {
  identityName: personaVersion.identityName,
  personality: personaVersion.personality,
  language: personaVersion.language,
  llmProvider: personaVersion.llmProvider,
  llmModel: personaVersion.llmModel,
  sttProvider: personaVersion.sttProvider,
  sttModel: personaVersion.sttModel,
  ttsProvider: personaVersion.ttsProvider,
  ttsModel: personaVersion.ttsModel,
  ttsVoiceId: personaVersion.ttsVoiceId,
  ttsSpeed: personaVersion.ttsSpeed,
} as const;

/** One version row's behavior columns, as the value every caller reads. */
type BehaviorRow = {
  readonly identityName: string;
  readonly personality: string;
  readonly language: string;
  readonly llmProvider: string;
  readonly llmModel: string;
  readonly sttProvider: string;
  readonly sttModel: string;
  readonly ttsProvider: string;
  readonly ttsModel: string;
  readonly ttsVoiceId: string;
  readonly ttsSpeed: number;
};

/**
 * The stored columns as one behavior.
 *
 * The models still go through `personaModelsFromRow`, even though the columns
 * are typed now: the types say the row holds text, and the provider catalog
 * says whether that text names something this release can execute. A row
 * somebody hand-edited into naming a model egma cannot run must fail here,
 * loudly and naming itself, rather than reach a work order.
 */
function behaviorFromRow(row: BehaviorRow, versionId: string): PersonaBehavior {
  return {
    identityName: row.identityName,
    personality: row.personality,
    language: row.language,
    models: personaModelsFromRow(
      {
        llm: { provider: row.llmProvider, model: row.llmModel },
        stt: { provider: row.sttProvider, model: row.sttModel },
        tts: {
          provider: row.ttsProvider,
          model: row.ttsModel,
          voiceId: row.ttsVoiceId,
          speed: row.ttsSpeed,
        },
      },
      versionId,
    ),
  };
}

/** One behavior as the columns a version row is written from. */
function behaviorColumns(behavior: PersonaBehavior): BehaviorRow {
  const { models } = behavior;
  return {
    identityName: behavior.identityName,
    personality: behavior.personality,
    language: behavior.language,
    llmProvider: models.llm.provider,
    llmModel: models.llm.model,
    sttProvider: models.stt.provider,
    sttModel: models.stt.model,
    ttsProvider: models.tts.provider,
    ttsModel: models.tts.model,
    ttsVoiceId: models.tts.voiceId,
    ttsSpeed: models.tts.speed,
  };
}

/**
 * What the factory will not write, refused as the caller's mistake rather than
 * as a fault.
 *
 * `UnprocessableInputError` rather than a plain `Error` because these
 * sentences are written for whoever has to fix the input, and a layer above
 * has to be able to tell them apart from something being broken. They were
 * plain errors while nothing but a script called this; the browser's door is
 * the caller that has to relay them.
 */
function stated(value: unknown, sentence: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new UnprocessableInputError(sentence);
  }
}

const NEEDS_AN_IDENTITY_NAME =
  "a persona needs an identity name, because the agent is told who is calling";

function validateName(name: unknown): asserts name is string {
  stated(name, "a persona needs a name");
}

const CREATE_FIELDS = [
  "name",
  "description",
  "identityName",
  "personality",
  "language",
  "models",
] as const;
const EDIT_FIELDS = CREATE_FIELDS;

/**
 * Reject stale or misspelled authoring fields before reading a required one.
 *
 * TypeScript keeps current in-repo callers honest, but this boundary is also
 * called by built JavaScript and can receive an object written against an
 * older release. Ignoring an old `traits` field on edit would report success
 * while changing nothing; reading its absent replacement on create would
 * throw a TypeError. Both are caller mistakes, so both get one stable input
 * refusal that names the accepted fields.
 */
function validateAuthoringFields(
  operation: "create" | "edit",
  input: unknown,
  accepted: readonly string[],
): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new UnprocessableInputError(
      `persona ${operation} input must be an object`,
    );
  }
  const acceptedSet = new Set(accepted);
  const unsupported = Object.getOwnPropertyNames(input)
    .filter((field) => !acceptedSet.has(field))
    .sort();
  if (unsupported.length === 0) return;

  const quoted = (fields: readonly string[]) =>
    fields.map((field) => `"${field}"`).join(", ");
  throw new UnprocessableInputError(
    `persona ${operation} received unsupported fields ${quoted(unsupported)}; accepted fields are ${quoted(accepted)}`,
  );
}

/** The three authored sentences, checked the way the columns are checked. */
function validateBehaviorText(input: {
  readonly identityName: unknown;
  readonly personality: unknown;
  readonly language: unknown;
}): void {
  stated(input.identityName, NEEDS_AN_IDENTITY_NAME);
  stated(input.personality, "a persona needs a personality");
  stated(input.language, "a persona needs a language");
}

function validateNewPersona(input: NewPersona): void {
  validateAuthoringFields("create", input, CREATE_FIELDS);
  validateName(input.name);
  validateBehaviorText(input);
  if (input.models !== undefined) validPersonaModels(input.models);
}

/**
 * Identical or not, decided field by field — one comparator per field, in a
 * table the compiler holds exhaustive.
 *
 * A field added to the authored behavior refuses to build until it is also
 * told how to compare. A hand-maintained comparator that missed a field would
 * call two different behaviors identical, and an edit would vanish without a
 * version — the one loss this whole file exists to rule out. The same table
 * decides whether a seeded catalog row still holds catalog content.
 */
const sameBehaviorField: {
  readonly [K in keyof PersonaBehavior]-?: (
    a: PersonaBehavior,
    b: PersonaBehavior,
  ) => boolean;
} = {
  identityName: (a, b) => a.identityName === b.identityName,
  personality: (a, b) => a.personality === b.personality,
  language: (a, b) => a.language === b.language,
  models: (a, b) => samePersonaModels(a.models, b.models),
};

/**
 * Identical, decided over the **normalized** behavior on both sides. The
 * stored side was trimmed on the way in, so the incoming side has to be put
 * through the same door or a trailing space would read as a change.
 */
function sameBehavior(a: PersonaBehavior, b: PersonaBehavior): boolean {
  const left = normalizedBehavior(a);
  const right = normalizedBehavior(b);
  return Object.values(sameBehaviorField).every((same) => same(left, right));
}

/**
 * The named persona, within the caller's tenancy and scope, **whatever their
 * lifecycle state**.
 *
 * Delete takes somebody out of the lists an author picks from; it does not
 * take them out of the product. A Delete has to read its own answer back, a
 * usage question has to be answerable about somebody who has gone, and a run
 * that pinned one of their versions is still on the record. A predicate that
 * filtered them out here would make each of those unanswerable. The filtering
 * belongs to the lists, and `listPersonas` does it.
 */
function thePersona(auth: AuthContext, id: string): SQL {
  return readablePersona(auth, eq(persona.id, id));
}

export type SeededPersona = {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly versionId: string;
};

function currentCatalogVersion(entry: EgmaProvidedPersona) {
  const current = entry.versions.at(-1);
  if (current === undefined) {
    throw new Error(`Egma-provided persona ${entry.id} has no version`);
  }
  entry.versions.forEach((version, index) => {
    if (version.version !== index + 1) {
      throw new Error(
        `Egma-provided persona ${entry.id} version ${version.id} must be number ${index + 1}`,
      );
    }
    validateBehaviorText(version);
    validPersonaModels(version.models);
  });
  return current;
}

/**
 * Put the personas Egma provides in the database without rewriting a version.
 * Identity metadata and the current pointer may move; version rows are insert
 * only and are checked field for field when their fixed id already exists.
 */
/** @internal Called only by the deployment seeder outside the access surface. */
export async function seedPersonaLibraryInternal(
  catalog: readonly EgmaProvidedPersona[] = PERSONA_LIBRARY_CATALOG,
): Promise<readonly SeededPersona[]> {
  if (catalog.length === 0) return [];

  return db().transaction(async (tx) => {
    const seeded: SeededPersona[] = [];
    for (const entry of catalog) {
      const current = currentCatalogVersion(entry);
      const now = new Date();
      const identityInsertions = await tx
        .insert(persona)
        .values({
          id: entry.id,
          organizationId: null,
          projectId: null,
          name: entry.name,
          description: entry.description,
          currentVersionId: current.id,
          createdBy: null,
          createdAt: entry.versions[0]?.createdAt ?? current.createdAt,
          updatedAt: entry.versions[0]?.createdAt ?? current.createdAt,
        })
        .onConflictDoNothing({ target: persona.id })
        .returning({ id: persona.id });
      const identityUpdates =
        identityInsertions.length > 0
          ? []
          : await tx
              .update(persona)
              .set({
                name: entry.name,
                description: entry.description,
                currentVersionId: current.id,
                updatedAt: now,
              })
              .where(
                and(
                  eq(persona.id, entry.id),
                  isNull(persona.organizationId),
                  sql`(${persona.name}, ${persona.description}, ${persona.currentVersionId}) is distinct from (${entry.name}, ${entry.description}, ${current.id})`,
                ),
              )
              .returning({ id: persona.id });
      const identityChanges = [...identityInsertions, ...identityUpdates];
      const versionInsertions = await tx
        .insert(personaVersion)
        .values(
          entry.versions.map((version) => ({
            id: version.id,
            personaId: entry.id,
            version: version.version,
            ...behaviorColumns(
              normalizedBehavior({
                ...version,
                models: validPersonaModels(version.models),
              }),
            ),
            createdBy: null,
            createdAt: version.createdAt,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: personaVersion.id });

      const [storedIdentity] = await tx
        .select({
          organizationId: persona.organizationId,
          projectId: persona.projectId,
          name: persona.name,
          description: persona.description,
          currentVersionId: persona.currentVersionId,
        })
        .from(persona)
        .where(eq(persona.id, entry.id))
        .limit(1);
      if (
        storedIdentity === undefined ||
        storedIdentity.organizationId !== null ||
        storedIdentity.projectId !== null ||
        storedIdentity.name !== entry.name ||
        storedIdentity.description !== entry.description ||
        storedIdentity.currentVersionId !== current.id
      ) {
        throw new Error(
          `fixed Egma-provided persona id ${entry.id} already holds a different identity`,
        );
      }

      const storedVersions = await tx
        .select({
          id: personaVersion.id,
          version: personaVersion.version,
          ...BEHAVIOR_COLUMNS,
        })
        .from(personaVersion)
        .where(eq(personaVersion.personaId, entry.id));
      for (const expected of entry.versions) {
        const stored = storedVersions.find((one) => one.id === expected.id);
        if (
          stored === undefined ||
          stored.version !== expected.version ||
          !sameBehavior(behaviorFromRow(stored, stored.id), {
            ...expected,
            models: validPersonaModels(expected.models),
          })
        ) {
          throw new Error(
            `fixed Egma-provided persona version ${expected.id} already holds different content`,
          );
        }
      }

      if (identityChanges.length > 0 || versionInsertions.length > 0) {
        seeded.push({
          id: entry.id,
          name: entry.name,
          version: current.version,
          versionId: current.id,
        });
      }
    }
    return seeded;
  });
}

/**
 * Hold the project a persona write lands in until that write commits.
 *
 * The shared lock makes project deletion wait until the new identity and
 * version either both commit or both roll back. Project first is also the lock
 * order a fork takes, so two writes that want both rows queue rather than
 * deadlock.
 */
async function lockPersonaProject(
  tx: Transaction,
  auth: AuthContext,
  projectId: string,
): Promise<void> {
  const [target] = await tx
    .select({ id: project.id })
    .from(project)
    .where(
      within(
        auth,
        project,
        and(eq(project.id, projectId), isNull(project.deletedAt)),
      ),
    )
    .limit(1)
    .for("share", { of: project });
  if (target === undefined) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }
}

/** Write one complete Custom persona on the caller's transaction. */
async function insertPersona(
  tx: Transaction,
  auth: AuthContext,
  projectId: string,
  input: Pick<NewPersona, "name" | "description">,
  behavior: PersonaBehavior,
): Promise<Persona> {
  const id = newId("prs");
  const versionId = newId("prsv");
  await tx.insert(persona).values({
    id,
    organizationId: auth.organizationId,
    projectId,
    name: input.name,
    description: input.description ?? null,
    currentVersionId: versionId,
    createdBy: auth.userId,
  });
  await tx.insert(personaVersion).values({
    id: versionId,
    personaId: id,
    version: 1,
    ...behaviorColumns(behavior),
    createdBy: auth.userId,
  });

  // Read through the ordinary seam while both rows and the project lock are
  // still on this transaction. This is the authoritative answer; no hand-built
  // return value can drift from what a following read will see.
  const inserted = await readPersonaOn(tx, auth, id);
  if (inserted === undefined) {
    throw new Error("the persona was not written");
  }
  return inserted;
}

export async function createPersona(
  auth: AuthContext,
  input: NewPersona,
): Promise<Persona> {
  authorize(auth, "author_definitions", here(auth));

  validateNewPersona(input);

  const projectId = auth.projectId;
  if (projectId === undefined) {
    throw new Error(
      "a persona belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }
  const behavior = normalizedBehavior({
    identityName: input.identityName,
    personality: input.personality,
    language: input.language,
    models: validPersonaModels(input.models ?? RECOMMENDED_PERSONA_MODELS),
  });

  return db().transaction(async (tx) => {
    await lockPersonaProject(tx, auth, projectId);
    return insertPersona(tx, auth, projectId, input, behavior);
  });
}

/**
 * The identity row joined to its current version — the shape `get` and `list`
 * both answer with, written once so the two can never drift.
 */
function selectWithCurrentVersion(auth: AuthContext, on: Queryable = db()) {
  return on
    .select({
      ...COLUMNS,
      version: personaVersion.version,
      versionId: personaVersion.id,
      ...BEHAVIOR_COLUMNS,
    })
    .from(persona)
    .innerJoin(
      personaVersion,
      eq(persona.currentVersionId, personaVersion.id),
    );
}

/** One row of that select, as a `Persona`. */
function personaFrom(
  row: BehaviorRow & {
    readonly id: string;
    readonly organizationId: string | null;
    readonly versionId: string;
  },
): Persona {
  const {
    organizationId,
    identityName: _identityName,
    personality: _personality,
    language: _language,
    llmProvider: _llmProvider,
    llmModel: _llmModel,
    sttProvider: _sttProvider,
    sttModel: _sttModel,
    ttsProvider: _ttsProvider,
    ttsModel: _ttsModel,
    ttsVoiceId: _ttsVoiceId,
    ttsSpeed: _ttsSpeed,
    ...identity
  } = row;
  return {
    ...(identity as unknown as Omit<
      Persona,
      "owner" | keyof PersonaBehavior
    >),
    owner: organizationId === null ? "egma" : "organization",
    ...behaviorFromRow(row, row.versionId),
  };
}

/**
 * The persona as it stands on one connection.
 *
 * **A write reads its own answer back through this, on its own transaction.**
 * `getPersona` below asks the pool, which is a different connection and cannot
 * see an uncommitted write — so a Delete that answered through it would hand
 * back the row exactly as it was a moment before, and every caller would
 * believe nothing had happened.
 */
async function readPersonaOn(
  on: Queryable,
  auth: AuthContext,
  id: string,
): Promise<Persona | undefined> {
  const [row] = await selectWithCurrentVersion(auth, on)
    .where(thePersona(auth, id))
    .limit(1);

  if (row === undefined) return undefined;
  return personaFrom(row);
}

export async function getPersona(
  auth: AuthContext,
  id: string,
): Promise<Persona | undefined> {
  authorize(auth, "read", here(auth));

  return readPersonaOn(db(), auth, id);
}

/**
 * One door for every change, so no caller needs the version rules to pick a
 * function — the rules live here. Name and description write in place and
 * version nothing. Behavior that differs from the current version inserts the
 * next version and moves the pointer, in one transaction with the identity row
 * locked, so two concurrent edits number one after the other rather than
 * fighting over the same version number. An identical save is not an edit at
 * all: nothing is written, not even `updated_at`, and the current version
 * comes back.
 *
 * Editing what the caller cannot see returns what reading it would have:
 * `undefined`, with nothing disturbed.
 */
export async function editPersona(
  auth: AuthContext,
  id: string,
  changes: PersonaChanges,
): Promise<Persona | undefined> {
  authorize(auth, "author_definitions", here(auth));

  validateAuthoringFields("edit", changes, EDIT_FIELDS);
  if (changes.name !== undefined) validateName(changes.name);
  if (changes.identityName !== undefined) {
    stated(changes.identityName, NEEDS_AN_IDENTITY_NAME);
  }
  if (changes.personality !== undefined) {
    stated(changes.personality, "a persona needs a personality");
  }
  if (changes.language !== undefined) {
    stated(changes.language, "a persona needs a language");
  }
  const askedModels =
    changes.models === undefined
      ? undefined
      : validPersonaModels(changes.models);

  return writing(() =>
    db().transaction(async (tx) => {
      const [locked] = await tx
        .select({
          ...COLUMNS,
          currentVersionId: persona.currentVersionId,
        })
        .from(persona)
        .where(thePersona(auth, id))
        .limit(1)
        .for("update", { of: persona });

      if (locked === undefined) return undefined;
      if (locked.organizationId === null) {
        throw new EgmaProvidedPersonaError(locked.id, locked.name);
      }
      if (locked.projectId === null) {
        throw new Error(`Custom persona ${locked.id} has no project`);
      }
      const { currentVersionId, organizationId: _organizationId, ...current } =
        locked;

      // This select and the update below are the two `where`s in this file that
      // start from a bare `eq` rather than `within`: each names an id that just
      // came off the tenancy-checked row locked above, in this same transaction,
      // so neither predicate can reach further than that check already did.
      const [currentVersion] = await tx
        .select({
          id: personaVersion.id,
          version: personaVersion.version,
          ...BEHAVIOR_COLUMNS,
        })
        .from(personaVersion)
        .where(eq(personaVersion.id, currentVersionId))
        .limit(1);
      if (currentVersion === undefined) {
        throw new Error("the persona's current version is missing");
      }

      const stored = behaviorFromRow(currentVersion, currentVersion.id);
      const asked: PersonaBehavior = {
        identityName: changes.identityName ?? stored.identityName,
        personality: changes.personality ?? stored.personality,
        language: changes.language ?? stored.language,
        models: askedModels ?? stored.models,
      };
      const next = sameBehavior(stored, asked)
        ? undefined
        : normalizedBehavior(asked);
      const identityChanged =
        changes.name !== undefined || changes.description !== undefined;

      if (next === undefined && !identityChanged) {
        return {
          ...current,
          owner: "organization" as const,
          version: currentVersion.version,
          versionId: currentVersion.id,
          ...stored,
        };
      }

      let versionId = currentVersion.id;
      let version = currentVersion.version;
      if (next !== undefined) {
        versionId = newId("prsv");
        version = currentVersion.version + 1;
        await tx.insert(personaVersion).values({
          id: versionId,
          personaId: current.id,
          version,
          ...behaviorColumns(next),
          createdBy: auth.userId,
        });
      }

      const [updated] = await tx
        .update(persona)
        .set({
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.description === undefined
            ? {}
            : { description: changes.description }),
          ...(next === undefined ? {} : { currentVersionId: versionId }),
          updatedAt: new Date(),
        })
        .where(eq(persona.id, current.id))
        .returning(COLUMNS);

      if (updated === undefined) {
        throw new Error("the persona was not written");
      }
      return {
        ...(() => {
          const { organizationId: _organizationId, ...identity } = updated;
          return identity;
        })(),
        owner: "organization" as const,
        version,
        versionId,
        ...(next ?? stored),
      };
    }),
  );
}

/**
 * One frozen version, by its own `prsv_` id — the read a run uses to stay
 * interpretable after the persona moves on, and the older-version read a
 * detail page offers. Deliberately no lifecycle filter: a version outlives
 * every change to the persona it belongs to, a Delete included, so a run that
 * pinned one can always say exactly who the persona was.
 */
export async function getPersonaVersion(
  auth: AuthContext,
  versionId: string,
): Promise<PersonaVersion | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select({
      id: personaVersion.id,
      personaId: personaVersion.personaId,
      version: personaVersion.version,
      ...BEHAVIOR_COLUMNS,
      createdAt: personaVersion.createdAt,
    })
    .from(personaVersion)
    .innerJoin(
      persona,
      eq(personaVersion.personaId, persona.id),
    )
    .where(
      readablePersona(auth, eq(personaVersion.id, versionId)),
    )
    .limit(1);

  if (row === undefined) return undefined;
  return {
    id: row.id,
    personaId: row.personaId,
    version: row.version,
    createdAt: row.createdAt,
    ...behaviorFromRow(row, row.id),
  };
}

/**
 * One page of the personas the caller can reach — the acting project's,
 * or the whole customer's for a credential acting in none — and where the
 * next page starts.
 *
 * The ids are Crockford base32 of UUIDv7 under `COLLATE "C"`, so ordering by
 * id *is* ordering by mint time and the last id of a page is the whole cursor
 * — no second sort column, no offset to drift when rows arrive mid-scroll.
 * Newest first, because the persona somebody is looking for is usually
 * the one they just made.
 */
export type PersonaPage = {
  readonly items: readonly Persona[];
  /** Hand back as `cursor` to continue; absent on the last page. */
  readonly nextCursor: string | undefined;
};

/**
 * **One list, because there is only one lifecycle worth listing.** A deleted
 * persona is gone as far as anybody authoring is concerned, so there is no
 * archived list to ask for and no flag to ask for it with.
 */
export type PersonaListRequest = PageRequest & {
  /** Part of the name, matched without regard to case. */
  readonly search?: string | undefined;
};

export async function listPersonas(
  auth: AuthContext,
  page?: PersonaListRequest,
): Promise<PersonaPage> {
  authorize(auth, "read", here(auth));

  const { limit, cursor } = pageWindow(page, {
    singular: "persona",
    plural: "personas",
    prefix: "prs",
  });
  const olderThanCursor =
    cursor === undefined ? undefined : lt(persona.id, cursor);
  const wanted = page?.search?.trim();
  const named =
    wanted === undefined || wanted === ""
      ? undefined
      : ilike(persona.name, `%${wanted.replace(/([\\%_])/g, "\\$1")}%`);

  const rows = await selectWithCurrentVersion(auth)
    .where(
      readablePersona(auth, and(notArchived, named, olderThanCursor)),
    )
    .orderBy(desc(persona.id))
    .limit(limit + 1);

  const { items, nextCursor } = pageOf(rows, limit);
  return { items: items.map(personaFrom), nextCursor };
}

/**
 * The persona ids a write names, from the names a reviewed file carries.
 *
 * A test file in somebody's repository says `personas: [impatient-caller]`,
 * because a folder a team reads in pull requests cannot be a folder of
 * identifiers. Turning those names into identity is the platform's job, and this
 * is where it happens. An identifier resolves too, so a caller already holding
 * one does not have to find a name for it first.
 *
 * The answers come back in the order the entries were given, because that order
 * is content: a version names its personas in the order they were authored.
 *
 * **Naming nobody comes back as nobody.** What an empty list means — that the
 * write is refused, because a test says who calls — is a rule about the write,
 * and the test factory holds it. Answering it here as well would put one rule
 * in two places, where it can come to disagree with itself.
 *
 * **This is a translation, not a promise.** The read is outside whatever
 * transaction the write will open, so a persona can be deleted between this
 * answer and that write. The factory checks the ids it is handed again inside
 * the write, under the lock that makes a delete and a write over one persona
 * wait for each other; that check is the guarantee this one leans on.
 *
 * Four ways it refuses, each naming what the writer wrote rather than what egma
 * looked up. A name nothing answers to, because a test naming somebody who is
 * not there would run one simulation fewer than it says it runs. A name only a
 * deleted persona answers to, which is a different problem with a different fix
 * and so gets the factory's own words for it rather than being reported as never
 * having existed. A name two living personas answer to, because there is no
 * uniqueness rule on a persona's name and picking one of the two would put
 * somebody in a test that nobody chose — its own class, so a repository client
 * can be told to write the identifier into the file. And the same persona named twice, which
 * asks for the same simulation twice — a run's business, never a test's.
 */
export async function resolvePersonaNames(
  auth: AuthContext,
  named: readonly string[],
): Promise<readonly string[]> {
  authorize(auth, "read", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "a persona belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  const wanted = named.map((entry) => entry.trim());
  if (wanted.length === 0) return [];

  // One read for the whole list, matching an entry against either column: an
  // entry is an identifier or a name, and which one it is is the writer's
  // choice rather than something to make them declare.
  //
  // Deleted personas are read too, and judged below rather than filtered out
  // here. Filtered, every one of them would be reported as a persona that never
  // existed — which sends somebody looking for a typo in a name that was right
  // when they wrote it.
  const rows = await db()
    .select({
      id: persona.id,
      name: persona.name,
      archivedAt: persona.archivedAt,
    })
    .from(persona)
    .where(
      personaAvailableToProject(
        auth,
        projectId,
        or(inArray(persona.id, wanted), inArray(persona.name, wanted)),
      ),
    );

  const resolved: string[] = [];
  for (const entry of wanted) {
    // The identifier first, so a project holding a persona whose *name* is
    // another persona's identifier still resolves the identifier to the row it
    // names. Nothing stops somebody authoring such a name.
    const matching = rows.filter((row) => row.id === entry);
    const answering =
      matching.length > 0 ? matching : rows.filter((row) => row.name === entry);
    const found = answering.filter((row) => row.archivedAt === null);

    if (found.length === 0 && answering.length > 0) {
      // The factory's own sentence for this, word for word: a version may not
      // name a deleted persona, and it says so the same way whichever layer
      // catches it.
      const [gone] = answering;
      throw new UnprocessableInputError(
        `persona ${gone?.id ?? entry} is deleted, and a test cannot name a deleted persona`,
      );
    }
    if (found.length === 0) {
      throw new UnprocessableInputError(
        isId("prs", entry)
          ? `there is no persona ${entry} in this project`
          : `Egma has no persona called "${entry}" in this project. Name a persona this project already has.`,
      );
    }
    if (found.length > 1) {
      // Its own class, because the reader is usually a repository file rather
      // than a form, and the sentence tells them where the identifier goes.
      throw new PersonaNameAmbiguousError(
        entry,
        `Persona name ${entry} matches more than one active persona in this ` +
          `project. Put the intended persona's stable ID in the file and try ` +
          `again; for a pinned file, egma pull can write the IDs after the ` +
          `file is safe to migrate.`,
      );
    }

    const [only] = found;
    if (only === undefined) throw new Error("a matched persona went missing");
    if (resolved.includes(only.id)) {
      throw new UnprocessableInputError(
        `persona "${entry}" is named twice on one test; name each persona once`,
      );
    }
    resolved.push(only.id);
  }

  return resolved;
}

/**
 * A new persona whose version 1 carries the source's current behavior.
 *
 * A fork is a create with the retyping saved: fresh `prs_` and `prsv_` ids,
 * version numbering starting over at 1, and no link back — the source's
 * history is the source's, and nothing of it comes along. The source is read
 * through the same tenancy predicate as `getPersona`, so a fork can only be
 * taken from an Egma-provided persona or one available in the acting project.
 * It is the one path from a read-only Predefined persona to one a project can
 * edit, and on a Custom persona it is a plain duplicate.
 *
 * Authorization is layered on purpose, not by accident of delegation. The
 * leading check refuses a viewer before anything is read, and a credential
 * acting in no project is refused right after it, still before the read —
 * the same stance as create and delete, and it keeps `undefined` meaning
 * invisible rather than refused. `getPersona`'s `read` permission applies
 * because the fork hands the source's behavior back, which is a read. The
 * independent Custom copy is written on that same transaction. If
 * reading ever gains a gate of its own, a caller who may not read the source
 * must be refused out loud here — never handed an `undefined` that pretends
 * the source does not exist, which would make Fork the one path that reads
 * without the read permission.
 *
 * **A deleted source forks to a live persona, deliberately.** Reaching back
 * for a starting point is a reasonable thing to want, and the fork is a new
 * identity with its own lifecycle — nothing about the source is disturbed, and
 * nothing deleted comes back by the back door.
 *
 * **The project, source pointer, source version, and new copy are one
 * transaction.** The project is locked first. The source identity is then
 * share-locked before its current-version pointer is read. An Edit or catalog
 * update that moves that pointer therefore happens wholly before or wholly
 * after Fork; Fork never copies a version that stopped being current while the
 * new identity was being written. The source version itself is immutable, so
 * reading it after the pointer lock completes the snapshot without another
 * lock.
 */
export async function forkPersona(
  auth: AuthContext,
  id: string,
): Promise<Persona | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "a fork lands in the acting project, and this credential is for the whole organization and acting in none",
    );
  }

  authorize(auth, "read", here(auth));
  const { projectId } = auth;

  return db().transaction(async (tx) => {
    // Project before persona. If either is busy, this fork waits before it
    // holds the other row, so two paths cannot form a lock cycle.
    await lockPersonaProject(tx, auth, projectId);

    const [source] = await tx
      .select({
        name: persona.name,
        description: persona.description,
        currentVersionId: persona.currentVersionId,
      })
      .from(persona)
      .where(thePersona(auth, id))
      .limit(1)
      .for("share", { of: persona });
    if (source === undefined) return undefined;
    validateName(source.name);

    const [current] = await tx
      .select({ id: personaVersion.id, ...BEHAVIOR_COLUMNS })
      .from(personaVersion)
      .where(eq(personaVersion.id, source.currentVersionId))
      .limit(1);
    if (current === undefined) {
      throw new Error("the persona's current version is missing");
    }

    return insertPersona(
      tx,
      auth,
      projectId,
      {
        name: source.name,
        description: source.description ?? undefined,
      },
      normalizedBehavior(behaviorFromRow(current, current.id)),
    );
  });
}

/**
 * The two ways Postgres ends a transaction because of another one.
 *
 * `40P01` is a deadlock it broke; `40001` is the serialization failure a
 * stricter isolation level produces instead. Neither says anything about the
 * request, and both are safe to send again.
 */
const ABORTED_BY_THE_STORE = ["40P01", "40001"];

/**
 * The code the driver reported, walked out of whatever wrapped it. Capped, so
 * a circular chain cannot spin.
 */
function postgresCodeOf(error: unknown): string | undefined {
  let held = error;
  for (let depth = 0; depth < 10; depth += 1) {
    if (typeof held !== "object" || held === null) return undefined;
    if ("code" in held) return String((held as { code: unknown }).code);
    held = (held as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * A write, with the store's own abort turned into something a surface can
 * answer with.
 *
 * A path added later that takes two locks out of order, or an isolation level
 * somebody raises, would otherwise surface as a driver error on a request that
 * was valid — an internal failure a person cannot act on and cannot reproduce.
 * `WriteAbortedError` says the true thing instead: nothing was written, and
 * sending it again is safe.
 */
async function writing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (thrown) {
    const code = postgresCodeOf(thrown);
    if (code !== undefined && ABORTED_BY_THE_STORE.includes(code)) {
      throw new WriteAbortedError("persona", { cause: thrown });
    }
    throw thrown;
  }
}

/**
 * Delete: the persona leaves every list and picker, and nothing else about
 * them changes.
 *
 * Every row stays exactly where it was — the identity, every version, every
 * run that pinned one — because what the user asked for is that this persona
 * stop being offered, and a simulation that pinned them still has to read
 * true. The stamp is `archived_at`, and it is the only mechanism: there is no
 * restore surface, no deleted list, and no successor to nominate.
 *
 * **One rule refuses it, and the database holds that rule.** An Egma-provided
 * persona has no organization, and `persona_egma_provided_is_active` refuses
 * the stamp on such a row; this function refuses it a step earlier so the
 * caller gets a sentence rather than a constraint name.
 *
 * **A live test naming them does not refuse it.** That guard was written when
 * every test created without naming anybody was silently given the project's
 * default, so one Delete could quietly empty a page of tests. Tests name their
 * personas explicitly now, and the protection sits where the loss would
 * happen: a run for a test naming a deleted persona is refused, and that
 * test's next write has to name somebody alive. Deleting is therefore one
 * honest verb with one confirmation, and the working set only ever shows
 * personas somebody can use.
 *
 * Deleting somebody already deleted writes nothing and answers what is there.
 * It is not an error: two tabs pressing Delete is an ordinary thing to happen,
 * and the second one has nothing to complain about.
 *
 * Like create, this refuses a credential acting in no project. An edit lands
 * on a row that already names its own project; a Delete decides the persona
 * should stop being offered in one, and that is an act taken from inside it.
 */
export async function deletePersona(
  auth: AuthContext,
  id: string,
): Promise<Persona | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "deleting a persona happens inside their project, and this credential is for the whole organization and acting in none",
    );
  }

  const archivedAt = new Date();

  return writing(() =>
    db().transaction(async (tx) => {
      // Locked for the whole transaction. The other half is the shared lock a
      // test being written takes on this same row, which `validateNamedPersonas`
      // in `tests.ts` explains: the two modes conflict, so one of the two
      // writes always waits for the other and then sees how it ended.
      const [locked] = await tx
        .select({
          id: persona.id,
          organizationId: persona.organizationId,
          projectId: persona.projectId,
          name: persona.name,
          archivedAt: persona.archivedAt,
        })
        .from(persona)
        .where(thePersona(auth, id))
        .limit(1)
        .for("update");

      if (locked === undefined) return undefined;
      if (locked.organizationId === null) {
        throw new EgmaProvidedPersonaError(locked.id, locked.name);
      }
      if (locked.projectId === null) {
        throw new Error(`Custom persona ${locked.id} has no project`);
      }
      if (locked.archivedAt !== null) return readPersonaOn(tx, auth, locked.id);

      // A bare `eq` on an id that just came off the tenancy-checked row locked
      // above, in this same transaction, so it reaches no further than that
      // check already did — the move `editPersona` makes, for the same reason.
      const [row] = await tx
        .update(persona)
        .set({ archivedAt, updatedAt: archivedAt })
        .where(eq(persona.id, locked.id))
        .returning({ id: persona.id });

      if (row === undefined) throw new Error("the persona was not written");
      return readPersonaOn(tx, auth, locked.id);
    }),
  );
}

/**
 * Every version of one persona, newest first — the history a detail page
 * shows, and the list an older-version read is chosen from.
 *
 * Deliberately no lifecycle filter on the persona: a deleted persona's history
 * is exactly as readable as a live one's, because a run that pinned one of
 * these versions is still on the record and still has to be interpretable.
 */
export async function listPersonaVersions(
  auth: AuthContext,
  personaId: string,
  page?: PageRequest,
): Promise<PersonaVersionPage> {
  authorize(auth, "read", here(auth));

  const { limit, cursor } = pageWindow(page, {
    singular: "persona version",
    plural: "persona versions",
    prefix: "prsv",
  });

  const rows = await db()
    .select({
      id: personaVersion.id,
      personaId: personaVersion.personaId,
      version: personaVersion.version,
      ...BEHAVIOR_COLUMNS,
      createdAt: personaVersion.createdAt,
    })
    .from(personaVersion)
    .innerJoin(persona, eq(personaVersion.personaId, persona.id))
    .where(
      and(
        thePersona(auth, personaId),
        cursor === undefined ? undefined : lt(personaVersion.id, cursor),
      ),
    )
    .orderBy(desc(personaVersion.id))
    .limit(limit + 1);

  const { items, nextCursor } = pageOf(rows, limit);
  return {
    items: items.map((row) => ({
      id: row.id,
      personaId: row.personaId,
      version: row.version,
      createdAt: row.createdAt,
      ...behaviorFromRow(row, row.id),
    })),
    nextCursor,
  };
}

export type PersonaVersionPage = {
  readonly items: readonly PersonaVersion[];
  readonly nextCursor: string | undefined;
};

/**
 * Which active tests currently name this persona — what a detail page shows
 * under *used by*.
 *
 * It no longer stands between anybody and a Delete: Delete asks nothing and
 * refuses nothing but a Predefined persona. What this answers is the question
 * somebody about to press it wants answered — who goes quiet if I do — and
 * the page shows it beside the button rather than after it.
 */
export async function testsUsingPersona(
  auth: AuthContext,
  personaId: string,
): Promise<readonly TestNamingPersona[] | undefined> {
  authorize(auth, "read", here(auth));

  const [found] = await db()
    .select({ id: persona.id, projectId: persona.projectId })
    .from(persona)
    .where(thePersona(auth, personaId))
    .limit(1);

  if (found === undefined) return undefined;
  const usageProjectId = found.projectId ?? auth.projectId;
  if (usageProjectId === undefined) {
    throw new Error(
      "usage of an Egma-provided persona is relative to a project, and this credential is acting in none",
    );
  }
  return liveTestsNamingPersona(db(), auth, usageProjectId, found.id);
}
