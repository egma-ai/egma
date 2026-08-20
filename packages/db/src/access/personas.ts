import { isId, newId } from "@egma/ids";
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { db, type Queryable, type Transaction } from "../client.ts";
import {
  PERSONA_LIBRARY_CATALOG,
  type PersonaTraits,
  type EgmaProvidedPersona,
} from "../persona-library/catalog.ts";
import {
  RECOMMENDED_PERSONA_MODELS,
  personaModelsFromRow,
  samePersonaModels,
  validPersonaModels,
  type PersonaModels,
} from "../models/selections.ts";
import { newRevision } from "../revisions.ts";
import {
  persona,
  personaVersion,
} from "../schema/personas.ts";
import { project } from "../schema/tenancy.ts";
import type { AuthContext } from "./context.ts";
import {
  DefaultPersonaReplacementError,
  IdentityConflictError,
  EgmaProvidedPersonaError,
  PersonaNamedByTestsError,
  ProjectOutsideOrganizationError,
  PersonaNameAmbiguousError,
  UnprocessableInputError,
  VersionConflictError,
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
 * project, so that write has somewhere to land. Archiving it refuses like
 * creating, because taking a persona out of a project's authoring lists is an
 * act taken inside one — `archivePersona` says why.
 *
 * **Nothing here deletes anybody.** Archive and Restore are the whole
 * lifecycle: a persona a run pinned has to stay interpretable forever, and a
 * removal somebody regrets at four o'clock has to be undoable at five.
 * Permanent removal is a compliance workflow with its own rules and is not
 * one of these verbs.
 */

export type { PersonaTraits };

/** Human traits that can be described but are not required. */
const DESCRIBED_TRAITS = [
  "manner",
  "patience",
  "accent",
  "backgroundNoise",
  "underFriction",
] as const;

type DescribedTrait = (typeof DESCRIBED_TRAITS)[number];

/**
 * The traits as they are stored and compared: described fields trimmed, and
 * an empty one dropped rather than kept as an empty string.
 *
 * **This is what makes a byte-identical save byte-identical.** A field
 * somebody cleared and a field somebody never filled in are the same fact —
 * nothing is stated about it — and storing them as two different values would
 * mint a version for a change nobody made.
 */
function normalizedTraits(traits: PersonaTraits): PersonaTraits {
  const described: { [K in DescribedTrait]?: string } = {};
  for (const field of DESCRIBED_TRAITS) {
    const written = traits[field]?.trim() ?? "";
    if (written !== "") described[field] = written;
  }
  return {
    personality: traits.personality.trim(),
    language: traits.language.trim(),
    ...described,
  };
}

export type NewPersona = {
  readonly name: string;
  readonly description?: string | undefined;
  readonly traits: PersonaTraits;
  /** Absent means the release's complete recommended selection. */
  readonly models?: PersonaModels | undefined;
};

export type PersonaOwner = "egma" | "organization";

export type Persona = {
  readonly id: string;
  readonly owner: PersonaOwner;
  readonly projectId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  /** The current version's own `prsv_` id — what a run pins. */
  readonly versionId: string;
  readonly traits: PersonaTraits;
  readonly models: PersonaModels;
  /**
   * The opaque token an identity write or a lifecycle change has to name.
   * It changes on every one of them and means nothing on its own.
   */
  readonly revision: string;
  /** When they were archived, or null while they are active. */
  readonly archivedAt: Date | null;
  /**
   * Whether the project points at them as the persona a test naming nobody
   * gets. **A pointer, not a kind**: it may point at a read-only Egma-provided
   * persona or at a Custom persona.
   */
  readonly isDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * What an edit may touch. Name and description are identity and version
 * nothing; traits are human behavior and version on a change. Absent means
 * keep.
 *
 * **The two expectations are separate because they answer separate
 * questions.** `expectedRevision` says *this persona has not moved* and guards
 * the identity fields and the lifecycle; `expectedVersionId` says *this
 * human behavior has not moved* and guards the authored behavior. An edit that
 * changes both names both. Either may be left out, and then that half is
 * written without a check — which is what the scripts do, and what no browser
 * write is ever allowed to do.
 */
export type PersonaChanges = {
  readonly name?: string;
  readonly description?: string | null;
  readonly traits?: PersonaTraits;
  readonly models?: PersonaModels;
  readonly expectedRevision?: string | undefined;
  readonly expectedVersionId?: string | undefined;
};

/** One version, frozen: the persona exactly as some simulation met them. */
export type PersonaVersion = {
  readonly id: string;
  readonly personaId: string;
  readonly version: number;
  readonly traits: PersonaTraits;
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
  revision: persona.revision,
  archivedAt: persona.archivedAt,
  createdAt: persona.createdAt,
  updatedAt: persona.updatedAt,
} as const;

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
function validateName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new UnprocessableInputError("a persona needs a name");
  }
}

