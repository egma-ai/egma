/**
 * Where the person holding this session is, and what the pages should offer
 * them a choice between.
 *
 * **Hide any level whose cardinality is one.** Somebody with a single
 * organization and a single project sees neither picker, because a level of
 * hierarchy they are not using is clutter rather than information. A solo
 * self-hoster therefore never learns that egma is multi-tenant, which is
 * exactly right — it is, and it does not concern them.
 */

export type WorkspaceOrganization = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: string;
};

export type WorkspaceProject = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
};

export type Workspace = {
  readonly user: { readonly id: string; readonly email: string };
  readonly organizations: readonly WorkspaceOrganization[];
  readonly projects: readonly WorkspaceProject[];
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
export function pickers(workspace: Workspace): Pickers {
  return {
    organization: workspace.organizations.length > 1,
    project: workspace.projects.length > 1,
  };
}
