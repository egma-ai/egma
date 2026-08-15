import { and, desc, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";

import { db } from "../client.ts";
import {
  GRADER_LIBRARY_CATALOG,
  type LibraryOutputDefinition,
  type LibraryParameter,
  type PredefinedGrader,
} from "../grader-library/catalog.ts";
import {
  graderLibrary,
  type LibraryType,
} from "../schema/graders.ts";
import type { AuthContext } from "./context.ts";
import { PredefinedGraderError } from "./errors.ts";
import { pageOf, pageWindow, type PageRequest } from "./pages.ts";
import { authorize, here } from "./permissions.ts";

/**
 * The grader library: the shelf of definitions, as it is seeded, read and
 * refused.
 *
 * What an entry *is* is the schema file's story (`schema/graders.ts`) and what
 * egma ships is the catalog's (`grader-library/catalog.ts`); this file is how
 * they are reached.
 *
 * Three doors, and the split between them is the design:
 *
 * - **Seeding** is the deployment writing egma's own entries from egma's own
 *   code, in the same breath as applying its migrations. It takes no context
 *   because there is no user and no customer — a predefined entry belongs to
 *   egma — and it is safe on every boot because it is an upsert that writes only
 *   what actually changed.
 * - **Reading** answers the entries a caller can see: egma's, plus their own
 *   team's when custom authoring arrives. Owner is **derived from tenancy**
 *   rather than stored, so the label on the Library screen and the row's
 *   ownership can never disagree.
 * - **Deleting** exists to refuse. There is no authoring surface in v0, so the
 *   only entries that exist are egma's, and egma's are undeletable — see
 *   `PredefinedGraderError`, which says why in the words a person reads.
 */

export type { LibraryOutputDefinition, LibraryParameter, PredefinedGrader };

/**
 * Who owns an entry, read off its tenancy rather than stored beside it.
 *
 * `egma` is null tenancy — the schema's one deliberate exception, and the whole
 * mechanism behind the Owner column. `organization` is an entry a team
 * authored, which is every entry that is not egma's, because the list a caller
 * reads is already narrowed to their own customer: there is no third answer
 * this door can return and no row it could return one for.
 */
export type LibraryOwner = "egma" | "organization";

/** One entry, as the Library screen and the API read it. */
export type LibraryEntry = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: LibraryType;
  /** Derived from tenancy; never a stored flag. */
  readonly owner: LibraryOwner;
  /** The project it belongs to, or null for one of egma's. */
  readonly projectId: string | null;
  readonly version: number;
  /** The judge prompt, for a judged entry — what the screen shows a developer. */
  readonly prompt: string | null;
  /** What **Use** will ask for. Empty where it asks nothing. */
  readonly params: readonly LibraryParameter[];
  readonly outputDefinition: LibraryOutputDefinition | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type LibraryPage = {
  readonly items: readonly LibraryEntry[];
  /** Hand back as `cursor` to continue; absent on the last page. */
  readonly nextCursor: string | undefined;
};

/** An answer's columns, and no more. The source columns are not among them. */
const COLUMNS = {
  id: graderLibrary.id,
  organizationId: graderLibrary.organizationId,
  projectId: graderLibrary.projectId,
  name: graderLibrary.name,
  description: graderLibrary.description,
  type: graderLibrary.type,
  version: graderLibrary.version,
  prompt: graderLibrary.prompt,
  params: graderLibrary.params,
  outputDefinition: graderLibrary.outputDefinition,
  createdAt: graderLibrary.createdAt,
  updatedAt: graderLibrary.updatedAt,
} as const;

/**
 * The definition fields the catalog owns, named once.
 *
 * **Everything downstream is derived from this list**: what an upsert writes,
 * and what an upsert compares to decide whether anything changed. Written twice
 * by hand, the two would drift — and a comparison missing a field is the exact
 * failure the version number exists to rule out, because an edited entry would
 * refresh silently with its version standing still, leaving no way at all to
 * tell which words judged which verdict.
 *
 * The compiler holds the pair together: a field added here refuses to build
 * until it is also told where its value comes from.
 */
const REFRESHED_FIELDS = [
  "name",
  "description",
  "type",
  "prompt",
  "params",
  "outputDefinition",
] as const;

type RefreshedField = (typeof REFRESHED_FIELDS)[number];

/** Each field's incoming value, as `on conflict` names the row being inserted. */
const FROM_THE_CATALOG: Readonly<Record<RefreshedField, SQL>> = {
  name: sql`excluded.name`,
  description: sql`excluded.description`,
  type: sql`excluded.type`,
  prompt: sql`excluded.prompt`,
  params: sql`excluded.params`,
  outputDefinition: sql`excluded.output_definition`,
};

/**
 * Whether the catalog says anything different from what the row already holds.
 *
 * `is distinct from` rather than `<>`, because half of these are nullable and
 * `null <> null` is null — which would make every boot look like a change on an
 * entry with no prompt, bumping a version for nothing. jsonb compares as a
 * value, so key order on the way in cannot mint a version either.
 */
const THE_CATALOG_HAS_MOVED: SQL = sql.join(
  REFRESHED_FIELDS.map(
    (field) =>
      sql`${graderLibrary[field]} is distinct from ${FROM_THE_CATALOG[field]}`,
  ),
  sql` or `,
);

/** One entry the seeding wrote, as the boot log names it. */
export type SeededGrader = {
  readonly id: string;
  readonly name: string;
  /** 1 where this run created the entry; higher where it refreshed one. */
  readonly version: number;
};

/**
 * Write egma's own graders onto the shelf, from egma's own code.
 *
 * **Deterministic, and that is the whole property.** Every entry carries a
 * fixed identifier, so the write is an upsert keyed by identity rather than a
 * merge by name: run it twice and the second run finds every row exactly as it
 * left it and writes nothing at all — not even `updated_at`, which says when
 * the *definition* last moved rather than when a container last started.
 *
 * **And refreshing.** Change an entry's words in the catalog, ship the release,
 * and the next boot updates that row and bumps its `version` — so an improved
 * judge prompt reaches every project on every deployment with nobody
 * migrating anything, and which words judged a given verdict stays answerable
 * from the catalog's history and this number. The bump happens only where
 * something actually differs, which is what keeps the number meaningful:
 * a version that moved every Tuesday would say nothing about anything.
 *
 * **Not authorized against an `AuthContext`, on the platform settings' exact
 * terms.** There is no user here: this is the deployment writing its own
 * product behaviour, in the same breath as applying its migrations, and a
 * predefined entry names no customer because it belongs to none — its tenancy
 * columns are null, which is what *predefined* means in this schema.
 *
 * The catalog is a parameter with the shipped one as its default, so a test can
 * hand in an edited copy and watch a version move. Nothing in it can name a
 * customer, and the build rule that lets this function skip the context
 * enforces exactly that.
 */
export async function seedGraderLibrary(
  catalog: readonly PredefinedGrader[] = GRADER_LIBRARY_CATALOG,
): Promise<readonly SeededGrader[]> {
  if (catalog.length === 0) return [];

  const now = new Date();
  const written = await db()
    .insert(graderLibrary)
    .values(
      catalog.map((entry) => ({
        id: entry.id,
        // Null on both, which is how this schema says "egma owns it". Written
        // out rather than omitted, so the one exception to hard-required
        // tenancy is visible at the site that takes it.
        organizationId: null,
        projectId: null,
        name: entry.name,
        description: entry.description,
        type: entry.type,
        prompt: entry.prompt,
        params: entry.params,
        outputDefinition: entry.outputDefinition,
        // The day egma shipped the entry, from the catalog — not the day this
        // container happened to boot. `updated_at` starts there too and moves
        // only when the words do.
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
      })),
    )
    .onConflictDoUpdate({
      target: graderLibrary.id,
      set: {
        ...FROM_THE_CATALOG,
        version: sql`${graderLibrary.version} + 1`,
        updatedAt: now,
      },
      // Nothing is written where nothing changed, which is what makes running
      // this on every boot free rather than merely harmless: no row is touched,
      // no version moves, and `returning` hands back exactly what this release
      // brought.
      setWhere: THE_CATALOG_HAS_MOVED,
    })
    .returning({
      id: graderLibrary.id,
      name: graderLibrary.name,
      version: graderLibrary.version,
    });

  return written;
}

/**
 * The entries this caller can see: egma's own, and their own organization's.
 *
 * **Both halves are the tenancy, and the null half is not a hole.** An entry
 * with no organization belongs to egma and is on every customer's shelf by
 * design — that is what a predefined grader is. An entry with one belongs to
 * that customer and is reachable only by them, which is the ordinary rule this
 * module holds everywhere. There is no predicate here a caller can widen: the
 * organization it compares against is the context's own.
 *
 * `within` is deliberately not used, and this is the one place in the module
 * that says so out loud: it builds `organization_id = $me`, which would hide
 * every one of egma's rows. The predicate below is that one with egma's null
 * added beside it, and nothing else.
 *
 * A context acting in a project sees that project's entries; a credential for
 * the whole customer, acting in none, sees the customer's. Egma's are outside
 * both narrowings, because they belong to no project either.
 */
function readable(auth: AuthContext): SQL {
  const egmas = isNull(graderLibrary.organizationId);
  const theirs =
    auth.projectId === undefined
      ? eq(graderLibrary.organizationId, auth.organizationId)
      : and(
          eq(graderLibrary.organizationId, auth.organizationId),
          eq(graderLibrary.projectId, auth.projectId),
        );

  const either = or(egmas, theirs);
  if (either === undefined) throw new Error("a tenancy predicate can never be empty");
  return either;
}

/** Owner, worked out from tenancy and never from a stored flag. */
function ownerOf(organizationId: string | null): LibraryOwner {
  return organizationId === null ? "egma" : "organization";
}

/**
 * The stored jsonb, read back as what it is.
 *
 * Shape only, and deliberately: what a parameter's `kind` may be will grow, and
 * an entry written by an older release has to stay readable exactly as it was
 * written. A row somebody hand-edited into something that is not a list is the
 * one case that fails here, loudly, rather than reaching a form as a list that
 * isn't one.
 */
function parametersFromRow(value: unknown, id: string): readonly LibraryParameter[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `library entry ${id} holds parameters in a shape egma never writes; the row needs repairing before anybody can read it`,
    );
  }
  return value as readonly LibraryParameter[];
}

