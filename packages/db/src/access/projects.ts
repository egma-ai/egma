import { newId } from "@egma/ids";
import { and, eq, isNull, like, or, type SQL } from "drizzle-orm";

import { db } from "../client.ts";
import { project } from "../schema/tenancy.ts";
import type { AuthContext } from "./context.ts";
import {
  IdentityConflictError,
  ProjectSlugTakenError,
  UnprocessableInputError,
} from "./errors.ts";
import { authorize, here } from "./permissions.ts";
/**
 * The one project factory, shared with signup.
 *
 * **This import closes a cycle — `projects` → `provisioning` → `seeded-graders` →
 * `projects` — and it is safe on the one condition that keeps any such cycle
 * safe: nothing on either side is read while the other is still being
 * evaluated.** `insertProject` is called from inside a function here, and
 * `isProjectOfOrganization` is called from inside a function there, so both
 * bindings exist long before either is reached. Move either use to module scope
 * and the cycle stops being safe.
 */
import { insertProject } from "./provisioning.ts";
import { theProject, within } from "./within.ts";

/**
 * A product area inside a customer: a permission scope and a query filter,
 * never a wall. Two projects in one organization are always queryable together,
 * which is why `listProjects` is scoped by the organization and not by the
 * project the caller happens to be acting in.
 */
export type Project = {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  /** What it is for, in somebody's own words, or nothing when nobody said. */
  readonly description: string | null;
  /** The opaque token an edit to any of the three above has to name. */
  readonly revision: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
};

const COLUMNS = {
  id: project.id,
  organizationId: project.organizationId,
  name: project.name,
  slug: project.slug,
  description: project.description,
  revision: project.revision,
  createdBy: project.createdBy,
  createdAt: project.createdAt,
} as const;

const notDeleted: SQL = isNull(project.deletedAt);

/**
 * Which projects belong to an organization? The second half of what an
 * `AuthContext` is built from, and the counterpart to `membershipsOf`.
 *
 * Resolving a browser session is otherwise circular: the context names a
 * project, and finding the project needs a context. `membershipsOf` answers
 * which organization the person is in, this answers which projects are in it,
 * and only then is there a context to hand to anything else. Every other read
 * of a project goes through `listProjects` below, which takes the context like
 * everything else.
 *
 * It is safe on the same terms as `membershipsOf`: the organization it is given
 * is the one the credential already resolved to, it names no project, and it
 * can return nothing outside the organization it was asked about. A caller with
 * somebody else's organization id has already gone wrong somewhere no read
 * could have saved them.
 *
 * The order is by identifier, which sorts by mint time, so the first row is the
 * organization's oldest project — the one provisioning created — and a session
 * that has named no project lands there.
 */
export async function projectsOf(
  organizationId: string,
): Promise<readonly Project[]> {
  return db()
    .select(COLUMNS)
    .from(project)
    .where(and(eq(project.organizationId, organizationId), notDeleted))
    .orderBy(project.id);
}

export async function listProjects(
  auth: AuthContext,
): Promise<readonly Project[]> {
  authorize(auth, "read", here(auth));

  return db()
    .select(COLUMNS)
    .from(project)
    .where(within(auth, project, notDeleted))
    .orderBy(project.id);
}

/**
 * The project the caller is acting in. Like `readOrganization`, it takes no id:
 * the project comes from the credential too, so there is no call that reaches
 * another project — not another customer's, and not another one of the
 * caller's.
 *
 * A credential that names no project is acting in none, so there is none to
 * read and the answer is nothing. `listProjects` is what that caller wants, and
 * it is scoped by the organization rather than by the project for exactly this
 * reason.
 */
export async function readProject(
  auth: AuthContext,
): Promise<Project | undefined> {
  authorize(auth, "read", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) return undefined;

  const [row] = await db()
    .select(COLUMNS)
    .from(project)
    .where(and(theProject(auth, projectId), notDeleted))
    .limit(1);
  return row;
}

/**
 * The word a project is known by in a URL, worked out from its name.
 *
 * **Deterministic, and deliberately dull.** The same name always produces the
 * same candidate, so two people creating "Outbound sales" in two organizations
 * get `outbound-sales` in both — and an admin who never thinks about slugs
 * never has to. Everything outside the small alphabet becomes a separator, runs
 * of separators collapse, and a name made entirely of punctuation still has to
 * produce something, so it falls back to a word rather than to an empty string.
 */
export function slugFrom(name: string): string {
  const shaped = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return shaped === "" ? "project" : shaped.slice(0, SLUG_LIMIT);
}

/**
 * How long a slug may be. Long enough for a sentence-shaped project name and
 * short enough to read in an address bar; the suffix a collision adds is
 * counted outside it, so the numbered form never truncates differently from the
 * unnumbered one and starts colliding with itself.
 */
const SLUG_LIMIT = 48;

