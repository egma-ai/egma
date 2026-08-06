/**
 * The fixture's own controls, which are not part of the contract.
 *
 * On a real instance a person approves a terminal in a browser. A check has no
 * person and no browser, so it says the same thing over HTTP instead. These
 * paths are under `/fixture` and nothing the CLI does ever touches them — the
 * separation is the point, and it is the shape the simulator's workbench uses
 * for the same reason.
 *
 * They are reachable over HTTP rather than only in the process that started the
 * server, because the thing being checked is usually a subprocess: the built
 * `egma` command, with a stand-in browser beside it.
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