function validateTraits(traits: unknown): asserts traits is PersonaTraits {
  if (typeof traits !== "object" || traits === null || Array.isArray(traits)) {
    throw new UnprocessableInputError("persona traits must be an object");
  }
  const held = traits as Record<string, unknown>;
  if (
    typeof held.personality !== "string" ||
    held.personality.trim() === ""
  ) {
    throw new UnprocessableInputError("a persona needs a personality");
  }
  if (typeof held.language !== "string" || held.language.trim() === "") {
    throw new UnprocessableInputError("a persona needs a language");
  }
  const accepted = new Set<string>([
    "personality",
    "language",
    ...DESCRIBED_TRAITS,
  ]);
  const unsupported = Object.keys(held).filter((key) => !accepted.has(key));
  if (unsupported.length > 0) {
    throw new UnprocessableInputError(
      `persona traits have unsupported fields ${unsupported.join(", ")}`,
    );
  }
  for (const field of DESCRIBED_TRAITS) {
    const value = held[field];
    if (value !== undefined && typeof value !== "string") {
      throw new UnprocessableInputError(`persona trait ${field} must be text`);
    }
  }
}

const CREATE_FIELDS = ["name", "description", "traits", "models"] as const;
const EDIT_FIELDS = [
  "name",
  "description",
  "traits",
  "models",
  "expectedRevision",
  "expectedVersionId",
] as const;

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

function validateNewPersona(input: NewPersona): void {
  validateAuthoringFields("create", input, CREATE_FIELDS);
  validateName(input.name);
  validateTraits(input.traits);
  if (input.models !== undefined) validPersonaModels(input.models);
}

function describedTraitsFromRow(
  value: Record<string, unknown>,
  malformed: () => Error,
): { [K in DescribedTrait]?: string } {
  const described: { [K in DescribedTrait]?: string } = {};
  for (const field of DESCRIBED_TRAITS) {
    const held = value[field];
    if (held === undefined) continue;
    if (typeof held !== "string" || held.trim() === "") throw malformed();
    described[field] = held;
  }
  return described;
}

/**
 * The shape guard on every read. Stored jsonb comes back `unknown`, and a row
 * somebody hand-edited must fail here, loudly and naming itself, rather than
 * leak into a caller as a `PersonaTraits` that isn't one. This guard accepts
 * only human behavior fields. Provider, model, voice, and speed are validated
 * separately as the version's required `models` value.
 */
function traitsFromRow(value: unknown, versionId: string): PersonaTraits {
  const malformed = () =>
    new Error(
      `version ${versionId} holds traits in a shape Egma never writes; the row needs repairing before anybody can read it`,
    );

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed();
  }
  const held = value as Record<string, unknown>;
  const { personality, language } = held;
  if (typeof personality !== "string" || personality.trim() === "") {
    throw malformed();
  }
  if (typeof language !== "string" || language.trim() === "") throw malformed();
  const accepted = new Set<string>([
    "personality",
    "language",
    ...DESCRIBED_TRAITS,
  ]);
  if (Object.keys(held).some((key) => !accepted.has(key))) throw malformed();
  return {
    personality,
    language,
    ...describedTraitsFromRow(held, malformed),
  };
}

/**
 * Byte-identical or not, decided field by field — the same answer canonical
 * serialization would give, without trusting any serializer to order keys the
 * way jsonb re-ordered them.
 *
 * One comparator per field, in tables the compiler holds exhaustive: a field
 * added to the human traits refuses to build until it is also told how to
 * compare. A hand-maintained comparator that missed a field would call two
 * different traits identical, and an edit would vanish without a version —
 * the one loss this whole file exists to rule out.
 */
