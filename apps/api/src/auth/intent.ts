import { AsyncLocalStorage } from "node:async_hooks";

import type { Landing, ProvisioningIntent } from "./seam.ts";

/**
 * The names a person chose on egma's signup page, travelling beside the request
 * that creates their identity.
 *
 * The provider owns the signup endpoint and its body is the provider's shape,
 * so there is nowhere in it to put an organization name — and widening what
 * egma asks the provider for, to squeeze one in, is exactly the cost this
 * architecture exists to avoid. So the names travel out of band: egma's signup
 * route enters this scope, the provider does its own work, and the hook that
 * fires when the identity is written reads what is here.
 *
 * An identity created any other way finds nothing here and is provisioned from
 * defaults derived from its email address, which is what makes *every* person
 * land in an organization however they arrived.
 *
 * The same scope carries the answer back. Where the person landed is decided
 * inside the hook, three layers down inside the provider's own call stack, and
 * this is how the route learns it without reading the provider's response body
 * and taking a dependency on its shape.
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
