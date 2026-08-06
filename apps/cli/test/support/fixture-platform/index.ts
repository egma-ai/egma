/**
 * A whole fixture platform, ready to point a CLI at.
 *
 * One function starts an HTTP server speaking egma's public API, hands back the
 * address to point at and the controls a test drives it with. Adding the next
 * part of the API is adding a group beside `deviceRoutes` here.
 */

import { controlRoutes } from "./controls.ts";
import { deviceRoutes, type DeviceControls } from "./device.ts";
import { startFixturePlatform, type FixturePlatform } from "./server.ts";

export type { DeviceControls } from "./device.ts";
export type { FixturePlatform, Observation } from "./server.ts";

export type Platform = FixturePlatform & {
  /** What a person in a browser would do, done directly. */
  readonly device: DeviceControls;
};

export async function startPlatform(): Promise<Platform> {
  let controls!: DeviceControls;

  const platform = await startFixturePlatform((origin) => {
    const device = deviceRoutes(origin);
    controls = device.controls;
    return [device.group, controlRoutes(() => controls)];
  });

  return { ...platform, device: controls };
}
