import { and, eq } from "drizzle-orm";

import { db } from "../client.ts";
import { deviceCode } from "../schema/device.ts";
import type { AuthContext } from "./context.ts";
import { ProjectOutsideOrganizationError } from "./errors.ts";
import { isProjectOfOrganization } from "./projects.ts";

/**
 * Device authorization joins two flows: browser approval records project scope,
 * and the terminal reads that scope using its secret device code.
 */

/** Which organization and project a terminal is being let into. */
export type DeviceAuthorization = {
  readonly organizationId: string;
  readonly projectId: string;
};

export type DeviceAuthorizationTarget = {
  /**
   * The short code the person read off their terminal, as the provider stored
   * it. Tidying up what somebody typed belongs at the edge that took the
   * typing, not here.
   */
  readonly userCode: string;
  /** The project they chose, which has to be one of their own. */
  readonly projectId: string;
};

/**
 * Set the pending authorization's project within the caller's organization.
 * The auth provider still decides whether the code can be approved.
 */
export async function recordDeviceAuthorization(
  auth: AuthContext,
  target: DeviceAuthorizationTarget,
): Promise<boolean> {
  if (!(await isProjectOfOrganization(auth, target.projectId))) {
    throw new ProjectOutsideOrganizationError(
      auth.organizationId,
      target.projectId,
    );
  }

  const rows = await db()
    .update(deviceCode)
    .set({
      organizationId: auth.organizationId,
      projectId: target.projectId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deviceCode.userCode, target.userCode),
        eq(deviceCode.status, "pending"),
      ),
    )
    .returning({ id: deviceCode.id });

  return rows.length > 0;
}

/**
 * Resolve organization and project from the secret device code.
 * Read before token exchange consumes the row; return undefined if scope is absent.
 */
export async function resolveDeviceAuthorization(
  deviceCodeSecret: string,
): Promise<DeviceAuthorization | undefined> {
  const [row] = await db()
    .select({
      organizationId: deviceCode.organizationId,
      projectId: deviceCode.projectId,
    })
    .from(deviceCode)
    .where(eq(deviceCode.deviceCode, deviceCodeSecret))
    .limit(1);

  if (row === undefined) return undefined;
  const { organizationId, projectId } = row;
  if (organizationId === null || projectId === null) return undefined;
  return { organizationId, projectId };
}
