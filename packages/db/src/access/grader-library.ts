import { and, asc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";

import { db } from "../client.ts";
import {
  GRADER_LIBRARY_CATALOG,
  type LibraryOutputDefinition,
  type LibraryParameter,
  type PredefinedGrader,
} from "../grader-library/catalog.ts";
import {
  grader,
  graderLibrary,
  type LibraryType,
} from "../schema/graders.ts";
import type { AuthContext } from "./context.ts";
import {
  GraderLibraryEntryInUseError,
  PredefinedGraderError,
} from "./errors.ts";
import { pageOf, pageWindow, type PageRequest } from "./pages.ts";
import { authorize, here } from "./permissions.ts";
import { inActingProject, within } from "./within.ts";

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
 * **The definition: every field the catalog owns, and the one type all three
 * writers are held to.**
 *
 * Three things have to agree about this list, and each of them is a separate
 * piece of SQL: what the insert writes, what the conflicting update writes, and
 * what the update compares before it writes anything. Written out three times
 * by hand they would drift — and the drift nobody would notice is the third
 * one, because a field left out of the comparison is a field whose edit
 * refreshes with the version standing still, which is precisely the thing the
 * version exists to make answerable.
 *
 * So none of the three is written by hand. `definitionOf` below is the insert's
 * half and `FROM_THE_CATALOG` is the update's, both typed over this one shape
 * so the compiler refuses either that is missing a field; and the comparison is
 * read off the update's own keys, so it cannot be missing one at all.
 */
type Definition = {
  readonly name: string;
  readonly description: string;
  readonly type: LibraryType;
  readonly prompt: string | null;
  readonly params: readonly LibraryParameter[];
  readonly outputDefinition: LibraryOutputDefinition | null;
};

/** What the insert writes, from the catalog entry — every field, or no build. */
function definitionOf(entry: PredefinedGrader): Definition {
  return {
    name: entry.name,
    description: entry.description,
    type: entry.type,
    prompt: entry.prompt,
    params: entry.params,
    outputDefinition: entry.outputDefinition,
  };
}

/**
 * What the conflicting update writes, as `on conflict` names the row that was
 * being inserted — every field again, held by the same type.
 */
const FROM_THE_CATALOG: Readonly<Record<keyof Definition, SQL>> = {
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
 * Read off the map above rather than listed again, so the comparison covers
 * exactly what the update writes and can never cover less.
 *
 * `is distinct from` rather than `<>`, because half of these are nullable and
 * `null <> null` is null — which would make every boot look like a change on an
 * entry with no prompt, bumping a version for nothing. jsonb compares as a
 * value, so key order on the way in cannot mint a version either.
 */
const THE_CATALOG_HAS_MOVED: SQL = sql.join(
  (Object.keys(FROM_THE_CATALOG) as (keyof Definition)[]).map(
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
        ...definitionOf(entry),
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
 * **The customer half is `within`, unchanged**, which is what keeps this read
 * under the same rule as every other one in the module: the organization it
 * compares against is the context's own, and a caller has no argument by which
 * to widen it. Acting in a project narrows to it; acting in none reaches the
 * whole customer, exactly as everywhere else.
 *
 * **The null half is beside it rather than inside it**, and it is not a hole in
 * the tenancy: an entry with no organization belongs to egma and is on every
 * customer's shelf by design — that is the whole of what a predefined grader
 * is. Egma's rows sit outside the project narrowing too, because they belong to
 * no project either.
 */
function readable(auth: AuthContext): SQL {
  const either = or(
    isNull(graderLibrary.organizationId),
    within(auth, graderLibrary, inActingProject(auth, graderLibrary)),
  );
  if (either === undefined) {
    throw new Error("a tenancy predicate can never be empty");
  }
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
 * One page of the shelf, **oldest first** — which on these identifiers is the
 * order the catalog was written in, so `expected_behaviors` reads before
 * `latency`.
 *
 * **The one list in this module that does not read newest first**, and
 * deliberately: a shelf is not a feed. The graders somebody meets first should
 * be the ones that are always on, and the newest entry on a shelf that grows
 * once a release is the least interesting row on the page. The other lists
 * answer "what happened lately" and are right to lead with it.
 *
 * The page rules are every other list's, written once in `pages.ts`; only the
 * direction differs, and the cursor turns with it.
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
  const afterCursor =
    cursor === undefined ? undefined : gt(graderLibrary.id, cursor);

  const rows = await db()
    .select(COLUMNS)
    .from(graderLibrary)
    .where(and(readable(auth), afterCursor))
    .orderBy(asc(graderLibrary.id))
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
 * Take a team's entry off the shelf — and refuse to take one of egma's, or one
 * anything is still judging with.
 *
 * **Two refusals, and both are about a copy that would be left holding
 * nothing.** A copy reads its definition through `library_id` every time it
 * judges; the words are never written down onto it, precisely so that the
 * screen and the judge cannot drift. That is what makes an entry's delete a
 * question about the copies rather than about the entry:
 *
 * - **egma's own entries are undeletable at all.** They are written again at
 *   the next start, so a delete that appeared to work would be a grader that
 *   vanished until somebody restarted a container. `PredefinedGraderError` says
 *   so in the words a person reads, and it is asked first because it is true
 *   whether or not anything is using the entry.
 * - **A referenced entry is refused**, naming the copies in the way — including
 *   the ones somebody switched off, because a copy's versions outlive its
 *   deletion so that verdicts stay interpretable, and the definition has to
 *   outlive them in turn. `GraderLibraryEntryInUseError`. Never `set null` and
 *   never a cascade: the first would leave a grader with no definition to read,
 *   the second would delete judging somebody set up without them asking.
 *
 * The database holds the same rule with `on delete restrict`, which is what
 * makes it true of a hand-written statement too. This is the half that can name
 * what is standing in the way, which is what somebody about to fix it needs.
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

    // **Every copy, anywhere, deleted ones included.**
    //
    // Not only the caller's own project's, because an entry belongs to the
    // organization and a copy of it in another project is just as much a grader
    // that would stop having a definition.
    //
    // And not only the living ones, which is the part worth arguing. Deleting a
    // copy is a soft delete: the row stays, and so do its versions, precisely so
    // that a verdict written under one is still interpretable. That chain runs
    // verdict → version → copy → entry, so the definition has to outlive the
    // copies that used it or the chain breaks at its last link. It is also what
    // the database enforces underneath — `on delete restrict` counts the rows
    // that are there, not the ones still switched on — and a module that
    // disagreed with its own foreign key would refuse in one place and raise a
    // driver error in the other.
    const using = await tx
      .select({ id: grader.id, name: grader.name })
      .from(grader)
      .where(eq(grader.libraryId, locked.id))
      .orderBy(asc(grader.id));

    if (using.length > 0) {
      throw new GraderLibraryEntryInUseError(locked.id, locked.name, using);
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
