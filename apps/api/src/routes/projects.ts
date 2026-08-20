import {
  createProject,
  IdentityConflictError,
  listProjects,
  NotPermittedError,
  ProjectSlugTakenError,
  ProjectOutsideOrganizationError,
  permits,
  updateProject,
  UnprocessableInputError,
  type Project,
} from "@egma/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { cannotActIn } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import {
  invalid,
  notPermitted,
  projectOutsideOrganization,
  sendRefusal,
  unprocessable,
  REFUSALS,
} from "../http/refusals.ts";

/**
 * The projects an organization holds: listing them, creating one, and editing
 * the three live fields of one.
 *
 * **A project is not addressed the way every other product resource is**, and
 * this file is where that shows. Everything else in this API names its project
 * in a query or a body and is read *inside* it; a project names itself in the
 * path, because the caller is administering the container rather than working
 * in it. So the acting-project helpers are deliberately not used here: what
 * bounds these routes is the organization the credential resolved to, and
 * `listProjects` is already scoped by it.
 *
 * **Creating one is the whole factory or nothing.** The data-access module
 * writes the project, its shared default-persona pointer, and its seeded grader
 * in one transaction —
 * exactly what signup writes. A route that created a bare row would hand
 * somebody a project that refuses the first test written in it.
 *
 * **Only an `admin`**, on the permission table's `manage_projects` row. Reading
 * the list is not gated: every member of an organization may work in every
 * project of it, so a `viewer` who could not list them could not choose one.
 */

export type ProjectRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export const PROJECTS_PATH = "/api/projects";
export const PROJECT_PATH = "/api/projects/:projectId";

type Body = Record<string, unknown>;

const CREATE_KEYS = ["name", "slug", "description"] as const;
const EDIT_KEYS = ["name", "slug", "description", "expected_revision"] as const;

function unknownKeyIn(
  body: Body,
  allowed: readonly string[],
  what: string,
): string | undefined {
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    return `${what} has no key "${key}"; it holds ${allowed.join(", ")}`;
  }
  return undefined;
}

/** A project on the wire. Everything a Settings page needs and nothing else. */
function described(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    organization_id: project.organizationId,
    revision: project.revision,
    created_at: project.createdAt.toISOString(),
  };
}

function refuseRole(
  reply: FastifyReply,
  role: string,
  action: string,
): FastifyReply {
  return sendRefusal(reply, "not_permitted", REFUSALS.notPermitted(role, action));
}

export async function projectRoutes(
  app: FastifyInstance,
  options: ProjectRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * Every project of the caller's organization.
   *
   * `may_manage_projects` travels with the list so a page can render the
   * controls it is allowed to offer rather than offering everything and finding
   * out. Deciding what to *show* is `permits`; deciding what to allow is the
   * check on each write below, and the data-access module checks it again.
   */
  app.get(PROJECTS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const projects = await listProjects(auth);

    return reply.send({
      items: projects.map(described),
      may_manage_projects: permits(auth, "manage_projects", {
        organizationId: auth.organizationId,
        projectId: auth.projectId,
      }),
    });
  });

  /**
   * One project, by the id in its address.
   *
   * A project of another organization is answered as an absence, in the
   * selector's own words — following a stranger's link must never reveal
   * whether the thing on the other end exists.
   */
  app.get(PROJECT_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { projectId } = request.params as { projectId: string };

    const projects = await listProjects(auth);
    const found = projects.find((project) => project.id === projectId);
    if (found === undefined) {
      return sendRefusal(
        reply,
        "project_outside_organization",
        projectOutsideOrganization(projectId),
      );
    }

    return reply.send({
      ...described(found),
      may_manage_projects: permits(auth, "manage_projects", {
        organizationId: auth.organizationId,
        projectId: auth.projectId,
      }),
    });
  });

  app.post(PROJECTS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    if (auth.role !== "admin") {
      return refuseRole(reply, auth.role, "create a project");
    }

    const unknown = unknownKeyIn(body, CREATE_KEYS, "a project");
    if (unknown !== undefined) return invalid(reply, unknown);

    const created = await createProject(auth, {
      name: text(body.name),
      ...(given(text(body.slug)) === undefined ? {} : { slug: text(body.slug) }),
      ...("description" in body ? { description: text(body.description) } : {}),
    });

    return reply.code(201).send(described(created));
  });

  /**
   * A project's name, slug or description, edited against the revision the form
   * was opened at.
   *
   * **Partial, like every other browser update in this API**: a field the body
   * does not name is left exactly as it was, so an editor that only shows the
   * description cannot erase a name it never displayed.
   */
  app.patch(PROJECT_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { projectId } = request.params as { projectId: string };
    const body = (request.body ?? {}) as Body;

    if (auth.role !== "admin") {
      return refuseRole(reply, auth.role, "change project settings");
    }

    const unknown = unknownKeyIn(body, EDIT_KEYS, "a project");
    if (unknown !== undefined) return invalid(reply, unknown);

    const edited = await updateProject(auth, projectId, {
      ...("name" in body ? { name: text(body.name) } : {}),
      ...("slug" in body ? { slug: text(body.slug) } : {}),
      ...("description" in body ? { description: text(body.description) } : {}),
      ...(given(text(body.expected_revision)) === undefined
        ? {}
        : { expectedRevision: text(body.expected_revision) }),
    });

    if (edited === undefined) {
      return sendRefusal(
        reply,
        "project_outside_organization",
        projectOutsideOrganization(projectId),
      );
    }

    return reply.send(described(edited));
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ProjectSlugTakenError) {
      return sendRefusal(
        reply,
        "project_slug_taken",
        REFUSALS.projectSlugTaken(error.slug),
      );
    }

    if (error instanceof IdentityConflictError) {
      return sendRefusal(
        reply,
        "identity_conflict",
        REFUSALS.identityConflict(error.resource, error.resourceId),
      );
    }

    if (error instanceof UnprocessableInputError) {
      return unprocessable(reply, error.message);
    }

    if (error instanceof ProjectOutsideOrganizationError) {
      return notPermitted(reply, cannotActIn(error.projectId));
    }

    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }

    throw error;
  });
}
