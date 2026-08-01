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
 * **Hide any level whose cardinality is one.** Somebody with a single
 * organization and a single project sees neither picker, because a level of
 * hierarchy they are not using is clutter rather than information. A solo
 * self-hoster therefore never learns that egma is multi-tenant, which is
 * exactly right — it is, and it does not concern them.
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

export type Pickers = {
  readonly organization: boolean;
  readonly project: boolean;
};

/**
 * Which pickers a page should render. Nothing to choose between is nothing to
 * show, at either level, and the two are decided the same way rather than one
 * being a special case of the other.
 */
export function pickers(me: Me): Pickers {
  return {
    organization: me.organizations.length > 1,
    project: me.projects.length > 1,
  };
}