const sameTraitsField: {
  readonly [K in keyof PersonaTraits]-?: (
    a: PersonaTraits,
    b: PersonaTraits,
  ) => boolean;
} = {
  personality: (a, b) => a.personality === b.personality,
  language: (a, b) => a.language === b.language,
  manner: (a, b) => a.manner === b.manner,
  patience: (a, b) => a.patience === b.patience,
  accent: (a, b) => a.accent === b.accent,
  backgroundNoise: (a, b) => a.backgroundNoise === b.backgroundNoise,
  underFriction: (a, b) => a.underFriction === b.underFriction,
};

/**
 * Byte-identical, decided over the **normalized** traits on both sides. The
 * stored side came out of `traitsFromRow`, which drops an empty described
 * trait; the incoming side has to be put through the same door or a cleared
 * field would compare unequal to an absent one forever.
 */
function sameTraits(a: PersonaTraits, b: PersonaTraits): boolean {
  const left = normalizedTraits(a);
  const right = normalizedTraits(b);
  return Object.values(sameTraitsField).every((same) => same(left, right));
}

/**
 * Full JSON equality for a fixed catalog version. Unlike `sameTraits`, this
 * must not parse through today's trait shape: doing so would drop an unknown
 * key and let a corrupted immutable row pass as catalog content. Object key
 * order is not content; every key and nested value is.
 */
function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  }
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        sameJson(leftRecord[key], rightRecord[key]),
    )
  );
}

/**
 * The named persona, within the caller's tenancy and scope, **whatever their
 * lifecycle state**.
 *
 * Archive takes somebody out of the lists an author picks from; it does not
 * take them out of the product. A detail page has to render an archived
 * persona — that is where Restore is — and Restore itself has to find one. A
 * predicate that filtered them out here would make an archived persona
 * unreachable by the one operation that exists to bring them back.
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
    validateTraits(version.traits);
    validPersonaModels(version.models);
  });
  return current;
}

/**
 * Put the personas Egma provides in the database without rewriting a version.
 * Identity metadata and the current pointer may move; version rows are insert
 * only and are checked byte for byte when their fixed id already exists.
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
                revision: newRevision(),
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
            traits: normalizedTraits(version.traits),
            models: validPersonaModels(version.models),
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
          traits: personaVersion.traits,
          models: personaVersion.models,
        })
        .from(personaVersion)
        .where(eq(personaVersion.personaId, entry.id));
      for (const expected of entry.versions) {
        const stored = storedVersions.find((one) => one.id === expected.id);
        if (
          stored === undefined ||
          stored.version !== expected.version ||
          !sameJson(stored.traits, normalizedTraits(expected.traits)) ||
          !sameJson(stored.models, validPersonaModels(expected.models))
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

async function createPersonaWithTraits(
  auth: AuthContext,
  input: Pick<NewPersona, "name" | "description">,
  traits: PersonaTraits,
  models: PersonaModels,
): Promise<Persona> {
  const projectId = auth.projectId;
  if (projectId === undefined) {
    throw new Error(
      "a persona belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }
  validateName(input.name);
  validateTraits(traits);
  const storedModels = validPersonaModels(models);

  return db().transaction(async (tx) => {
    await lockPersonaProject(tx, auth, projectId);
    return insertPersonaWithTraits(
      tx,
      auth,
      projectId,
      input,
      normalizedTraits(traits),
      storedModels,
    );
  });
}

/**
 * Hold the project a persona write lands in until that write commits.
 *
 * Project first is the shared lock order for a fork: lifecycle writes also
 * take the project before a persona. A fork that took the source first could
 * deadlock with an Archive that already held the project and was waiting for
 * that same source. The shared lock also makes project deletion wait until the
 * new identity and version either both commit or both roll back.
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

/** Write one complete project-owned persona on the caller's transaction. */
async function insertPersonaWithTraits(
  tx: Transaction,
  auth: AuthContext,
  projectId: string,
  input: Pick<NewPersona, "name" | "description">,
  storedTraits: PersonaTraits,
  storedModels: PersonaModels,
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
    traits: storedTraits,
    models: storedModels,
    createdBy: auth.userId,
  });

  // Read through the ordinary seam while both rows and the project lock are
  // still on this transaction. This is the authoritative answer for the
  // version and project-default pointer; no hand-built return value can drift
  // from what a following read will see.
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
  return createPersonaWithTraits(
    auth,
    input,
    input.traits,
    input.models ?? RECOMMENDED_PERSONA_MODELS,
  );
}

