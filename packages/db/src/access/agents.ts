import { newId } from "@egma/ids";
import { and, eq, isNull, type SQL } from "drizzle-orm";

import { db } from "../client.ts";
import { agent } from "../schema/agents.ts";
import type { AuthContext } from "./context.ts";
import { ProjectOutsideOrganizationError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { within } from "./within.ts";

/**
 * Reading and writing agents — what an agent is is the schema file's story
 * (`schema/agents.ts`); this file is how one is reached.
 *
 * The agent is the aggregate root of the factory: when the connection verbs
 * arrive they will live here too, every one of them taking the agent's id,
 * because a connection is how you reach an agent and there is no path to one
 * that doesn't name its agent first.
 *
 * Project scoping works as the digital-human factory's does. A context acting
 * in a project writes and reads there; a context acting in none — an
 * organization-scoped credential — reads the whole customer and creates
 * nothing, because an agent belongs to a project and a credential for the
 * whole customer is acting in none.
 */

export type NewAgent = {
  readonly name: string;
  readonly description?: string | undefined;
};

export type Agent = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

const notDeleted: SQL = isNull(agent.deletedAt);

/** An answer's columns, and no more — the tenant-free view. */
const COLUMNS = {
  id: agent.id,
  projectId: agent.projectId,
  name: agent.name,
  description: agent.description,
  createdAt: agent.createdAt,
  updatedAt: agent.updatedAt,
} as const;

function validateName(name: string): void {
  if (name.trim() === "") {
    throw new Error("an agent needs a name");
  }
}

/**
 * Whether this write lost to a live agent already holding the name. Read from
 * the constraint's own name, walking the `cause` chain because the query layer
 * may hand the driver's error back wrapped — recognising it by message
 * substring would break silently the day the text changed.
 */
function nameAlreadyAlive(error: unknown): boolean {
  for (
    let at: unknown = error, depth = 0;
    at !== undefined && at !== null && depth < 4;
    depth += 1
  ) {
    if (typeof at !== "object") break;
    const carrier = at as { constraint?: unknown; cause?: unknown };
    if (carrier.constraint === "agent_project_id_name_unique") return true;
    at = carrier.cause;
  }
  return false;
}

/** Acting in a project narrows to it; acting in none reaches the customer. */
function inActingProject(auth: AuthContext): SQL | undefined {
  return auth.projectId === undefined
    ? undefined
    : eq(agent.projectId, auth.projectId);
}

/** The named agent, alive, within the caller's tenancy and scope. */
function theAgent(auth: AuthContext, id: string): SQL {
  return within(
    auth,
    agent,
    and(eq(agent.id, id), notDeleted, inActingProject(auth)),
  );
}

export async function createAgent(
  auth: AuthContext,
  input: NewAgent,
): Promise<Agent> {
  authorize(auth, "configure_agents", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "an agent belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  // Everything answerable without the database is answered first; only an
  // input worth writing costs the project-membership read below.
  validateName(input.name);

  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  const [inserted] = await db()
    .insert(agent)
    .values({
      id: newId("agt"),
      organizationId: auth.organizationId,
      projectId,
      name: input.name,
      description: input.description ?? null,
      createdBy: auth.userId,
    })
    .returning(COLUMNS)
    .catch((error: unknown) => {
      if (nameAlreadyAlive(error)) {
        throw new Error(
          `an agent named "${input.name}" already exists in this project`,
        );
      }
      throw error;
    });

  if (inserted === undefined) throw new Error("the agent was not written");
  return inserted;
}

export async function getAgent(
  auth: AuthContext,
  id: string,
): Promise<Agent | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select(COLUMNS)
    .from(agent)
    .where(theAgent(auth, id))
    .limit(1);
  return row;
}