function answer(row: {
  readonly id: string;
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly type: string;
  readonly version: number;
  readonly prompt: string | null;
  readonly params: unknown;
  readonly outputDefinition: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): LibraryEntry {
  const { organizationId, type, params, outputDefinition, ...rest } = row;
  return {
    ...rest,
    // Pinned by a check constraint on the way in, so what comes back is one of
    // the two words this module writes.
    type: type as LibraryType,
    owner: ownerOf(organizationId),
    params: parametersFromRow(params, row.id),
    outputDefinition: outputDefinition as LibraryOutputDefinition | null,
  };
}

/**
 * One page of the shelf, newest first on the id — which is the mint order, and
 * for the predefined pair the order they were written in the catalog.
 *
 * The page rules are every other list's, written once in `pages.ts`.
 */
export async function listGraderLibrary(
  auth: AuthContext,
  page?: PageRequest,
): Promise<LibraryPage> {
  authorize(auth, "read", here(auth));

  const { limit, cursor } = pageWindow(page, {
    singular: "library entry",
    plural: "library entries",
    prefix: "grl",
  });
  const olderThanCursor =
    cursor === undefined ? undefined : lt(graderLibrary.id, cursor);

  const rows = await db()
    .select(COLUMNS)
    .from(graderLibrary)
    .where(and(readable(auth), olderThanCursor))
    .orderBy(desc(graderLibrary.id))
    .limit(limit + 1);

  const { items, nextCursor } = pageOf(rows, limit);
  return { items: items.map(answer), nextCursor };
}

/** One entry, by its own `grl_` id, or `undefined` where the caller sees none. */
export async function getGraderLibraryEntry(
  auth: AuthContext,
  id: string,
): Promise<LibraryEntry | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select(COLUMNS)
    .from(graderLibrary)
    .where(and(readable(auth), eq(graderLibrary.id, id)))
    .limit(1);

  if (row === undefined) return undefined;
  return answer(row);
}

