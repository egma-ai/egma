import { newId } from "@egma/ids";

import { REPOSITORY_CONTRACT } from "../../../../api/src/routes/platform.ts";
import type { RouteGroup } from "./server.ts";

export type PlatformIdentityControls = {
  readonly instanceId: string;
  /**
   * Answer a different repository contract, as a platform on another release
   * would.
   *
   * The only way to stand in for the situation the check exists for: two egmas
   * that read and write different shapes, which cannot otherwise be produced
   * from one checkout where both halves are built from the same constant.
   */
  speaksContract(said: number): void;
};

export function platformRoutes(
  origin: () => string,
): { readonly group: RouteGroup; readonly controls: PlatformIdentityControls } {
  const instanceId = newId("pf");
  let contract = REPOSITORY_CONTRACT;
  return {
    controls: {
      instanceId,
      speaksContract(said) {
        contract = said;
      },
    },
    group: {
      name: "platform",
      routes: [
        {
          method: "GET",
          path: "/api/platform",
          handle: () => ({
            status: 200,
            body: {
              instance_id: instanceId,
              origin: origin(),
              // Which shape this platform speaks to a repository. Read from the
              // API's own constant rather than written again here: a fixture
              // that agreed to a number the platform had moved past would be
              // the one place the mismatch check could never be caught.
              repository_contract: contract,
            },
          }),
        },
      ],
    },
  };
}
