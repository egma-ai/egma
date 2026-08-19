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

import { db, type Queryable } from "../client.ts";
import {
  DEFAULT_PERSONA_SPEECH,
  PERSONA_LIBRARY_CATALOG,
  PREDEFINED_PERSONAS,
  VOICE_PROVIDERS,
  type PersonaTraits,
  type PredefinedPersona,
  type VoiceProvider,
} from "../persona-library/catalog.ts";
import { newRevision } from "../revisions.ts";
import {
  persona,
  personaVersion,
} from "../schema/personas.ts";
import { test, testPersona } from "../schema/tests.ts";
import { project } from "../schema/tenancy.ts";
import type { AuthContext } from "./context.ts";
import {
  DefaultPersonaReplacementError,
  IdentityConflictError,
  PredefinedPersonaError,
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
import { isProjectOfOrganization } from "./projects.ts";
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

export type { PersonaTraits, VoiceProvider };

/** Optional fields retained only so frozen historical versions stay readable. */
const LEGACY_DESCRIBED_TRAITS = [
  "manner",
  "patience",
  "accent",
  "backgroundNoise",
  "underFriction",
] as const;

type LegacyDescribedTrait = (typeof LEGACY_DESCRIBED_TRAITS)[number];

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
  const described: { [K in LegacyDescribedTrait]?: string } = {};
  for (const field of LEGACY_DESCRIBED_TRAITS) {
    const written = traits[field]?.trim() ?? "";
    if (written !== "") described[field] = written;
  }
  return {
    personality: traits.personality,
    language: traits.language,
    voice: traits.voice,
    ...described,
  };
}

