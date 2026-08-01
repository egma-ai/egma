import { newId } from "@egma/ids";
import { and, eq, isNull, type SQL } from "drizzle-orm";

import { db } from "../client.ts";
import { project } from "../schema/tenancy.ts";
import type { AuthContext } from "./context.ts";
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

export async function listProjects(
  auth: AuthContext,
): Promise<readonly Project[]> {
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
 */
export async function readProject(
  auth: AuthContext,
): Promise<Project | undefined> {
  const [row] = await db()
    .select(COLUMNS)
    .from(project)
    .where(and(theProject(auth), notDeleted))
    .limit(1);
  return row;
}

export type NewProject = {
  readonly name: string;
  readonly slug: string;
};

/** The new project belongs to the caller's customer. There is no other option. */
export async function createProject(
  auth: AuthContext,
  input: NewProject,
): Promise<Project> {
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
