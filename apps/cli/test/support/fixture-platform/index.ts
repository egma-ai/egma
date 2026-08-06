/**
 * A whole fixture platform, ready to point a CLI at.
 *
 * One function starts an HTTP server speaking egma's public API, hands back the
 * address to point at and the controls a test drives it with. Adding the next
 * part of the API is adding a group beside `deviceRoutes` here.
 */

import { agentRoutes, type AgentControls } from "./agents.ts";
import { controlRoutes } from "./controls.ts";
import { deviceRoutes, type DeviceControls } from "./device.ts";
import { startFixturePlatform, type FixturePlatform } from "./server.ts";

export type { AgentControls } from "./agents.ts";
export type { DeviceControls } from "./device.ts";
export type { FixturePlatform, Observation } from "./server.ts";

export type Platform = FixturePlatform & {
  /** What a person in a browser would do, done directly. */
  readonly device: DeviceControls;
  /** What was registered, and what the platform was handed to seal. */
  readonly registered: AgentControls;
};

export async function startPlatform(): Promise<Platform> {
  let controls!: DeviceControls;
  let registered!: AgentControls;

  const platform = await startFixturePlatform((origin) => {
    const device = deviceRoutes(origin);
    controls = device.controls;

    // Which customer this is comes from the key, so every group that writes
    // asks the same question of the same list of minted keys.
    const written = agentRoutes((key) => controls.keys.includes(key));
    registered = written.controls;

    return [device.group, written.group, controlRoutes(() => controls)];
  });

  return { ...platform, device: controls, registered };
}
