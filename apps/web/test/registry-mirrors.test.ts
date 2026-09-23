import { describe, expect, it } from "vitest";

import {
  PLATFORMS_PUSHING_TRACES,
  platformPushesTraces,
  schema,
} from "@egma/db";

import { isSdkPlatform, SDK_PLATFORMS } from "../lib/agent-setup-flow.ts";
import { LANES_WITH_AN_AGENT_POV, laneHasAnAgentPov } from "../lib/simulations.ts";

/**
 * The browser cannot import `@egma/db`, so it holds copies of two registry
 * lists. These tests keep each copy equal to the registry's own.
 */
describe("the web's copies of registry lists", () => {
  const { AGENT_PLATFORMS, CONNECTION_TYPES } = schema;
  const REGISTRY_AGENT_POV_LANES = schema.LANES_WITH_AN_AGENT_POV;

  it("treats exactly the registry's trace-pushing platforms as SDK platforms", () => {
    expect([...SDK_PLATFORMS]).toEqual([...PLATFORMS_PUSHING_TRACES]);
    for (const platform of AGENT_PLATFORMS) {
      expect(isSdkPlatform(platform), platform).toBe(platformPushesTraces(platform));
    }
  });

  it("reads the agent's own record on exactly the registry's agent-POV lanes", () => {
    expect([...LANES_WITH_AN_AGENT_POV]).toEqual([...REGISTRY_AGENT_POV_LANES]);
    for (const connectionType of CONNECTION_TYPES) {
      expect(laneHasAnAgentPov(connectionType), connectionType).toBe(
        (REGISTRY_AGENT_POV_LANES as readonly string[]).includes(connectionType),
      );
    }
  });
});
