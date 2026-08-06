/**
 * A whole fixture platform, ready to point a CLI at.
 *
 * One function starts an HTTP server speaking egma's public API, hands back the
 * address to point at and the controls a test drives it with. Adding the next
 * part of the API is adding a group beside the ones here.
 */

import { controlRoutes } from "./controls.ts";
import { deviceRoutes, type DeviceControls } from "./device.ts";
import { startFixturePlatform, type FixturePlatform } from "./server.ts";
import { testRoutes, type TestControls } from "./tests.ts";

export type { DeviceControls } from "./device.ts";
export type { FixturePlatform, Observation } from "./server.ts";
export type { SeedTest, SeededTest, TestControls } from "./tests.ts";

export type Platform = FixturePlatform & {
  /** What a person in a browser would do, done directly. */
  readonly device: DeviceControls;
  /** What somebody authoring in the dashboard would do, done directly. */
  readonly tests: TestControls;
  /**
   * Sign a machine in without a login: the key is treated as one this instance
   * minted, exactly as a key collected at the end of a device flow is.
   */
  signedInWith(key: string): void;
};

export async function startPlatform(): Promise<Platform> {
  let device!: DeviceControls;
  let tests!: TestControls;

  const platform = await startFixturePlatform((origin) => {
    const deviceGroup = deviceRoutes(origin);
    device = deviceGroup.controls;

    const testGroup = testRoutes({ holdsKey: (key) => device.keys.includes(key) });
    tests = testGroup.controls;

    return [deviceGroup.group, testGroup.group, controlRoutes(() => device)];
  });

  return {
    ...platform,
    device,
    tests,
    signedInWith(key) {
      device.accept(key);
    },
  };
}
