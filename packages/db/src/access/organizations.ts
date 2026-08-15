import { db } from "../client.ts";
import { organization, organizationSettings } from "../schema/tenancy.ts";
import type { AuthContext } from "./context.ts";
import { UnprocessableInputError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { theOrganization, within } from "./within.ts";

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
 * The customer's own name, changed.
 *
 * **The name and not the slug.** A name is what the product shows and is
 * nobody's identifier: two organizations on one deployment may both be called
 * Acme, and renaming one breaks no link anybody holds. The slug is unique
 * across the whole deployment, and letting a customer take a word another
 * customer might be using — or lose the one their invitation links were sent
 * under — is a different decision with a different blast radius, so it is not
 * one this door offers.
 *
 * **Only an `admin`**, on the row of the permission table that already covers
 * retention and provider credentials. Renaming the customer is felt by
 * everybody in it at once.
 *
 * It takes no organization id, like every read above it: which organization
 * is a fact about the credential, not a thing a caller gets to ask for.
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
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select()
    .from(organizationSettings)
    .where(within(auth, organizationSettings))
    .limit(1);
  return row;
}

export type OrganizationSettingsChanges = {
  readonly retentionDays?: number | null;
  readonly dataResidency?: string | null;
};

/**
 * Settings are one row per customer, so writing them is an upsert keyed on the
 * organization from the context. There is no organization to name and therefore
 * none to name wrongly.
 *
 * **Only an `admin` writes them.** Retention is on this row, and retention
 * decides how long a customer's trace data survives — so this is the one
 * setting in the product that can destroy data without deleting anything. The
 * check is here rather than at a route because there is no route yet, and a row
 * of the permission table with no call site refuses nobody.
 */
export async function updateOrganizationSettings(
  auth: AuthContext,
  changes: OrganizationSettingsChanges,
): Promise<OrganizationSettings> {
  authorize(auth, "manage_organization", here(auth));

  const now = new Date();
  const [row] = await db()
    .insert(organizationSettings)
    .values({
      organizationId: auth.organizationId,
      retentionDays: changes.retentionDays ?? null,
      dataResidency: changes.dataResidency ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: {
        ...(changes.retentionDays === undefined
          ? {}
          : { retentionDays: changes.retentionDays }),
        ...(changes.dataResidency === undefined
          ? {}
          : { dataResidency: changes.dataResidency }),
        updatedAt: now,
      },
    })
    .returning();

  if (row === undefined) {
    throw new Error("settings for the caller's organization were not written");
  }
  return row;
}
