import { isId, newId } from "@egma/ids";
import { and, desc, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm";

import { db } from "../client.ts";
import {
  persona,
  personaVersion,
} from "../schema/personas.ts";
import type { AuthContext } from "./context.ts";
import {
  PersonaNamedByTestsError,
  ProjectOutsideOrganizationError,
  UnprocessableInputError,
} from "./errors.ts";
import { pageOf, pageWindow, type PageRequest } from "./pages.ts";
import { authorize, here } from "./permissions.ts";
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
 * project, so that write has somewhere to land. Deleting it refuses like
 * creating, because taking a persona out of a project is an act taken
 * inside one — `deletePersona` says why.
 */

/** The mouths egma knows how to ask for. Grows one entry at a time. */
export const VOICE_PROVIDERS = ["elevenlabs", "cartesia", "openai"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

/**
 * Who the persona is. The voice is concrete — provider, that provider's
 * catalog id, and pace — so the same persona sounds identical on every
 * future simulation; a described voice would let two runs cast two people.
 */
export type PersonaTraits = {
  readonly personality: string;
  readonly language: string;
  readonly voice: {
    readonly provider: VoiceProvider;
    readonly voiceId: string;
    readonly speed: number;
  };
};

export type NewPersona = {
  readonly name: string;
  readonly description?: string | undefined;
  readonly traits: PersonaTraits;
};

export type Persona = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  /** The current version's own `prsv_` id — what a run pins. */
  readonly versionId: string;
  readonly traits: PersonaTraits;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * What an edit may touch. Name and description are identity and version
 * nothing; traits are behavior and version on any change. Absent means keep.
 */
export type PersonaChanges = {
  readonly name?: string;
  readonly description?: string | null;
  readonly traits?: PersonaTraits;
};

/** One version, frozen: the persona exactly as some simulation met them. */
export type PersonaVersion = {
  readonly id: string;
  readonly personaId: string;
  readonly version: number;
  readonly traits: PersonaTraits;
  readonly createdAt: Date;
};

const notDeleted: SQL = isNull(persona.deletedAt);

/** An answer's columns, and no more — the hash-free, tenant-free view. */
const COLUMNS = {
  id: persona.id,
  projectId: persona.projectId,
  name: persona.name,
  description: persona.description,
  createdAt: persona.createdAt,
  updatedAt: persona.updatedAt,
} as const;

/** Speech only stays intelligible so far from natural pace. */
const SPEED_RANGE = { slowest: 0.5, fastest: 2 } as const;

function validateName(name: string): void {
  if (name.trim() === "") {
    throw new Error("a persona needs a name");
  }
}

function validateTraits(traits: PersonaTraits): void {
  if (traits.personality.trim() === "") {
    throw new Error("a persona needs a personality");
  }
  if (traits.language.trim() === "") {
    throw new Error("a persona needs a language");
  }
  const { provider, voiceId, speed } = traits.voice;
  if (!VOICE_PROVIDERS.includes(provider)) {
    throw new Error(
      `"${provider}" is not a voice provider Egma knows; expected one of ${VOICE_PROVIDERS.join(", ")}`,
    );
  }
  if (voiceId.trim() === "") {
    throw new Error("a persona needs a voice id from its provider");
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

function validateNewPersona(input: NewPersona): void {
  validateName(input.name);
  validateTraits(input.traits);
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
  readonly [K in keyof PersonaTraits["voice"]]: (
    a: PersonaTraits["voice"],
    b: PersonaTraits["voice"],
  ) => boolean;
} = {
  provider: (a, b) => a.provider === b.provider,
  voiceId: (a, b) => a.voiceId === b.voiceId,
  speed: (a, b) => a.speed === b.speed,
};

const sameTraitsField: {
  readonly [K in keyof PersonaTraits]: (
    a: PersonaTraits,
    b: PersonaTraits,
  ) => boolean;
} = {
  personality: (a, b) => a.personality === b.personality,
  language: (a, b) => a.language === b.language,
  voice: (a, b) =>
    Object.values(sameVoiceField).every((same) => same(a.voice, b.voice)),
};

function sameTraits(a: PersonaTraits, b: PersonaTraits): boolean {
  return Object.values(sameTraitsField).every((same) => same(a, b));
}

/** Acting in a project narrows to it; acting in none reaches the customer. */
function inActingProject(auth: AuthContext): SQL | undefined {
  return auth.projectId === undefined
    ? undefined
    : eq(persona.projectId, auth.projectId);
}

/** The named persona, alive, within the caller's tenancy and scope. */
function thePersona(auth: AuthContext, id: string): SQL {
  return within(
    auth,
    persona,
    and(eq(persona.id, id), notDeleted, inActingProject(auth)),
  );
}

export async function createPersona(
  auth: AuthContext,
  input: NewPersona,
): Promise<Persona> {
  authorize(auth, "author_definitions", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "a persona belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  // Everything answerable without the database is answered first; only an
  // input worth writing costs the project-membership read below.
  validateNewPersona(input);

  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  const id = newId("prs");
  const versionId = newId("prsv");

  const inserted = await db().transaction(async (tx) => {
    // The identity row goes first, naming a version that does not exist yet;
    // the pointer's constraint is deferred, so Postgres checks it at commit.
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
      traits: input.traits,
      createdBy: auth.userId,
    });

    return identity;
  });

  if (inserted === undefined) throw new Error("the persona was not written");

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
      version: personaVersion.version,
      versionId: personaVersion.id,
      traits: personaVersion.traits,
    })
    .from(persona)
    .innerJoin(
      personaVersion,
      eq(persona.currentVersionId, personaVersion.id),
    );
}

export async function getPersona(
  auth: AuthContext,
  id: string,
): Promise<Persona | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await selectWithCurrentVersion()
    .where(thePersona(auth, id))
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
export async function editPersona(
  auth: AuthContext,
  id: string,
  changes: PersonaChanges,
): Promise<Persona | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (changes.name !== undefined) validateName(changes.name);
  if (changes.traits !== undefined) validateTraits(changes.traits);

  return db().transaction(async (tx) => {
    const [locked] = await tx
      .select({ ...COLUMNS, currentVersionId: persona.currentVersionId })
      .from(persona)
      .where(thePersona(auth, id))
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
        updatedAt: new Date(),
      })
      .where(eq(persona.id, current.id))
      .returning(COLUMNS);

    if (updated === undefined) {
      throw new Error("the persona was not written");
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
 * One frozen version, by its own `prsv_` id — the read a run uses to stay
 * interpretable after the persona moves on. Deliberately no deleted
 * filter: versions outlive their persona's deletion, so a run that
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
      within(
        auth,
        persona,
        and(eq(personaVersion.id, versionId), inActingProject(auth)),
      ),
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

export async function listPersonas(
  auth: AuthContext,
  page?: PageRequest,
): Promise<PersonaPage> {
  authorize(auth, "read", here(auth));

  const { limit, cursor } = pageWindow(page, {
    singular: "persona",
    plural: "personas",
    prefix: "prs",
  });
  const olderThanCursor =
    cursor === undefined ? undefined : lt(persona.id, cursor);

  const rows = await selectWithCurrentVersion()
    .where(
      within(
        auth,
        persona,
        and(notDeleted, inActingProject(auth), olderThanCursor),
      ),
    )
    .orderBy(desc(persona.id))
    .limit(limit + 1);

  const { items, nextCursor } = pageOf(rows, limit);
  return {
    items: items.map((row) => ({
      ...row,
      traits: traitsFromRow(row.traits, row.versionId),
    })),
    nextCursor,
  };
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
 * somebody in a test that nobody chose. And the same persona named twice, which
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
    .select({ id: persona.id, name: persona.name, deletedAt: persona.deletedAt })
    .from(persona)
    .where(
      within(
        auth,
        persona,
        and(
          eq(persona.projectId, projectId),
          or(inArray(persona.id, wanted), inArray(persona.name, wanted)),
        ),
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
    const found = answering.filter((row) => row.deletedAt === null);

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
          : `Egma has no persona called "${entry}" in this project. Name a persona this project already has, or name none and Egma takes the project's default.`,
      );
    }
    if (found.length > 1) {
      throw new UnprocessableInputError(
        `this project has more than one persona called "${entry}", so Egma cannot tell which one this test means. Name the one you want by its prs_ identifier.`,
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
 * A clone is a create with the retyping saved: fresh `prs_` and `prsv_` ids,
 * version numbering starting over at 1, and no link back — the source's
 * history is the source's, and nothing of it comes along. The source is read
 * through the same seam as `getPersona`, so a clone can only be taken of
 * what the caller could have fetched: same customer, same acting project,
 * not deleted.
 *
 * Authorization is layered on purpose, not by accident of delegation. The
 * leading check refuses a viewer before anything is read, and a credential
 * acting in no project is refused right after it, still before the read —
 * the same stance as create and delete, and it keeps `undefined` meaning
 * invisible rather than refused. `getPersona`'s `read` applies because
 * the clone hands the source's traits back, which is a read;
 * `createPersona`'s check applies because a clone is a create. If
 * reading ever gains a gate of its own, a caller who may not read the source
 * must be refused out loud here — never handed an `undefined` that pretends
 * the source does not exist, which would make clone the one path that reads
 * without the read permission.
 */
export async function clonePersona(
  auth: AuthContext,
  id: string,
): Promise<Persona | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "a clone lands in the acting project, and this credential is for the whole organization and acting in none",
    );
  }

  const source = await getPersona(auth, id);
  if (source === undefined) return undefined;

  return createPersona(auth, {
    name: source.name,
    description: source.description ?? undefined,
    traits: source.traits,
  });
}

export type DeletedPersona = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly deletedAt: Date;
};

/**
 * The soft-delete marker, and only the marker. The persona vanishes
 * from lists and fetches at once; the version rows stay exactly where they
 * are, because a run that pinned one must stay interpretable for as long as
 * the run itself is kept. Sweeping orphaned versions is the deletion worker's
 * job, not this function's.
 *
 * **Refused while the current version of a live test names them**, naming every
 * test standing in the way; `PersonaNamedByTestsError` says why. Historical
 * versions never block, and neither does a deleted test.
 *
 * Like create, this refuses a credential acting in no project. An edit lands
 * on a row that already names its own project; a delete decides the persona
 * should stop appearing in one, and emptying a project is an act taken
 * from inside it — a credential for the whole customer is acting in none.
 */
export async function deletePersona(
  auth: AuthContext,
  id: string,
): Promise<DeletedPersona | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "deleting a persona happens inside their project, and this credential is for the whole organization and acting in none",
    );
  }

  const deletedAt = new Date();
  return db().transaction(async (tx) => {
    // Locked before the tests naming them are counted, and held until this
    // transaction ends, so nothing can come to name them between the count and
    // the write — which a count taken on this transaction's own snapshot could
    // not promise. The other half is the shared lock a test being written takes
    // on this same row, which `validateNamedPersonas` in `tests.ts`
    // explains: the two modes conflict, so one of the two writes always waits
    // for the other and then sees how it ended.
    const [locked] = await tx
      .select({ id: persona.id })
      .from(persona)
      .where(thePersona(auth, id))
      .limit(1)
      .for("update");

    if (locked === undefined) return undefined;

    const blocking = await liveTestsNamingPersona(tx, locked.id);
    if (blocking.length > 0) {
      throw new PersonaNamedByTestsError(locked.id, blocking);
    }

    // A bare `eq` on an id that just came off the tenancy-checked row locked
    // above, in this same transaction, so it reaches no further than that check
    // already did — the move `editPersona` makes, for the same reason.
    const [row] = await tx
      .update(persona)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(eq(persona.id, locked.id))
      .returning({
        id: persona.id,
        projectId: persona.projectId,
        name: persona.name,
      });

    if (row === undefined) throw new Error("the persona was not written");
    return { ...row, deletedAt };
  });
}