export type DeletedLibraryEntry = {
  readonly id: string;
  readonly name: string;
};

/**
 * Take a team's entry off the shelf — and refuse to take one of egma's.
 *
 * **The refusal is the part that matters in v0**, because egma's two are the
 * only entries that exist: there is no authoring surface yet, so every row here
 * was written by the catalog and every one of them is written again at the next
 * start. `PredefinedGraderError` says so in the words a person reads.
 *
 * Deleting what the caller cannot see returns what reading it would have:
 * `undefined`, with nothing disturbed and nothing confirmed about whether such
 * a row exists somewhere else.
 */
export async function deleteGraderLibraryEntry(
  auth: AuthContext,
  id: string,
): Promise<DeletedLibraryEntry | undefined> {
  authorize(auth, "author_definitions", here(auth));

  return db().transaction(async (tx) => {
    // Locked before it is judged and held to the end of the transaction, so
    // nothing can change what this row is between the reading and the writing.
    const [locked] = await tx
      .select({
        id: graderLibrary.id,
        name: graderLibrary.name,
        organizationId: graderLibrary.organizationId,
      })
      .from(graderLibrary)
      .where(and(readable(auth), eq(graderLibrary.id, id)))
      .limit(1)
      .for("update");

    if (locked === undefined) return undefined;
    if (locked.organizationId === null) {
      throw new PredefinedGraderError(locked.id, locked.name);
    }

    // A bare `eq` on an id that just came off the tenancy-checked row locked
    // above, in this same transaction, so it reaches no further than that check
    // already did — the move every other factory here makes, for the same
    // reason.
    const [row] = await tx
      .delete(graderLibrary)
      .where(eq(graderLibrary.id, locked.id))
      .returning({ id: graderLibrary.id, name: graderLibrary.name });

    if (row === undefined) throw new Error("the library entry was not deleted");
    return row;
  });
}
