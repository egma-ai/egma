/**
 * A whole fixture platform, ready to point a CLI at.
 *
 * One function starts an HTTP server speaking Egma's public API, hands back the
 * address to point at and the controls a test drives it with. Adding the next
 * part of the API is adding a group beside the ones here.
 */

import { newId } from "../../../../../packages/ids/src/index.ts";
import { agentRoutes, type AgentControls } from "./agents.ts";
import { controlRoutes } from "./controls.ts";
import { deviceRoutes, type DeviceControls } from "./device.ts";
import { platformRoutes, type PlatformIdentityControls } from "./platform.ts";
import { mockToolRoutes, type MockToolControls } from "./mock-tools.ts";
import { runControlRoutes, runRoutes, type RunControls } from "./runs.ts";
import { startFixturePlatform, type FixturePlatform } from "./server.ts";
import { testRoutes, type TestControls } from "./tests.ts";

export type { AgentControls } from "./agents.ts";
export type { DeviceControls } from "./device.ts";
export type { MockToolControls, SeedMockTool, SeededMockTool } from "./mock-tools.ts";
export type {
  AdvanceStep,
  RunControls,
  RunStatus,
  SeededRun,
  SeededSimulation,
  SimulationStatus,
  Verdict,
} from "./runs.ts";
export type { FixturePlatform, Observation } from "./server.ts";
export type { SeedTest, SeededTest, TestControls } from "./tests.ts";

export type Platform = FixturePlatform & {
  /** Stable identity returned before login. */
  readonly instanceId: PlatformIdentityControls["instanceId"];
  /** What a person in a browser would do, done directly. */
  readonly device: DeviceControls;
  /** What was registered, and what the platform was handed to seal. */
  readonly registered: AgentControls;
  /** What somebody authoring in the dashboard would do, done directly. */
  readonly tests: TestControls;
  /** The mock tools this project answers with, authored directly. */
  readonly mocking: MockToolControls;
  /** What the simulator would do to a run, done directly and in any order. */
  readonly running: RunControls;
  /**
   * Sign a machine in without a login: the key is treated as one this instance
   * minted, exactly as a key collected at the end of a device flow is.
   */
  signedInWith(key: string): void;
};

export type StartPlatformOptions = {
  /** What the identity route names when this socket is only an alias. */
  readonly canonicalOrigin?: string;
};

export async function startPlatform(options: StartPlatformOptions = {}): Promise<Platform> {
  let device!: DeviceControls;
  let registered!: AgentControls;
  let tests!: TestControls;
  let mocking!: MockToolControls;
  let running!: RunControls;
  let identity!: PlatformIdentityControls;

  const platform = await startFixturePlatform((origin) => {
    const platformGroup = platformRoutes(() => options.canonicalOrigin ?? origin());
    identity = platformGroup.controls;
    const deviceGroup = deviceRoutes(origin);
    device = deviceGroup.controls;

    // Which customer this is comes from the key, so every group that writes
    // asks the same question of the same list of minted keys — and every group
    // acts in the one project that key was minted for, so a body or a filter
    // naming a project meets one answer rather than one per route group.
    const holdsKey = (key: string): boolean => device.keys.includes(key);
    const projectId = newId("prj");

    const agentGroup = agentRoutes({ knowsKey: holdsKey, projectId });
    registered = agentGroup.controls;

    const testGroup = testRoutes({ holdsKey, projectId });
    tests = testGroup.controls;

    // The scope a mock tool may name is read out of the agent group rather
    // than copied, so an agent registered after this is wired is one a mock
    // tool can still be scoped to.
    const mockToolGroup = mockToolRoutes({
      holdsKey,
      projectId,
      agentsHere: () => agentGroup.controls.agents,
    });
    mocking = mockToolGroup.controls;

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
      platformGroup.group,
      deviceGroup.group,
      agentGroup.group,
      testGroup.group,
      mockToolGroup.group,
      runGroup.group,
      controlRoutes(() => device),
      runControlRoutes(() => running),
    ];
  });

  return {
    ...platform,
    instanceId: identity.instanceId,
    device,
    registered,
    tests,
    mocking,
    running,
    signedInWith(key) {
      device.accept(key);
    },
  };
}