/**
 * The identity row joined to its current version, and to the project whose
 * pointer decides whether it is the default — the shape `get` and `list` both
 * answer with, written once so the two can never drift.
 *
 * The project join is what makes "is this the default?" a fact of the read
 * rather than a second question every caller would have to remember to ask.
 */
function selectWithCurrentVersion(auth: AuthContext, on: Queryable = db()) {
  const defaultProject =
    auth.projectId === undefined
      ? sql`false`
      : eq(project.id, auth.projectId);
  return on
    .select({
      ...COLUMNS,
      version: personaVersion.version,
      versionId: personaVersion.id,
      traits: personaVersion.traits,
      models: personaVersion.models,
      defaultPersonaId: project.defaultPersonaId,
    })
    .from(persona)
    .innerJoin(
      personaVersion,
      eq(persona.currentVersionId, personaVersion.id),
    )
    .leftJoin(
      project,
      and(defaultProject, eq(project.defaultPersonaId, persona.id)),
    );
}

/** One row of that select, as a `Persona`. */
function personaFrom(row: {
  readonly id: string;
  readonly organizationId: string | null;
  readonly versionId: string;
  readonly traits: unknown;
  readonly models: unknown;
  readonly defaultPersonaId: string | null;
}): Persona {
  const { defaultPersonaId, organizationId, ...rest } = row;
  return {
    ...(rest as unknown as Omit<
      Persona,
      "owner" | "traits" | "models" | "isDefault"
    >),
    owner: organizationId === null ? "egma" : "organization",
    traits: traitsFromRow(row.traits, row.versionId),
    models: personaModelsFromRow(row.models, row.versionId),
    isDefault: defaultPersonaId === row.id,
  };
}

/**
 * The persona as it stands on one connection.
 *
 * **A lifecycle write reads its own answer back through this, on its own
 * transaction.** `getPersona` below asks the pool, which is a different
 * connection and cannot see an uncommitted write — so an Archive that answered
 * through it would hand back the row exactly as it was a moment before, and
 * every caller would believe nothing had happened.
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
 * Make one active, available persona the project's default.
 *
 * This moves only the project's pointer. It does not change the persona's
 * type, identity, traits, models, or version. The project is locked first,
 * then the persona, which is the same order Archive uses. That makes Archive
 * and a default change serialize instead of leaving the project pointed at an
 * archived persona, without creating a lock cycle between the two actions.
 */
