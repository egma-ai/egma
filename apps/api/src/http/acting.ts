import { listProjects, type AuthContext } from "@egma/db";
import type { FastifyReply } from "fastify";

import {
  projectOutsideOrganization,
  sendRefusal,
  type RefusalCode,
} from "./refusals.ts";

/**
 * Resolve project scope without changing organization ownership. API keys
 * stay within their stored project scope; sessions can select another project
 * in the same organization. Reject an explicit project the credential cannot use.
 */

export function cannotActIn(projectId: string): string {
  return (
    `this credential may not act in project ${projectId}. A credential ` +
    `authorized for one project acts in that one, and a key for the whole ` +
    `organization acts in any project of that organization. Leave project out ` +
    `to use the project this credential already acts in.`
  );
}

/** Require a project when an organization-wide credential has several choices. */
export const NAME_THE_PROJECT =
  "this organization holds more than one project and this credential names " +
        "none, so Egma cannot tell which project this is about. Send project with " +
  "the one you mean, or use a key minted for that project.";

/**
 * Why a project could not be resolved, and which answer that is. Named rather
 * than retyped at every use: the two codes are the whole of the choice, and a
 * second copy of the pair is a second place for one of them to be forgotten.
 */
export type ActingRefusal = {
  readonly refusal: string;
  readonly code: RefusalCode;
};

export type Acting = { readonly auth: AuthContext } | ActingRefusal;

/** Route-specific wording for project-scope refusals. */
export type ProjectWording = {
  actsElsewhere(scoped: string, named: string): string;
  outsideOrganization(named: string): string;
};

const ACTING_WORDING: ProjectWording = {
  actsElsewhere: (_scoped, named) => cannotActIn(named),
  outsideOrganization: (named) => cannotActIn(named),
};

/** The agents group's pair, byte-for-byte as its tests pin them. */
export const AGENTS_PROJECT_WORDING = {
  actsElsewhere: (
    scoped: string,
    named: string,
    verb: "writes into" | "reads",
  ): string =>
    `this credential acts in project ${scoped}, and the request named ` +
    `${named}. A key minted for one product area ${verb} that one; drop ` +
    "the project, or use a key for the whole organization.",
  outsideOrganization: (named: string): string =>
    `project ${named} is not in your organization. A request may name a ` +
    "project of your own organization or leave it out, and which " +
    "organization this is always comes from the key.",
};

/**
 * A named project, checked against what the credential may reach. A key
 * minted for one project is answered rather than quietly widened; a key for
 * the whole customer may name any project the membership read confirms.
 */
export async function resolveNamedProject(
  auth: AuthContext,
  named: string,
  wording: ProjectWording,
): Promise<Acting> {
  // A browser is answered by `browserProject` below, whose rule is the
  // membership's rather than the credential's. The branch is here rather than
  // at each call site so that every route group a page reaches gets the one
  // rule, and a group added later cannot get the other one by omission.
  if (auth.via === "session") return browserProject(auth, named);

  if (auth.projectId !== undefined) {
    return named === auth.projectId
      ? { auth }
      : {
          refusal: wording.actsElsewhere(auth.projectId, named),
          code: "not_permitted",
        };
  }

  const projects = await listProjects(auth);
  return projects.some((project) => project.id === named)
    ? { auth: { ...auth, projectId: named } }
    : { refusal: wording.outsideOrganization(named), code: "not_permitted" };
}

/**
 * Resolve a browser's requested project within its organization. A session
 * project is a default, while an API key's project is a scope restriction.
 * Call only for sessions; this function does not check auth.via itself.
 * Resolve per request so tabs can use different projects.
 */
export async function browserProject(
  auth: AuthContext,
  named: string,
): Promise<Acting> {
  const projects = await listProjects(auth);
  return projects.some((project) => project.id === named)
    ? { auth: { ...auth, projectId: named } }
    : {
        refusal: projectOutsideOrganization(named),
        code: "project_outside_organization",
      };
}

/**
 * The project a credential acts in when the request named none: the key's
 * own, or the organization's single v1 project. Zero projects is this
 * instance broken; more than one is a question only the caller can answer.
 */
export async function resolveAbsentProject(auth: AuthContext): Promise<Acting> {
  if (auth.projectId !== undefined) return { auth };

  const projects = await listProjects(auth);
  const [only] = projects;
  if (only === undefined) {
    // Not a refusal: signing up provisions a project and nothing takes it
    // away, so there is nothing the person holding this key could do about it.
    // It is this instance being broken, and it is answered as one.
    throw new Error(
      "this organization holds no project, which signup makes impossible",
    );
  }
  if (projects.length > 1) {
    return { refusal: NAME_THE_PROJECT, code: "invalid_request" };
  }
  return { auth: { ...auth, projectId: only.id } };
}

/**
 * Use for operations that require one destination project. An omitted project
 * uses the credential scope or the organization's sole project; ambiguity
 * fails. Resource-ID lookups should use reachingIn instead.
 */
export async function actingIn(
  auth: AuthContext,
  named: string | undefined,
): Promise<Acting> {
  return named === undefined
    ? resolveAbsentProject(auth)
    : resolveNamedProject(auth, named, ACTING_WORDING);
}

/**
 * Use for lookups by resource ID where project is an optional filter.
 * A named project follows actingIn rules. Without one, preserve AuthContext:
 * sessions retain their default project, while organization-wide keys retain
 * organization-wide access. Do not choose a project as actingIn does.
 */
export async function reachingIn(
  auth: AuthContext,
  named: string | undefined,
): Promise<Acting> {
  return named === undefined
    ? { auth }
    : resolveNamedProject(auth, named, ACTING_WORDING);
}

/** However a project failed to resolve, answered as what it is. */
export function refuseActing(
  reply: FastifyReply,
  acting: ActingRefusal,
): FastifyReply {
  return sendRefusal(reply, acting.code, acting.refusal);
}
