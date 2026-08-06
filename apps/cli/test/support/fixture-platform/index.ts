/**
 * A whole fixture platform, ready to point a CLI at.
 *
 * One function starts an HTTP server speaking egma's public API, hands back the
 * address to point at and the controls a test drives it with. Adding the next
 * part of the API is adding a group beside the ones here.
 */

import { agentRoutes, type AgentControls } from "./agents.ts";
import { controlRoutes } from "./controls.ts";
import { deviceRoutes, type DeviceControls } from "./device.ts";
import { runControlRoutes, runRoutes, type RunControls } from "./runs.ts";
import { startFixturePlatform, type FixturePlatform } from "./server.ts";
import { testRoutes, type TestControls } from "./tests.ts";

export type { AgentControls } from "./agents.ts";
export type { DeviceControls } from "./device.ts";
export type {
  AdvanceStep,
  RunControls,
  RunStatus,
  SeededRun,
  SeededSimulation,
  SimulationStatus,
  Verdict,
} from "./runs.ts";
export { noAdapterMessage } from "./runs.ts";
export type { FixturePlatform, Observation } from "./server.ts";
export type { SeedTest, SeededTest, TestControls } from "./tests.ts";

export type Platform = FixturePlatform & {
  /** What a person in a browser would do, done directly. */
  readonly device: DeviceControls;
  /** What was registered, and what the platform was handed to seal. */
  readonly registered: AgentControls;
  /** What somebody authoring in the dashboard would do, done directly. */
  readonly tests: TestControls;
  /** What the simulator would do to a run, done directly and in any order. */
  readonly running: RunControls;
  /**
   * Sign a machine in without a login: the key is treated as one this instance
   * minted, exactly as a key collected at the end of a device flow is.
   */
  signedInWith(key: string): void;
};

export async function startPlatform(): Promise<Platform> {
  let device!: DeviceControls;
  let registered!: AgentControls;
  let tests!: TestControls;
  let running!: RunControls;

  const platform = await startFixturePlatform((origin) => {
    const deviceGroup = deviceRoutes(origin);
    device = deviceGroup.controls;

    // Which customer this is comes from the key, so every group that writes
    // asks the same question of the same list of minted keys.
    const holdsKey = (key: string): boolean => device.keys.includes(key);

    const agentGroup = agentRoutes(holdsKey);
    registered = agentGroup.controls;

    const testGroup = testRoutes({ holdsKey });
    tests = testGroup.controls;

    // A run reads the other two groups rather than holding copies of what they
    // hold: a version it pins is the version the test group issued, and the
    // connection it executes over is the one the agent group registered.
    const runGroup = runRoutes({
      holdsKey,
      origin,
      versionById: testGroup.versionById,
      connectionById: agentGroup.connectionById,
    });
    running = runGroup.controls;

    return [
      deviceGroup.group,
      agentGroup.group,
      testGroup.group,
      runGroup.group,
      controlRoutes(() => device),
      runControlRoutes(() => running),
    ];
  });

  return {
    ...platform,
    device,
    registered,
    tests,
    running,
    signedInWith(key) {
      device.accept(key);
    },
  };
}