export async function setDefaultPersona(
  auth: AuthContext,
  id: string,
): Promise<Persona | undefined> {
  authorize(auth, "author_definitions", here(auth));

  const projectId = auth.projectId;
  if (projectId === undefined) {
    throw new Error(
      "a project default belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  return writing(() =>
    db().transaction(async (tx) => {
      const [target] = await tx
        .select({ id: project.id, defaultPersonaId: project.defaultPersonaId })
        .from(project)
        .where(within(auth, project, eq(project.id, projectId)))
        .limit(1)
        .for("update", { of: project });
      if (target === undefined) {
        throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
      }

      const [available] = await tx
        .select({ id: persona.id })
        .from(persona)
        .where(
          personaAvailableToProject(
            auth,
            target.id,
            and(eq(persona.id, id), notArchived),
          ),
        )
        .limit(1)
        .for("share", { of: persona });
      if (available === undefined) return undefined;

      if (target.defaultPersonaId !== available.id) {
        await tx
          .update(project)
          .set({ defaultPersonaId: available.id, updatedAt: new Date() })
          .where(eq(project.id, target.id));
      }

      return readPersonaOn(tx, auth, available.id);
    }),
  );
}

/**
 * One door for every change, so no caller needs the version rules to pick a
 * function — the rules live here. Name and description write in place and
 * version nothing. Human traits that differ from the current version insert
 * the next version and moves the pointer, in one transaction with the identity
 * row locked, so two concurrent edits number one after the other rather than
 * fighting over the same version number. Byte-identical traits are not
 * an edit at all: nothing is written, not even `updated_at`, and the current
 * version comes back.
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
  const { traits: askedTraits } = changes;
  if (askedTraits !== undefined) validateTraits(askedTraits);
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
        throw new Error(`customer-owned persona ${locked.id} has no project`);
      }
      const currentProjectId = locked.projectId;
      const { currentVersionId, organizationId: _organizationId, ...current } =
        locked;
      const [pointing] = await tx
        .select({ defaultPersonaId: project.defaultPersonaId })
        .from(project)
        .where(eq(project.id, currentProjectId))
        .limit(1);
      const isDefault = pointing?.defaultPersonaId === current.id;

      // Both expectations are checked against the row this transaction has
      // locked, so nothing can move between the check and the write.
      expectRevision(current, changes.expectedRevision);

      // This select and the update below are the two `where`s in this file that
      // start from a bare `eq` rather than `within`: each names an id that just
      // came off the tenancy-checked row locked above, in this same transaction,
      // so neither predicate can reach further than that check already did.
      const [currentVersion] = await tx
        .select({
          id: personaVersion.id,
          version: personaVersion.version,
          traits: personaVersion.traits,
          models: personaVersion.models,
        })
        .from(personaVersion)
        .where(eq(personaVersion.id, currentVersionId))
        .limit(1);
      if (currentVersion === undefined) {
        throw new Error("the persona's current version is missing");
      }

      /**
       * The content expectation, and where it is deliberately **not** applied.
       *
       * A traits write names the version it was written against. A save whose
       * traits are byte-identical to what is stored is not a write
       * at all — it mints nothing, so there is nothing for a stale expectation
       * to overwrite — but a stale one is still a caller working from an old
       * read, and telling them so is what stops the next save silently landing
       * on top of somebody else's. So it is checked whenever traits were
       * sent.
       */
      if (
        (askedTraits !== undefined || askedModels !== undefined) &&
        changes.expectedVersionId !== undefined
      ) {
        if (changes.expectedVersionId !== currentVersion.id) {
          throw new VersionConflictError(
            "persona",
            changes.expectedVersionId,
            currentVersion.id,
          );
        }
      }

      const storedTraits = traitsFromRow(currentVersion.traits, currentVersion.id);
      const storedModels = personaModelsFromRow(
        currentVersion.models,
        currentVersion.id,
      );
      const nextTraits =
        askedTraits !== undefined && !sameTraits(storedTraits, askedTraits)
          ? normalizedTraits(askedTraits)
          : undefined;
      const nextModels =
        askedModels !== undefined &&
        !samePersonaModels(storedModels, askedModels)
          ? askedModels
          : undefined;
      const identityChanged =
        changes.name !== undefined || changes.description !== undefined;

      if (
        nextTraits === undefined &&
        nextModels === undefined &&
        !identityChanged
      ) {
        return {
          ...current,
          owner: "organization" as const,
          version: currentVersion.version,
          versionId: currentVersion.id,
          traits: storedTraits,
          models: storedModels,
          isDefault,
        };
      }

      let versionId = currentVersion.id;
      let version = currentVersion.version;
      if (nextTraits !== undefined || nextModels !== undefined) {
        versionId = newId("prsv");
        version = currentVersion.version + 1;
        await tx.insert(personaVersion).values({
          id: versionId,
          personaId: current.id,
          version,
          traits: nextTraits ?? storedTraits,
          models: nextModels ?? storedModels,
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
          ...(nextTraits === undefined && nextModels === undefined
            ? {}
            : { currentVersionId: versionId }),
          // The identity moved, so the token that names it moves too — whichever
          // half of the edit moved it. A caller holding the old one is holding a
          // read taken before this write, and that is exactly what it is for.
          revision: newRevision(),
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
        traits: nextTraits ?? storedTraits,
        models: nextModels ?? storedModels,
        isDefault,
      };
    }),
  );
}

/**
 * One frozen version, by its own `prsv_` id — the read a run uses to stay
 * interpretable after the persona moves on, and the older-version read a
 * detail page offers. Deliberately no lifecycle filter: a version outlives
 * every change to the persona it belongs to, archiving included, so a run that
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
      traits: personaVersion.traits,
      models: personaVersion.models,
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
    ...row,
    traits: traitsFromRow(row.traits, row.id),
    models: personaModelsFromRow(row.models, row.id),
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
 * Which lifecycle state a list is of. **Two lists, never one with a column
 * saying which** — an authoring list mixing archived rows into active ones is
 * a list somebody picks the wrong row out of.
 */
