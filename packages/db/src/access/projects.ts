import { newId } from "@egma/ids";
import { and, eq, isNull, type SQL } from "drizzle-orm";

import { db } from "../client.ts";
import { project } from "../schema/tenancy.ts";
import type { AuthContext } from "./context.ts";
import { authorize, here } from "./permissions.ts";
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
  readonly createdBy: string | null;
  readonly createdAt: Date;
};

const COLUMNS = {
  id: project.id,
  organizationId: project.organizationId,
  name: project.name,
  slug: project.slug,
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

export type NewProject = {
  readonly name: string;
  readonly slug: string;
};

/**
 * The new project belongs to the caller's customer. There is no other option.
 *
 * **Only an `admin` creates one.** The check is here rather than at a route
 * because there is no route: nothing in the product creates a project except
 * signup, which provisions one before anybody has a context at all. A row of
 * the permission table with no call site is a row that reads as coverage and
 * refuses nobody, which is worse than not having written it.
 */
export async function createProject(
  auth: AuthContext,
  input: NewProject,
): Promise<Project> {
  authorize(auth, "manage_projects", here(auth));

  const [row] = await db()
    .insert(project)
    .values({
      id: newId("prj"),
      organizationId: auth.organizationId,
      name: input.name,
      slug: input.slug,
      createdBy: auth.userId,
    })
    .returning(COLUMNS);

  if (row === undefined) throw new Error("the project was not written");
  return row;
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
