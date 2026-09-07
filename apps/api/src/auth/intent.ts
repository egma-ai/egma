import { AsyncLocalStorage } from "node:async_hooks";

import type { Landing, ProvisioningIntent } from "./seam.ts";

/**
 * Request-local signup intent carries names and invitation data into provider
 * hooks without changing the provider request body. Hooks return provisioning
 * results through the same scope; absent intent uses email-derived defaults.
 */

type Scope = {
  readonly intent: ProvisioningIntent;
  landing: Landing | undefined;
};

const scope = new AsyncLocalStorage<Scope>();

export async function withProvisioningIntent<T>(
  intent: ProvisioningIntent,
  work: () => Promise<T>,
): Promise<{ readonly result: T; readonly landing: Landing | undefined }> {
  const current: Scope = { intent, landing: undefined };
  const result = await scope.run(current, work);
  return { result, landing: current.landing };
}

/** What the person asked for, if they came through egma's own signup page. */
export function currentIntent(): ProvisioningIntent | undefined {
  return scope.getStore()?.intent;
}

/** Where they ended up. Ignored when nobody is waiting to hear. */
export function recordLanding(landing: Landing): void {
  const current = scope.getStore();
  if (current !== undefined) current.landing = landing;
}