export type PersonaListRequest = PageRequest & {
  /** `false`, the default, is the authoring list. `true` is the archive. */
  readonly archived?: boolean | undefined;
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
  const lifecycle =
    page?.archived === true ? isNotNull(persona.archivedAt) : notArchived;
  const wanted = page?.search?.trim();
  const named =
    wanted === undefined || wanted === ""
      ? undefined
      : ilike(persona.name, `%${wanted.replace(/([\\%_])/g, "\\$1")}%`);

  const rows = await selectWithCurrentVersion(auth)
    .where(
      readablePersona(auth, and(lifecycle, named, olderThanCursor)),
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
 * **Naming nobody comes back as nobody.** What an empty list means — the
 * project's default persona — is a rule about the write, and the test factory
 * holds it. Answering the default here as well would put one rule in two places,
 * where it can come to disagree with itself.
 *
 * **This is a translation, not a promise.** The read is outside whatever
 * transaction the write will open, so a persona can be archived between this
 * answer and that write. The factory checks the ids it is handed again inside
 * the write, under the lock that makes a delete and a write over one persona
 * wait for each other; that check is the guarantee this one leans on.
 *
 * Four ways it refuses, each naming what the writer wrote rather than what egma
 * looked up. A name nothing answers to, because a test naming somebody who is
 * not there would run one simulation fewer than it says it runs. A name only an
 * archived persona answers to, which is a different problem with a different fix
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
  // Archived personas are read too, and judged below rather than filtered out
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
      // name an archived persona, and it says so the same way whichever layer
      // catches it.
      const [gone] = answering;
      throw new UnprocessableInputError(
        `persona ${gone?.id ?? entry} is archived, and a test cannot name an archived persona`,
      );
    }
    if (found.length === 0) {
      throw new UnprocessableInputError(
        isId("prs", entry)
          ? `there is no persona ${entry} in this project`
          : `Egma has no persona called "${entry}" in this project. Name a persona this project already has, or name none and Egma takes the project's default.`,
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
 * A new persona whose version 1 carries the source's current traits.
 *
 * A fork is a create with the retyping saved: fresh `prs_` and `prsv_` ids,
 * version numbering starting over at 1, and no link back — the source's
 * history is the source's, and nothing of it comes along. The source is read
 * through the same tenancy predicate as `getPersona`, so a fork can only be
 * taken from an Egma-provided persona or one available in the acting project.
 *
 * Authorization is layered on purpose, not by accident of delegation. The
 * leading check refuses a viewer before anything is read, and a credential
 * acting in no project is refused right after it, still before the read —
 * the same stance as create and archive, and it keeps `undefined` meaning
 * invisible rather than refused. `getPersona`'s `read` permission applies
 * because the fork hands the source's traits back, which is a read. The
 * independent project-owned copy is written on that same transaction. If
 * reading ever gains a gate of its own, a caller who may not read the source
 * must be refused out loud here — never handed an `undefined` that pretends
 * the source does not exist, which would make Fork the one path that reads
 * without the read permission.
 *
 * **An archived source forks to an active persona, deliberately.** Reaching
 * back into the archive for a starting point is a reasonable thing to want,
 * and the fork is a new identity with its own lifecycle — nothing about the
 * source is disturbed, and nothing archived comes back by the back door.
 *
 * **The project, source pointer, source version, and new copy are one
 * transaction.** The project is locked first, matching Archive's lock order.
 * The source identity is then share-locked before its current-version pointer
 * is read. An Edit or catalog update that moves that pointer therefore happens
 * wholly before or wholly after Fork; Fork never copies a version that stopped
 * being current while the new identity was being written. The source version
 * itself is immutable, so reading it after the pointer lock completes the
 * snapshot without another lock.
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
    // Project before persona is the same order as Archive. If either is busy,
    // this fork waits before it holds the other row, so the two paths cannot
    // form a lock cycle.
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
      .select({
        id: personaVersion.id,
        traits: personaVersion.traits,
        models: personaVersion.models,
      })
      .from(personaVersion)
      .where(eq(personaVersion.id, source.currentVersionId))
      .limit(1);
    if (current === undefined) {
      throw new Error("the persona's current version is missing");
    }

    return insertPersonaWithTraits(
      tx,
      auth,
      projectId,
      {
        name: source.name,
        description: source.description ?? undefined,
      },
      normalizedTraits(traitsFromRow(current.traits, current.id)),
      personaModelsFromRow(current.models, current.id),
    );
  });
}

/**
 * What a lifecycle change takes, beyond the persona it names.
 *
 * `expectedRevision` is optional here and required at the browser's door. The
 * scripts and the seeding paths act on a row they read a line earlier and have
 * nobody to race; a person with a page open in a tab they left over lunch has
 * exactly somebody to race, and the door they write through says so.
 */
