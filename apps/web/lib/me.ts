import { readJson, type Answer } from "./api.ts";
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
 * How long the session read may take before egma calls it a failure.
 *
 * **It is the one read in this product with a deadline, and what is standing on
 * it is the reason.** Every other request fails into a page that is already
 * drawn: a list says it could not load, and the application stays usable around
 * it. This one holds a cover over the whole document with everything behind it
 * inert — which is right while the answer is on its way, and a frozen page if
 * it never comes.
 *
 * A connection refused, dropped or reset rejects, and that path always worked.
 * What this closes is a server that accepts the connection and then says
 * nothing: no error, no response, and a browser limit of its own measured in
 * minutes. Twelve seconds is long enough that no real answer is thrown away and
 * short enough that nobody waits in front of a page they cannot touch.
 */
export const SESSION_READ_TIMEOUT_MS = 12_000;

/**
 * Who is signed in, bounded.
 *
 * Both readers of `/api/me` — the shell's session and the entrance — come
 * through here, so the deadline is one value rather than two that could drift,
 * and neither of them can be the one that forgets it. A read that runs out
 * arrives as an ordinary failure, which lands the pages on the states they
 * already have for one: `Session unavailable` in the shell, and the entrance's
 * own sentence with a way to try again.
 */
export async function readSession(
  timeoutMs: number = SESSION_READ_TIMEOUT_MS,
): Promise<Answer<Me>> {
  return readJson<Me>("/api/me", { signal: AbortSignal.timeout(timeoutMs) });
}
