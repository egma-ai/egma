import { isId, newId } from "@egma/ids";
import { and, desc, eq, isNull, lt, type SQL } from "drizzle-orm";

import { db } from "../client.ts";
import {
  digitalHuman,
  digitalHumanVersion,
} from "../schema/digital-humans.ts";
import type { AuthContext } from "./context.ts";
import { ProjectOutsideOrganizationError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { within } from "./within.ts";

/**
 * Reading and writing digital humans — what they are is the schema file's
 * story (`schema/digital-humans.ts`); this file is how they are reached.
 *
 * The first project-scoped entity, so the first table where `within` narrows
 * by the project as well as the organization. A context acting in a project
 * writes and reads there; a context acting in none — an organization-scoped
 * credential — reads the whole customer and creates nothing, because a
 * digital human belongs to a project and a credential for the whole customer
 * is acting in none. What already exists it may edit: the row names its own
 * project, so that write has somewhere to land. Deleting it refuses like
 * creating, because taking a digital human out of a project is an act taken
 * inside one — `deleteDigitalHuman` says why.
 */

/** The mouths egma knows how to ask for. Grows one entry at a time. */
export const VOICE_PROVIDERS = ["elevenlabs", "cartesia", "openai"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

/**
 * Who the digital human is. The voice is concrete — provider, that provider's
 * catalog id, and pace — so the same digital human sounds identical on every
 * future simulation; a described voice would let two runs cast two people.
 */
export type DigitalHumanTraits = {
  readonly personality: string;
  readonly language: string;
  readonly voice: {
    readonly provider: VoiceProvider;
    readonly voiceId: string;
    readonly speed: number;
  };
};

export type NewDigitalHuman = {
  readonly name: string;
  readonly description?: string | undefined;
  readonly traits: DigitalHumanTraits;
};

export type DigitalHuman = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  /** The current version's own `dhv_` id — what a run pins. */
  readonly versionId: string;
  readonly traits: DigitalHumanTraits;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * What an edit may touch. Name and description are identity and version
 * nothing; traits are behavior and version on any change. Absent means keep.
 */
export type DigitalHumanChanges = {
  readonly name?: string;
  readonly description?: string | null;
  readonly traits?: DigitalHumanTraits;
};

/** One version, frozen: the digital human exactly as some simulation met them. */
export type DigitalHumanVersion = {
  readonly id: string;
  readonly digitalHumanId: string;
  readonly version: number;
  readonly traits: DigitalHumanTraits;
  readonly createdAt: Date;
};

const notDeleted: SQL = isNull(digitalHuman.deletedAt);

/** An answer's columns, and no more — the hash-free, tenant-free view. */
const COLUMNS = {
  id: digitalHuman.id,
  projectId: digitalHuman.projectId,
  name: digitalHuman.name,
  description: digitalHuman.description,
  createdAt: digitalHuman.createdAt,
  updatedAt: digitalHuman.updatedAt,
} as const;

/** Speech only stays intelligible so far from natural pace. */
const SPEED_RANGE = { slowest: 0.5, fastest: 2 } as const;

function validateName(name: string): void {
  if (name.trim() === "") {
    throw new Error("a digital human needs a name");
  }
}

function validateTraits(traits: DigitalHumanTraits): void {
  if (traits.personality.trim() === "") {
    throw new Error("a digital human needs a personality");
  }
  if (traits.language.trim() === "") {
    throw new Error("a digital human needs a language");
  }
  const { provider, voiceId, speed } = traits.voice;
  if (!VOICE_PROVIDERS.includes(provider)) {
    throw new Error(
      `"${provider}" is not a voice provider egma knows; expected one of ${VOICE_PROVIDERS.join(", ")}`,
    );
  }
  if (voiceId.trim() === "") {
    throw new Error("a digital human needs a voice id from its provider");
  }
  if (
    !Number.isFinite(speed) ||
    speed < SPEED_RANGE.slowest ||
    speed > SPEED_RANGE.fastest
  ) {
    throw new Error(
      `speaking speed must be between ${SPEED_RANGE.slowest} and ${SPEED_RANGE.fastest}`,
    );
  }
}

function validateNewDigitalHuman(input: NewDigitalHuman): void {
  validateName(input.name);
  validateTraits(input.traits);
}

/**
 * The shape guard on every read. Stored jsonb comes back `unknown`, and a row
 * somebody hand-edited must fail here, loudly and naming itself, rather than
 * leak into a caller as a `DigitalHumanTraits` that isn't one. Shape only,
 * deliberately: the allowed provider list and the speed range may tighten
 * later, and an old version must stay readable exactly as it was written —
 * so the provider is taken on trust once it is a string.
 */
function traitsFromRow(value: unknown, versionId: string): DigitalHumanTraits {
  const malformed = () =>
    new Error(
      `version ${versionId} holds traits in a shape egma never writes; the row needs repairing before anybody can read it`,
    );

  if (typeof value !== "object" || value === null) throw malformed();
  const { personality, language, voice } = value as Record<string, unknown>;
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
  readonly [K in keyof DigitalHumanTraits["voice"]]: (
    a: DigitalHumanTraits["voice"],
    b: DigitalHumanTraits["voice"],
  ) => boolean;
} = {
  provider: (a, b) => a.provider === b.provider,
  voiceId: (a, b) => a.voiceId === b.voiceId,
  speed: (a, b) => a.speed === b.speed,
};

const sameTraitsField: {
  readonly [K in keyof DigitalHumanTraits]: (
    a: DigitalHumanTraits,
    b: DigitalHumanTraits,
  ) => boolean;
} = {
  personality: (a, b) => a.personality === b.personality,
  language: (a, b) => a.language === b.language,
  voice: (a, b) =>
    Object.values(sameVoiceField).every((same) => same(a.voice, b.voice)),
};

function sameTraits(a: DigitalHumanTraits, b: DigitalHumanTraits): boolean {
  return Object.values(sameTraitsField).every((same) => same(a, b));
}

/** Acting in a project narrows to it; acting in none reaches the customer. */
function inActingProject(auth: AuthContext): SQL | undefined {
  return auth.projectId === undefined
    ? undefined
    : eq(digitalHuman.projectId, auth.projectId);
}

/** The named digital human, alive, within the caller's tenancy and scope. */
function theDigitalHuman(auth: AuthContext, id: string): SQL {
  return within(
    auth,
    digitalHuman,
    and(eq(digitalHuman.id, id), notDeleted, inActingProject(auth)),
  );
}

export async function createDigitalHuman(
  auth: AuthContext,
  input: NewDigitalHuman,
): Promise<DigitalHuman> {
  authorize(auth, "author_definitions", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "a digital human belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  // Everything answerable without the database is answered first; only an
  // input worth writing costs the project-membership read below.
  validateNewDigitalHuman(input);

  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  const id = newId("dh");
  const versionId = newId("dhv");

  const inserted = await db().transaction(async (tx) => {
    // The identity row goes first, naming a version that does not exist yet;
    // the pointer's constraint is deferred, so Postgres checks it at commit.
    const [identity] = await tx
      .insert(digitalHuman)
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

    await tx.insert(digitalHumanVersion).values({
      id: versionId,
      digitalHumanId: id,
      version: 1,
      traits: input.traits,
      createdBy: auth.userId,
    });

    return identity;
  });

  if (inserted === undefined) throw new Error("the digital human was not written");

  return { ...inserted, version: 1, versionId, traits: input.traits };
}

/**
 * The identity row joined to its current version — the shape `get` and `list`
 * both answer with, written once so the two can never drift.
 */
function selectWithCurrentVersion() {
  return db()
    .select({
      ...COLUMNS,
      version: digitalHumanVersion.version,
      versionId: digitalHumanVersion.id,
      traits: digitalHumanVersion.traits,
    })
    .from(digitalHuman)
    .innerJoin(
      digitalHumanVersion,
      eq(digitalHuman.currentVersionId, digitalHumanVersion.id),
    );
}

export async function getDigitalHuman(
  auth: AuthContext,
  id: string,
): Promise<DigitalHuman | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await selectWithCurrentVersion()
    .where(theDigitalHuman(auth, id))
    .limit(1);

  if (row === undefined) return undefined;
  return { ...row, traits: traitsFromRow(row.traits, row.versionId) };
}

/**
 * One door for every change, so no caller needs the version rules to pick a
 * function — the rules live here. Name and description write in place and
 * version nothing. Traits that differ from the current version insert the
 * next version and move the pointer, in one transaction with the identity row
 * locked, so two concurrent edits number one after the other rather than
 * fighting over the same version number. Traits byte-identical to the current
 * version are not an edit at all: nothing is written, not even `updated_at`,
 * and the current version comes back.
 *
 * Editing what the caller cannot see returns what reading it would have:
 * `undefined`, with nothing disturbed.
 */
export async function editDigitalHuman(
  auth: AuthContext,
  id: string,
  changes: DigitalHumanChanges,
): Promise<DigitalHuman | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (changes.name !== undefined) validateName(changes.name);
  if (changes.traits !== undefined) validateTraits(changes.traits);

  return db().transaction(async (tx) => {
    const [locked] = await tx
      .select({ ...COLUMNS, currentVersionId: digitalHuman.currentVersionId })
      .from(digitalHuman)
      .where(theDigitalHuman(auth, id))
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
        id: digitalHumanVersion.id,
        version: digitalHumanVersion.version,
        traits: digitalHumanVersion.traits,
      })
      .from(digitalHumanVersion)
      .where(eq(digitalHumanVersion.id, currentVersionId))
      .limit(1);
    if (currentVersion === undefined) {
      throw new Error("the digital human's current version is missing");
    }

    const storedTraits = traitsFromRow(currentVersion.traits, currentVersion.id);
    const nextTraits =
      changes.traits !== undefined && !sameTraits(storedTraits, changes.traits)
        ? changes.traits
        : undefined;
    const identityChanged =
      changes.name !== undefined || changes.description !== undefined;

    if (nextTraits === undefined && !identityChanged) {
      return {
        ...current,
        version: currentVersion.version,
        versionId: currentVersion.id,
        traits: storedTraits,
      };
    }

    let versionId = currentVersion.id;
    let version = currentVersion.version;
    if (nextTraits !== undefined) {
      versionId = newId("dhv");
      version = currentVersion.version + 1;
      await tx.insert(digitalHumanVersion).values({
        id: versionId,
        digitalHumanId: current.id,
        version,
        traits: nextTraits,
        createdBy: auth.userId,
      });
    }

    const [updated] = await tx
      .update(digitalHuman)
      .set({
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.description === undefined
          ? {}
          : { description: changes.description }),
        ...(nextTraits === undefined ? {} : { currentVersionId: versionId }),
        updatedAt: new Date(),
      })
      .where(eq(digitalHuman.id, current.id))
      .returning(COLUMNS);

    if (updated === undefined) {
      throw new Error("the digital human was not written");
    }
    return {
      ...updated,
      version,
      versionId,
      traits: nextTraits ?? storedTraits,
    };
  });
}

