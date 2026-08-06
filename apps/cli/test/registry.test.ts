import { describe, expect, it } from "vitest";

import {
  DEFAULT_DRIVEN_AGENT_ID,
  UnlaunchableDrivenAgentError,
  findDrivenAgent,
  launchFor,
  launchForId,
  registry,
} from "../src/acp/registry.ts";

describe("the mirrored agent registry", () => {
  it("carries the agents egma drives, so no launch table is written by hand", () => {
    expect(findDrivenAgent(DEFAULT_DRIVEN_AGENT_ID)).not.toBeNull();
    expect(findDrivenAgent("codex-acp")).not.toBeNull();
    expect(registry().agents.length).toBeGreaterThan(10);
  });

  it("starts a published agent with the package the registry names", () => {
    const launch = launchForId(DEFAULT_DRIVEN_AGENT_ID);

    expect(launch.command).toMatch(/^npx/);
    expect(launch.args.join(" ")).toContain("@agentclientprotocol/claude-agent-acp");
  });

  it("gives Codex the setting that stops it asking", () => {
    expect(launchForId("codex-acp").env).toEqual({ INITIAL_AGENT_MODE: "agent-full-access" });
  });

  it("refuses an agent it has never heard of, by name", () => {
    expect(() => launchForId("no-such-agent")).toThrow(UnlaunchableDrivenAgentError);
    expect(() => launchForId("no-such-agent")).toThrow(/no-such-agent/);
  });

  it("refuses an agent it can only reach as a downloadable binary", () => {
    expect(() =>
      launchFor({ id: "binary-only", name: "Binary Only", distribution: { binary: {} } }),
    ).toThrow(/downloadable binary/);
  });
});
