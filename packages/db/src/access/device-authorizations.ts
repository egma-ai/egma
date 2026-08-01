import { and, eq } from "drizzle-orm";

import { db } from "../client.ts";
import { deviceCode } from "../schema/device.ts";
import type { AuthContext } from "./context.ts";
import { ProjectOutsideOrganizationError } from "./errors.ts";
import { isProjectOfOrganization } from "./projects.ts";

/**
 * What a terminal was authorized for: written when a person approves, read when
 * the terminal collects.
 *
 * The two halves are deliberately different shapes, because their two callers
 * are in different positions. Approving happens in a browser, so it has a
 * session and a context and looks like every other write here. Collecting
 * happens in a terminal holding nothing but the device code it was issued, so
 * the read below takes that code and answers what it resolves to — the same
 * shape as `resolveApiKey`, and safe for the same reason.
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
 * Record which organization and project a pending device authorization is for.
 *
 * The organization is the caller's, from their credential, and never anything
 * the browser sent. The project is named — this is the one moment a person
 * picks one — and a project belonging to somebody else is refused before the
 * write, on top of the database refusing the pairing outright.
 *
 * Nothing here decides whether the authorization is approved. That stays the
 * provider's, so a code that expired or was already answered is still its
 * business rather than a second rule kept in step by hand.
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
 * What this device code was aimed at, or nothing.
 *
 * It takes the device code and returns two identifiers, and that is the whole
 * of it: no argument would make it answer about a different terminal, because
 * the device code is a secret the provider issued to exactly one. A caller
 * holding one has already been handed everything this returns.
 *
 * It has to be read before the code is exchanged rather than after, because
 * exchanging consumes the row. That ordering is the reason this exists at all,
 * rather than the terminal's own context answering the question.
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