/**
 * One frozen version, by its own `dhv_` id — the read a run uses to stay
 * interpretable after the digital human moves on. Deliberately no deleted
 * filter: versions outlive their digital human's deletion, so a run that
 * pinned one can always say exactly who the digital human was.
 */
export async function getDigitalHumanVersion(
  auth: AuthContext,
  versionId: string,
): Promise<DigitalHumanVersion | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select({
      id: digitalHumanVersion.id,
      digitalHumanId: digitalHumanVersion.digitalHumanId,
      version: digitalHumanVersion.version,
      traits: digitalHumanVersion.traits,
      createdAt: digitalHumanVersion.createdAt,
    })
    .from(digitalHumanVersion)
    .innerJoin(
      digitalHuman,
      eq(digitalHumanVersion.digitalHumanId, digitalHuman.id),
    )
    .where(
      within(
        auth,
        digitalHuman,
        and(eq(digitalHumanVersion.id, versionId), inActingProject(auth)),
      ),
    )
    .limit(1);

  if (row === undefined) return undefined;
  return { ...row, traits: traitsFromRow(row.traits, row.id) };
}

/**
 * One page of the digital humans the caller can reach — the acting project's,
 * or the whole customer's for a credential acting in none — and where the
 * next page starts.
 *
 * The ids are Crockford base32 of UUIDv7 under `COLLATE "C"`, so ordering by
 * id *is* ordering by mint time and the last id of a page is the whole cursor
 * — no second sort column, no offset to drift when rows arrive mid-scroll.
 * Newest first, because the digital human somebody is looking for is usually
 * the one they just made.
 */
