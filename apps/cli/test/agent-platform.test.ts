import { describe, expect, it } from "vitest";

import {
  agentPlatformIn,
  isSupportedAgentPlatform,
} from "../src/wizard/agent-platform.ts";

describe("the voice-agent platform route", () => {
  it.each([
    ["retell-sdk", "retell"],
    ["Retell", "retell"],
    ["livekit-agents", "livekit"],
    ["@livekit/agents", "livekit"],
    ["pipecat-ai", "pipecat"],
    ["Vapi SDK", "vapi"],
  ] as const)("reads %s as %s", (reported, expected) => {
    expect(agentPlatformIn(new Map([["framework", reported]]))).toBe(expected);
  });

  it("does not guess from an unknown or mixed answer", () => {
    expect(agentPlatformIn(new Map([["framework", "custom websocket"]]))).toBeNull();
    expect(agentPlatformIn(new Map([["framework", "Retell bridge to LiveKit"]]))).toBeNull();
  });

  it("supports Retell and LiveKit in the wizard today", () => {
    expect(isSupportedAgentPlatform("retell")).toBe(true);
    expect(isSupportedAgentPlatform("livekit")).toBe(true);
    expect(isSupportedAgentPlatform("pipecat")).toBe(false);
    expect(isSupportedAgentPlatform("vapi")).toBe(false);
  });
});