export type NewPersona = {
  readonly name: string;
  readonly description?: string | undefined;
  readonly personality: string;
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
  /**
   * The opaque token an identity write or a lifecycle change has to name.
   * It changes on every one of them and means nothing on its own.
   */
  readonly revision: string;
  /** When they were archived, or null while they are active. */
  readonly archivedAt: Date | null;
  /**
   * Whether the project points at them as the persona a test naming nobody
   * gets. **A pointer, not a kind**: it may point at a read-only predefined
   * persona or at a project-owned persona.
   */
  readonly isDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * What an edit may touch. Name and description are identity and version
 * nothing; personality is behavior and versions on a change. Absent means
 * keep.
 *
 * **The two expectations are separate because they answer separate
 * questions.** `expectedRevision` says *this persona has not moved* and guards
 * the identity fields and the lifecycle; `expectedVersionId` says *this
 * personality has not moved* and guards the authored behavior. An edit that
 * changes both names both. Either may be left out, and then that half is
 * written without a check — which is what the scripts do, and what no browser
 * write is ever allowed to do.
 */
export type PersonaChanges = {
  readonly name?: string;
  readonly description?: string | null;
  readonly personality?: string;
  readonly expectedRevision?: string | undefined;
  readonly expectedVersionId?: string | undefined;
};

/** One version, frozen: the persona exactly as some simulation met them. */
export type PersonaVersion = {
  readonly id: string;
  readonly personaId: string;
  readonly version: number;
  readonly traits: PersonaTraits;
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

/** Speech only stays intelligible so far from natural pace. */
const SPEED_RANGE = { slowest: 0.5, fastest: 2 } as const;

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

function validateTraits(traits: PersonaTraits): void {
  if (traits.personality.trim() === "") {
    throw new UnprocessableInputError("a persona needs a personality");
  }
  if (traits.language.trim() === "") {
    throw new UnprocessableInputError("a persona needs a language");
  }
  const { provider, voiceId, speed } = traits.voice;
  if (!VOICE_PROVIDERS.includes(provider)) {
    throw new UnprocessableInputError(
      `"${provider}" is not a voice provider Egma knows; expected one of ${VOICE_PROVIDERS.join(", ")}`,
    );
  }
  if (voiceId.trim() === "") {
    throw new UnprocessableInputError(
      "a persona needs a voice id from its provider",
    );
  }
  if (
    !Number.isFinite(speed) ||
    speed < SPEED_RANGE.slowest ||
    speed > SPEED_RANGE.fastest
  ) {
    throw new UnprocessableInputError(
      `speaking speed must be between ${SPEED_RANGE.slowest} and ${SPEED_RANGE.fastest}`,
    );
  }
}

const CREATE_FIELDS = ["name", "description", "personality"] as const;
const EDIT_FIELDS = [
  "name",
  "description",
  "personality",
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
  validatePersonality(input.personality);
}

function validatePersonality(
  personality: unknown,
): asserts personality is string {
  if (typeof personality !== "string" || personality.trim() === "") {
    throw new UnprocessableInputError("a persona needs a personality");
  }
}

function legacyDescribedTraitsFromRow(
  value: Record<string, unknown>,
  malformed: () => Error,
): { [K in LegacyDescribedTrait]?: string } {
  const described: { [K in LegacyDescribedTrait]?: string } = {};
  for (const field of LEGACY_DESCRIBED_TRAITS) {
    const held = value[field];
    if (held === undefined || held === null) continue;
    if (typeof held !== "string") throw malformed();
    if (held.trim() !== "") described[field] = held;
  }
  return described;
}

/**
 * The shape guard on every read. Stored jsonb comes back `unknown`, and a row
 * somebody hand-edited must fail here, loudly and naming itself, rather than
 * leak into a caller as a `PersonaTraits` that isn't one. Shape only,
 * deliberately: the allowed provider list and the speed range may tighten
 * later, and an old version must stay readable exactly as it was written —
 * so the provider is taken on trust once it is a string.
 */
function traitsFromRow(value: unknown, versionId: string): PersonaTraits {
  const malformed = () =>
    new Error(
      `version ${versionId} holds traits in a shape Egma never writes; the row needs repairing before anybody can read it`,
    );

  if (typeof value !== "object" || value === null) throw malformed();
  const held = value as Record<string, unknown>;
  const { personality, language, voice } = held;
  if (typeof personality !== "string" || personality.trim() === "") {
    throw malformed();
  }
  if (typeof language !== "string" || language.trim() === "") throw malformed();
  if (typeof voice !== "object" || voice === null) throw malformed();
  const { provider, voiceId, speed } = voice as Record<string, unknown>;
  if (
    typeof provider !== "string" ||
    typeof voiceId !== "string" ||
    typeof speed !== "number"
  ) {
    throw malformed();
  }

  return {
    personality,
    language,
    voice: { provider: provider as VoiceProvider, voiceId, speed },
    ...legacyDescribedTraitsFromRow(held, malformed),
  };
}

/**
 * Byte-identical or not, decided field by field — the same answer canonical
 * serialization would give, without trusting any serializer to order keys the
 * way jsonb re-ordered them.
 *
 * One comparator per field, in tables the compiler holds exhaustive: a field
 * added to the traits (or to the voice inside them) refuses to build until it
 * is also told how to compare. A hand-maintained comparator that missed a
 * field would call two different traits identical, and an edit would vanish
 * without a version — the one loss this whole file exists to rule out.
 */
const sameVoiceField: {
  readonly [K in keyof PersonaTraits["voice"]]: (
    a: PersonaTraits["voice"],
    b: PersonaTraits["voice"],
  ) => boolean;
} = {
  provider: (a, b) => a.provider === b.provider,
  voiceId: (a, b) => a.voiceId === b.voiceId,
  speed: (a, b) => a.speed === b.speed,
};

/**
 * `-?` rather than the bare mapped type, because the described traits are
 * optional: without it, an optional field's comparator would be optional too,
 * and the compiler would stop insisting that a field added to the traits is
 * also told how to compare. That insistence is the only reason this table is
 * written out at all.
 */
const sameTraitsField: {
  readonly [K in keyof PersonaTraits]-?: (
    a: PersonaTraits,
    b: PersonaTraits,
  ) => boolean;
} = {
  personality: (a, b) => a.personality === b.personality,
  language: (a, b) => a.language === b.language,
  voice: (a, b) =>
    Object.values(sameVoiceField).every((same) => same(a.voice, b.voice)),
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

const LEGACY_STARTER = {
  name: "Starter",
  description:
    "The persona a test gets when it names none. Rename them, rewrite them, or point the project at somebody else.",
  traits: {
    personality: "Speaks plainly, stays patient, and asks one question at a time.",
    language: "en-US",
    voice: {
      provider: "elevenlabs",
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      speed: 1,
    },
  },
} as const;

async function adoptUntouchedLegacyStarters(on: Queryable): Promise<void> {
  const adopted = await on.execute<{
    project_id: string;
    legacy_persona_id: string;
  }>(sql`
    with exact_starters as materialized (
      select target.id as project_id, legacy.id as legacy_persona_id
        from ${project} as target
        join ${persona} as legacy
          on legacy.id = target.default_persona_id
        join ${personaVersion} as legacy_version
          on legacy_version.id = legacy.current_version_id
       where legacy.organization_id is not null
         and legacy.project_id = target.id
         and legacy.archived_at is null
         and legacy.name = ${LEGACY_STARTER.name}
         and legacy.description = ${LEGACY_STARTER.description}
         and legacy_version.version = 1
         and legacy_version.traits = ${JSON.stringify(LEGACY_STARTER.traits)}::jsonb
         and not exists (
           select 1 from ${personaVersion} as another_version
            where another_version.persona_id = legacy.id
              and another_version.id <> legacy_version.id
         )
    ), moved as (
      update ${project} as target
         set default_persona_id = ${PREDEFINED_PERSONAS.defaultPersona}
        from exact_starters as exact
       where target.id = exact.project_id
       returning target.id as project_id, exact.legacy_persona_id
    )
    select project_id, legacy_persona_id
      from moved
     order by project_id
  `);

  // Prelaunch cleanup, confirmed by the founder on 2026-08-19. Egma had no
  // production runs to preserve, so the current test version can replace the
  // exact generated Starter link in place. Existing simulation rows keep their
  // own persona and version pins. The copied identity is then retired so it
  // does not remain beside the shared default persona in the active library.
  // This avoids carrying a general migration subsystem for data that was never
  // a supported production contract.
  for (const row of adopted.rows) {
    await on.execute(sql`
      update ${testPersona} as link
         set persona_id = ${PREDEFINED_PERSONAS.defaultPersona}
        from ${test} as identity
       where identity.current_version_id = link.test_version_id
         and identity.project_id = ${row.project_id}
         and link.persona_id = ${row.legacy_persona_id}
    `);

    const retiredAt = new Date();
    await on
      .update(persona)
      .set({
        archivedAt: retiredAt,
        revision: newRevision(),
        updatedAt: retiredAt,
      })
      .where(eq(persona.id, row.legacy_persona_id));
  }
}

function currentCatalogVersion(entry: PredefinedPersona) {
  const current = entry.versions.at(-1);
  if (current === undefined) {
    throw new Error(`predefined persona ${entry.id} has no version`);
  }
  entry.versions.forEach((version, index) => {
    if (version.version !== index + 1) {
      throw new Error(
        `predefined persona ${entry.id} version ${version.id} must be number ${index + 1}`,
      );
    }
    validateTraits(version.traits);
  });
  return current;
}

/**
 * Put Egma's predefined personas in the database without rewriting a version.
 * Identity metadata and the current pointer may move; version rows are insert
 * only and are checked byte for byte when their fixed id already exists.
 */
/** @internal Called only by the deployment seeder outside the access surface. */
export async function seedPersonaLibraryInternal(
  catalog: readonly PredefinedPersona[] = PERSONA_LIBRARY_CATALOG,
): Promise<readonly SeededPersona[]> {
  if (catalog.length === 0) return [];

  return db().transaction(async (tx) => {
    const seeded: SeededPersona[] = [];
    let insertedDefaultPersona = false;
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
      if (
        entry.id === PREDEFINED_PERSONAS.defaultPersona &&
        identityInsertions.length > 0
      ) {
        insertedDefaultPersona = true;
      }

      const versionInsertions = await tx
        .insert(personaVersion)
        .values(
          entry.versions.map((version) => ({
            id: version.id,
            personaId: entry.id,
            version: version.version,
            traits: normalizedTraits(version.traits),
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
          `fixed predefined persona id ${entry.id} already holds a different identity`,
        );
      }

      const storedVersions = await tx
        .select({
          id: personaVersion.id,
          version: personaVersion.version,
          traits: personaVersion.traits,
        })
        .from(personaVersion)
        .where(eq(personaVersion.personaId, entry.id));
      for (const expected of entry.versions) {
        const stored = storedVersions.find((one) => one.id === expected.id);
        if (
          stored === undefined ||
          stored.version !== expected.version ||
          !sameJson(stored.traits, normalizedTraits(expected.traits))
        ) {
          throw new Error(
            `fixed predefined persona version ${expected.id} already holds different content`,
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
    // This is an upgrade adoption, not a standing policy. Running it again
    // would override a customer who later chose to point back at the exact old
    // local Starter. The fixed identity's first insert is the one-time marker.
    if (insertedDefaultPersona) {
      await adoptUntouchedLegacyStarters(tx);
    }
    return seeded;
  });
}

async function createPersonaWithTraits(
  auth: AuthContext,
  input: Pick<NewPersona, "name" | "description">,
  traits: PersonaTraits,
): Promise<Persona> {
  const projectId = auth.projectId;
  if (projectId === undefined) {
    throw new Error(
      "a persona belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }
  validateName(input.name);
  validateTraits(traits);
  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  const id = newId("prs");
  const versionId = newId("prsv");
  const storedTraits = normalizedTraits(traits);
  const inserted = await db().transaction(async (tx) => {
    const [identity] = await tx
      .insert(persona)
      .values({
        id,
        organizationId: auth.organizationId,
        projectId,
        name: input.name,
        description: input.description ?? null,
        currentVersionId: versionId,
        createdBy: auth.userId,
      })
      .returning(COLUMNS);
    await tx.insert(personaVersion).values({
      id: versionId,
      personaId: id,
      version: 1,
      traits: storedTraits,
      createdBy: auth.userId,
    });
    return identity;
  });
  if (inserted === undefined) throw new Error("the persona was not written");
  const { organizationId: _organizationId, ...identity } = inserted;
  return {
    ...identity,
    owner: "organization",
    version: 1,
    versionId,
    traits: storedTraits,
    isDefault: false,
  };
}

export async function createPersona(
  auth: AuthContext,
  input: NewPersona,
): Promise<Persona> {
  authorize(auth, "author_definitions", here(auth));

  validateNewPersona(input);
  const traits: PersonaTraits = {
    personality: input.personality,
    ...DEFAULT_PERSONA_SPEECH,
  };
  return createPersonaWithTraits(auth, input, traits);
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
  readonly defaultPersonaId: string | null;
}): Persona {
  const { defaultPersonaId, organizationId, ...rest } = row;
  return {
    ...(rest as unknown as Omit<Persona, "owner" | "traits" | "isDefault">),
    owner: organizationId === null ? "egma" : "organization",
    traits: traitsFromRow(row.traits, row.versionId),
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
 * One door for every change, so no caller needs the version rules to pick a
 * function — the rules live here. Name and description write in place and
 * version nothing. A personality that differs from the current version inserts
 * the next version and moves the pointer, in one transaction with the identity
 * row locked, so two concurrent edits number one after the other rather than
 * fighting over the same version number. A byte-identical personality is not
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
  const { personality } = changes;
  if (personality !== undefined) {
    validatePersonality(personality);
  }

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
        throw new PredefinedPersonaError(locked.id, locked.name);
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
       * A personality write names the version it was written against. A save
       * whose personality is byte-identical to what is stored is not a write
       * at all — it mints nothing, so there is nothing for a stale expectation
       * to overwrite — but a stale one is still a caller working from an old
       * read, and telling them so is what stops the next save silently landing
       * on top of somebody else's. So it is checked whenever personality was
       * sent.
       */
      if (
        personality !== undefined &&
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
      const requestedTraits =
        personality === undefined
          ? undefined
          : { ...storedTraits, personality };
      const nextTraits =
        requestedTraits !== undefined &&
        !sameTraits(storedTraits, requestedTraits)
          ? normalizedTraits(requestedTraits)
          : undefined;
      const identityChanged =
        changes.name !== undefined || changes.description !== undefined;

      if (nextTraits === undefined && !identityChanged) {
        return {
          ...current,
          owner: "organization" as const,
          version: currentVersion.version,
          versionId: currentVersion.id,
          traits: storedTraits,
          isDefault,
        };
      }

      let versionId = currentVersion.id;
      let version = currentVersion.version;
      if (nextTraits !== undefined) {
        versionId = newId("prsv");
        version = currentVersion.version + 1;
        await tx.insert(personaVersion).values({
          id: versionId,
          personaId: current.id,
          version,
          traits: nextTraits,
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
          ...(nextTraits === undefined ? {} : { currentVersionId: versionId }),
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
  return { ...row, traits: traitsFromRow(row.traits, row.id) };
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
 * through the same seam as `getPersona`, so a fork can only be taken from a
 * predefined persona or a persona available in the acting project.
 *
 * Authorization is layered on purpose, not by accident of delegation. The
 * leading check refuses a viewer before anything is read, and a credential
 * acting in no project is refused right after it, still before the read —
 * the same stance as create and archive, and it keeps `undefined` meaning
 * invisible rather than refused. `getPersona`'s `read` applies because
 * the fork hands the source's traits back, which is a read;
 * `createPersonaWithTraits` writes the independent project-owned copy. If
 * reading ever gains a gate of its own, a caller who may not read the source
 * must be refused out loud here — never handed an `undefined` that pretends
 * the source does not exist, which would make Fork the one path that reads
 * without the read permission.
 *
 * **An archived source forks to an active persona, deliberately.** Reaching
 * back into the archive for a starting point is a reasonable thing to want,
 * and the fork is a new identity with its own lifecycle — nothing about the
 * source is disturbed, and nothing archived comes back by the back door.
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

  const source = await getPersona(auth, id);
  if (source === undefined) return undefined;

  return createPersonaWithTraits(
    auth,
    {
      name: source.name,
      description: source.description ?? undefined,
    },
    source.traits,
  );
}

/** @deprecated Use the product word `forkPersona`. */
export const clonePersona = forkPersona;

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
        throw new PredefinedPersonaError(locked.id, locked.name);
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
        throw new PredefinedPersonaError(locked.id, locked.name);
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
      "usage of a predefined persona is relative to a project, and this credential is acting in none",
    );
  }
  return liveTestsNamingPersona(db(), auth, usageProjectId, found.id);
}
