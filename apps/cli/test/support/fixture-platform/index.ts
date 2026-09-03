/**
 * A whole fixture platform, ready to point a CLI at.
 *
 * One function starts an HTTP server speaking egma's public API, hands back the
 * address to point at and the controls a test drives it with. Adding the next
 * part of the API is adding a group beside the ones here.
 */

import { newId } from "../../../../../packages/ids/src/index.ts";
import { agentRoutes, type AgentControls } from "./agents.ts";
import { apiKeyRoutes, type ApiKeyControls } from "./api-keys.ts";
import { controlRoutes } from "./controls.ts";
import { deviceRoutes, type DeviceControls } from "./device.ts";
import { mockToolRoutes, type MockToolControls } from "./mock-tools.ts";
import { personaRoutes, type PersonaControls } from "./personas.ts";
import { monitoringRoutes, type MonitoringControls } from "./monitoring.ts";
import { runControlRoutes, runRoutes, type RunControls } from "./runs.ts";
import { startFixturePlatform, type FixturePlatform } from "./server.ts";
import { suiteRoutes, type SuiteControls } from "./suites.ts";
import { testRoutes, type TestControls } from "./tests.ts";

export type { AgentControls } from "./agents.ts";
export type { ApiKeyControls, MintedKey } from "./api-keys.ts";
export type { DeviceControls } from "./device.ts";
export type {
  MonitoringControls,
  RetellAccountAgent,
  StartRefusalReason,
} from "./monitoring.ts";
export type { MockToolControls, SeedMockTool, SeededMockTool } from "./mock-tools.ts";
export type { PersonaControls, SeededPersona } from "./personas.ts";
export type {
  AdvanceStep,
  FixtureGrade,
  GradingState,
  GradingStep,
  RunControls,
  RunStatus,
  SeededRun,
  SeededSimulation,
  SimulationStatus,
} from "./runs.ts";
export type { FixturePlatform, Observation } from "./server.ts";
export type { SeedBehavior, SeedTest, SeededTest, TestControls } from "./tests.ts";
export type { SeededSuite, SuiteControls } from "./suites.ts";

export type Platform = FixturePlatform & {
  /** The one project every authenticated fixture request belongs to. */
  readonly projectId: string;
  /** What a person in a browser would do, done directly. */
  readonly device: DeviceControls;
  /** What was registered, and what the platform was handed to seal. */
  readonly registered: AgentControls;
  /** The Retell account Egma discovers, and the keys sealed onto agent rows. */
  readonly monitoring: MonitoringControls;
  /** Every key this instance minted through its own API. */
  readonly keys: ApiKeyControls;
  /** What somebody authoring in the dashboard would do, done directly. */
  readonly tests: TestControls;
  readonly suites: SuiteControls;
  /** The mock tools this project answers with, authored directly. */
  readonly mocking: MockToolControls;
  /** Who can call: the shared default every project starts with, and any more. */
  readonly personas: PersonaControls;
  /** What the simulator would do to a run, done directly and in any order. */
  readonly running: RunControls;
  /**
   * Sign a machine in without a login: the key is treated as one this instance
   * minted, exactly as a key collected at the end of a device flow is.
   */
  signedInWith(key: string): void;
};

export type StartPlatformOptions = {
  /** A synchronous race seam after remote creation and before the CLI writes. */
  readonly afterSuiteCreate?: (suite: import("./suites.ts").SeededSuite) => void;
};

export async function startPlatform(options: StartPlatformOptions = {}): Promise<Platform> {
  let device!: DeviceControls;
  let registered!: AgentControls;
  let monitoring!: MonitoringControls;
  let keys!: ApiKeyControls;
  let tests!: TestControls;
  let suites!: SuiteControls;
  let mocking!: MockToolControls;
  let personas!: PersonaControls;
  let running!: RunControls;
  let projectId!: string;

  const platform = await startFixturePlatform((origin) => {
    projectId = newId("prj");
    const deviceGroup = deviceRoutes(origin, () => projectId);
    device = deviceGroup.controls;

    // Which customer this is comes from the key, so every group that writes
    // asks the same question of the same list of minted keys — and every group
    // acts in the one project that key was minted for, so a body or a filter
    // naming a project meets one answer rather than one per route group.
    const holdsKey = (key: string): boolean => device.keys.includes(key);
    const organizationId = newId("org");

    const suiteGroup = suiteRoutes({
      holdsKey,
      projectId,
      projectName: "Fixture project",
      ...(options.afterSuiteCreate === undefined
        ? {}
        : { afterCreate: options.afterSuiteCreate }),
    });
    suites = suiteGroup.controls;

    // Egma's Predefined persona belongs to no project, so every project can
    // name one before anybody authors anything.
    const personaGroup = personaRoutes({ holdsKey, projectId });
    personas = personaGroup.controls;

    const agentGroup = agentRoutes({ knowsKey: holdsKey, projectId });
    registered = agentGroup.controls;

    // Monitoring writes to the same agent rows the agent group answers reads
    // from, because the binding, the sealed key and the switch are the agent's
    // own (ADR-0015). It is handed the roster rather than a copy.
    const monitoringGroup = monitoringRoutes({
      holdsKey,
      projectId,
      roster: agentGroup.roster,
    });
    monitoring = monitoringGroup.controls;

    // A key minted here is a key this instance authorizes, so what a terminal
    // writes into a `.env` is a credential this platform would really take.
    const apiKeyGroup = apiKeyRoutes({
      holdsKey,
      accept: (key) => device.accept(key),
      reject: (key) => device.reject(key),
      organizationId,
      projectId,
    });
    keys = apiKeyGroup.controls;

    // The scope a mock tool may name is read out of the agent group rather
    // than copied, so an agent registered after this is wired is one a mock
    // tool can still be scoped to.
    const mockToolGroup = mockToolRoutes({
      holdsKey,
      projectId,
      agentsHere: () => agentGroup.controls.agents,
    });
    mocking = mockToolGroup.controls;

    // Tests and mock tools are committed by one repository change set. Each
    // fixture group prepares its part before either part changes state.
    const testGroup = testRoutes({
      holdsKey,
      projectId,
      suiteById: suiteGroup.controls.byId,
      allSuites: () => suiteGroup.controls.suites,
      createSuite: suiteGroup.controls.add,
      prepareMockTools: mockToolGroup.controls.prepareRepository,
    });
    tests = testGroup.controls;

    // A run reads the other two groups rather than holding copies of what they
    // hold: a version it pins is the version the test group issued, and the
    // connection it executes over is the one the agent group registered.
    const runGroup = runRoutes({
      holdsKey,
      origin,
      projectId,
      testsInSuite: testGroup.testsInSuite,
      connectionById: agentGroup.connectionById,
    });
    running = runGroup.controls;

    return [
      // The full key-list route must win over the device-flow fixture's older
      // login probe at the same path. A login probe needs only a 200; the CLI
      // recovery flow needs the real safe metadata list.
      apiKeyGroup.group,
      deviceGroup.group,
      agentGroup.group,
      monitoringGroup.group,
      suiteGroup.group,
      personaGroup.group,
      testGroup.group,
      mockToolGroup.group,
      runGroup.group,
      controlRoutes(() => device),
      runControlRoutes(() => running),
    ];
  });

  return {
    ...platform,
    projectId,
    device,
    registered,
    monitoring,
    keys,
    tests,
    suites,
    mocking,
    personas,
    running,
    signedInWith(key) {
      device.accept(key);
    },
  };
}
