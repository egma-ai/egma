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
 * is acting in none.
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
  readonly traits: DigitalHumanTraits;
  readonly createdAt: Date;
  readonly updatedAt: Date;
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

function validateNewDigitalHuman(input: NewDigitalHuman): void {
  if (input.name.trim() === "") {
    throw new Error("a digital human needs a name");
  }
  if (input.traits.personality.trim() === "") {
    throw new Error("a digital human needs a personality");
  }
  if (input.traits.language.trim() === "") {
    throw new Error("a digital human needs a language");
  }
  const { provider, voiceId, speed } = input.traits.voice;
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
  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  validateNewDigitalHuman(input);

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

  return { ...inserted, version: 1, traits: input.traits };
}

export async function getDigitalHuman(
  auth: AuthContext,
  id: string,
): Promise<DigitalHuman | undefined> {
  authorize(auth, "read", here(auth));

  // Acting in a project narrows to it; acting in none reads the customer.
  const inActingProject =
    auth.projectId === undefined
      ? undefined
      : eq(digitalHuman.projectId, auth.projectId);

  const [row] = await db()
    .select({
      ...COLUMNS,
      version: digitalHumanVersion.version,
      traits: digitalHumanVersion.traits,
    })
    .from(digitalHuman)
    .innerJoin(
      digitalHumanVersion,
      eq(digitalHuman.currentVersionId, digitalHumanVersion.id),
    )
    .where(
      within(
        auth,
        digitalHuman,
        and(eq(digitalHuman.id, id), notDeleted, inActingProject),
      ),
    )
    .limit(1);

  if (row === undefined) return undefined;
  return { ...row, traits: row.traits as DigitalHumanTraits };
}