export type DigitalHumanPage = {
  readonly items: readonly DigitalHuman[];
  /** Hand back as `cursor` to continue; absent on the last page. */
  readonly nextCursor: string | undefined;
};

const DEFAULT_PAGE_SIZE = 50;
const LARGEST_PAGE_SIZE = 200;

export async function listDigitalHumans(
  auth: AuthContext,
  page?: {
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
  },
): Promise<DigitalHumanPage> {
  authorize(auth, "read", here(auth));

  const limit = page?.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > LARGEST_PAGE_SIZE) {
    throw new Error(
      `a page holds between 1 and ${LARGEST_PAGE_SIZE} digital humans`,
    );
  }
  const cursor = page?.cursor;
  if (cursor !== undefined && !isId("dh", cursor)) {
    throw new Error(
      `"${cursor}" is not a digital-human id, so it cannot be a cursor`,
    );
  }

  const olderThanCursor =
    cursor === undefined ? undefined : lt(digitalHuman.id, cursor);

  // One row beyond the page answers "is there more?" without a second query.
  const rows = await selectWithCurrentVersion()
    .where(
      within(
        auth,
        digitalHuman,
        and(notDeleted, inActingProject(auth), olderThanCursor),
      ),
    )
    .orderBy(desc(digitalHuman.id))
    .limit(limit + 1);

  const items = rows
    .slice(0, limit)
    .map((row) => ({ ...row, traits: traitsFromRow(row.traits, row.versionId) }));

  return {
    items,
    nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined,
  };
}

