/**
 * Test-only /fixture controls for approval and other simulated user actions.
 * HTTP access lets separate CLI and browser-stub processes drive the fixture.
 */

import type { DeviceControls } from "./device.ts";
import type { RouteGroup } from "./server.ts";

export function controlRoutes(controls: () => DeviceControls): RouteGroup {
  const act = (
    request: { url: URL; body: Record<string, unknown> | null },
    take: (code: string) => boolean,
  ) => {
    const code =
      request.url.searchParams.get("user_code") ??
      (typeof request.body?.user_code === "string" ? request.body.user_code : "");
    return take(code)
      ? { status: 200, body: { done: true } }
      : { status: 404, body: { done: false, message: `nothing is waiting on ${code}` } };
  };

  return {
    name: "fixture-controls",
    routes: [
      {
        method: "POST",
        path: "/fixture/approve",
        handle: (request) => act(request, (code) => controls().approve(code)),
      },
      {
        method: "POST",
        path: "/fixture/deny",
        handle: (request) => act(request, (code) => controls().deny(code)),
      },
      {
        method: "POST",
        path: "/fixture/expire",
        handle: (request) => act(request, (code) => controls().expire(code)),
      },
      {
        method: "GET",
        path: "/fixture/keys",
        handle: () => ({ status: 200, body: { keys: [...controls().keys] } }),
      },
    ],
  };
}
