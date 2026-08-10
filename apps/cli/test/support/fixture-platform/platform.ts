/**
 * The one endpoint a repository reads before it holds a key: which egma this is.
 *
 * Pinned to `apps/api/test/platform-identity.test.ts`, which asserts the same
 * two fields on the real API — an identifier the deployment minted for itself
 * and the origin it believes it is reached on, both unauthenticated and neither
 * a secret.
 *
 * Every fixture platform mints its own identifier, so two of them started in one
 * test are two platforms and a repository bound to the first refuses the second.
 * `becomeAnother` is the case an origin alone cannot catch: the same address,
 * answering as a different egma, which is a new deployment or a restored
 * database.
 */

import { newId } from "../../../../../packages/ids/src/index.ts";
import type { RouteGroup } from "./server.ts";

export type PlatformIdentityControls = {
  /** What this fixture currently calls itself. */
  readonly instanceId: string;
  /**
   * The address this fixture gives out as its own — for its identity, for the
   * approval address a login is sent to, and for a run's results address. One
   * base address behind all three, exactly as a real deployment has one
   * `EGMA_BASE_URL` behind all three.
   */
  readonly origin: string;
  /** Answer as a different egma from now on, as a replacement would. */
  becomeAnother(): string;
  /**
   * Answer with an address of its own that is not the one it was reached at —
   * a deployment whose configured base address is another name for the same
   * server, which is what `EGMA_BASE_URL` is on nearly every self-host.
   */
  saysItIsAt(elsewhere: string): void;
  /**
   * Stop answering who it is at all, as a deployment older than this endpoint
   * does. Everything else it serves goes on working.
   */
  staysQuiet(): void;
};

export function platformRoutes(origin: () => string): {
  readonly group: RouteGroup;
  readonly controls: PlatformIdentityControls;
} {
  let instanceId = newId("ins");
  let saidOrigin: string | null = null;
  let quiet = false;

  const controls: PlatformIdentityControls = {
    get instanceId() {
      return instanceId;
    },
    get origin() {
      return saidOrigin ?? origin();
    },
    becomeAnother() {
      instanceId = newId("ins");
      return instanceId;
    },
    saysItIsAt(elsewhere) {
      saidOrigin = elsewhere;
    },
    staysQuiet() {
      quiet = true;
    },
  };

  return {
    controls,
    group: {
      name: "platform",
      routes: [
        {
          method: "GET",
          path: "/api/platform",
          handle: () =>
            quiet
              ? {
                  status: 404,
                  body: { error: "not_found", message: "nothing serves /api/platform" },
                }
              : {
                  status: 200,
                  body: { instance_id: instanceId, origin: saidOrigin ?? origin() },
                },
        },
      ],
    },
  };
}
