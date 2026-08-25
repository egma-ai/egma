import { listProjects, type AuthContext } from "@egma/db";
import type { FastifyReply } from "fastify";

import {
  projectOutsideOrganization,
  sendRefusal,
  type RefusalCode,
} from "./refusals.ts";

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

/**
 * The words a refusal uses when a named project cannot be acted in. Two cases,
 * two sentences — or one sentence twice, which is what the tests and runs
 * groups do.
 *
 * The agents group speaks its own pair (below). One situation answered in two
 * wordings is a recorded inconsistency awaiting the dev's word on which
 * sentence wins; housing both HERE is what turns that decision into a
 * one-file edit instead of a hunt.
 */
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
 * The project a **browser** request works in: the one its address names,
 * checked against the organization the session resolved to.
 *
 * **A session's project is a default, not a scope**, and that is the whole
 * distinction from a key. Every member of an organization holds their
 * organization role on every project in it, so naming a sibling project is
 * what the selector does on every click — while a key minted for one project
 * is bounded by it, and reaching a sibling with one is the refusal above.
 * Widening a key by reusing this rule is the one thing that must never
 * happen, so the two rules are two functions and the caller cannot pass a flag
 * to swap them.
 *
 * **The project comes off the address on every request, and nothing here
 * remembers one.** Two tabs on two projects are ordinary, and neither can be
 * right if the server keeps a chosen project per session. The organization
 * still comes from the credential and from nowhere else, so naming a project
 * can only ever pick among what this membership already reaches.
 *
 * A project outside the organization is an absence rather than a denial —
 * `projectOutsideOrganization` says why.
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
 * The acting project as a context to hand the data-access module. Absent, it is
 * the project the credential is authorized for, or the organization's single
 * project for a key minted for the whole customer. Named, it has to be one this
 * credential may act in.
 *
 * **Use this where the request has to land in one project**: a create, or a
 * list of a project's things. There the absent case has to *choose*, and
 * `NAME_THE_PROJECT` is the honest answer when there is more than one to choose
 * from. Where the address already carries the id of the one row being asked
 * about, `reachingIn` below is the one to use instead.
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
 * The acting context for a route addressed by **one resource's own id**, where
 * the project is a filter rather than a destination.
 *
 * Named, it is exactly `actingIn`'s rule and the same wording: a session may
 * name any project of its organization, a key minted for one project may not
 * name a sibling.
 *
 * **Absent, it is whatever the credential itself reaches, and the two callers
 * that arrive here are told apart by `AuthContext.projectId` alone.**
 *
 * - A **session** always carries a project. `apps/api/src/auth/session.ts`
 *   fills it from the membership and throws rather than leaving it out, so
 *   `{ auth }` here is the session's own project. That is the case ticket 12
 *   asked for: a browser naming no project is still answered from the project
 *   it is standing in, not from the whole organization.
 * - A **key minted for the whole organization** carries none, deliberately —
 *   `AuthContext.projectId` is `string | undefined` so that this absence is a
 *   case every reader has to answer rather than a value that defaults. `{ auth }`
 *   here leaves it absent, `inActingProject` returns no predicate for it, and
 *   the read spans the customer. That is the first-class case for such a key,
 *   in the agents group's own words: *"reading across a whole customer is the
 *   first-class case, because two projects of one customer are always readable
 *   together."*
 *
 * One expression answers both because `projectId` is precisely the fact that
 * separates them, and neither answer is a guess: the session's project was
 * chosen by a person, and the organization-wide one narrows by nothing.
 *
 * **Why not `actingIn`.** It resolves an absent project by *choosing* one, and
 * refuses with `NAME_THE_PROJECT` where an organization holds more than one.
 * On a route addressed by a run id or a simulation id there is nothing to
 * choose: the id is unique inside the organization, and a CLI or API client
 * following a run it already identified has no reason to know which project it
 * belongs to. Sending it there turns an
 * organization-wide read into a 400. This function exists so that the two
 * meanings of "no project named" cannot be swapped by picking the shorter name.
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
