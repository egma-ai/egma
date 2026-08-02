import { newId } from "@egma/ids";
import { and, eq, isNull, type SQL } from "drizzle-orm";

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
 * project, so that write has somewhere to land.
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
 * Byte-identical or not, decided field by field. The traits shape is closed,
 * so this is the same answer canonical serialization would give, without
 * trusting any serializer to order keys the way jsonb re-ordered them.
 */
function sameTraits(a: DigitalHumanTraits, b: DigitalHumanTraits): boolean {
  return (
    a.personality === b.personality &&
    a.language === b.language &&
    a.voice.provider === b.voice.provider &&
    a.voice.voiceId === b.voice.voiceId &&
    a.voice.speed === b.voice.speed
  );
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

export async function getDigitalHuman(
  auth: AuthContext,
  id: string,
): Promise<DigitalHuman | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
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
    )
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

    // The one `where` in this file that starts from a bare `eq` rather than
    // `within`: the id it names just came off the tenancy-checked row locked
    // above, in this same transaction, so the predicate cannot reach further
    // than that check already did.
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
 * pinned one can always say exactly who called.
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
