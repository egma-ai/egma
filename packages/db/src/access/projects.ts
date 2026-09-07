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
 * This import forms a cycle through provisioning and seeded-graders. Keep uses
 * of insertProject and isProjectOfOrganization inside functions, after module evaluation.
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
 * Resolve active projects after verifying organization membership, before building
 * AuthContext. IDs sort oldest first for session default selection.
 * Use listProjects once the caller has a context.
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
 * Read the active project named by AuthContext, or undefined if no project is set.
 * Use listProjects to list projects in the organization.
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
 * Derive a lowercase URL slug from a name. Replace non-alphanumeric runs with
 * hyphens, trim outer hyphens, and use project when the result is empty.
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
 * Return the first available slug: the base, then base-2, base-3, and so on.
 * The caller must still handle concurrent uniqueness conflicts.
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
   * Optional user-chosen slug. Reject collisions for a chosen slug; derive and
   * renumber a slug from the project name when omitted or blank.
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
 * Create an organization project and its expected-behaviors project grader in one
 * transaction through the signup factory. Require manage_projects. Retry derived
 * slug collisions up to SLUG_ATTEMPTS; reject a chosen slug collision immediately.
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
 * Require manage_projects and lock the visible active project for editing.
 * Check expectedRevision when supplied and advance revision on every write.
 * Return undefined for unseen projects; report slug conflicts explicitly.
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
 * Distinguish a live project, a deleted project, and an absent organization/project
 * pair. Ingestion uses this to validate evidence accepted before project deletion.
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
