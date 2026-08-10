/**
 * A whole fixture platform, ready to point a CLI at.
 *
 * One function starts an HTTP server speaking egma's public API, hands back the
 * address to point at and the controls a test drives it with. Adding the next
 * part of the API is adding a group beside the ones here.
 */

import { newId } from "../../../../../packages/ids/src/index.ts";
import { agentRoutes, type AgentControls } from "./agents.ts";
import { controlRoutes } from "./controls.ts";
import { deviceRoutes, type DeviceControls } from "./device.ts";
import { mockToolRoutes, type MockToolControls } from "./mock-tools.ts";
import { platformRoutes, type PlatformIdentityControls } from "./platform.ts";
import { runControlRoutes, runRoutes, type RunControls } from "./runs.ts";
import { startFixturePlatform, type FixturePlatform } from "./server.ts";
import { testRoutes, type TestControls } from "./tests.ts";

export type { AgentControls } from "./agents.ts";
export type { DeviceControls } from "./device.ts";
export type { MockToolControls, SeedMockTool, SeededMockTool } from "./mock-tools.ts";
export type { PlatformIdentityControls } from "./platform.ts";
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
  /** Who this fixture says it is, and how to make it somebody else. */
  readonly identity: PlatformIdentityControls;
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

export async function startPlatform(): Promise<Platform> {
  let identity!: PlatformIdentityControls;
  let device!: DeviceControls;
  let registered!: AgentControls;
  let tests!: TestControls;
  let mocking!: MockToolControls;
  let running!: RunControls;

  const platform = await startFixturePlatform((origin) => {
    // First, because it is the first thing a repository asks and the only
    // thing it asks before it holds a key.
    const platformGroup = platformRoutes(origin);
    identity = platformGroup.controls;

    // Every address this fixture hands out comes from the one it calls its
    // own, the way a deployment's all come from `EGMA_BASE_URL`.
    const self = (): string => identity.origin;

    const deviceGroup = deviceRoutes(self);
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
      origin: self,
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
    identity,
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