export type ArchiveRequest = {
  readonly expectedRevision?: string | undefined;
  /**
   * Who takes the project's default pointer, when the persona being archived
   * is holding it. Required in that case and meaningless otherwise.
   */
  readonly replacementPersonaId?: string | undefined;
};

export type RestoreRequest = {
  readonly expectedRevision?: string | undefined;
};

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
 * **The lock order in `archivePersona` is what stops a deadlock happening;
 * this is what happens if one does anyway.** A path added later that takes a
 * lock out of order, or an isolation level somebody raises, would otherwise
 * surface as a driver error on a request that was valid — an internal failure
 * a person cannot act on and cannot reproduce. `WriteAbortedError` says the
 * true thing instead: nothing was written, and sending it again is safe.
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

/** The revision check, written once for the three writes that make it. */
function expectRevision(
  current: { readonly id: string; readonly revision: string },
  expected: string | undefined,
): void {
  if (expected === undefined || expected === current.revision) return;
  throw new IdentityConflictError("persona", current.id, {
    expected,
    current: current.revision,
  });
}

/**
 * Archive: the persona leaves the lists somebody authors from, and nothing
 * else about them changes.
 *
 * Every row stays exactly where it was — the identity, every version, every
 * run that pinned one — because Archive is a statement about what should be
 * *offered*, not about what happened. `restorePersona` is therefore an
 * ordinary write rather than a recovery, and that is the whole point of
 * archiving instead of deleting.
 *
 * **Two rules can refuse it, and they are checked under the lock.**
 *
 * - A current version of an active test names them, which would leave that
 *   test running one simulation fewer than it says it runs.
 *   `PersonaNamedByTestsError` names every test standing in the way.
 * - They are the project's default, and no active replacement was named to
 *   take the pointer. The replacement moves in this same transaction, so
 *   there is never an instant in which a test authored naming nobody has
 *   nobody to be given. `DefaultPersonaReplacementError` says why.
 *
 * Archiving somebody already archived writes nothing and answers what is
 * there. It is not an error: two tabs pressing Archive is an ordinary thing to
 * happen, and the second one has nothing to complain about.
 *
 * Like create, this refuses a credential acting in no project. An edit lands
 * on a row that already names its own project; an Archive decides the persona
 * should stop being offered in one, and that is an act taken from inside it.
 */