/**
 * A new digital human whose version 1 carries the source's current traits.
 *
 * A clone is a create with the retyping saved: fresh `dh_` and `dhv_` ids,
 * version numbering starting over at 1, and no link back — the source's
 * history is the source's, and nothing of it comes along. The source is read
 * through the same seam as `getDigitalHuman`, so a clone can only be taken of
 * what the caller could have fetched: same customer, same acting project,
 * not deleted.
 *
 * Authorization is layered on purpose, not by accident of delegation. The
 * leading check refuses a viewer before anything is read, and a credential
 * acting in no project is refused right after it, still before the read —
 * the same stance as create and delete, and it keeps `undefined` meaning
 * invisible rather than refused. `getDigitalHuman`'s `read` applies because
 * the clone hands the source's traits back, which is a read;
 * `createDigitalHuman`'s check applies because a clone is a create. If
 * reading ever gains a gate of its own, a caller who may not read the source
 * must be refused out loud here — never handed an `undefined` that pretends
 * the source does not exist, which would make clone the one path that reads
 * without the read permission.
 */
export async function cloneDigitalHuman(
  auth: AuthContext,
  id: string,
): Promise<DigitalHuman | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "a clone lands in the acting project, and this credential is for the whole organization and acting in none",
    );
  }

  const source = await getDigitalHuman(auth, id);
  if (source === undefined) return undefined;

  return createDigitalHuman(auth, {
    name: source.name,
    description: source.description ?? undefined,
    traits: source.traits,
  });
}

export type DeletedDigitalHuman = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly deletedAt: Date;
};

/**
 * The soft-delete marker, and only the marker. The digital human vanishes
 * from lists and fetches at once; the version rows stay exactly where they
 * are, because a run that pinned one must stay interpretable for as long as
 * the run itself is kept. Sweeping orphaned versions is the deletion worker's
 * job, not this function's.
 *
 * Like create, this refuses a credential acting in no project. An edit lands
 * on a row that already names its own project; a delete decides the digital
 * human should stop appearing in one, and emptying a project is an act taken
 * from inside it — a credential for the whole customer is acting in none.
 */
export async function deleteDigitalHuman(
  auth: AuthContext,
  id: string,
): Promise<DeletedDigitalHuman | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "deleting a digital human happens inside their project, and this credential is for the whole organization and acting in none",
    );
  }

  const deletedAt = new Date();
  const [row] = await db()
    .update(digitalHuman)
    .set({ deletedAt, updatedAt: deletedAt })
    .where(theDigitalHuman(auth, id))
    .returning({
      id: digitalHuman.id,
      projectId: digitalHuman.projectId,
      name: digitalHuman.name,
    });

  if (row === undefined) return undefined;
  return { ...row, deletedAt };
}
