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
  /** Answer as a different egma from now on, as a replacement would. */
  becomeAnother(): string;
};

export function platformRoutes(origin: () => string): {
  readonly group: RouteGroup;
  readonly controls: PlatformIdentityControls;
} {
  let instanceId = newId("ins");

  const controls: PlatformIdentityControls = {
    get instanceId() {
      return instanceId;
    },
    becomeAnother() {
      instanceId = newId("ins");
      return instanceId;
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
          handle: () => ({
            status: 200,
            body: { instance_id: instanceId, origin: origin() },
          }),
        },
      ],
    },
  };
}
