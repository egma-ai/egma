import { db } from "../client.ts";
import { organization } from "../schema/tenancy.ts";
import type { AuthContext } from "./context.ts";
import { UnprocessableInputError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { theOrganization } from "./within.ts";

/** The customer. The only tenancy boundary there is. */
export type Organization = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
};

export type OrganizationSettings = {
  readonly organizationId: string;
  /** Null means keep forever. */
  readonly retentionDays: number | null;
  readonly dataResidency: string | null;
  readonly updatedAt: Date;
};

const SETTINGS_COLUMNS = {
  organizationId: organization.id,
  retentionDays: organization.retentionDays,
  dataResidency: organization.dataResidency,
  updatedAt: organization.settingsUpdatedAt,
};

/**
 * The caller's own customer row. It takes no id: which organization is a fact
 * about the credential, not a thing a caller gets to ask for.
 */
export async function readOrganization(
  auth: AuthContext,
): Promise<Organization | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdAt: organization.createdAt,
    })
    .from(organization)
    .where(theOrganization(auth))
    .limit(1);
  return row;
}

/**
 * Allow admins to change the organization name. Scope comes from AuthContext;
 * the deployment-unique slug remains unchanged.
 */
export async function updateOrganization(
  auth: AuthContext,
  changes: { readonly name: string },
): Promise<Organization | undefined> {
  authorize(auth, "manage_organization", here(auth));

  const name = changes.name.trim();
  if (name === "") {
    throw new UnprocessableInputError("an organization needs a name");
  }

  const [row] = await db()
    .update(organization)
    .set({ name, updatedAt: new Date() })
    .where(theOrganization(auth))
    .returning({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdAt: organization.createdAt,
    });
  return row;
}

export async function readOrganizationSettings(
  auth: AuthContext,
): Promise<OrganizationSettings | undefined> {
  authorize(auth, "read_organization", here(auth));

  const [row] = await db()
    .select(SETTINGS_COLUMNS)
    .from(organization)
    .where(theOrganization(auth))
    .limit(1);
  if (row === undefined || row.updatedAt === null) return undefined;
  return { ...row, updatedAt: row.updatedAt };
}

export type OrganizationSettingsChanges = {
  readonly retentionDays?: number | null;
  readonly dataResidency?: string | null;
};

/**
 * Update only supplied settings on the caller's organization, preserving
 * concurrent changes to other fields. Use a separate settings timestamp.
 * Require manage_organization here so every caller is subject to the admin rule.
 */
export async function updateOrganizationSettings(
  auth: AuthContext,
  changes: OrganizationSettingsChanges,
): Promise<OrganizationSettings> {
  authorize(auth, "manage_organization", here(auth));

  const [row] = await db()
    .update(organization)
    .set({
      ...(changes.retentionDays === undefined
        ? {}
        : { retentionDays: changes.retentionDays }),
      ...(changes.dataResidency === undefined
        ? {}
        : { dataResidency: changes.dataResidency }),
      settingsUpdatedAt: new Date(),
    })
    .where(theOrganization(auth))
    .returning(SETTINGS_COLUMNS);

  if (row === undefined || row.updatedAt === null) {
    throw new Error("settings for the caller's organization were not written");
  }
  return { ...row, updatedAt: row.updatedAt };
}
