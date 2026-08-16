import { roleFrom, type Role } from "./roles.ts";

/**
 * Where the person holding this session is, and what the pages should offer
 * them a choice between. What `/api/me` answers, as the pages read it.
 *
 * **There are two levels and they are called `organization` and `project`**,
 * which is what they are and what the rest of the codebase calls them. No third
 * word sits above the pair naming it: a container word invented for the top of
 * a hierarchy is how `project` comes to mean the tenancy container in one place
 * and something inside it in another, and a word that means two things is one
 * nobody can read a permission with.
 *
 * **This read names no chosen project, and never will.** Which project a tab is
 * working in lives in that tab's address; a mutable browser-wide "current
 * project" would make two tabs on two projects impossible and would make a
 * pasted link mean something different to whoever opened it. So this answers
 * the *choices* — every project the membership reaches, in stable creation
 * order — and the address answers the choice.
 *
 * **The organization and project control stays on screen even with one
 * project.** An earlier rule hid any level whose cardinality was one, on the
 * grounds that a level you are not using is clutter. It is not: it is where you
 * are, and somebody who cannot see where they are working cannot tell that a
 * page is empty because the project is empty.
 */

/** The customer, and the role you hold in it. */
export type Organization = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: string;
};

/** A product area inside it: a scope over resources, never a wall. */
export type Project = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
};

/** You: who you are, and everywhere you are. */
export type Me = {
  readonly user: { readonly id: string; readonly email: string };
  readonly organizations: readonly Organization[];
  readonly projects: readonly Project[];
};

/**
 * The organization this session acts in.
 *
 * A list of one in this version, and read through a function anyway, so that
 * nothing is written as though *the* organization is a fact rather than a
 * lookup. It can be absent: somebody whose provisioning failed is signed in
 * and is nowhere, and the pages say so rather than pretending.
 */
export function organizationOf(me: Me): Organization | undefined {
  return me.organizations[0];
}

/** The role this session holds, or the least of them when there is none. */
export function roleOf(me: Me): Role {
  return roleFrom(organizationOf(me)?.role);
}

/** The project an entry address with none in it opens. */
export function firstProjectOf(me: Me): Project | undefined {
  return me.projects[0];
}

/**
 * The projects a typed query leaves. Name and slug both, because a person who
 * knows a project by the word in its address should not have to know its
 * display name to find it.
 *
 * Order is never rearranged by relevance: the list is in stable creation order
 * and a menu whose items move under the keyboard is a menu that mis-selects.
 */
export function projectsMatching(
  projects: readonly Project[],
  query: string,
): readonly Project[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return projects;
  return projects.filter(
    (project) =>
      project.name.toLowerCase().includes(wanted) ||
      project.slug.toLowerCase().includes(wanted),
  );
}