/**
 * The first free slug in the numbered series a name produces: `outbound`, then
 * `outbound-2`, then `outbound-3`.
 *
 * **Deterministic under collision, which is the property that matters**: the
 * answer depends only on the name and on what the organization already holds,
 * never on a clock or on randomness. Two admins creating "Outbound" a second
 * apart both compute `outbound-2`, one of them loses the unique index, and the
 * loser recomputes and gets `outbound-3` — rather than both ending up with
 * `outbound-8f3c` and nobody able to guess either.
 */
export function nextFreeSlug(
  wanted: string,
  taken: readonly string[],
): string {
  const held = new Set(taken);
  if (!held.has(wanted)) return wanted;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${wanted}-${suffix}`;
    if (!held.has(candidate)) return candidate;
  }
}

/** Every slug in this organization that could collide with the wanted one. */
async function slugsLike(
  auth: AuthContext,
  wanted: string,
): Promise<readonly string[]> {
  const rows = await db()
    .select({ slug: project.slug })
    .from(project)
    .where(
      within(
        auth,
        project,
        and(
          notDeleted,
          or(eq(project.slug, wanted), like(project.slug, `${wanted}-%`)),
        ),
      ),
    );
  return rows.map((row) => row.slug);
}

export type NewProject = {
  readonly name: string;
  /**
   * The slug an admin typed, when they typed one. Absent means egma works one
   * out from the name and numbers it past whatever is already there.
   *
   * The two are answered differently on collision and that is the whole reason
   * this is optional rather than always supplied by the caller: a slug somebody
   * chose is refused out loud, because silently giving them `outbound-2` when
   * they asked for `outbound` is egma deciding something they came to decide.
   * A slug egma derived is renumbered, because nobody asked for it.
   */
  readonly slug?: string | undefined;
  readonly description?: string | null | undefined;
};

/**
 * How many times a derived slug is recomputed after losing the unique index to
 * a project created between the read and the insert. Three, because the second
 * attempt already sees the row that beat the first one; anything past that is a
 * pathological burst and is answered as the collision it is rather than looped
 * on forever.
 */
const SLUG_ATTEMPTS = 3;

/** Postgres's unique-violation code, which the slug index raises. */
const UNIQUE_VIOLATION = "23505";

/**
 * The driver's error is wrapped by the query layer before it reaches here, so
 * the chain is walked rather than the top read. A check that looked only at
 * what was thrown would find no code, decide this was not a collision, and let
 * a wrapped constraint violation escape as an internal failure — which is the
 * shape of bug that looks like it works, because the refusal is rare.
 */
function isSlugCollision(thrown: unknown): boolean {
  for (let held = thrown; held != null; held = (held as { cause?: unknown }).cause) {
    const { code, constraint } = held as {
      code?: unknown;
      constraint?: unknown;
    };
    if (
      code === UNIQUE_VIOLATION &&
      constraint === "project_organization_id_slug_unique"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A whole project, in one transaction.
 *
 * The new project belongs to the caller's customer. There is no other option.
 *
 * **Only an `admin` creates one**, on the row of the permission table that says
 * so. The check is here as well as at the route, because signup provisions a
 * project before anybody has a context at all and the two paths must not be
 * able to drift apart on who may.
 *
 * What it writes is `insertProject`'s business and deliberately not this
 * function's: the project, its pointer to Egma's shared default persona, and its
 * `expected_behaviors` project grader. A project created here is therefore
 * indistinguishable from the one signup makes, which is the point — anything
 * less is a project that refuses the first test written in it, or one whose
 * completed simulations receive no expected-behavior grade.
 *
 * **The project and its expected-behavior grading are one transaction**, which
 * is the factory's doing rather than this function's: a project that existed
 * for even a moment with no project grader would produce completed simulations
 * with no expected-behavior grade, and "it depends when you looked" is not an
 * answer a trust product may give.
 */
export async function createProject(
  auth: AuthContext,
  input: NewProject,
): Promise<Project> {
  authorize(auth, "manage_projects", here(auth));

  const name = input.name.trim();
  if (name === "") {
    throw new UnprocessableInputError("a project needs a name");
  }

  const chosen = input.slug?.trim();
  const asked = chosen === undefined || chosen === "" ? undefined : slugFrom(chosen);
  const description = normalizedDescription(input.description);

  for (let attempt = 1; ; attempt += 1) {
    const slug =
      asked ?? nextFreeSlug(slugFrom(name), await slugsLike(auth, slugFrom(name)));

    try {
      return await db().transaction(async (tx) => {
        const projectId = newId("prj");
        await insertProject(tx, {
          projectId,
          organizationId: auth.organizationId,
          name,
          slug,
          description,
          revision: newId("rev"),
          createdBy: auth.userId,
        });

        const [row] = await tx
          .select(COLUMNS)
          .from(project)
          .where(eq(project.id, projectId))
          .limit(1);
        if (row === undefined) throw new Error("the project was not written");
        return row;
      });
    } catch (thrown) {
      if (!isSlugCollision(thrown)) throw thrown;
      // A slug somebody typed is theirs to change; a slug egma derived is
      // egma's to renumber, and it recomputes from a list that now includes
      // whatever beat it.
      if (asked !== undefined) throw new ProjectSlugTakenError(slug);
      if (attempt >= SLUG_ATTEMPTS) throw new ProjectSlugTakenError(slug);
    }
  }
}

/** A description stored trimmed, or not stored at all when it says nothing. */
function normalizedDescription(
  description: string | null | undefined,
): string | null {
  if (description === undefined || description === null) return null;
  const trimmed = description.trim();
  return trimmed === "" ? null : trimmed;
}

export type ProjectChanges = {
  readonly name?: string | undefined;
  readonly slug?: string | undefined;
  readonly description?: string | null | undefined;
  /**
   * The revision this edit was written against. **Required at the browser's
   * door and optional here**, on the terms every other identity write in this
   * codebase uses: an internal caller that has just read and written in one
   * transaction has nothing to race with, and a person with a form open in two
   * tabs has everything to.
   */
  readonly expectedRevision?: string | undefined;
};

/**
 * A project's live fields, edited.
 *
 * **Only an `admin`**, because a project's name and slug are what every link
 * anybody has sent is written against, and a slug change is felt by everybody
 * in the organization at once.
 *
 * The row is locked, the expected revision is checked against the locked row,
 * and the revision moves on every write — so two admins editing one project in
 * two tabs are told, rather than the second silently overwriting the first.
 * Editing a project the caller cannot see returns what reading it would:
 * nothing, with nothing disturbed.
 */
export async function updateProject(
  auth: AuthContext,
  projectId: string,
  changes: ProjectChanges,
): Promise<Project | undefined> {
  authorize(auth, "manage_projects", here(auth));

  const name = changes.name?.trim();
  if (changes.name !== undefined && name === "") {
    throw new UnprocessableInputError("a project needs a name");
  }

  const slug =
    changes.slug === undefined ? undefined : slugFrom(changes.slug.trim());
  if (changes.slug !== undefined && changes.slug.trim() === "") {
    throw new UnprocessableInputError("a project needs a slug");
  }

  try {
    return await db().transaction(async (tx) => {
      const [locked] = await tx
        .select(COLUMNS)
        .from(project)
        .where(within(auth, project, and(eq(project.id, projectId), notDeleted)))
        .limit(1)
        .for("update");

      if (locked === undefined) return undefined;

      if (
        changes.expectedRevision !== undefined &&
        changes.expectedRevision !== locked.revision
      ) {
        throw new IdentityConflictError("Project", locked.id, {
          expected: changes.expectedRevision,
          current: locked.revision,
        });
      }

      const [updated] = await tx
        .update(project)
        .set({
          ...(name === undefined ? {} : { name }),
          ...(slug === undefined ? {} : { slug }),
          ...(changes.description === undefined
            ? {}
            : { description: normalizedDescription(changes.description) }),
          // The identity moved, so the token that names it moves too. A caller
          // still holding the old one is holding a read taken before this
          // write, which is exactly what it is for.
          revision: newId("rev"),
          updatedAt: new Date(),
        })
        .where(eq(project.id, locked.id))
        .returning(COLUMNS);

      if (updated === undefined) throw new Error("the project was not written");
      return updated;
    });
  } catch (thrown) {
    if (isSlugCollision(thrown) && slug !== undefined) {
      throw new ProjectSlugTakenError(slug);
    }
    throw thrown;
  }
}

/**
 * Whether a project id names a live project of the caller's customer. Internal:
 * it is how a write that has been handed a project id refuses one that belongs
 * to somebody else, before the write is attempted.
 */
export async function isProjectOfOrganization(
  auth: AuthContext,
  projectId: string,
): Promise<boolean> {
  const [row] = await db()
    .select({ id: project.id })
    .from(project)
    .where(within(auth, project, and(eq(project.id, projectId), notDeleted)))
    .limit(1);
  return row !== undefined;
}

/** Whether a project of this organization is live, soft-deleted, or not one at all. */
export type ProjectTenancyState = "live" | "deleted" | "absent";

/**
 * The organization's project as a tenancy fact, deletion included.
 *
 * The counterpart to `isProjectOfOrganization` for a caller that has to tell a
 * project the organization never had from one it had and later archived. Both
 * come back `false` from the boolean above, and they are two different truths:
 * evidence naming a pair that was never real is a binding that could not exist,
 * while evidence for a project archived after the evidence was accepted names a
 * pair that was real when it arrived. It reads the same one row, without the
 * live filter, and answers which of the three it is.
 */
export async function projectOfOrganizationState(
  auth: AuthContext,
  projectId: string,
): Promise<ProjectTenancyState> {
  const [row] = await db()
    .select({ deletedAt: project.deletedAt })
    .from(project)
    .where(within(auth, project, eq(project.id, projectId)))
    .limit(1);
  if (row === undefined) return "absent";
  return row.deletedAt === null ? "live" : "deleted";
}