export async function archivePersona(
  auth: AuthContext,
  id: string,
  request: ArchiveRequest = {},
): Promise<Persona | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "archiving a persona happens inside their project, and this credential is for the whole organization and acting in none",
    );
  }

  const archivedAt = new Date();
  const { projectId } = auth;

  return writing(() =>
    db().transaction(async (tx) => {
      /**
       * **The project first, always, and before any persona.**
       *
       * An archive can touch three rows: the persona leaving, the project
       * whose pointer may have to move, and the persona taking that pointer.
       * Two archives at once will therefore want two of each other's rows —
       * somebody archives the default and names a colleague as the
       * replacement while that colleague is being archived from another tab —
       * and if the two take their locks in different orders, Postgres finds
       * the cycle and kills one of them. That abort lands on a request that
       * was valid, which is a fault nobody can reproduce and nobody can act
       * on. `personas-archive-concurrency.test.ts` produced exactly that.
       *
       * So there is one order and every archive takes it. The project row is
       * the one row both of them are certain to want, so taking it first
       * leaves the second archive waiting before it holds anything at all —
       * and a transaction holding nothing cannot be half of a cycle.
       *
       * It is locked within the caller's tenancy rather than by bare id: a
       * predicate that reached any project would take a lock on a row this
       * caller was never entitled to touch, which is a denial of service
       * wearing a read's clothes.
       */
      const [pointing] = await tx
        .select({ defaultPersonaId: project.defaultPersonaId })
        .from(project)
        .where(within(auth, project, eq(project.id, projectId)))
        .limit(1)
        .for("update");

      if (pointing === undefined) return undefined;

      // Locked before the tests naming them are counted, and held until this
      // transaction ends, so nothing can come to name them between the count
      // and the write — which a count taken on this transaction's own snapshot
      // could not promise. The other half is the shared lock a test being
      // written takes on this same row, which `validateNamedPersonas` in
      // `tests.ts` explains: the two modes conflict, so one of the two writes
      // always waits for the other and then sees how it ended.
      const [locked] = await tx
        .select({
          id: persona.id,
          organizationId: persona.organizationId,
          projectId: persona.projectId,
          name: persona.name,
          revision: persona.revision,
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
        throw new Error(`customer-owned persona ${locked.id} has no project`);
      }
      const lockedProjectId = locked.projectId;
      expectRevision(locked, request.expectedRevision);
      if (locked.archivedAt !== null) return readPersonaOn(tx, auth, locked.id);

      const blocking = await liveTestsNamingPersona(
        tx,
        auth,
        lockedProjectId,
        locked.id,
      );
      if (blocking.length > 0) {
        throw new PersonaNamedByTestsError(locked.id, blocking);
      }

      if (pointing.defaultPersonaId === locked.id) {
        const replacement = request.replacementPersonaId;
        if (replacement === undefined || replacement === locked.id) {
          throw new DefaultPersonaReplacementError(locked.id, "none_named");
        }

        const [taking] = await tx
          .select({ id: persona.id })
          .from(persona)
          .where(
            personaAvailableToProject(
              auth,
              lockedProjectId,
              and(eq(persona.id, replacement), notArchived),
            ),
          )
          .limit(1)
          .for("share");

        if (taking === undefined) {
          throw new DefaultPersonaReplacementError(locked.id, "not_available");
        }

        await tx
          .update(project)
          .set({ defaultPersonaId: taking.id })
          .where(eq(project.id, lockedProjectId));
      }

      // A bare `eq` on an id that just came off the tenancy-checked row locked
      // above, in this same transaction, so it reaches no further than that
      // check already did — the move `editPersona` makes, for the same reason.
      const [row] = await tx
        .update(persona)
        .set({ archivedAt, revision: newRevision(), updatedAt: archivedAt })
        .where(eq(persona.id, locked.id))
        .returning({ id: persona.id });

      if (row === undefined) throw new Error("the persona was not written");
      return readPersonaOn(tx, auth, locked.id);
    }),
  );
}

/**
 * Restore: the persona is offered again.
 *
 * **Nothing refuses this one.** A persona's name is not unique, so there is no
 * name to collide with and no replacement name to ask for; their versions
 * never went anywhere; and a test that named them was never allowed to lose
 * them in the first place. Restoring somebody already active writes nothing.
 *
 * The pointer is not touched. Somebody restoring the persona a project used to
 * default to gets the persona back and not the pointer, because the project
 * has been pointing at somebody else in the meantime and silently taking that
 * back is a decision nobody asked for.
 */
export async function restorePersona(
  auth: AuthContext,
  id: string,
  request: RestoreRequest = {},
): Promise<Persona | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "restoring a persona happens inside their project, and this credential is for the whole organization and acting in none",
    );
  }

  const restoredAt = new Date();
  return writing(() =>
    db().transaction(async (tx) => {
      // One row, so there is no order to get wrong: Restore never touches the
      // project, because taking the default pointer back is a decision nobody
      // asked for.
      const [locked] = await tx
        .select({
          id: persona.id,
          organizationId: persona.organizationId,
          name: persona.name,
          revision: persona.revision,
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
      expectRevision(locked, request.expectedRevision);
      if (locked.archivedAt === null) return readPersonaOn(tx, auth, locked.id);

      await tx
        .update(persona)
        .set({
          archivedAt: null,
          revision: newRevision(),
          updatedAt: restoredAt,
        })
        .where(eq(persona.id, locked.id));

      return readPersonaOn(tx, auth, locked.id);
    }),
  );
}

/**
 * Every version of one persona, newest first — the history a detail page
 * shows, and the list an older-version read is chosen from.
 *
 * Deliberately no archive filter on the persona: an archived persona's history
 * is exactly as readable as an active one's, because a run that pinned one of
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
      traits: personaVersion.traits,
      models: personaVersion.models,
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
      ...row,
      traits: traitsFromRow(row.traits, row.id),
      models: personaModelsFromRow(row.models, row.id),
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
 * under *used by*, and exactly the set that would refuse their Archive.
 *
 * **The same question the Archive asks, answered by the same function**, so a
 * page saying "nothing uses them" can never be followed by a refusal saying
 * three tests do. A page that computed usage its own way would drift the first
 * time either rule moved.
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
