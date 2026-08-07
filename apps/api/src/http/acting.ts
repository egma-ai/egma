import { listProjects, type AuthContext } from "@egma/db";
import type { FastifyReply } from "fastify";

/**
 * Which project a request acts in, resolved from the credential and from what
 * the request named.
 *
 * No resource in this API is rooted at a project and the organization is in no
 * address at all, so every route that writes into one has to resolve it before
 * it can write anything. It is one file rather than one copy per route group
 * because the wording is contract — a client relays these sentences to a
 * terminal a coding agent is reading — and two copies of a contract sentence
 * are two things to keep in step by hand.
 *
 * **The context is narrowed and never widened.** The only project it can come
 * to name is one `listProjects` answered with, and that read is scoped to the
 * caller's organization by the data-access module itself — so a request cannot
 * argue its way into somebody else's project, and a credential minted for one
 * project cannot argue its way out of it. The write verbs check the project
 * against the organization again before they insert anything.
 *
 * A project-scoped credential naming a *sibling* project of its own
 * organization is refused rather than quietly narrowed back. The narrowing
 * would be safe and the silence would not: a caller whose filter was dropped
 * reads the answer as though the filter had applied.
 */

export function cannotActIn(projectId: string): string {
  return (
    `this credential may not act in project ${projectId}. A credential ` +
    `authorized for one project acts in that one, and a key for the whole ` +
    `organization acts in any project of that organization. Leave project out ` +
    `to use the project this credential already acts in.`
  );
}

/**
 * What a credential for the whole organization is told when the organization
 * turns out to hold more than one project.
 *
 * v1 gives an organization one project, and a credential naming none resolves
 * to it. Picking the oldest of several instead would read as harmless and would
 * be the same silent narrowing this codebase has already had to find once: the
 * request would be answered about one product area, correctly and completely,
 * with nothing in the answer to say which.
 */
export const NAME_THE_PROJECT =
  "this organization holds more than one project and this credential names " +
  "none, so egma cannot tell which project this is about. Send project with " +
  "the one you mean, or use a key minted for that project.";

export type Acting =
  | { readonly auth: AuthContext }
  | {
      readonly refusal: string;
      readonly code: "not_permitted" | "invalid_request";
    };

/**
 * The acting project as a context to hand the data-access module. Absent, it is
 * the project the credential is authorized for, or the organization's single
 * project for a key minted for the whole customer. Named, it has to be one this
 * credential may act in.
 */
export async function actingIn(
  auth: AuthContext,
  named: string | undefined,
): Promise<Acting> {
  if (auth.projectId !== undefined) {
    if (named !== undefined && named !== auth.projectId) {
      return { refusal: cannotActIn(named), code: "not_permitted" };
    }
    return { auth };
  }

  const projects = await listProjects(auth);
  if (named !== undefined) {
    return projects.some((project) => project.id === named)
      ? { auth: { ...auth, projectId: named } }
      : { refusal: cannotActIn(named), code: "not_permitted" };
  }

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

/** The two ways a project can fail to resolve, each answered as what it is. */
export function refuseActing(
  reply: FastifyReply,
  acting: {
    readonly refusal: string;
    readonly code: "not_permitted" | "invalid_request";
  },
): FastifyReply {
  return acting.code === "not_permitted"
    ? reply.code(403).send({ error: "not_permitted", message: acting.refusal })
    : reply.code(400).send({ error: "invalid_request", message: acting.refusal });
}
