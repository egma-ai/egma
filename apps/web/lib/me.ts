import { readJson, type Answer } from "./api.ts";
import { roleFrom, type Role } from "./roles.ts";

/**
 * Session identity and available organizations and projects from /api/me.
 * The selected project belongs in each tab's URL, not shared browser state.
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
 * Bound the session read so an unresponsive server cannot leave the document
 * behind its loading cover indefinitely.
 */
export const SESSION_READ_TIMEOUT_MS = 12_000;

/**
 * Share the session deadline between the shell and entrance. Timeout returns
 * a failed read so each surface can show its retry state.
 */
export async function readSession(
  timeoutMs: number = SESSION_READ_TIMEOUT_MS,
): Promise<Answer<Me>> {
  return readJson<Me>("/api/me", { signal: AbortSignal.timeout(timeoutMs) });
}
