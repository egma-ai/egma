import { newId } from "@egma/ids";

import type { RouteGroup } from "./server.ts";

export type PlatformIdentityControls = {
  readonly instanceId: string;
};

export function platformRoutes(
  origin: () => string,
): { readonly group: RouteGroup; readonly controls: PlatformIdentityControls } {
  const instanceId = newId("pf");
  return {
    controls: { instanceId },
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
